import type { AgentEvent, AgentTool } from "@ponythewhite/base-context-agent";
import {
	type AssistantMessage,
	type Context,
	fauxAssistantMessage,
	fauxThinking,
	fauxToolCall,
	type Model,
} from "@ponythewhite/base-context-ai";
import OpenAI from "openai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IDEMPOTENCY_KEY_HEADER, MODEL_REQUEST_ID_HEADER } from "../../src/core/semantic-edges.js";
import { createHarness, type Harness } from "./harness.js";

function normalizeEventOrder(events: Harness["events"]): string[] {
	const normalized: string[] = [];
	for (const event of events) {
		const label =
			event.type === "message_start" || event.type === "message_end"
				? `${event.type}:${event.message.role}`
				: event.type === "tool_execution_start" || event.type === "tool_execution_end"
					? `${event.type}:${event.toolName}`
					: event.type;
		if (label === "message_update" && normalized[normalized.length - 1] === "message_update") {
			continue;
		}
		normalized.push(label);
	}
	return normalized;
}

function structuredProviderFailure(
	kind: "auth" | "invalid_request" | "refusal" | "transport" | "overloaded" | "rate_limit" | "server_error",
	errorMessage = `provider ${kind} failure`,
): AssistantMessage {
	return {
		...fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage,
		}),
		diagnostics: [
			{
				type: "provider_stream_failure",
				timestamp: Date.now(),
				details: { kind },
			},
		],
	};
}

