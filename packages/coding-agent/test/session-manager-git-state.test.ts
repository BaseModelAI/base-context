import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeJournalFrame, INITIAL_JOURNAL_CURSOR } from "../src/core/journal-frame.js";
import * as sessionJournalReader from "../src/core/session-journal-reader.js";
import { loadEntriesFromFile, SessionManager } from "../src/core/session-manager.js";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(dir: string, message: string): string {
	writeFileSync(join(dir, "file.txt"), `${message}\n`);
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", message);
	return git(dir, "rev-parse", "HEAD");
}

describe("SessionManager git state", () => {
	let repoDir: string;
	let sessionDir: string;
	let firstSha: string;
	let managers: SessionManager[];

	async function createSession(): Promise<SessionManager> {
		const manager = await SessionManager.create(repoDir, sessionDir);
		managers.push(manager);
		return manager;
	}

	beforeEach(() => {
		managers = [];
		repoDir = mkdtempSync(join(tmpdir(), "sm-git-repo-"));
		sessionDir = mkdtempSync(join(tmpdir(), "sm-git-sessions-"));
		git(repoDir, "init", "-q", "-b", "main");
		git(repoDir, "config", "user.email", "t@t.co");
		git(repoDir, "config", "user.name", "t");
		git(repoDir, "remote", "add", "origin", "https://github.com/acme/widgets.git");
		firstSha = commit(repoDir, "init");
	});

	afterEach(async () => {
		await Promise.all(managers.map((manager) => manager.close()));
		rmSync(repoDir, { recursive: true, force: true });
		rmSync(sessionDir, { recursive: true, force: true });
	});

	it("captures git context in the session header", async () => {
		const sm = await createSession();
		expect(sm.getHeader()?.git).toEqual({
			branch: "main",
			commit: firstSha,
			repoUrl: "https://github.com/acme/widgets.git",
		});
	});

	it("does not record a git_state entry when nothing changed", async () => {
		const sm = await createSession();
		expect(await sm.recordGitStateIfChanged()).toBeUndefined();
		expect(sm.getEntries().some((e) => e.type === "git_state")).toBe(false);
	});

	it("records a git_state entry when the commit changes", async () => {
		const sm = await createSession();
		const secondSha = commit(repoDir, "second");

		const id = await sm.recordGitStateIfChanged();
		expect(id).toBeDefined();

		const entry = sm.getEntries().find((e) => e.type === "git_state");
		expect(entry).toMatchObject({ type: "git_state", git: { commit: secondSha } });

		expect(await sm.recordGitStateIfChanged()).toBeUndefined();
	});

	it("re-records git state on a branch that lacks it on its active path", async () => {
		const sm = await createSession();
		const msgId = await sm.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 });
		commit(repoDir, "second");

		expect(await sm.recordGitStateIfChanged()).toBeDefined();

		// Navigate to before that entry: this branch's nearest git context is the header (firstSha),
		// so even though the file already holds a git_state for the live commit, a new one must be
		// appended on this path rather than deduped away.
		sm.branch(msgId);
		expect(await sm.recordGitStateIfChanged()).toBeDefined();
	});

	it("captures git context in a forked session header", async () => {
		const sm = await createSession();
		const msgId = await sm.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 });
		await sm.createBranchedSession(msgId);
		expect(sm.getHeader()?.git).toEqual({
			branch: "main",
			commit: firstSha,
			repoUrl: "https://github.com/acme/widgets.git",
		});
	});

	it("captures target git context when forking and drops the source's git_state", async () => {
		const sourcePath = join(sessionDir, "source.jsonl");
		const usage = (input: number) => ({
			input,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: input,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		const rows = [
			{
				type: "session",
				version: 3,
				id: "src",
				timestamp: "t",
				cwd: "/old",
				rlmDepth: 2,
				git: { repoUrl: "https://github.com/acme/source.git", commit: "sourcesha", branch: "main" },
			},
			{
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: "t",
				message: { role: "user", content: "hi", timestamp: 1 },
			},
			{
				type: "git_state",
				id: "g1",
				parentId: "m1",
				timestamp: "t",
				git: { repoUrl: "https://github.com/acme/source.git", commit: "sourcesha", branch: "main" },
			},
			...[10, 20].map((input) => ({
				type: "child_usage_attributed",
				id: `usage-${input}`,
				parentId: "g2",
				timestamp: "t",
				targetId: "m2",
				childUsage: usage(input),
				aggregateUsage: usage(input + 1),
			})),
			{
				type: "message",
				id: "m2",
				parentId: "g2",
				timestamp: "t",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "more" }],
					api: "openai-responses",
					provider: "openai",
					model: "gpt-5.4",
					usage: usage(1),
					stopReason: "stop",
					timestamp: 2,
				},
			},
			{
				type: "git_state",
				id: "g2",
				parentId: "g1",
				timestamp: "t",
				git: { repoUrl: "https://github.com/acme/source.git", commit: "later-sha", branch: "main" },
			},
		];
		let cursor = INITIAL_JOURNAL_CURSOR;
		const source = rows
			.map((row) => {
				const frame = encodeJournalFrame(
					row,
					cursor,
					64 * 1024,
					row.id === "src" || row.id === "m2" ? "retained-import" : undefined,
				);
				cursor = frame.next;
				return frame.line;
			})
			.join("");
		writeFileSync(sourcePath, source);

		const reader = vi.spyOn(sessionJournalReader, "readSessionJournal");
		let forked: SessionManager;
		try {
			forked = await SessionManager.forkFrom(sourcePath, repoDir, sessionDir);
			managers.push(forked);
			expect(reader).toHaveBeenCalledTimes(1);
			expect(reader).toHaveBeenCalledWith(sourcePath);
		} finally {
			reader.mockRestore();
		}

		expect(forked.getHeader()).toMatchObject({ parentSession: sourcePath, rlmDepth: 2 });
		expect(forked.getHeader()?.git).toEqual({
			branch: "main",
			commit: firstSha,
			repoUrl: "https://github.com/acme/widgets.git",
		});
		// Source git_state is dropped and its children re-linked to keep the tree intact.
		const entries = forked.getEntries();
		expect(entries.map((entry) => [entry.id, entry.parentId])).toEqual([
			["m1", null],
			["usage-10", "m1"],
			["usage-20", "m1"],
			["m2", "m1"],
		]);
		expect(forked.getEntryRetention("m1")).toBeUndefined();
		expect(forked.getEntryRetention("m2")).toBe("retained-import");
		expect(forked.getEntry("m2")).toMatchObject({ message: { usage: usage(21) } });
		const persisted = loadEntriesFromFile(forked.getSessionFile()!);
		expect(persisted.find((entry) => entry.id === "m2")).toMatchObject({
			parentId: "m1",
			message: { usage: usage(21) },
		});
		const imported = await SessionManager.importRetainedFrom(sourcePath, repoDir, sessionDir);
		managers.push(imported);
		expect(imported.getEntryRetention("m1")).toBe("retained-import");
		expect(imported.getEntryRetention("m2")).toBe("retained-import");
		expect(imported.getEntry("m2")).toMatchObject({ parentId: "m1", message: { usage: usage(21) } });
		expect(readFileSync(sourcePath, "utf8")).toBe(source);
	});

	it("keeps git_state entries out of the LLM context", async () => {
		const sm = await createSession();
		commit(repoDir, "second");
		await sm.recordGitStateIfChanged();
		expect(sm.buildSessionContext().messages).toHaveLength(0);
	});
});
