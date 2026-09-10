import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "child_process";
import { getPhysicalPackageDir } from "./config.js";
import {
	type InstallSelection,
	installedCli,
	OWNED_INSTALL_MARKER,
	type OwnedInstallation,
	ownedVersion,
	parseInstallSelection,
	readInstallSelection,
} from "./owned-install-layout.js";
import { PRODUCT, PRODUCT_ENV } from "./product-identity.js";
import { assertProductStatePath } from "./runtime-paths.js";

export interface OwnedActivation {
	selection: InstallSelection;
	installation: OwnedInstallation;
}

export class OwnedInstallActivatedError extends Error {
	constructor(
		readonly activation: OwnedActivation,
		cause: unknown,
	) {
		super(
			`Base-Context activation was accepted, but a later step failed (${cause instanceof Error ? cause.message : String(cause)}). No rollback was attempted.`,
			{ cause },
		);
	}
}

export function captureOwnedUpdate(installation: OwnedInstallation): InstallSelection {
	const selection = readInstallSelection(installation.root);
	if (!selection || selection.active !== installation.version) {
		throw new Error(
			"This Base-Context process uses an older installation. Run the selected launcher before updating.",
		);
	}
	return selection;
}

function assertSelection(root: string, expected: InstallSelection | null): InstallSelection | null {
	const current = readInstallSelection(root);
	if (current?.generation !== expected?.generation) {
		throw new Error(
			"Base-Context selection changed while this operation was in progress. No activation was attempted; retry from the selected launcher.",
		);
	}
	return current;
}

function initializeRoot(root: string): void {
	assertProductStatePath(root);
	if (process.platform === "win32") throw new Error("Owned Base-Context installation currently requires POSIX.");
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const marker = join(root, "owned");
	if (existsSync(marker)) {
		if (readFileSync(marker, "utf8") !== OWNED_INSTALL_MARKER)
			throw new Error("Unrecognized Base-Context installation owner.");
		return;
	}
	if (readdirSync(root).length !== 0) {
		throw new Error(`Base-Context will not take ownership of a nonempty installation directory: ${root}`);
	}
	writeFileSync(marker, OWNED_INSTALL_MARKER, { flag: "wx", mode: 0o600 });
}

function launcherSource(): string {
	return `const fs = require("node:fs");
const path = require("node:path");
const url = require("node:url");
const root = __dirname;
const selection = JSON.parse(fs.readFileSync(path.join(root, "current.json"), "utf8"));
const installer = process.argv[2] === "install";
const packageDir = path.join(root, "versions", selection.active, "node_modules", ${JSON.stringify(PRODUCT.packageName)});
const entry = path.join(packageDir, installer ? "dist/installer.mjs" : "dist/bundle/cli.js");
process.env.BASE_CONTEXT_LAUNCHER_PATH = path.join(root, "bin", installer ? "base-context-install" : "base-context");
process.env.BASE_CONTEXT_PACKAGE_DIR = packageDir;
process.argv.splice(1, 2, entry);
import(url.pathToFileURL(entry).href).catch(error => { console.error(error); process.exitCode = 1; });
`;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function publishFirstLauncher(filePath: string, content: string, mode: number): void {
	if (existsSync(filePath)) return;
	const pending = `${filePath}-${randomUUID()}.tmp`;
	writeFileSync(pending, content, { flag: "wx", mode });
	renameSync(pending, filePath);
}

/** Called only by the external Node activation worker with SQLite explicitly enabled. */
export function runOwnedActivation(
	root: string,
	expected: InstallSelection | null,
	version: string,
	parentPid: number,
): OwnedActivation {
	const sqlite = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseSync };
	const database = new sqlite.DatabaseSync(join(root, ".activation.sqlite"));
	let activation: OwnedActivation | undefined;
	let failure: unknown;
	try {
		// The existing SQLite exclusive-ownership pattern; no table or second selection store.
		database.exec(
			"PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; PRAGMA user_version=1; COMMIT;",
		);
		if (process.ppid !== parentPid) throw new Error("Base-Context activation worker lost its original parent.");
		const current = assertSelection(root, expected);
		const selection: InstallSelection = {
			generation: randomUUID(),
			active: version,
			previous: current?.active ?? null,
		};
		const result: OwnedActivation = { selection, installation: ownedVersion(root, version) };
		const bin = join(root, "bin");
		mkdirSync(bin, { recursive: true, mode: 0o700 });
		const loader = join(root, "launcher.cjs");
		publishFirstLauncher(loader, launcherSource(), 0o600);
		for (const [name, installer] of [
			[PRODUCT.command, false],
			[`${PRODUCT.command}-install`, true],
		] as const) {
			const launcher = join(bin, name);
			publishFirstLauncher(
				launcher,
				`#!/bin/sh\nexec node ${shellQuote(loader)} ${installer ? "install" : "cli"} "$@"\n`,
				0o755,
			);
		}
		const pending = join(root, `current-${selection.generation}.json`);
		writeFileSync(pending, `${JSON.stringify(selection)}\n`, { flag: "wx", mode: 0o600 });
		if (process.ppid !== parentPid) throw new Error("Base-Context activation worker lost its original parent.");
		renameSync(pending, join(root, "current.json"));
		activation = result;
	} catch (error) {
		failure = error;
	}
	try {
		database.close();
	} catch (cleanupError) {
		if (activation) throw new OwnedInstallActivatedError(activation, cleanupError);
		if (failure)
			throw new AggregateError(
				[failure, cleanupError],
				`Base-Context activation failed (${failure instanceof Error ? failure.message : String(failure)}); mutex cleanup also failed (${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}).`,
			);
		throw cleanupError;
	}
	if (activation) return activation;
	throw failure;
}