const compatibleModel: Model<"openai-completions"> = {
	api: "openai-completions",
	provider: "offline-compatible",
	id: "offline-compatible",
	name: "Offline compatible fixture",
	baseUrl: "https://example.invalid/v1",
	input: ["text"],
	reasoning: false,
	contextWindow: 65536,
	maxTokens: 64,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function compatibleResponse(delta: Record<string, unknown>, finishReason: string | null, failure?: Error): Response {
	const chunk = {
		id: "compatible-reply",
		model: compatibleModel.id,
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	};
	const encoded = new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n${failure ? "" : "data: [DONE]\n\n"}`);
	let sentPartial = false;
	return new Response(
		new ReadableStream<Uint8Array>({
			pull(controller) {
				if (!sentPartial) {
					sentPartial = true;
					controller.enqueue(encoded);
				} else if (failure) controller.error(failure);
				else controller.close();
			},
		}),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

type SessionRetryCompactionInternals = {
	_retryAttempt: number;
	_retryPromise: Promise<void> | undefined;
	_retryResolve: (() => void) | undefined;
	_autoCompactionAbortController: AbortController | undefined;
	_postCompactionContinuationScheduled: boolean;
	_processAgentEvent: (event: AgentEvent) => Promise<void>;
	_checkCompaction: (message: AssistantMessage) => Promise<boolean>;
	_schedulePostCompactionContinue: () => void;
	_cancelPostCompactionContinue: () => void;
};

describe("AgentSession retry and event characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) {
			await harnesses.pop()?.cleanup();
		}
		vi.restoreAllMocks();
	});

	it("retries after a transient error and succeeds", async () => {
		const harness = await createHarness({
			persistSession: true,
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		const retryEvents: string[] = [];
		const requests: { body: string; headers: Record<string, string> }[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") retryEvents.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") retryEvents.push(`end:${event.success}`);
		});

		harness.setResponses([
			(context, options) => {
				requests.push({ body: JSON.stringify(context), headers: { ...options?.headers } });
				return structuredProviderFailure("overloaded", "overloaded_error");
			},
			(context, options) => {
				requests.push({ body: JSON.stringify(context), headers: { ...options?.headers } });
				return fauxAssistantMessage("recovered");
			},
		]);

		await harness.session.prompt("test");

		expect(retryEvents).toEqual(["start:1", "end:true"]);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.isRetrying).toBe(false);
		expect(requests).toHaveLength(2);
		expect(requests[1].body).toBe(requests[0].body);
		const requestId = requests[0].headers[MODEL_REQUEST_ID_HEADER];
		expect(requestId).toEqual(expect.stringMatching(/\S/));
		expect(requests.map((request) => request.headers[MODEL_REQUEST_ID_HEADER])).toEqual([requestId, requestId]);
		expect(requests.map((request) => request.headers[IDEMPOTENCY_KEY_HEADER])).toEqual([requestId, requestId]);
		expect(
			harness.sessionManager
				.getEntries()
				.some(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						entry.message.stopReason === "error" &&
						entry.message.errorMessage === "overloaded_error",
				),
		).toBe(true);
	});

	it("retries multiple transient failures and succeeds on the final attempt", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		harnesses.push(harness);
		const retryEvents: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") retryEvents.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") retryEvents.push(`end:${event.success}`);
		});

		harness.setResponses([
			structuredProviderFailure("overloaded", "overloaded_error"),
			structuredProviderFailure("overloaded", "overloaded_error"),
			fauxAssistantMessage("success"),
		]);

		await harness.session.prompt("test");

		expect(retryEvents).toEqual(["start:1", "start:2", "end:true"]);
		expect(harness.faux.state.callCount).toBe(3);
	});

	it("recovers beyond the old retry cap within one persisted invocation and output allowance", async () => {
		const toolRuns: string[] = [];
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				toolRuns.push(text);
				return { content: [{ type: "text", text: `echo:${text}` }], details: { text } };
			},
		};
		// user + two tool exchanges + four retained failures + final assistant = ten output messages.
		const outputLimits = { maxMessages: 10, maxSourceBytes: 128 * 1024 };
		const harness = await createHarness({
			persistSession: true,
			tools: [echoTool],
			invocationOutputLimits: outputLimits,
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1, provider: { maxRetryDelayMs: 2 } } },
		});
		harnesses.push(harness);
		expect(harness.sessionManager.supportsCapturedHistoryReads()).toBe(true);
		const continueAgent = vi.spyOn(harness.session.agent, "continue");
		const interrupted = {
			...structuredProviderFailure("transport"),
			content: [fauxToolCall("echo", { text: "partial" }, { id: "partial-call" })],
		};
		const failedRequests: string[] = [];
		const failures = [interrupted, ...Array.from({ length: 3 }, () => structuredProviderFailure("overloaded"))];
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "before" }, { id: "completed-call" })], {
				stopReason: "toolUse",
			}),
			...failures.map((failure) => (context: Context) => {
				failedRequests.push(JSON.stringify(context));
				return failure;
			}),
			(context) => {
				failedRequests.push(JSON.stringify(context));
				return fauxAssistantMessage([fauxToolCall("echo", { text: "after" }, { id: "recovered-call" })], {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage("final answer"),
		]);

		await harness.session.promptAndWait("test");
		await harness.session.waitForIdle();

		expect(harness.faux.state.callCount).toBe(7);
		expect(harness.eventsOfType("auto_retry_start").map(({ attempt, delayMs }) => [attempt, delayMs])).toEqual([
			[1, 1],
			[2, 2],
			[3, 2],
			[4, 2],
		]);
		expect(harness.eventsOfType("auto_retry_end")).toHaveLength(1);
		expect(harness.eventsOfType("auto_retry_end")[0]).toMatchObject({ success: true, attempt: 4 });
		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
		expect(harness.eventsOfType("agent_end")).toHaveLength(1);
		expect(continueAgent).not.toHaveBeenCalled();
		expect(toolRuns).toEqual(["before", "after"]);
		expect(harness.eventsOfType("tool_execution_start").map(({ toolCallId }) => toolCallId)).toEqual([
			"completed-call",
			"recovered-call",
		]);
		expect(failedRequests).toHaveLength(5);
		expect(failedRequests.every((body) => body === failedRequests[0])).toBe(true);
		const terminal = harness.eventsOfType("agent_end")[0]!;
		expect(terminal.refusal).toBeUndefined();
		const output = terminal.messages ?? [];
		expect(output).toHaveLength(outputLimits.maxMessages);
		expect(output.filter((message) => message.role === "assistant" && message.stopReason === "error")).toHaveLength(
			4,
		);
		expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(outputLimits.maxSourceBytes);
		const entries = await harness.sessionManager.readEntries();
		expect(
			entries.filter(
				(entry) =>
					entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "error",
			),
		).toHaveLength(4);
		expect(entries.filter((entry) => entry.type === "message" && entry.message.role === "toolResult")).toHaveLength(
			2,
		);
		expect(harness.session.isRetrying).toBe(false);
		expect(harness.session.hasAcceptedPromptInFlight).toBe(false);
	});

	// Keep the existing persisted invocation owner; only HTTP is replaced, not the adapter or recovery.
	async function createCompatibleHarness(tools: AgentTool[] = []) {
		const harness = await createHarness({
			persistSession: true,
			tools,
			settings: {
				retry: { enabled: true, baseDelayMs: 1, provider: { maxRetryDelayMs: 1 } },
				compaction: { enabled: false },
				autoRefine: { enabled: false },
			},
		});
		harnesses.push(harness);
		harness.session.modelRegistry.registerProvider(compatibleModel.provider, {
			api: compatibleModel.api,
			baseUrl: compatibleModel.baseUrl,
			apiKey: "offline-compatible-key",
			models: [compatibleModel],
		});
		harness.authStorage.setRuntimeApiKey(compatibleModel.provider, "offline-compatible-key");
		await harness.session.setModel(compatibleModel);
		return harness;
	}

	it("recovers an OpenAI-compatible body failure in one owned invocation without tool replay", async () => {
		const execute = vi.fn(async () => ({
			content: [{ type: "text" as const, text: "completed once" }],
			details: {},
		}));
		const harness = await createCompatibleHarness([
			{
				name: "echo",
				label: "Echo",
				description: "Local fixture",
				parameters: Type.Object({ text: Type.String() }),
				execute,
			},
		]);
		const continueAgent = vi.spyOn(harness.session.agent, "continue");
		const bodies: string[] = [];
		const offlineFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
			expect(String(url)).toBe(`${compatibleModel.baseUrl}/chat/completions`);
			bodies.push(String(init?.body));
			if (bodies.length <= 2) {
				const interrupted = bodies.length === 2;
				return compatibleResponse(
					{
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: interrupted ? "partial-call" : "completed-call",
								type: "function",
								function: { name: "echo", arguments: interrupted ? '{"text":"partial' : '{"text":"before"}' },
							},
						],
					},
					interrupted ? null : "tool_calls",
					interrupted
						? new TypeError("terminated", {
								cause: Object.assign(new Error("socket closed"), { code: "UND_ERR_SOCKET" }),
							})
						: undefined,
				);
			}
			return compatibleResponse({ role: "assistant", content: "recovered" }, "stop");
		});

		await harness.session.promptAndWait("Run the local tool, then finish.");
		await harness.session.waitForIdle();

		expect(offlineFetch).toHaveBeenCalledTimes(3);
		expect(harness.faux.state.callCount).toBe(0);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(harness.eventsOfType("tool_execution_start").map(({ toolCallId }) => toolCallId)).toEqual([
			"completed-call",
		]);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(1);
		expect(harness.eventsOfType("auto_retry_end")).toMatchObject([{ success: true, attempt: 1 }]);
		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
		expect(harness.eventsOfType("agent_end")).toHaveLength(1);
		expect(continueAgent).not.toHaveBeenCalled();
		expect(bodies[2]).toBe(bodies[1]);
		const terminal = harness.eventsOfType("agent_end")[0]!;
		expect(terminal.refusal).toBeUndefined();
		const output = terminal.messages ?? [];
		expect(output).toHaveLength(5);
		expect(output.at(-1)).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "recovered" }] });
		const failed = output.find((message) => message.role === "assistant" && message.stopReason === "error");
		expect(failed).toMatchObject({
			errorMessage: "Provider transport interrupted (UND_ERR_SOCKET)",
			content: [{ type: "toolCall", id: "partial-call", name: "echo" }],
			diagnostics: [
				{
					type: "provider_stream_failure",
					details: { kind: "transport", providerErrorType: "UND_ERR_SOCKET" },
				},
			],
		});
		const entries = await harness.sessionManager.readEntries();
		expect(entries).toContainEqual(expect.objectContaining({ type: "message", message: failed }));
		const settled = entries.flatMap((entry) =>
			entry.type === "request" && entry.request.type === "attempt_settled" ? [entry.request] : [],
		);
		expect(settled.map(({ receipt }) => receipt.outcome)).toEqual(["completed", "interrupted", "completed"]);
		expect(settled[2].operationId).toBe(settled[1].operationId);
		// MAIN recompiles after the failed message ACK, keeping the operation but refreshing its source.
		expect(settled[2].source).toMatchObject({
			sessionId: settled[1].source.sessionId,
			sessionFile: settled[1].source.sessionFile,
			persistent: true,
		});
		expect(settled[2].source.leafId).not.toBe(settled[1].source.leafId);
		expect(settled[2].source.sourceSequence).toBeGreaterThan(settled[1].source.sourceSequence);
		expect(harness.session.isRetrying).toBe(false);
		expect(harness.session.hasAcceptedPromptInFlight).toBe(false);
	});

	it("recovers an actual OpenAI SDK timeout through native recovery", async () => {
		const harness = await createCompatibleHarness();
		const offlineFetch = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValueOnce(new OpenAI.APIConnectionTimeoutError())
			.mockRejectedValueOnce(new OpenAI.APIConnectionTimeoutError())
			.mockRejectedValueOnce(new OpenAI.APIConnectionTimeoutError())
			.mockImplementation(async () => compatibleResponse({ role: "assistant", content: "recovered" }, "stop"));

		await harness.session.promptAndWait("Recover the local SDK timeout.");
		await harness.session.waitForIdle();

		expect(offlineFetch).toHaveBeenCalledTimes(4);
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(1);
		expect(harness.eventsOfType("auto_retry_end")).toMatchObject([{ success: true, attempt: 1 }]);
		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
		expect(harness.eventsOfType("agent_end")).toHaveLength(1);
		const output = harness.eventsOfType("agent_end")[0].messages ?? [];
		expect(output.find((message) => message.role === "assistant" && message.stopReason === "error")).toMatchObject({
			errorMessage: "Request timed out.",
			diagnostics: [
				{
					type: "provider_stream_failure",
					details: { kind: "transport", providerErrorType: "APIConnectionTimeoutError" },
				},
			],
		});
		expect(output.at(-1)).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "recovered" }] });
		expect(harness.session.isRetrying).toBe(false);
	});

	it("does not retry unstructured OpenAI-compatible timeout wording", async () => {
		const harness = await createCompatibleHarness();
		const offlineFetch = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(compatibleResponse({ content: "partial" }, null, new Error("Request timed out.")))
			.mockImplementation(async () => compatibleResponse({ content: "unused" }, "stop"));

		await harness.session.promptAndWait("Keep unstructured timeout wording terminal.");
		await harness.session.waitForIdle();

		expect(offlineFetch).toHaveBeenCalledTimes(1);
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		expect(harness.eventsOfType("auto_retry_end")).toEqual([]);
		expect(harness.eventsOfType("agent_end")).toHaveLength(1);
		expect(harness.eventsOfType("agent_end")[0].messages?.at(-1)).toMatchObject({
			stopReason: "error",
			errorMessage: "Request timed out.",
			diagnostics: [{ type: "provider_stream_failure", details: { kind: "unknown" } }],
		});
		expect(harness.session.isRetrying).toBe(false);
	});

	it("does not retry an OpenAI-compatible HTTP auth failure despite a transient body type", async () => {
		const harness = await createCompatibleHarness();
		// The SDK exposes error.type and status separately; permanent HTTP status must win.
		const offlineFetch = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ error: { message: "Denied", type: "overloaded_error" } }), {
					status: 401,
					headers: { "content-type": "application/json", "x-request-id": "offline-auth-request" },
				}),
			)
			.mockImplementation(async () => compatibleResponse({ content: "unused" }, "stop"));

		await harness.session.promptAndWait("Local auth failure.");
		await harness.session.waitForIdle();

		expect(offlineFetch).toHaveBeenCalledTimes(1);
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		expect(harness.eventsOfType("auto_retry_end")).toEqual([]);
		expect(harness.eventsOfType("agent_end")).toHaveLength(1);
		expect(harness.eventsOfType("agent_end")[0].messages?.at(-1)).toMatchObject({
			stopReason: "error",
			errorMessage:
				"Provider authentication failed (overloaded_error, 401): Denied [request_id: offline-auth-request]\n\nRun /login to update credentials.",
			diagnostics: [
				{
					type: "provider_stream_failure",
					details: {
						kind: "auth",
						status: 401,
						providerErrorType: "overloaded_error",
						requestId: "offline-auth-request",
					},
				},
			],
		});
		expect(harness.session.isRetrying).toBe(false);
		expect(harness.session.hasAcceptedPromptInFlight).toBe(false);
	});

	it("prompt waits for retry completion even when assistant message_end handling is delayed", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("message_end", async (event) => {
						if (event.message.role === "assistant") {
							await new Promise((resolve) => setTimeout(resolve, 40));
						}
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			structuredProviderFailure("overloaded", "overloaded_error"),
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.isRetrying).toBe(false);
	});

	it("accepted agent message prompts keep retry state queued after returning", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 40 } } });
		harnesses.push(harness);
		harness.setResponses([
			structuredProviderFailure("overloaded", "overloaded_error"),
			fauxAssistantMessage("recovered"),
		]);
		const sawRetryStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "auto_retry_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		await harness.session.acceptAgentMessagePrompt("agent-to-agent payload", { expandPromptTemplates: false });
		await sawRetryStart;

		expect(harness.session.isRetrying).toBe(true);
		expect(harness.session.hasAcceptedPromptInFlight).toBe(true);
		await expect(
			harness.session.prompt("second", { queueIfBusy: true, streamingBehavior: "followUp" }),
		).resolves.toBeUndefined();
		expect(harness.session.queuedActionCount).toBe(1);
	});

	it("does not retry when retry is disabled", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		harness.setResponses([structuredProviderFailure("overloaded", "overloaded_error")]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
	});

	it("does not retry faux provider queue exhaustion", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		harnesses.push(harness);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		expect(harness.session.isRetrying).toBe(false);
	});

	it("does not retry local agent lifecycle listener failures", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		harnesses.push(harness);
		let unsubscribe = () => {};
		unsubscribe = harness.session.agent.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "assistant") {
				unsubscribe();
				throw new Error("local listener failed");
			}
		});
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("retry should not happen")]);

		await harness.session.prompt("test");

		const lastMessage = harness.session.messages.at(-1);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		expect(harness.session.isRetrying).toBe(false);
		expect(lastMessage?.role).toBe("assistant");
		if (lastMessage?.role === "assistant") {
			expect(lastMessage.diagnostics?.some((diagnostic) => diagnostic.type === "agent_lifecycle_failure")).toBe(
				true,
			);
		}
	});

	for (const [name, errorMessage] of [
		["network finish reason", "Provider finish_reason: network_error"],
		["content-filter finish reason", "Provider finish_reason: content_filter"],
		["empty response", "Provider returned an empty response"],
		["cybersecurity policy flag", "Your request was flagged for cybersecurity risk and cannot be processed."],
		["usage policy flag", "flagged as potentially violating our usage policy"],
		["prose-form transient 5xx", "An error occurred while processing your request. You can retry your request."],
	] as const) {
		it(`does not retry unclassified ${name}`, async () => {
			const harness = await createHarness({
				settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
			});
			harnesses.push(harness);
			harness.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage }),
				fauxAssistantMessage("recovered"),
			]);

			await harness.session.prompt("test");

			expect(harness.faux.state.callCount).toBe(1);
			expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
			expect(harness.eventsOfType("auto_retry_end")).toEqual([]);
			expect(harness.session.isRetrying).toBe(false);
		});
	}

	it("does not retry generic provider errors", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" }),
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		expect(harness.eventsOfType("auto_retry_end")).toEqual([]);
	});

	for (const kind of ["auth", "invalid_request", "refusal"] as const) {
		it(`does not retry structured permanent provider ${kind} failures`, async () => {
			const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
			harnesses.push(harness);
			harness.setResponses([
				structuredProviderFailure(kind),
				structuredProviderFailure(kind),
				fauxAssistantMessage("unused"),
			]);

			await harness.session.prompt("test");

			expect(harness.faux.state.callCount).toBe(1);
			expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
			expect(harness.eventsOfType("auto_retry_end")).toEqual([]);
			expect(harness.session.isRetrying).toBe(false);
		});
	}

	it("keeps retry state active when overflow compaction will retry", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		harnesses.push(harness);
		const internals = harness.session as unknown as SessionRetryCompactionInternals;
		const originalCheckCompaction = internals._checkCompaction.bind(harness.session);
		const overflowMessage = fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "prompt is too long",
		});
		internals._retryAttempt = 1;
		internals._retryPromise = new Promise<void>((resolve) => {
			internals._retryResolve = resolve;
		});
		internals._checkCompaction = async () => true;

		try {
			await internals._processAgentEvent({ type: "agent_end", messages: [overflowMessage] } as AgentEvent);

			expect(internals._retryAttempt).toBe(1);
			expect(harness.session.isRetrying).toBe(true);
			expect(harness.eventsOfType("auto_retry_end")).toEqual([]);
		} finally {
			internals._checkCompaction = originalCheckCompaction;
			harness.session.abortRetry();
		}
	});

	it("cancels overflow-compaction retry continuation when abortRetry is called", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		harnesses.push(harness);
		const internals = harness.session as unknown as SessionRetryCompactionInternals;
		const compactionAbortController = new AbortController();
		internals._retryAttempt = 1;
		internals._retryPromise = new Promise<void>((resolve) => {
			internals._retryResolve = resolve;
		});
		internals._autoCompactionAbortController = compactionAbortController;
		internals._schedulePostCompactionContinue();

		try {
			expect(internals._postCompactionContinuationScheduled).toBe(true);

			harness.session.abortRetry();

			expect(compactionAbortController.signal.aborted).toBe(true);
			expect(internals._postCompactionContinuationScheduled).toBe(false);
			expect(internals._retryAttempt).toBe(0);
			expect(harness.session.isRetrying).toBe(false);
			expect(harness.eventsOfType("auto_retry_end").at(-1)).toMatchObject({
				success: false,
				attempt: 1,
				finalError: "Retry cancelled",
			});
		} finally {
			internals._autoCompactionAbortController = undefined;
			internals._cancelPostCompactionContinue();
		}
	});

	it("cancels a persisted invocation during retry backoff without a later provider send", async () => {
		const harness = await createHarness({
			persistSession: true,
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 60_000, provider: { maxRetryDelayMs: 0 } } },
		});
		harnesses.push(harness);
		const continueAgent = vi.spyOn(harness.session.agent, "continue");
		harness.setResponses([
			structuredProviderFailure("transport"),
			fauxAssistantMessage("must remain unused after cancellation"),
		]);
		const sawRetryStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "auto_retry_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.promptAndWait("test");
		await sawRetryStart;
		expect(harness.eventsOfType("auto_retry_start")[0].delayMs).toBe(60_000);
		expect(harness.session.isRetrying).toBe(true);
		expect(harness.session.hasAcceptedPromptInFlight).toBe(true);
		harness.session.abortRetry();
		await promptPromise;
		await harness.session.waitForIdle();

		expect(harness.session.isRetrying).toBe(false);
		expect(harness.session.hasAcceptedPromptInFlight).toBe(false);
		expect(harness.eventsOfType("auto_retry_end")).toHaveLength(1);
		expect(harness.eventsOfType("auto_retry_end")[0]).toMatchObject({ success: false, attempt: 1 });
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(continueAgent).not.toHaveBeenCalled();
		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
		expect(harness.eventsOfType("agent_end")).toHaveLength(1);
		expect(harness.eventsOfType("message_end").at(-1)?.message).toMatchObject({
			role: "assistant",
			stopReason: "aborted",
		});
		const entries = await harness.sessionManager.readEntries();
		expect(
			entries.some(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					entry.message.stopReason === "error" &&
					entry.message.errorMessage === "provider transport failure",
			),
		).toBe(true);
	});

	it("waits for the full loop when retry recovery produces tool calls", async () => {
		const toolRuns: string[] = [];
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				toolRuns.push(text);
				return { content: [{ type: "text", text: `echo:${text}` }], details: { text } };
			},
		};
		const harness = await createHarness({
			tools: [echoTool],
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			structuredProviderFailure("overloaded", "overloaded_error"),
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("final answer"),
		]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(3);
		expect(toolRuns).toEqual(["hello"]);
		expect(harness.session.isStreaming).toBe(false);
		harness.appendResponses([fauxAssistantMessage("follow-up answer")]);
		await harness.session.prompt("follow-up");
		expect(harness.faux.state.callCount).toBe(4);
	});

	it("emits extension events before public event subscribers", async () => {
		const order: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("message_start", async (event) => {
						order.push(`extension:${event.type}:${event.message.role}`);
					});
					pi.on("message_end", async (event) => {
						order.push(`extension:${event.type}:${event.message.role}`);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.subscribe((event) => {
			if (event.type === "message_start" || event.type === "message_end") {
				order.push(`public:${event.type}:${event.message.role}`);
			}
		});
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("hi");

		expect(order).toEqual([
			"extension:message_start:user",
			"public:message_start:user",
			"extension:message_end:user",
			"public:message_end:user",
			"extension:message_start:assistant",
			"public:message_start:assistant",
			"extension:message_end:assistant",
			"public:message_end:assistant",
		]);
	});

	it("emits the expected event order for a single prompt", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("hello")]);

		await harness.session.prompt("hi");

		expect(normalizeEventOrder(harness.events)).toEqual([
			"agent_start",
			"turn_start",
			"message_start:user",
			"message_end:user",
			"message_start:assistant",
			"message_update",
			"message_end:assistant",
			"turn_end",
			"agent_end",
		]);
	});

	it("emits the expected event order for a tool call turn", async () => {
		const toolRuns: string[] = [];
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				toolRuns.push(text);
				return { content: [{ type: "text", text: `echo:${text}` }], details: { text } };
			},
		};
		const harness = await createHarness({ tools: [echoTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("hi");

		expect(toolRuns).toEqual(["hello"]);
		expect(normalizeEventOrder(harness.events)).toEqual([
			"agent_start",
			"turn_start",
			"message_start:user",
			"message_end:user",
			"message_start:assistant",
			"message_update",
			"message_end:assistant",
			"tool_execution_start:echo",
			"tool_execution_end:echo",
			"message_start:toolResult",
			"message_end:toolResult",
			"turn_end",
			"turn_start",
			"message_start:assistant",
			"message_update",
			"message_end:assistant",
			"turn_end",
			"agent_end",
		]);
	});

	it("emits streaming deltas for text, thinking, and tool calls in message_update events", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[fauxThinking("plan"), { type: "text", text: "answer" }, fauxToolCall("echo", { text: "hello" })],
				{
					stopReason: "toolUse",
				},
			),
		]);

		await harness.session.prompt("hi").catch(() => {});

		const updateTypes = harness.eventsOfType("message_update").map((event) => event.assistantMessageEvent.type);
		expect(updateTypes).toContain("thinking_delta");
		expect(updateTypes).toContain("text_delta");
		expect(updateTypes).toContain("toolcall_delta");
	});

	it("emits agent_end for error responses", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "broken" })]);

		await harness.session.prompt("hi");

		expect(harness.events[harness.events.length - 1]?.type).toBe("agent_end");
	});

	it("emits agent_end for aborted runs and persists the aborted assistant message", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("x".repeat(20_000))]);

		const sawMessageUpdate = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "message_update") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.prompt("hi");
		await sawMessageUpdate;
		await harness.session.abort();
		await promptPromise;

		expect(harness.events[harness.events.length - 1]?.type).toBe("agent_end");
		const lastMessage = harness.session.messages[harness.session.messages.length - 1];
		expect(lastMessage?.role).toBe("assistant");
		if (lastMessage?.role === "assistant") {
			expect(lastMessage.stopReason).toBe("aborted");
		}
	});
});
