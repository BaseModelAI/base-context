import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { Agent } from "@ponythewhite/base-context-agent";
import {
	type AssistantMessage,
	type Context,
	type FauxProviderRegistration,
	type FauxResponseFactory,
	getModel,
	registerFauxProvider,
	type TextContent,
	type Usage,
} from "@ponythewhite/base-context-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { BASE_CONTEXT_META_NAMESPACE, type PrimeAgentSessionMeta } from "../src/modes/acp/acp-meta.js";
import { runAcpModeWithConnection } from "../src/modes/acp/index.js";
import { InProcessAgentConnection } from "../src/modes/agent-connection/in-process-agent-connection.js";
import { createTestResourceLoader } from "./utilities.js";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

function userText(context: Context): string {
	const last = context.messages.at(-1);
	if (!last || last.role !== "user") return "";
	if (typeof last.content === "string") return last.content;
	return last.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function usage(input = 7, output = 3): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input, output, cacheRead: 0, cacheWrite: 0, total: input + output },
	};
}

function answer(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: usage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/**
 * Checks RLM subagent activity reaches an ACP client.
 *
 * Uses real AgentSession instances with the local faux provider (no API key,
 * no network) so subagent spawn is genuine rather than mocked at the mapper.
 */

function runtimeHostFor(session: AgentSession): AgentSessionRuntime {
	return {
		session,
		setRebindSession() {},
		setBeforeSessionInvalidate() {},
		async dispose() {},
	} as unknown as AgentSessionRuntime;
}

describe("ACP mode surfaces RLM subagents", () => {
	let tempDir: string;
	let session: AgentSession | undefined;
	let faux: FauxProviderRegistration | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-acp-rlm-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await session?.disposeAsync();
		faux?.unregister();
		faux = undefined;
		session = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("streams subagent lifecycle to an ACP client as namespaced metadata", async () => {
		faux = registerFauxProvider({ api: model.api, provider: model.provider, models: [{ id: model.id }] });
		const provider = faux;
		const respond: FauxResponseFactory = (context) => {
			provider.appendResponses([respond]);
			return answer(`child answer: ${userText(context)}`);
		};
		provider.setResponses([respond]);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const agent = new Agent({
			convertToLlm,
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "", tools: [], thinkingLevel: "off" },
		});
		session = new AgentSession({
			agent,
			sessionManager: await SessionManager.create(tempDir, join(tempDir, "sessions")),
			settingsManager: SettingsManager.create(tempDir, tempDir),
			cwd: tempDir,
			modelRegistry: ModelRegistry.create(authStorage, join(tempDir, "models.json")),
			resourceLoader: createTestResourceLoader(),
		});

		await session.initialize();
		const connection = new InProcessAgentConnection(runtimeHostFor(session));
		const toAgent = new TransformStream<Uint8Array, Uint8Array>();
		const toClient = new TransformStream<Uint8Array, Uint8Array>();
		const updates: acp.SessionNotification[] = [];
		void runAcpModeWithConnection(connection, {
			stream: acp.ndJsonStream(toClient.writable, toAgent.readable),
		});
		const handle = acp
			.client({ name: "rlm-client" })
			.onNotification("session/update", (ctx) => {
				updates.push(ctx.params);
			})
			.connect(acp.ndJsonStream(toAgent.writable, toClient.readable));

		await handle.agent.request("initialize", {
			protocolVersion: acp.PROTOCOL_VERSION,
			clientCapabilities: {},
		});
		const acpSession = await handle.agent.request("session/new", { cwd: tempDir, mcpServers: [] });

		// No prompt turn: a fire-and-forget subagent must still reach the client,
		// which is only true if ACP subscribes for the session lifetime.
		await session.runRlmChild("summarize shard 1");
		await session.waitForRlmQuiescence();

		// Drain the async notification queue.
		await new Promise((resolve) => setTimeout(resolve, 50));

		const subagentMeta = updates.flatMap(
			(u) => (u.update._meta?.[BASE_CONTEXT_META_NAMESPACE] as PrimeAgentSessionMeta | undefined)?.subagents ?? [],
		);
		expect(acpSession.sessionId).toBeTruthy();
		expect(subagentMeta.length, "subagent updates must reach the ACP client").toBeGreaterThan(0);
		expect(subagentMeta).toContainEqual(expect.objectContaining({ status: "running" }));
		expect(subagentMeta).toContainEqual(expect.objectContaining({ status: "done" }));
	}, 30_000);
});
