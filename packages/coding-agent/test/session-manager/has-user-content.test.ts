import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.js";
import { userMsg } from "../utilities.js";

describe("SessionManager.hasUserContent", () => {
	async function withSession(run: (session: SessionManager) => Promise<void>): Promise<void> {
		const tempDir = mkdtempSync(join(tmpdir(), "has-user-content-"));
		let session: SessionManager | undefined;
		try {
			session = await SessionManager.create(join(tempDir, "project"), join(tempDir, "sessions"));
			await run(session);
		} finally {
			await session?.close();
			rmSync(tempDir, { recursive: true, force: true });
		}
	}

	it("is false for a fresh session with only the default configuration entries", async () => {
		await withSession(async (session) => {
			// What createAgentSession writes for every new session.
			await session.appendModelChange("anthropic", "claude-opus-4-8");
			await session.appendThinkingLevelChange("off");
			await session.appendServiceTierChange("default");
			expect(session.hasUserContent()).toBe(false);
		});
	});

	it("is true once the user changes the model after creation", async () => {
		await withSession(async (session) => {
			await session.appendModelChange("anthropic", "claude-opus-4-8");
			await session.appendThinkingLevelChange("off");
			await session.appendModelChange("openai", "gpt-5");
			expect(session.hasUserContent()).toBe(true);
		});
	});

	it("is true once the user changes the thinking level after creation", async () => {
		await withSession(async (session) => {
			await session.appendModelChange("anthropic", "claude-opus-4-8");
			await session.appendThinkingLevelChange("off");
			await session.appendThinkingLevelChange("high");
			expect(session.hasUserContent()).toBe(true);
		});
	});

	it("is true once the user enables Fast mode after creation", async () => {
		await withSession(async (session) => {
			await session.appendModelChange("openai-codex", "gpt-5.5");
			await session.appendThinkingLevelChange("medium");
			await session.appendServiceTierChange("default");
			await session.appendServiceTierChange("priority");
			expect(session.hasUserContent()).toBe(true);
		});
	});

	it("is false for a fresh session created with no model available (thinking entry only)", async () => {
		await withSession(async (session) => {
			// createAgentSession skips the model_change when no model is configured,
			// leaving a lone leading thinking_level_change as the creation default.
			await session.appendThinkingLevelChange("off");
			expect(session.hasUserContent()).toBe(false);
		});
	});

	it("is true once the user changes the thinking level on a no-model session", async () => {
		await withSession(async (session) => {
			await session.appendThinkingLevelChange("off");
			await session.appendThinkingLevelChange("high");
			expect(session.hasUserContent()).toBe(true);
		});
	});

	it("is true for a session with a message", async () => {
		await withSession(async (session) => {
			await session.appendMessage(userMsg("hello"));
			expect(session.hasUserContent()).toBe(true);
		});
	});

	it("is true once the session is named", async () => {
		await withSession(async (session) => {
			await session.appendModelChange("anthropic", "claude-opus-4-8");
			await session.appendThinkingLevelChange("off");
			await session.appendSessionInfo("my draft");
			expect(session.hasUserContent()).toBe(true);
		});
	});
});
