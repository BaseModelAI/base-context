import { type AssistantMessage, createAssistantMessageEventStream, type Model } from "@ponythewhite/base-context-ai";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { Agent } from "../src/agent.js";
import type { AgentEvent, AgentTool, FinalizedToolExchange, StreamFn, ToolInvocation } from "../src/types.js";

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

function response(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
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
}

function streamResponse(message: AssistantMessage): StreamFn {
	return () => {
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "done", reason: "toolUse", message });
		return stream;
	};
}

it("captures invocation snapshots and final middleware results before observers, preserving parallel source order", async () => {
	const parameters = Type.Object({ value: Type.Number(), nested: Type.Object({ stage: Type.String() }) });
	const admitted: ToolInvocation[] = [];
	let releaseFirst = () => {};
	const firstCanFinish = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	const tool: AgentTool<typeof parameters> = {
		name: "change",
		label: "Change",
		description: "Fixture",
		parameters,
		prepareArguments(args) {
			const raw = args as { value: string | number; nested: { stage: string } };
			raw.value = Number(raw.value);
			raw.nested.stage = "prepared";
			return { value: raw.value, nested: raw.nested };
		},
		async execute(id, args) {
			expect(admitted.some((invocation) => invocation.toolCallId === id)).toBe(true);
			args.nested.stage = "mutated during execution";
			if (id === "first") await firstCanFinish;
			return { content: [{ type: "text", text: "raw" }], details: { raw: true } };
		},
	};
	const calls: AssistantMessage["content"] = ["first", "second"].map((id) => ({
		type: "toolCall",
		id,
		name: "change",
		arguments: { value: "2", nested: { stage: "model" } },
	}));
	const committed: FinalizedToolExchange[] = [];
	const events: AgentEvent[] = [];
	const agent = new Agent({
		initialState: { model, tools: [tool] },
		streamFn: streamResponse(response(calls)),
		beforeToolCall: async ({ args }) => {
			(args as { nested: { stage: string } }).nested.stage = "validated middleware";
			return undefined;
		},
		afterToolCall: async ({ toolCall }) => ({
			content: [{ type: "text", text: `final ${toolCall.id}` }],
			details: { final: true },
			isError: true,
			terminate: true,
		}),
		onToolInvocationStarting: async (invocation) => {
			await Promise.resolve();
			admitted.push(invocation);
		},
		onToolExchangeFinalized: async (exchange) => {
			await Promise.resolve();
			committed.push(exchange);
			if (exchange.toolCallId === "second") releaseFirst();
		},
	});
	agent.subscribe((event) => {
		events.push(event);
		if (event.type === "tool_execution_end") expect(committed).toContain(event.exchange);
	});
	await agent.prompt("Run both calls");
	const turn = events.find((event) => event.type === "turn_end");
	expect(committed.map((exchange) => exchange.toolCallId)).toEqual(["second", "first"]);
	expect(turn?.toolExecution).toBe("parallel");
	expect(turn?.exchanges?.map((exchange) => [exchange.sourceOrder, exchange.toolCallId])).toEqual([
		[0, "first"],
		[1, "second"],
	]);
	for (const exchange of turn?.exchanges ?? []) {
		const invocation = admitted.find((intent) => intent.executionId === exchange.executionId);
		expect(invocation?.executedInput).toEqual(exchange.executedInput);
		expect(exchange.originalInput).toEqual({ value: "2", nested: { stage: "model" } });
		expect(exchange.executedInput).toEqual({ value: 2, nested: { stage: "validated middleware" } });
		expect(exchange.executionOutcome).toBe("completed");
		expect(exchange.result).toMatchObject({
			content: [{ type: "text", text: `final ${exchange.toolCallId}` }],
			details: { final: true },
			isError: true,
		});
		expect(turn?.toolResults[exchange.sourceOrder]).toBe(exchange.result);
	}
});

