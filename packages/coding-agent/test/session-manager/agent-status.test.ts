import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSessionContext, loadEntriesFromFile, SessionManager } from "../../src/core/session-manager.js";
import { assistantMsg, userMsg } from "../utilities.js";

describe("SessionManager agent status", () => {
	it("persists the latest agent status append-only and reads it back", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "agent-status-"));
		let session: SessionManager | undefined;
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			session = await SessionManager.create(cwd, sessionDir);

			await session.appendMessage(userMsg("add a login endpoint"));
			await session.appendMessage(assistantMsg("done"));
			await session.appendAgentStatus({ summary: "Working", taskState: undefined, basedOnMessageCount: 2 });
			await session.appendAgentStatus({
				summary: "Added login endpoint",
				taskState: "completed",
				basedOnMessageCount: 2,
			});

			// Latest entry wins.
			expect(session.getLatestAgentStatus()).toEqual({
				summary: "Added login endpoint",
				taskState: "completed",
				basedOnMessageCount: 2,
			});

			// Append-only: re-reading the raw file recovers both entries and the
			// two conversation messages untouched.
			const entries = loadEntriesFromFile(session.getSessionFile()!);
			expect(entries.filter((entry) => entry.type === "agent_status")).toHaveLength(2);
			expect(entries.filter((entry) => entry.type === "message")).toHaveLength(2);
		} finally {
			await session?.close();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("reads the status on the active branch, not a sibling branch's later entry", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "agent-status-branch-"));
		let session: SessionManager | undefined;
		try {
			session = await SessionManager.create(join(tempDir, "p"), join(tempDir, "s"));
			const m1 = await session.appendMessage(userMsg("first"));
			const m2 = await session.appendMessage(assistantMsg("reply"));

			// Branch A off m1, leave a status on it.
			session.branch(m1);
			const branchAStatus = await session.appendAgentStatus({ summary: "branch A", basedOnMessageCount: 1 });

			// Branch B off m2 with a status appended later in the file.
			session.branch(m2);
			await session.appendAgentStatus({ summary: "branch B", basedOnMessageCount: 1 });

			// Re-activate branch A; its status must win despite B being later in the file.
			session.branch(branchAStatus);
			expect(session.getLatestAgentStatus()?.summary).toBe("branch A");
		} finally {
			await session?.close();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("is ignored by context building so it never reaches the model", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "agent-status-context-"));
		let session: SessionManager | undefined;
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			session = await SessionManager.create(cwd, sessionDir);

			await session.appendMessage(userMsg("hello"));
			await session.appendMessage(assistantMsg("hi"));
			await session.appendAgentStatus({
				summary: "Greeted the user",
				taskState: "completed",
				basedOnMessageCount: 2,
			});

			const context = buildSessionContext(session.getEntries(), session.getLeafId());
			expect(context.messages).toHaveLength(2);
			expect(context.messages.every((message) => message.role === "user" || message.role === "assistant")).toBe(
				true,
			);
		} finally {
			await session?.close();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
