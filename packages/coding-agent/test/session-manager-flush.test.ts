import {
	appendFileSync,
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionJournalOwner } from "../src/core/session-journal-owner.js";
import { loadEntriesFromFile, SessionManager } from "../src/core/session-manager.js";

const tempDirs: string[] = [];
const managers: SessionManager[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(managers.splice(0).map((manager) => manager.close()));
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "base-flush-test-"));
	tempDirs.push(dir);
	return dir;
}
async function createManager(): Promise<SessionManager> {
	const dir = createTempDir();
	const manager = await SessionManager.create(dir, join(dir, "sessions"));
	managers.push(manager);
	return manager;
}
const assistant = {
	role: "assistant" as const,
	content: [{ type: "text" as const, text: "hello" }],
	api: "openai-completions" as const,
	provider: "openai",
	model: "test",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop" as const,
	timestamp: 1,
};

// Boundary fault injection, not a claim that a real filesystem ran out of space.
function rejectNextAppend(): void {
	vi.spyOn(SessionJournalOwner.prototype, "appendJson").mockRejectedValueOnce(new Error("owner rejected append"));
}
function loseNextAcknowledgement(): void {
	const append = SessionJournalOwner.prototype.appendJson;
	vi.spyOn(SessionJournalOwner.prototype, "appendJson").mockImplementationOnce(async function (
		this: SessionJournalOwner,
		json,
	) {
		await append.call(this, json);
		throw new Error("append acknowledgement lost");
	});
}

describe("SessionManager.flushNow", () => {
	it("acknowledges pre-assistant entries before flush returns", async () => {
		const manager = await createManager();
		await manager.appendCustomEntry("thread_goal_state", { active: true, status: "active" });
		await manager.flushNow();
		const entries = loadEntriesFromFile(manager.getSessionFile()!);
		expect(entries).toHaveLength(2);
		expect(entries[0].type).toBe("session");
		expect(entries[1]).toMatchObject({
			type: "custom",
			customType: "thread_goal_state",
			data: { active: true, status: "active" },
		});
	});

	it("leaves acknowledged bytes and view unchanged when the owner rejects an append", async () => {
		const manager = await createManager();
		await manager.appendCustomEntry("before_failure");
		const file = manager.getSessionFile()!;
		const before = readFileSync(file);
		const leaf = manager.getLeafId();
		rejectNextAppend();
		await expect(manager.appendMessage({ role: "user", content: "pending", timestamp: 1 })).rejects.toThrow(
			"owner rejected",
		);
		expect(readFileSync(file)).toEqual(before);
		expect(manager.getLeafId()).toBe(leaf);
	});

	it("preserves inode and file metadata by appending rather than replacing", async () => {
		const manager = await createManager();
		const file = manager.getSessionFile()!;
		chmodSync(file, 0o660);
		const before = statSync(file);
		await manager.appendMessage({ role: "user", content: "pending", timestamp: 1 });
		await manager.flushNow();
		const after = statSync(file);
		expect({ ino: after.ino, mode: after.mode, uid: after.uid, gid: after.gid }).toEqual({
			ino: before.ino,
			mode: before.mode,
			uid: before.uid,
			gid: before.gid,
		});
	});

	it("refuses a second writer without touching the live source", async () => {
		const manager = await createManager();
		const file = manager.getSessionFile()!;
		const before = readFileSync(file);
		await expect(SessionManager.open(file)).rejects.toThrow();
		expect(readFileSync(file)).toEqual(before);
		await manager.appendCustomEntry("still_owned");
	});

	it("opens a cross-directory alias without replacing or implicitly migrating its target", async () => {
		const dir = createTempDir();
		mkdirSync(join(dir, "targets"));
		mkdirSync(join(dir, "aliases"));
		const target = join(dir, "targets", "session.jsonl");
		const alias = join(dir, "aliases", "session.jsonl");
		const original = `${JSON.stringify({
			type: "session",
			version: 2,
			id: "symlink-session",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: dir,
		})}\n`;
		writeFileSync(target, original);
		chmodSync(target, 0o640);
		symlinkSync(target, alias);
		const manager = await SessionManager.open(alias);
		managers.push(manager);
		expect(manager.getSessionFile()).toBe(target); // Published references bind the actual owner, not a movable alias.
		expect(manager.getHeader()?.version).toBe(3); // Local legacy view only.
		expect(lstatSync(alias).isSymbolicLink()).toBe(true);
		expect(readFileSync(target, "utf8")).toBe(original);
		expect(statSync(target).mode & 0o777).toBe(0o640);
	});

	it("keeps ephemeral sessions off disk", async () => {
		const manager = SessionManager.inMemory("/tmp");
		await manager.appendCustomEntry("thread_goal_state", { active: true });
		await manager.flushNow();
		expect(manager.getSessionFile()).toBeUndefined();
	});

	it("preserves the parent chain through pre-assistant and later entries", async () => {
		const manager = await createManager();
		const custom = await manager.appendCustomEntry("thread_goal_state", { active: true });
		await manager.flushNow();
		const user = await manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		const answer = await manager.appendMessage(assistant);
		const entries = loadEntriesFromFile(manager.getSessionFile()!);
		expect(entries).toHaveLength(4);
		expect(entries[1]).toMatchObject({ id: custom, parentId: null });
		expect(entries[2]).toMatchObject({ id: user, parentId: custom });
		expect(entries[3]).toMatchObject({ id: answer, parentId: user });
	});

	it("does not rewrite an acknowledged prefix when flushing a later entry", async () => {
		const manager = await createManager();
		await manager.appendMessage(assistant);
		const file = manager.getSessionFile()!;
		const before = readFileSync(file);
		const inode = statSync(file).ino;
		await manager.appendCustomEntry("thread_goal_state", { active: true });
		await manager.flushNow();
		expect(statSync(file).ino).toBe(inode);
		expect(readFileSync(file).subarray(0, before.length)).toEqual(before);
		expect(loadEntriesFromFile(file).at(-1)).toMatchObject({ type: "custom", customType: "thread_goal_state" });
	});
});

