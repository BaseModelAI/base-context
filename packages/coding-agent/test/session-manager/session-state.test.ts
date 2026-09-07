import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEntriesFromFile, SessionManager, type SessionStateEntry } from "../../src/core/session-manager.js";
import { inactiveLifecycleForSession } from "../../src/modes/daemon/daemon-session-list.js";
import { assistantMsg, userMsg } from "../utilities.js";

const managers: SessionManager[] = [];
async function createSession(cwd: string, dir: string): Promise<SessionManager> {
	const manager = await SessionManager.create(cwd, dir);
	managers.push(manager);
	return manager;
}
async function openSession(path: string, dir: string): Promise<SessionManager> {
	const manager = await SessionManager.open(path, dir);
	managers.push(manager);
	return manager;
}
// Offline fixture conversion: old state spellings live in a wholly legacy JSONL source.
function appendLegacyState(path: string, status: string): void {
	const entries = loadEntriesFromFile(path);
	const previous = entries[entries.length - 1];
	const entry = {
		type: "session_state",
		id: `legacy-${entries.length}`,
		parentId: previous.type === "session" ? null : previous.id,
		timestamp: new Date().toISOString(),
		state: { status },
	};
	writeFileSync(path, `${[...entries, entry].map((value) => JSON.stringify(value)).join("\n")}\n`);
}

