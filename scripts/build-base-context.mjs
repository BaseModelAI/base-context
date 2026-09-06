#!/usr/bin/env node
// Builds the checked-in source graph. Model discovery is an explicit, separate operation.
import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binSuffix = process.platform === "win32" ? ".cmd" : "";
function run(command, args) {
	const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}

const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
const changes = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
const buildInfo = {
	sourceCommit: commit.status === 0 ? commit.stdout.trim() : null,
	sourceDirty: changes.status === 0 ? changes.stdout.trim().length > 0 : null,
};

for (const name of ["tui", "ai", "agent", "coding-agent"]) {
	const directory = join(root, "packages", name);
	rmSync(join(directory, "dist"), { recursive: true, force: true });
	run(join(root, "node_modules", ".bin", `tsgo${binSuffix}`), ["-p", join(directory, "tsconfig.build.json")]);
	for (const notice of ["LICENSE", "NOTICE"]) copyFileSync(join(root, notice), join(directory, "dist", notice));
	writeFileSync(join(directory, "dist", "build-info.json"), `${JSON.stringify(buildInfo, null, 2)}\n`);
}
const codingPackage = JSON.parse(readFileSync(join(root, "packages", "coding-agent", "package.json"), "utf8"));
run(`npm${binSuffix}`, ["run", "copy-assets", `--workspace=${codingPackage.name}`]);
run(`npm${binSuffix}`, ["run", "bundle", `--workspace=${codingPackage.name}`]);
