#!/usr/bin/env node
// Builds the checked-in source graph. Model discovery is an explicit, separate operation.
import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binSuffix = process.platform === "win32" ? ".cmd" : "";
const npmExecutable = `npm${binSuffix}`;
const compilerExecutable = join(root, "node_modules", ".bin", `tsgo${binSuffix}`);
const requireFromBundle = createRequire(join(root, "packages", "coding-agent", "scripts", "bundle.mjs"));
function run(command, args, captureStdout = false) {
	const result = spawnSync(command, args, {
		cwd: root,
		stdio: captureStdout ? ["inherit", "pipe", "inherit"] : "inherit",
		encoding: "utf8",
		shell: process.platform === "win32",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
	if (captureStdout) return result.stdout.trim();
}

const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
const changes = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
const buildInfo = {
	sourceCommit: commit.status === 0 ? commit.stdout.trim() : null,
	sourceDirty: changes.status === 0 ? changes.stdout.trim().length > 0 : null,
	buildHost: { platform: process.platform, arch: process.arch },
	toolchain: {
		node: process.version,
		npm: run(npmExecutable, ["--version"], true),
		tsgo: run(compilerExecutable, ["--version"], true),
		esbuild: JSON.parse(readFileSync(requireFromBundle.resolve("esbuild/package.json"), "utf8")).version,
	},
};

for (const name of ["tui", "ai", "agent", "coding-agent"]) {
	const directory = join(root, "packages", name);
	rmSync(join(directory, "dist"), { recursive: true, force: true });
	run(compilerExecutable, ["-p", join(directory, "tsconfig.build.json")]);
	for (const notice of ["LICENSE", "NOTICE"]) copyFileSync(join(root, notice), join(directory, "dist", notice));
	writeFileSync(join(directory, "dist", "build-info.json"), `${JSON.stringify(buildInfo, null, 2)}\n`);
}
const codingPackage = JSON.parse(readFileSync(join(root, "packages", "coding-agent", "package.json"), "utf8"));
run(npmExecutable, ["run", "copy-assets", `--workspace=${codingPackage.name}`]);
run(npmExecutable, ["run", "bundle", `--workspace=${codingPackage.name}`]);
