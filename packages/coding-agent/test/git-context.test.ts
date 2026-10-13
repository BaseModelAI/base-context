import * as childProcess from "node:child_process";
import { ChildProcess, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureGitContext, gitContextsEqual } from "../src/utils/git.js";

vi.mock("node:child_process", async (importOriginal) => ({ ...(await importOriginal<typeof childProcess>()) }));

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(dir: string): void {
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.email", "t@t.co");
	git(dir, "config", "user.name", "t");
}

function commit(dir: string, message: string): string {
	writeFileSync(join(dir, "file.txt"), `${message}\n`);
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", message);
	return git(dir, "rev-parse", "HEAD");
}

describe("captureGitContext", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "git-context-"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(dir, { recursive: true, force: true });
	});

	it("starts all Git probes before any completes", async () => {
		const callbacks: NonNullable<Parameters<typeof childProcess.execFile>[3]>[] = [];
		const probe = vi.spyOn(childProcess, "execFile").mockImplementation((_file, _args, _options, callback) => {
			callbacks.push(callback!);
			return new ChildProcess();
		});
		const capture = captureGitContext(dir);
		expect(probe.mock.calls.map(([file, args, options]) => [file, args, options])).toEqual([
			["git", ["--no-optional-locks", "rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }],
			["git", ["--no-optional-locks", "branch", "--show-current"], { cwd: dir, encoding: "utf8" }],
			["git", ["--no-optional-locks", "remote", "get-url", "origin"], { cwd: dir, encoding: "utf8" }],
		]);
		callbacks[2](null, "https://github.com/acme/widgets.git\n", "");
		callbacks[0](null, "commit-sha\n", "");
		callbacks[1](null, "main\n", "");
		expect(await capture).toEqual({
			commit: "commit-sha",
			branch: "main",
			repoUrl: "https://github.com/acme/widgets.git",
		});
	});

	it("reads branch, commit, and normalized repo url", async () => {
		initRepo(dir);
		git(dir, "remote", "add", "origin", "https://github.com/acme/widgets.git");
		const sha = commit(dir, "init");

		expect(await captureGitContext(dir)).toEqual({
			branch: "main",
			commit: sha,
			repoUrl: "https://github.com/acme/widgets.git",
		});
	});

	it("reports a detached HEAD as a commit with no branch", async () => {
		initRepo(dir);
		const sha = commit(dir, "init");
		git(dir, "checkout", "-q", sha);

		const ctx = await captureGitContext(dir);
		expect(ctx?.commit).toBe(sha);
		expect(ctx?.branch).toBeUndefined();
	});

	it("omits repo url when there is no origin remote", async () => {
		initRepo(dir);
		const sha = commit(dir, "init");

		const ctx = await captureGitContext(dir);
		expect(ctx?.repoUrl).toBeUndefined();
		expect(ctx?.commit).toBe(sha);
	});

	it("keeps an ssh remote url verbatim when it cannot be normalized", async () => {
		initRepo(dir);
		git(dir, "remote", "add", "origin", "git@github.com:acme/widgets.git");
		commit(dir, "init");

		expect((await captureGitContext(dir))?.repoUrl).toBe("git@github.com:acme/widgets.git");
	});

	it("returns null outside a git repo", async () => {
		expect(await captureGitContext(dir)).toBeNull();
	});
});

describe("gitContextsEqual", () => {
	const SHA = "0123456789abcdef0123456789abcdef01234567";
	const SHA2 = "89abcdef0123456789abcdef0123456789abcdef";

	it("compares all fields", () => {
		expect(gitContextsEqual({ commit: SHA, branch: "main" }, { commit: SHA, branch: "main" })).toBe(true);
		expect(gitContextsEqual({ commit: SHA, branch: "main" }, { commit: SHA2, branch: "main" })).toBe(false);
		expect(gitContextsEqual({ commit: SHA }, { commit: SHA, branch: "main" })).toBe(false);
	});
});
