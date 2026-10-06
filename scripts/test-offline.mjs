#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { credentialTests, kernelTests, processStressTests } from "./test-suites.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packages = ["agent", "ai", "coding-agent", "tui"];
const args = process.argv.slice(2);
const selected = args.find((arg) => !arg.startsWith("--"));
const group = args.find((arg) => arg.startsWith("--group="))?.split("=")[1];
const shard = args.find((arg) => arg.startsWith("--shard="))?.split("=")[1] ?? "1/1";
const [part, count] = shard.split("/").map(Number);
if ((selected && !packages.includes(selected)) || !Number.isInteger(part) || !Number.isInteger(count) || part < 1 || part > count || (group && !["kernel", "process-stress"].includes(group))) {
	throw new Error("Usage: node scripts/test-offline.mjs [agent|ai|coding-agent|tui] [--shard=1/8] [--group=kernel|process-stress] [--list]");
}
function testFiles(directory, prefix = "test") {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const name = `${prefix}/${entry.name}`;
		return entry.isDirectory() ? testFiles(join(directory, entry.name), name) : entry.name.endsWith(".test.ts") ? [name] : [];
	}).sort();
}
function run(command, commandArgs, cwd, env) {
	console.log(`\n${cwd}: ${command} ${commandArgs.join(" ")}`);
	return new Promise((done, reject) => {
		const child = spawn(command, commandArgs, { cwd, env, stdio: "inherit" });
		child.on("error", reject);
		child.on("exit", (code, signal) => signal ? reject(new Error(`Test process stopped by ${signal}`)) : done(code ?? 1));
	});
}
const home = mkdtempSync(join(tmpdir(), "base-context-offline-"));
const env = {};
for (const key of ["PATH", "LANG", "LC_ALL", "TERM", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "UV_CACHE_DIR", "UV_PYTHON_INSTALL_DIR", "UV_OFFLINE", "UV_PYTHON_DOWNLOADS", "NPM_CONFIG_CACHE"]) {
	if (process.env[key] !== undefined) env[key] = process.env[key];
}
env.HOME = home;
env.USERPROFILE = home;
env.BASE_CONTEXT_HOME = join(home, "state");
env.CI = "1";
env.UV_CACHE_DIR ??= join(homedir(), ".cache", "uv");
env.UV_PYTHON_INSTALL_DIR ??= join(homedir(), ".local", "share", "uv", "python");
const tsx = join(root, "node_modules", "tsx", "dist", "cli.mjs");
const vitest = join(root, "node_modules", "vitest", "dist", "cli.js");
let status = 0;
try {
	for (const pkg of selected ? [selected] : packages) {
		if (group && pkg !== "coding-agent") continue;
		const cwd = join(root, "packages", pkg);
		const excluded = new Set(credentialTests[pkg] ?? []);
		const available = group === "kernel" ? kernelTests : group === "process-stress" ? processStressTests : testFiles(join(cwd, "test"));
		const files = available.filter((file) => !excluded.has(file)).filter((_, index) => index % count === part - 1);
		if (args.includes("--list")) {
			console.log(`${pkg}:\n${files.join("\n")}`);
			continue;
		}
		if (!files.length) throw new Error(`No offline tests selected for ${pkg}, shard ${shard}`);
		if (pkg === "coding-agent") {
			const code = await run(process.execPath, [tsx, join(root, "scripts", "bootstrap-test-kernel.mjs")], cwd, env);
			if (code) { status = code; break; }
			env.BASE_CONTEXT_KERNEL_PYTHON = join(env.BASE_CONTEXT_HOME, "runtime", "bin", "python");
		}
		const offlineEnv = { ...env, NODE_OPTIONS: `--require=${join(root, "scripts", "offline-network.cjs")}` };
		const commandArgs = pkg === "tui"
			? ["--import", "tsx", "--test", "--test-concurrency=2", ...files]
			: [tsx, vitest, "--run", "--maxWorkers=2", ...(group ? ["--tagsFilter", group === "kernel" ? "kernel-heavy" : "process-stress", "--no-file-parallelism"] : []), ...files];
		const code = await run(process.execPath, commandArgs, cwd, offlineEnv);
		status = code || status;
	}
} finally {
	rmSync(home, { recursive: true, force: true });
}
process.exitCode = status;