describe("SessionManager session state", () => {
	it("persists lifecycle state and exposes it through list", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = await createSession(cwd, sessionDir);

			await session.appendMessage(userMsg("hello"));
			await session.appendMessage(assistantMsg("hi"));
			await session.appendSessionState({ status: "crash" });

			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();
			expect(existsSync(sessionFile!)).toBe(true);

			const stateEntries = loadEntriesFromFile(sessionFile!).filter(
				(entry): entry is SessionStateEntry => entry.type === "session_state",
			);
			expect(stateEntries).toHaveLength(1);
			expect(stateEntries[0]!.state).toEqual({ status: "crash" });
			expect(session.getSessionState()).toEqual({ status: "crash" });

			const sessions = await SessionManager.list(cwd, sessionDir);
			expect(sessions).toHaveLength(1);
			expect(sessions[0]).toMatchObject({
				id: session.getSessionId(),
				state: { status: "crash" },
			});
		} finally {
			await Promise.all(managers.splice(0).map((manager) => manager.close()));
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("flushes lifecycle state for sessions without assistant messages", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-empty-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = await createSession(cwd, sessionDir);

			await session.appendSessionInfo("empty");
			await session.appendSessionState({ status: "archived" });

			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();
			expect(existsSync(sessionFile!)).toBe(true);

			const sessions = await SessionManager.list(cwd, sessionDir);
			expect(sessions).toHaveLength(1);
			expect(sessions[0]).toMatchObject({
				id: session.getSessionId(),
				name: "empty",
				messageCount: 0,
				state: { status: "archived" },
			});
		} finally {
			await Promise.all(managers.splice(0).map((manager) => manager.close()));
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("persists renamed sessions without assistant messages", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-rename-empty-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = await createSession(cwd, sessionDir);
			await session.appendSessionState({ status: "active" });
			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();

			await session.close();
			await (await openSession(sessionFile!, sessionDir)).appendSessionInfo("Renamed draft");

			await expect(SessionManager.list(cwd, sessionDir)).resolves.toEqual([
				expect.objectContaining({ id: session.getSessionId(), name: "Renamed draft" }),
			]);
		} finally {
			await Promise.all(managers.splice(0).map((manager) => manager.close()));
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("archives a deactivated session that has no prior state entry", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-deactivate-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = await createSession(cwd, sessionDir);
			await session.appendMessage(userMsg("hello"));
			await session.appendMessage(assistantMsg("hi"));
			const sessionFile = session.getSessionFile()!;

			await session.close();
			const reopened = await openSession(sessionFile, sessionDir);
			expect(reopened.getSessionState()).toBeUndefined();
			if (reopened.getSessionState()?.status !== "archived") {
				await reopened.appendSessionState({ status: "archived" });
			}

			const sessions = await SessionManager.list(cwd, sessionDir);
			expect(sessions).toHaveLength(1);
			expect(sessions[0]!.state).toEqual({ status: "archived" });
			expect(inactiveLifecycleForSession(sessions[0]!)).toBe("archived");
		} finally {
			await Promise.all(managers.splice(0).map((manager) => manager.close()));
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	// Guards the agents-view deactivate path: opening a deleted file and appending
	// would recreate a stub session at the old path, so the caller must skip it.
	it("recreates a stub when archiving a deleted file, which the existsSync guard prevents", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-deleted-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = await createSession(cwd, sessionDir);
			await session.appendMessage(userMsg("hello"));
			await session.appendMessage(assistantMsg("hi")); // forces a flush to disk
			const sessionFile = session.getSessionFile()!;
			await session.close();
			rmSync(sessionFile);
			expect(existsSync(sessionFile)).toBe(false);

			// Without the guard, the open+append recreates a fresh stub on disk.
			await (await openSession(sessionFile, sessionDir)).appendSessionState({ status: "archived" });
			expect(existsSync(sessionFile)).toBe(true);

			// The guard the caller uses skips a missing file, leaving nothing behind.
			await managers[managers.length - 1].close();
			rmSync(sessionFile);
			if (existsSync(sessionFile)) {
				await (await openSession(sessionFile, sessionDir)).appendSessionState({ status: "archived" });
			}
			expect(existsSync(sessionFile)).toBe(false);
		} finally {
			await Promise.all(managers.splice(0).map((manager) => manager.close()));
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("coerces legacy sleep and hidden lifecycle state to archived on read", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-hidden-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = await createSession(cwd, sessionDir);

			await session.appendMessage(userMsg("hide me"));
			// Flush a header + state entry, then append the legacy raw "sleep"/"hidden"
			// entries older daemons wrote; both must normalize to "archived" on read.
			await session.appendSessionState({ status: "active" });
			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();
			await session.close();
			appendLegacyState(sessionFile!, "sleep");
			appendLegacyState(sessionFile!, "hidden");

			expect((await openSession(sessionFile!, sessionDir)).getSessionState()).toEqual({ status: "archived" });

			const sessions = await SessionManager.list(cwd, sessionDir);
			expect(sessions).toHaveLength(1);
			expect(sessions[0]).toMatchObject({
				id: session.getSessionId(),
				state: { status: "archived" },
			});
		} finally {
			await Promise.all(managers.splice(0).map((manager) => manager.close()));
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("falls back to the last valid status when the newest entry is unrecognized", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-bad-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = await createSession(cwd, sessionDir);

			await session.appendMessage(userMsg("hi"));
			await session.appendSessionState({ status: "active" });
			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();
			await session.close();
			appendLegacyState(sessionFile!, "bogus");

			expect((await openSession(sessionFile!, sessionDir)).getSessionState()).toEqual({ status: "active" });

			const sessions = await SessionManager.list(cwd, sessionDir);
			expect(sessions[0]).toMatchObject({ id: session.getSessionId(), state: { status: "active" } });
		} finally {
			await Promise.all(managers.splice(0).map((manager) => manager.close()));
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not duplicate entries when lifecycle state is followed by a normal turn", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-turn-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = await createSession(cwd, sessionDir);

			await session.appendSessionState({ status: "archived" });
			await session.appendMessage(userMsg("hello"));
			await session.appendMessage(assistantMsg("hi"));

			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();

			const entries = loadEntriesFromFile(sessionFile!);
			expect(entries.filter((entry) => entry.type === "session_state")).toHaveLength(1);
			expect(entries.filter((entry) => entry.type === "message")).toHaveLength(2);
		} finally {
			await Promise.all(managers.splice(0).map((manager) => manager.close()));
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("creates the source directory before acknowledging its first lifecycle state", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-missing-dir-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = await createSession(cwd, sessionDir);
			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();

			expect(existsSync(sessionDir)).toBe(true);
			await session.appendSessionState({ status: "archived" });

			expect(existsSync(sessionFile!)).toBe(true);
			const entries = loadEntriesFromFile(sessionFile!);
			expect(entries[0]).toMatchObject({ type: "session", id: session.getSessionId() });
			expect(entries.filter((entry) => entry.type === "session_state")).toHaveLength(1);
		} finally {
			await Promise.all(managers.splice(0).map((manager) => manager.close()));
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("rejects a disappeared source instead of rewriting history from the current view", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-missing-file-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = await createSession(cwd, sessionDir);

			await session.appendMessage(userMsg("hello"));
			await session.appendMessage(assistantMsg("hi"));
			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();
			expect(existsSync(sessionFile!)).toBe(true);

			rmSync(sessionFile!, { force: true });
			await expect(session.appendSessionState({ status: "archived" })).rejects.toThrow();
			expect(existsSync(sessionFile!)).toBe(false);
			expect(session.getEntries().filter((entry) => entry.type === "message")).toHaveLength(2);
			expect(session.getSessionState()).toBeUndefined();
		} finally {
			await Promise.all(managers.splice(0).map((manager) => manager.close()));
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
