import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream, type Model } from "@ponythewhite/base-context-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Agent } from "../../../agent/src/agent.js";
import type { FinalizedToolExchange } from "../../../agent/src/types.js";
import { loadEntriesFromFile, SessionManager } from "../../src/core/session-manager.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "base-context-tool-history-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const model: Model<"openai-responses"> = {
	id: "fixture",
	name: "fixture",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
};

it("records intent before effects and one exact result, with source-ordered replay", async () => {
	const manager = SessionManager.create(dir, join(dir, "sessions"));
	const path = manager.getSessionFile()!;
	const exchanges: FinalizedToolExchange[] = [];
	let releaseFirst = () => {};
	const firstCanFinish = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	const response: AssistantMessage = {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: ["first", "second"].map((id) => ({ type: "toolCall", id, name: "effect", arguments: { value: id } })),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	};
	const agent = new Agent({
		initialState: {
			model,
			tools: [
				{
					name: "effect",
					label: "Effect",
					description: "Fixture",
					parameters: Type.Object({ value: Type.String() }),
					async execute(id) {
						const intents = loadEntriesFromFile(path).filter((entry) => entry.type === "tool_intent");
						expect(
							intents.some((entry) => entry.type === "tool_intent" && entry.invocation.toolCallId === id),
						).toBe(true);
						if (id === "first") await firstCanFinish;
						return { content: [{ type: "text", text: id }], details: { observed: id }, terminate: true };
					},
				},
			],
		},
		streamFn: () => {
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "done", reason: "toolUse", message: response });
			return stream;
		},
		onToolInvocationStarting: (invocation) => {
			manager.appendToolInvocation(invocation);
		},
		onToolExchangeFinalized: (exchange) => {
			manager.appendToolExchange(exchange);
			exchanges.push(exchange);
			if (exchange.toolCallId === "second") releaseFirst();
		},
	});
	agent.subscribe((event) => {
		if (event.type === "message_end" && ["user", "assistant", "toolResult"].includes(event.message.role)) {
			if (
				event.message.role === "user" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult"
			) {
				manager.appendMessage(event.message);
			}
		}
	});
	await agent.prompt("Run both calls");
	expect(agent.state.errorMessage).toBeUndefined();
	expect(exchanges.map((exchange) => exchange.toolCallId)).toEqual(["second", "first"]);
	const restored = SessionManager.open(path);
	const resultEntries = restored
		.getEntries()
		.filter((entry) => entry.type === "message" && entry.message.role === "toolResult");
	expect(resultEntries).toHaveLength(2);
	for (const exchange of exchanges) {
		expect(restored.getToolExchange(exchange.executionId)).toEqual(exchange);
		const entry = restored.getEntry(exchange.executionId);
		expect(entry?.type === "message" ? entry.execution : undefined).not.toHaveProperty("originalInput");
	}
	expect(
		restored
			.buildSessionContext()
			.messages.filter((message) => message.role === "toolResult")
			.map((message) => message.toolCallId),
	).toEqual(["first", "second"]);
	const before = readFileSync(path, "utf8");
	const duplicate = structuredClone(exchanges[0]);
	restored.appendToolExchange(duplicate);
	restored.appendMessage(duplicate.result);
	expect(readFileSync(path, "utf8")).toBe(before);
});

it("retains a not-started result without inventing an invocation", () => {
	const manager = SessionManager.create(dir, join(dir, "sessions"));
	const exchange: FinalizedToolExchange = {
		executionId: "blocked-execution",
		sourceOrder: 0,
		toolCallId: "blocked",
		toolName: "effect",
		originalInput: { value: "invalid" },
		toolExecution: "sequential",
		executionOutcome: "not_started",
		cancellationRequested: false,
		result: {
			role: "toolResult",
			toolCallId: "blocked",
			toolName: "effect",
			content: [{ type: "text", text: "blocked" }],
			isError: true,
			timestamp: 1,
		},
	};
	manager.appendToolExchange(exchange);
	const restored = SessionManager.open(manager.getSessionFile()!);
	expect(restored.getEntries().some((entry) => entry.type === "tool_intent")).toBe(false);
	expect(restored.getToolExchange(exchange.executionId)).toEqual(exchange);
	expect(restored.getToolExchange(exchange.executionId)).not.toHaveProperty("executedInput");
});
