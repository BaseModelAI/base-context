import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as sessionJournalReader from "../../src/core/session-journal-reader.js";
import { readSessionInfo, SessionManager } from "../../src/core/session-manager.js";
import { assistantMsg, userMsg } from "../utilities.js";

const managers: SessionManager[] = [];
describe("SessionManager flat storage", () => {
	it("stores sessions directly in the session root and filters current-cwd lists", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-flat-"));
		try {
			const sessionDir = join(tempDir, "sessions");
			const cwdA = join(tempDir, "project-a");
			const cwdB = join(tempDir, "project-b");
			const sessionA = await createPersistedSession(cwdA, sessionDir, "a");
			const sessionB = await createPersistedSession(cwdB, sessionDir, "b");

			const files = readdirSync(sessionDir).filter((file) => file.endsWith(".jsonl"));
			expect(files).toHaveLength(2);
			expect(files.some((file) => file.startsWith("--"))).toBe(false);
			expect(new Set(files)).toEqual(
				new Set([`${sessionA.getSessionId()}.jsonl`, `${sessionB.getSessionId()}.jsonl`]),
			);

			const currentSessions = await SessionManager.list(cwdA, sessionDir);
			expect(currentSessions.map((session) => session.id)).toEqual([sessionA.getSessionId()]);

			const allSessions = await SessionManager.listAll(undefined, sessionDir);
			expect(new Set(allSessions.map((session) => session.id))).toEqual(
				new Set([sessionA.getSessionId(), sessionB.getSessionId()]),
			);

			await sessionA.close();
			const continued = await SessionManager.continueRecent(cwdA, sessionDir);
			managers.push(continued);
			expect(continued.getSessionId()).toBe(sessionA.getSessionId());

			expect(sessionA.getSessionArtifactDir()).toBe(join(tempDir, "session-artifacts", sessionA.getSessionId()));
		} finally {
			await Promise.all(managers.splice(0).map((manager) => manager.close()));
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("lists sessions without loading large message bodies into search text", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-large-list-"));
		const scans = vi.spyOn(sessionJournalReader, "readSessionJournal");
		try {
			const sessionDir = join(tempDir, "sessions");
			const cwd = join(tempDir, "project");
			const session = await SessionManager.create(cwd, sessionDir);
			managers.push(session);
			await session.appendSessionInfo("large history");
			await session.appendSessionState({ status: "active" });
			await session.appendMessage(userMsg("small prompt"));
			await session.appendMessage(assistantMsg("x".repeat(2 * 1024 * 1024)));

			const sessions = await SessionManager.listAll(undefined, sessionDir);
			expect(sessions).toHaveLength(1);
			expect(sessions[0].id).toBe(session.getSessionId());
			expect(sessions[0].name).toBe("large history");
			expect(sessions[0].state).toEqual({ status: "active" });
			expect(sessions[0].messageCount).toBe(2);
			expect(sessions[0].firstMessage).toBe("small prompt");
			expect(sessions[0].allMessagesText).toBe("small prompt");

			// Each metadata row remains below the existing scanner's character limit.
			// UTF-8 makes two retained summaries exceed 4MiB well before 256 entries.
			const largeMetadata = "界".repeat(720_000);
			const sessionPath = session.getSessionFile()!;
			const scansFor = (path: string) => scans.mock.calls.filter(([source]) => source === path).length;
			await session.appendAgentStatus({ summary: largeMetadata, taskState: "completed", basedOnMessageCount: 2 });
			const initial = await readSessionInfo(sessionPath);
			expect(initial!.agentStatus!.summary).toBe(largeMetadata);
			const complete = structuredClone(initial);
			initial!.agentStatus!.summary = "caller-only summary";
			initial!.state!.status = "archived";
			const beforeHit = scansFor(sessionPath);
			expect((await SessionManager.list(cwd, sessionDir))[0]).toEqual(complete);
			expect(scansFor(sessionPath)).toBe(beforeHit);

			const peer = await createPersistedSession(cwd, sessionDir, "byte-budget peer");
			await peer.appendAgentStatus({ summary: largeMetadata, basedOnMessageCount: 2 });
			expect((await readSessionInfo(peer.getSessionFile()!))!.agentStatus!.summary).toBe(largeMetadata);
			const beforeEvictedRead = scansFor(sessionPath);
			expect(await readSessionInfo(sessionPath)).toEqual(complete);
			expect(scansFor(sessionPath)).toBe(beforeEvictedRead + 1);

			// A complete single result can exceed the cache budget. It still appears
			// unchanged in actual list results, and another read must rescan it.
			await session.appendSessionInfo(largeMetadata);
			const beforeOversizedRead = scansFor(sessionPath);
			const uncached = await readSessionInfo(sessionPath);
			expect(uncached!.name).toBe(largeMetadata);
			expect(uncached!.agentStatus!.summary).toBe(largeMetadata);
			expect(uncached!.messageCount).toBe(2);
			expect(uncached!.firstMessage).toBe("small prompt");
			const completeList = await SessionManager.listAll(undefined, sessionDir);
			expect(completeList).toHaveLength(2);
			expect(completeList.find((item) => item.id === session.getSessionId())).toEqual(uncached);
			expect(scansFor(sessionPath)).toBe(beforeOversizedRead + 2);
		} finally {
			scans.mockRestore();
			await Promise.all(managers.splice(0).map((manager) => manager.close()));
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("preserves list metadata from oversized user message rows", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-large-user-list-"));
		try {
			const sessionDir = join(tempDir, "sessions");
			mkdirSync(sessionDir, { recursive: true });
			const sessionFile = join(sessionDir, "large-user.jsonl");
			const largeText = "y".repeat(2 * 1024 * 1024);
			writeFileSync(
				sessionFile,
				`${JSON.stringify({
					type: "session",
					id: "large-user",
					timestamp: "2026-01-01T00:00:00.000Z",
					cwd: join(tempDir, "project"),
				})}\n${JSON.stringify({
					type: "message",
					id: "message-1",
					parentId: null,
					timestamp: "2026-01-02T00:00:00.000Z",
					message: {
						role: "user",
						content: largeText,
						timestamp: 1,
					},
				})}\n`,
			);

			const sessions = await SessionManager.listAll(undefined, sessionDir);
			expect(sessions).toHaveLength(1);
			expect(sessions[0].messageCount).toBe(1);
			expect(sessions[0].firstMessage).toBe("y".repeat(256));
			expect(sessions[0].allMessagesText).toBe("");
			expect(sessions[0].modified.toISOString()).toBe("2026-01-02T00:00:00.000Z");
		} finally {
			await Promise.all(managers.splice(0).map((manager) => manager.close()));
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("ignores oversized non-conversation rows when computing modified time", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-large-tool-list-"));
		try {
			const sessionDir = join(tempDir, "sessions");
			mkdirSync(sessionDir, { recursive: true });
			const sessionFile = join(sessionDir, "large-tool.jsonl");
			const largeText = "z".repeat(2 * 1024 * 1024);
			writeFileSync(
				sessionFile,
				`${JSON.stringify({
					type: "session",
					id: "large-tool",
					timestamp: "2026-01-01T00:00:00.000Z",
					cwd: join(tempDir, "project"),
				})}\n${JSON.stringify({
					type: "message",
					id: "message-1",
					parentId: null,
					timestamp: "2026-01-02T00:00:00.000Z",
					message: {
						role: "user",
						content: "small prompt",
					},
				})}\n${JSON.stringify({
					type: "message",
					id: "message-2",
					parentId: "message-1",
					timestamp: "2026-01-03T00:00:00.000Z",
					message: {
						role: "toolResult",
						content: largeText,
					},
				})}\n`,
			);

			const sessions = await SessionManager.listAll(undefined, sessionDir);
			expect(sessions).toHaveLength(1);
			expect(sessions[0].messageCount).toBe(2);
			expect(sessions[0].firstMessage).toBe("small prompt");
			expect(sessions[0].allMessagesText).toBe("small prompt");
			expect(sessions[0].modified.toISOString()).toBe("2026-01-02T00:00:00.000Z");
		} finally {
			await Promise.all(managers.splice(0).map((manager) => manager.close()));
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

async function createPersistedSession(cwd: string, sessionDir: string, text: string): Promise<SessionManager> {
	const session = await SessionManager.create(cwd, sessionDir);
	managers.push(session);
	await session.appendMessage(userMsg(text));
	await session.appendMessage(assistantMsg(text));
	return session;
}