function captureActivationOwner(
	executable = "bun" in process.versions ? "node" : process.execPath,
): (root: string, expected: InstallSelection | null, version: string) => OwnedActivation {
	const parentPid = process.pid;
	const env = {
		PATH: process.env.PATH,
		HOME: homedir(),
		TMPDIR: tmpdir(),
		SYSTEMROOT: process.env.SYSTEMROOT,
		WINDIR: process.env.WINDIR,
	};
	const candidates = [
		fileURLToPath(new URL("./owned-install-worker.js", import.meta.url)),
		fileURLToPath(new URL("./owned-install-worker.ts", import.meta.url)),
		join(getPhysicalPackageDir(), "dist", "owned-install-worker.js"),
		join(dirname(process.execPath), "owned-install-worker.js"),
	];
	const entrypoint = candidates.find((candidate) => existsSync(candidate));
	if (!entrypoint) throw new Error("Base-Context activation worker payload is missing; activation was not attempted.");
	const args = [
		"--experimental-sqlite",
		"--disable-warning=ExperimentalWarning",
		...(entrypoint.endsWith(".ts") ? ["--import", import.meta.resolve("tsx")] : []),
		entrypoint,
	];
	return (root, expected, version) => {
		const result = spawnSync(executable, [...args, JSON.stringify({ root, expected, version, parentPid })], {
			env,
			cwd: root,
			encoding: "utf8",
			timeout: 10_000,
			maxBuffer: 64 * 1024,
		});
		const failures: Error[] = [];
		let selection: InstallSelection | null = null;
		try {
			const reply: unknown = JSON.parse(result.stdout ?? "");
			if (!reply || typeof reply !== "object" || !("selection" in reply))
				throw new Error("Invalid activation reply");
			const selected = parseInstallSelection(JSON.stringify(reply.selection) ?? "");
			if (selected && selected.active !== version) throw new Error("Activation reply does not match its candidate");
			selection = selected;
			if (!("failures" in reply) || !Array.isArray(reply.failures)) throw new Error("Invalid activation failures");
			for (const item of reply.failures as unknown[]) {
				if (
					!item ||
					typeof item !== "object" ||
					!("name" in item) ||
					typeof item.name !== "string" ||
					!("message" in item) ||
					typeof item.message !== "string"
				)
					throw new Error("Invalid activation failure");
				failures.push(
					Object.assign(new Error(item.message), {
						name: item.name,
						...("code" in item && typeof item.code === "string" ? { code: item.code } : {}),
					}),
				);
			}
		} catch (error) {
			failures.push(
				new Error(
					`Base-Context activation helper result is uncertain: ${error instanceof Error ? error.message : String(error)}. Retained files were not deleted or rolled back. ${result.stderr ?? ""}`,
					{ cause: error },
				),
			);
		}
		if (result.error) failures.push(result.error);
		if (result.signal)
			failures.push(new Error(`Base-Context activation helper exited on ${result.signal}. ${result.stderr ?? ""}`));
		if (result.status !== 0 && failures.length === 0)
			failures.push(
				new Error(`Base-Context activation helper exited with status ${result.status}. ${result.stderr ?? ""}`),
			);
		const activation = selection ? { selection, installation: ownedVersion(root, version) } : undefined;
		if (failures.length > 0) {
			const failure =
				failures.length === 1
					? failures[0]
					: new AggregateError(failures, failures.map((error) => error.message).join("; "));
			if (activation) throw new OwnedInstallActivatedError(activation, failure);
			throw failure;
		}
		if (!activation)
			throw new Error(
				"Base-Context activation helper returned no accepted selection; outcome is uncertain. Retained files were not deleted or rolled back.",
			);
		return activation;
	};
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<void> {
	return new Promise((resolveRun, reject) => {
		const child = spawn(command, args, { env, cwd, stdio: "inherit" });
		child.on("error", reject);
		child.on("close", (code, signal) => {
			if (code === 0) resolveRun();
			else reject(new Error(`Base-Context preparation failed: ${command} (${signal ?? `exit ${code}`}).`));
		});
	});
}

export async function installOwnedRelease(options: {
	root: string;
	expected: InstallSelection | null;
	installSpec: string;
	version: string;
}): Promise<OwnedActivation> {
	const { root: rootInput, expected: expectedInput, installSpec, version } = options;
	const expected = expectedInput ? { ...expectedInput } : null;
	const root = resolve(rootInput);
	const executable = "bun" in process.versions ? "node" : process.execPath;
	const environment = { ...process.env };
	const activate = captureActivationOwner(executable);
	assertSelection(root, expected);
	initializeRoot(root);
	const installation = ownedVersion(root, `${version}-${randomUUID()}`);
	const directory = join(root, "versions", installation.version);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	delete environment[PRODUCT_ENV.kernelPython];
	delete environment[PRODUCT_ENV.kernelVenv];
	delete environment[PRODUCT_ENV.packageDirectory];
	delete environment.PYTHONHOME;
	delete environment.PYTHONPATH;
	environment.BASE_CONTEXT_BOOTSTRAP_KERNEL_ON_INSTALL = "0";
	environment.BASE_CONTEXT_BOOTSTRAP_TOOLS_ON_INSTALL = "0";
	// Local prefix only; keep dependency build scripts, but disable this package's optional bootstrap.
	await run(
		"npm",
		[
			"install",
			"--prefix",
			directory,
			"--global=false",
			"--no-save",
			"--package-lock=false",
			`--allow-scripts=${installSpec}`,
			"--engine-strict",
			"--no-fund",
			"--no-audit",
			"--allow-remote=all",
			"--",
			installSpec,
		],
		environment,
		directory,
	);
	const manifest: unknown = JSON.parse(readFileSync(join(installation.packageDir, "package.json"), "utf8"));
	if (
		!manifest ||
		typeof manifest !== "object" ||
		!("name" in manifest) ||
		manifest.name !== PRODUCT.packageName ||
		!("version" in manifest) ||
		manifest.version !== version
	) {
		throw new Error("The prepared package is not the requested Base-Context release.");
	}
	if (
		!existsSync(installedCli(installation)) ||
		!existsSync(join(installation.packageDir, "dist", PRODUCT.runtimeDistribution, "pyproject.toml"))
	) {
		throw new Error("The Base-Context candidate is missing its CLI or shipped Python payload.");
	}
	environment[PRODUCT_ENV.installUv] = "1";
	await run(executable, [join(installation.packageDir, "dist", "installer.mjs"), "prepare"], environment, directory);
	if (!existsSync(join(installation.runtimeDir, "bin", "python")))
		throw new Error("The Base-Context candidate did not prepare its release-local Python runtime.");
	return activate(root, expected, installation.version);
}

export function rollbackOwnedRelease(root: string, expected: InstallSelection): OwnedActivation {
	const activate = captureActivationOwner();
	const current = assertSelection(root, expected);
	initializeRoot(root);
	if (!current?.previous) throw new Error("There is no previous Base-Context version to select.");
	const previous = ownedVersion(root, current.previous);
	if (!existsSync(installedCli(previous)) || !existsSync(join(previous.runtimeDir, "bin", "python"))) {
		throw new Error("The retained Base-Context executable/runtime pair is missing. No rollback was attempted.");
	}
	return activate(root, current, current.previous);
}