it.each(["blocked", "invalid", "throws", "abort"] as const)(
	"retains truthful finalized evidence for %s without a second execution",
	async (scenario) => {
		const parameters = Type.Object({ value: Type.Number() });
		let executions = 0;
		let agent: Agent;
		const tool: AgentTool<typeof parameters> = {
			name: "edge",
			label: "Edge",
			description: "Fixture",
			parameters,
			executionMode: "sequential",
			async execute() {
				executions++;
				if (scenario === "abort") {
					agent.abort();
					return new Promise(() => {});
				}
				throw new Error("fixture failure");
			},
		};
		const committed: FinalizedToolExchange[] = [];
		const events: AgentEvent[] = [];
		agent = new Agent({
			initialState: { model, tools: [tool] },
			streamFn: streamResponse(
				response([
					{
						type: "toolCall",
						id: "edge",
						name: "edge",
						arguments: { value: scenario === "invalid" ? "invalid" : 3 },
					},
				]),
			),
			beforeToolCall: async () => (scenario === "blocked" ? { block: true, reason: "fixture block" } : undefined),
			shouldStopAfterTurn: () => true,
			onToolExchangeFinalized: (exchange) => {
				committed.push(exchange);
			},
		});
		agent.subscribe((event) => {
			events.push(event);
		});
		await agent.prompt("Run the edge call");
		expect(committed).toHaveLength(1);
		const exchange = committed[0];
		expect(exchange.toolExecution).toBe("sequential");
		expect(exchange.result.isError).toBe(true);
		expect(exchange.sourceOrder).toBe(0);
		expect(exchange.cancellationRequested).toBe(scenario === "abort");
		expect(exchange.executionOutcome).toBe(
			scenario === "abort" ? "outcome_unknown" : scenario === "throws" ? "failed" : "not_started",
		);
		expect(executions).toBe(scenario === "throws" || scenario === "abort" ? 1 : 0);
		if (executions === 0) expect(exchange).not.toHaveProperty("executedInput");
		else expect(exchange.executedInput).toEqual({ value: 3 });
		const turn = events.find((event) => event.type === "turn_end");
		expect(turn?.toolExecution).toBe("sequential");
		expect(turn?.exchanges).toEqual(committed);
	},
);

it("does not invoke or fabricate a tool result when intent persistence fails", async () => {
	let executed = false;
	const agent = new Agent({
		initialState: {
			model,
			tools: [
				{
					name: "effect",
					label: "Effect",
					description: "Fixture",
					parameters: Type.Object({}),
					async execute() {
						executed = true;
						return { content: [{ type: "text", text: "unexpected" }], details: {} };
					},
				},
			],
		},
		streamFn: streamResponse(response([{ type: "toolCall", id: "effect", name: "effect", arguments: {} }])),
	});
	const owner = {
		onToolInvocationStarting: async (): Promise<void> => {
			throw new Error("intent write failed");
		},
		onToolExchangeFinalized: async () => {},
	};
	agent.bindToolExecutionOwner(owner);
	expect(() => agent.bindToolExecutionOwner(owner)).toThrow("already bound");
	owner.onToolInvocationStarting = async () => {};
	agent.onToolInvocationStarting = async () => {};
	agent.onToolExchangeFinalized = async () => {};
	await agent.prompt("Run effect");
	expect(executed).toBe(false);
	expect(agent.state.errorMessage).toBe("intent write failed");
	expect(agent.state.messages.some((message) => message.role === "toolResult")).toBe(false);
});

it("keeps ownership until other started calls settle after an admission failure", async () => {
	let release = () => {};
	let started = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const running = new Promise<void>((resolve) => {
		started = resolve;
	});
	const finalized: string[] = [];
	const agent = new Agent({
		initialState: {
			model,
			tools: [
				{
					name: "effect",
					label: "Effect",
					description: "Fixture",
					parameters: Type.Object({}),
					async execute() {
						started();
						await gate;
						return { content: [{ type: "text", text: "actual late result" }], details: {} };
					},
				},
			],
		},
		streamFn: streamResponse(
			response(["rejected", "late"].map((id) => ({ type: "toolCall", id, name: "effect", arguments: {} }))),
		),
		onToolInvocationStarting: (intent) => {
			if (intent.toolCallId === "rejected") throw new Error("admission failed");
		},
		onToolExchangeFinalized: (exchange) => {
			finalized.push(exchange.toolCallId);
		},
	});
	const run = agent.prompt("Run both");
	await running;
	await new Promise<void>((resolve) => setImmediate(resolve));
	try {
		expect(agent.state.isStreaming).toBe(true);
	} finally {
		release();
	}
	await run;
	expect(finalized).toEqual(["late"]);
	expect(agent.state.errorMessage).toBe("admission failed");
	expect(agent.state.messages.some((message) => message.role === "toolResult" && message.toolCallId === "late")).toBe(
		true,
	);
});