describe("SessionManager acknowledged custom entries", () => {
	it("acknowledges rollback-aware value entries immediately", async () => {
		const manager = await createManager();
		await manager.appendCustomEntryWithRollback("rlm_max_depth_state", { maxDepth: 2 });
		expect(loadEntriesFromFile(manager.getSessionFile()!).at(-1)).toMatchObject({
			type: "custom",
			customType: "rlm_max_depth_state",
			data: { maxDepth: 2 },
		});
	});

	it("acknowledges custom messages before the first assistant response", async () => {
		const manager = await createManager();
		await manager.appendCustomMessageEntryWithRollback("compaction_outcome", "failed early", true);
		expect(loadEntriesFromFile(manager.getSessionFile()!).at(-1)).toMatchObject({
			type: "custom_message",
			customType: "compaction_outcome",
		});
	});

	it("does not erase a committed record after losing its acknowledgement", async () => {
		const manager = await createManager();
		const file = manager.getSessionFile()!;
		const before = readFileSync(file);
		loseNextAcknowledgement();
		await expect(manager.appendCustomMessageEntryWithRollback("test.outcome", "details", false)).rejects.toThrow(
			"acknowledgement lost",
		);
		expect(readFileSync(file).subarray(0, before.length)).toEqual(before);
		expect(loadEntriesFromFile(file).at(-1)).toMatchObject({ type: "custom_message", customType: "test.outcome" });
	});

	it("does not publish the unacknowledged entry into the current view", async () => {
		const manager = await createManager();
		await manager.appendMessage(assistant);
		const leaf = manager.getLeafId();
		const entries = manager.getEntries();
		loseNextAcknowledgement();
		await expect(manager.appendCustomMessageEntryWithRollback("test.outcome", "details", false)).rejects.toThrow(
			"acknowledgement lost",
		);
		expect(manager.getLeafId()).toBe(leaf);
		expect(manager.getEntries()).toEqual(entries);
	});

	it("refuses blind retries and repairs a torn tail only under a new owned recovery", async () => {
		const manager = await createManager();
		const file = manager.getSessionFile()!;
		const before = readFileSync(file);
		appendFileSync(file, '{"truncated":'); // Explicit external corruption fixture.
		await expect(manager.appendCustomMessageEntryWithRollback("test.outcome", "details", false)).rejects.toThrow();
		const damaged = readFileSync(file);
		await expect(manager.flushNow()).rejects.toThrow("outcome may be unknown");
		await manager.close();
		const reopened = await SessionManager.open(file);
		managers.push(reopened);
		await expect(reopened.appendSessionInfo("must not append")).rejects.toThrow();
		expect(readFileSync(file)).toEqual(damaged);
		await reopened.recover();
		expect(readFileSync(file)).toEqual(before);
		await reopened.appendSessionInfo("recovered");
		expect(reopened.getSessionName()).toBe("recovered");
	});
});
