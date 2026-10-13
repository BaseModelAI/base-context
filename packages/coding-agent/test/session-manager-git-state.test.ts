import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeJournalFrame, INITIAL_JOURNAL_CURSOR } from "../src/core/journal-frame.js";
import { SessionJournalOwner } from "../src/core/session-journal-owner.js";
import * as sessionJournalReader from "../src/core/session-journal-reader.js";
import { buildSessionContext, loadEntriesFromFile, SessionManager } from "../src/core/session-manager.js";
import * as gitContext from "../src/utils/git.js";

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
		vi.restoreAllMocks();
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

	it("keeps memory sessions probe-free and captures before materializing their header", async () => {
		let release!: (git: gitContext.GitContext) => void;
		const capture = vi.spyOn(gitContext, "captureGitContext").mockImplementation(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		const sm = SessionManager.inMemory(repoDir, sessionDir);
		managers.push(sm);
		await sm.recordGitStateIfChanged();
		expect(capture).not.toHaveBeenCalled();
		await sm.appendMessage({ role: "user", content: "memory message", timestamp: 1 });
		const materializing = sm.materializeSessionFile();
		await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
		expect(readdirSync(sessionDir)).toEqual([]);
		release({ commit: "prepared", branch: "main" });
		const path = await materializing;
		expect(loadEntriesFromFile(path)[0]).toMatchObject({ git: { commit: "prepared", branch: "main" } });
	});

	it("includes async Git context in the fork header budget before opening a file", async () => {
		const sm = await createSession();
		const capture = vi.spyOn(gitContext, "captureGitContext").mockResolvedValue({ repoUrl: "x".repeat(4096) });
		const before = readdirSync(sessionDir);
		await expect(sm.forkBranch(null, { limits: { maxEntries: 4, maxSourceBytes: 2048 } })).rejects.toThrow(
			/budget|limit/i,
		);
		expect(capture).toHaveBeenCalledTimes(1);
		expect(readdirSync(sessionDir)).toEqual(before);
	});

	it("captures outside persistence and deduplicates concurrent captures in write order", async () => {
		const sm = await createSession();
		const releases: ((git: gitContext.GitContext) => void)[] = [];
		vi.spyOn(gitContext, "captureGitContext").mockImplementation(
			() =>
				new Promise((resolve) => {
					releases.push(resolve);
				}),
		);
		const first = sm.recordGitStateIfChanged();
		const second = sm.recordGitStateIfChanged();
		const message = await sm.appendMessage({ role: "user", content: "not blocked by Git", timestamp: 1 });
		expect(sm.getLeafId()).toBe(message);
		for (const release of releases) release({ commit: "second" });
		const results = await Promise.all([first, second]);
		expect(results.filter((id) => id !== undefined)).toHaveLength(1);
		expect((await sm.readEntries()).filter((entry) => entry.type === "git_state")).toHaveLength(1);
	});

	it("discards a capture after source replacement or close", async () => {
		const sm = await createSession();
		let release!: (git: gitContext.GitContext) => void;
		const capture = vi.spyOn(gitContext, "captureGitContext").mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		const recording = sm.recordGitStateIfChanged();
		await sm.newSession();
		release({ commit: "stale" });
		expect(await recording).toBeUndefined();
		expect((await sm.readEntries()).filter((entry) => entry.type === "git_state")).toEqual([]);
		capture.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		const closingCapture = sm.recordGitStateIfChanged();
		await sm.close();
		release({ commit: "closed" });
		expect(await closingCapture).toBeUndefined();
	});

	it("discards a delayed Git capture after a branch summary selects another parent", async () => {
		const sm = await createSession();
		const root = await sm.appendMessage({ role: "user", content: "root", timestamp: 1 });
		await sm.appendMessage({ role: "user", content: "later", timestamp: 2 });
		let release!: (git: gitContext.GitContext) => void;
		vi.spyOn(gitContext, "captureGitContext").mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		const recording = sm.recordGitStateIfChanged();
		const ownsSource = sm.captureCompactionSourceOwner();
		await sm.branchWithSummary(root, "selected the earlier parent");
		release({ commit: "old-branch" });
		expect(await recording).toBeUndefined();
		expect(ownsSource()).toBe(false);
		expect((await sm.readEntries()).filter((entry) => entry.type === "git_state")).toEqual([]);
	});

	it("invalidates resident source ownership only when a branch summary selects another parent", async () => {
		const sm = SessionManager.inMemory(repoDir, sessionDir);
		managers.push(sm);
		const root = await sm.appendMessage({ role: "user", content: "root", timestamp: 1 });
		const ownsSource = sm.captureCompactionSourceOwner();
		await sm.branchWithSummary(root, "continued the current branch");
		expect(ownsSource()).toBe(true);
		await sm.branchWithSummary(root, "selected the earlier parent");
		expect(ownsSource()).toBe(false);
	});

	it("does not adopt a fork after an admitted branch selection changes during the final write drain", async () => {
		const sm = await createSession();
		const root = await sm.appendMessage({ role: "user", content: "root", timestamp: 1 });
		await sm.appendMessage({ role: "user", content: "later", timestamp: 2 });
		const originalId = sm.getSessionId();
		const originalPath = sm.getSessionFile();
		const next = await sm.forkBranch(root);
		managers.push(next);
		vi.spyOn(sm, "forkBranch").mockResolvedValue(next);
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered!: () => void;
		const writing = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const append = SessionJournalOwner.prototype.appendJson;
		vi.spyOn(SessionJournalOwner.prototype, "appendJson").mockImplementation(async function (
			this: SessionJournalOwner,
			json,
			retention,
		) {
			if (this.journalPath === originalPath && JSON.parse(json).type === "branch_summary") {
				entered();
				await blocked;
			}
			return append.call(this, json, retention);
		});
		const selecting = sm.branchWithSummary(root, "selected the earlier parent");
		await writing;
		const flush = vi.spyOn(sm, "flushNow");
		const adopting = sm.createBranchedSession(root);
		const rejected = expect(adopting).rejects.toThrow("Session source or branch changed during fork preparation");
		try {
			await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(1));
		} finally {
			release();
		}
		const selected = await selecting;
		await rejected;
		expect(sm.getSessionId()).toBe(originalId);
		expect(sm.getSessionFile()).toBe(originalPath);
		expect(sm.getLeafId()).toBe(selected);
		await expect(next.appendSessionInfo("closed destination")).rejects.toThrow("closing");
		await sm.appendMessage({ role: "user", content: "original source remains writable", timestamp: 3 });
	});

	it("does not adopt a newly prepared session after close", async () => {
		const sm = await createSession();
		const previous = sm.getSessionId();
		let release!: (git: gitContext.GitContext) => void;
		const capture = vi.spyOn(gitContext, "captureGitContext").mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		const changing = sm.newSession();
		const rejected = expect(changing).rejects.toThrow("closing");
		await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
		await sm.close();
		release({ commit: "after-close" });
		await rejected;
		expect(sm.getSessionId()).toBe(previous);
	});

	it("does not record a git_state entry when nothing changed", async () => {
		const sm = await createSession();
		expect(await sm.recordGitStateIfChanged()).toBeUndefined();
		expect((await sm.readBranch()).some((e) => e.type === "git_state")).toBe(false);
	});

	it("records a git_state entry when the commit changes", async () => {
		const sm = await createSession();
		const secondSha = commit(repoDir, "second");

		const id = await sm.recordGitStateIfChanged();
		expect(id).toBeDefined();

		const entry = (await sm.readBranch()).find((e) => e.type === "git_state");
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
		await sm.branchTo(msgId);
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

		const reader = vi.spyOn(sessionJournalReader, "readCapturedSessionJournal");
		let forked: SessionManager;
		try {
			forked = await SessionManager.forkFrom(sourcePath, repoDir, sessionDir);
			managers.push(forked);
			expect(reader).toHaveBeenCalledTimes(1);
			expect(reader).toHaveBeenCalledWith(sourcePath, expect.any(Function), { requireCompleteTail: false });
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
		const entries = await forked.readEntries();
		expect(entries.map((entry) => [entry.id, entry.parentId])).toEqual([
			["m1", null],
			["usage-10", "m1"],
			["usage-20", "m1"],
			["m2", "m1"],
		]);
		expect(await forked.readEntryRetention("m1")).toBeUndefined();
		expect(await forked.readEntryRetention("m2")).toBe("retained-import");
		expect(await forked.readEntry("m2")).toMatchObject({ message: { usage: usage(21) } });
		const persisted = loadEntriesFromFile(forked.getSessionFile()!);
		expect(persisted.find((entry) => entry.id === "m2")).toMatchObject({
			parentId: "m1",
			message: { usage: usage(21) },
		});
		const imported = await SessionManager.importRetainedFrom(sourcePath, repoDir, sessionDir);
		managers.push(imported);
		expect(await imported.readEntryRetention("m1")).toBe("retained-import");
		expect(await imported.readEntryRetention("m2")).toBe("retained-import");
		expect(await imported.readEntry("m2")).toMatchObject({ parentId: "m1", message: { usage: usage(21) } });
		expect(readFileSync(sourcePath, "utf8")).toBe(source);
	});

	it("keeps git_state entries out of the LLM context", async () => {
		const sm = await createSession();
		commit(repoDir, "second");
		await sm.recordGitStateIfChanged();
		expect(buildSessionContext(await sm.readBranch(), sm.getLeafId()).messages).toHaveLength(0);
	});
});
