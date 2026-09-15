import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@ponythewhite/base-context-agent";
import { type AssistantMessage, getModel, type Usage } from "@ponythewhite/base-context-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

function createUsage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
}

function createAssistantMessage(text: string, totalTokens: number, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(totalTokens),
		stopReason: "stop",
		timestamp,
	};
}

function createUserMessage(text: string, timestamp: number) {
	return {
		role: "user" as const,
		content: text,
		timestamp,
	};
}

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function createSession(persistent = false) {
	const settingsManager = SettingsManager.inMemory();
	const dir = persistent ? mkdtempSync(join(tmpdir(), "bc-context-usage-")) : undefined;
	if (dir) tempDirs.push(dir);
	const sessionManager = dir ? await SessionManager.create(dir, join(dir, "sessions")) : SessionManager.inMemory();
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "You are a helpful assistant.",
				tools: [],
				thinkingLevel: "high",
			},
		}),
		sessionManager,
		settingsManager,
		cwd: process.cwd(),
		modelRegistry: ModelRegistry.inMemory(authStorage),
		resourceLoader: createTestResourceLoader(),
	});

	await session.initialize();
	return { session, sessionManager, settingsManager };
}

function syncAgentMessages(session: AgentSession, sessionManager: SessionManager): void {
	session.agent.state.messages = sessionManager.buildSessionContext().messages;
}

describe("AgentSession.getSessionStats", () => {
	it("exposes the current context usage alongside token totals", async () => {
		const { session, sessionManager } = await createSession();

		try {
			await sessionManager.appendMessage(createUserMessage("hello", 1));
			await sessionManager.appendMessage(createAssistantMessage("hi", 200, 2));
			syncAgentMessages(session, sessionManager);

			const stats = await session.getSessionStats();
			expect(stats.contextUsage).toEqual(await session.getContextUsage());
			expect(stats.contextUsage?.tokens).toBe(200);
			expect(stats.contextUsage?.contextWindow).toBe(model.contextWindow);
			expect(stats.contextUsage?.percent).toBe((200 / model.contextWindow) * 100);
		} finally {
			await session.disposeAsync();
		}
	});

	it("reports unknown current context usage immediately after compaction", async () => {
		const { session, sessionManager } = await createSession(true);

		try {
			await sessionManager.appendMessage(createUserMessage("first", 1));
			await sessionManager.appendMessage(createAssistantMessage("response1", 180_000, 2));
			const keptUserId = await sessionManager.appendMessage(createUserMessage("second", 3));
			await sessionManager.appendMessage(createAssistantMessage("response2", 195_000, 4));
			await sessionManager.appendCompaction("summary", keptUserId, 195_000);
			await sessionManager.appendMessage(createUserMessage("third", 5));
			syncAgentMessages(session, sessionManager);

			const eagerBranch = vi.spyOn(sessionManager, "getBranch").mockImplementation(() => {
				throw new Error("Unbounded context-usage branch scan");
			});
			const stats = await session.getSessionStats();
			expect(stats.tokens.input).toBe(195_000);
			expect(stats.contextUsage).toBeDefined();
			expect(stats.contextUsage?.tokens).toBeNull();
			expect(stats.contextUsage?.percent).toBeNull();
			await sessionManager.appendMessage(createAssistantMessage("zero", 0, 0));
			await sessionManager.appendMessage({ ...createAssistantMessage("error", 1, 0), stopReason: "error" });
			expect((await session.getContextUsage())?.tokens).toBeNull();
			expect(eagerBranch).not.toHaveBeenCalled();
		} finally {
			vi.restoreAllMocks();
			await session.disposeAsync();
		}
	});

	it("uses post-compaction usage for current context instead of stale kept usage", async () => {
		const { session, sessionManager, settingsManager } = await createSession(true);

		try {
			await sessionManager.appendMessage(createUserMessage("first", 1));
			await sessionManager.appendMessage(createAssistantMessage("response1", 180_000, 2));
			const keptUserId = await sessionManager.appendMessage(createUserMessage("second", 3));
			await sessionManager.appendMessage(createAssistantMessage("response2", 195_000, 4));
			await sessionManager.appendCompaction("summary", keptUserId, 195_000);
			await sessionManager.appendMessage(createUserMessage("third", 5));
			const assistantId = await sessionManager.appendMessage(createAssistantMessage("response3", 25_000, 6));
			syncAgentMessages(session, sessionManager);

			const eagerBranch = vi.spyOn(sessionManager, "getBranch").mockImplementation(() => {
				throw new Error("Unbounded context-usage branch scan");
			});
			const stats = await session.getSessionStats();
			expect(stats.tokens.input).toBe(220_000);
			expect(stats.contextUsage).toBeDefined();
			expect(stats.contextUsage?.tokens).toBe(25_000);
			expect(stats.contextUsage?.percent).toBe((25_000 / model.contextWindow) * 100);
			const limits = settingsManager.getCanonicalContextLimits();
			settingsManager.applyOverrides({ canonicalContext: { ...limits, maxSourceBytes: 1 } });
			try {
				await expect(session.getContextUsage()).rejects.toThrow("Context usage source byte budget exceeded");
			} finally {
				settingsManager.applyOverrides({ canonicalContext: limits });
			}
			await sessionManager.appendMessage(createUserMessage("attribution branch", 7));
			await sessionManager.appendChildUsageAttribution(assistantId, createUsage(0), createUsage(0));
			sessionManager.branch(assistantId);
			expect((await session.getContextUsage())?.tokens).toBeNull();
			await sessionManager.appendChildUsageAttribution(assistantId, createUsage(1), createUsage(26_000));
			expect((await session.getContextUsage())?.tokens).not.toBeNull();
			expect(eagerBranch).not.toHaveBeenCalled();
		} finally {
			vi.restoreAllMocks();
			await session.disposeAsync();
		}
	});
});
