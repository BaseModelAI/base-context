import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeOpenAICodexWebSocketSessions,
	getOpenAICodexWebSocketDebugStats,
	resetOpenAICodexWebSocketDebugStats,
	streamOpenAICodexResponses,
	streamSimpleOpenAICodexResponses,
} from "../src/providers/openai-codex-responses.js";
import type {
	AssistantMessage,
	Context,
	Model,
	ProviderAttemptObserver,
	ProviderAttemptReceipt,
} from "../src/types.js";
import {
	type ProviderRequestRepresentation,
	type RequestTokenAssessment,
	RequestTokenBudget,
	RequestTokenBudgetError,
} from "../src/utils/request-token-budget.js";

const originalFetch = global.fetch;
const originalWebSocket = globalThis.WebSocket;
const originalAgentDir = process.env.BASE_CONTEXT_HOME;

afterEach(() => {
	global.fetch = originalFetch;
	globalThis.WebSocket = originalWebSocket;
	if (originalAgentDir === undefined) {
		delete process.env.BASE_CONTEXT_HOME;
	} else {
		process.env.BASE_CONTEXT_HOME = originalAgentDir;
	}
	closeOpenAICodexWebSocketSessions();
	resetOpenAICodexWebSocketDebugStats();
	vi.restoreAllMocks();
});

function mockToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

// Synthetic configured estimates and existing mock usage, not Codex tokenizer accuracy.
function cachedRequestBudget() {
	return new RequestTokenBudget({
		mode: "enforce",
		profiles: [
			{
				id: "fixture-codex",
				revision: "fixture-v1",
				api: "openai-codex-responses",
				provider: "openai-codex",
				url: "https://chatgpt.com/backend-api/codex/responses",
				model: "gpt-5.1-codex",
				authMode: "fixture-subscription",
				templateRevision: "fixture-template",
				replayFamily: "fixture-responses",
				responseModels: ["gpt-5.1-codex-snapshot"],
				contextTokens: 4096,
				outputCeilingTokens: 64,
				estimate: { tokensPerUtf8Byte: 1, templateTokens: 9, marginTokens: 17 },
			},
		],
	});
}

function buildSSEPayload({
	status,
	includeDone = false,
}: {
	status: "completed" | "incomplete";
	includeDone?: boolean;
}): string {
	const terminalType = status === "incomplete" ? "response.incomplete" : "response.completed";
	const events = [
		`data: ${JSON.stringify({
			type: "response.output_item.added",
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		})}`,
		`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
		`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "Hello" }],
			},
		})}`,
		`data: ${JSON.stringify({
			type: terminalType,
			response: {
				status,
				incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
				usage: {
					input_tokens: 5,
					output_tokens: 3,
					total_tokens: 8,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		})}`,
	];

	if (includeDone) {
		events.push("data: [DONE]");
	}

	return `${events.join("\n\n")}\n\n`;
}

describe("Codex websocket connection identity", () => {
	const model: Model<"openai-codex-responses"> = {
		id: "gpt-5.1-codex",
		name: "Fixture Codex",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	};
	const context: Context = { messages: [{ role: "user", content: "Hello", timestamp: 0 }] };
	const options = { apiKey: mockToken(), sessionId: "connection-identity", transport: "websocket-cached" as const };

	class MockWebSocket extends EventTarget {
		static instances: MockWebSocket[] = [];
		readyState = 1;
		autoComplete = true;
		bodies: { previous_response_id?: string; input: unknown[] }[] = [];
		constructor(readonly url: string) {
			super();
			MockWebSocket.instances.push(this);
			queueMicrotask(() => this.dispatchEvent(new Event("open")));
		}
		send(data: string): void {
			this.bodies.push(JSON.parse(data));
			if (this.autoComplete) queueMicrotask(() => this.complete());
		}
		complete(): void {
			this.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({
						type: "response.completed",
						response: { id: "resp_fixture", status: "completed", output: [] },
					}),
				}),
			);
		}
		close(): void {
			this.readyState = 3;
		}
	}

	it("reuses unchanged auth despite trace headers, but replaces changed auth and URLs", async () => {
		MockWebSocket.instances = [];
		globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
		global.fetch = vi.fn(async () => {
			throw new Error("Unexpected SSE fallback");
		});
		expect((await streamOpenAICodexResponses(model, context, options).result()).stopReason).toBe("stop");
		const first = MockWebSocket.instances[0];
		expect(
			(
				await streamOpenAICodexResponses(model, context, {
					...options,
					headers: { traceparent: "new-trace" },
				}).result()
			).stopReason,
		).toBe("stop");
		expect(MockWebSocket.instances).toHaveLength(1);
		expect(first.bodies[1].previous_response_id).toBe("resp_fixture");
		const changedAuth = { ...options, apiKey: `${mockToken()}-rotated` };
		expect((await streamOpenAICodexResponses(model, context, changedAuth).result()).stopReason).toBe("stop");
		expect(MockWebSocket.instances).toHaveLength(2);
		expect(first.readyState).toBe(3);
		expect(first.bodies).toHaveLength(2);
		const second = MockWebSocket.instances[1];
		expect(second.bodies[0].previous_response_id).toBeUndefined();
		expect(second.bodies[0].input).toHaveLength(1);
		expect(
			(
				await streamOpenAICodexResponses(
					{ ...model, baseUrl: "https://other.invalid" },
					context,
					changedAuth,
				).result()
			).stopReason,
		).toBe("stop");
		expect(MockWebSocket.instances).toHaveLength(3);
		expect(second.readyState).toBe(3);
		expect(MockWebSocket.instances[2].url).toBe("wss://other.invalid/codex/responses");
		expect(MockWebSocket.instances[2].bodies[0].previous_response_id).toBeUndefined();
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it("keeps a busy socket with its owner and does not let its stale release evict a replacement", async () => {
		MockWebSocket.instances = [];
		globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
		global.fetch = vi.fn(async () => {
			throw new Error("Unexpected SSE fallback");
		});
		await streamOpenAICodexResponses(model, context, options).result();
		const owner = MockWebSocket.instances[0];
		owner.autoComplete = false;
		let sent!: () => void;
		const sending = new Promise<void>((resolve) => {
			sent = resolve;
		});
		const send = owner.send.bind(owner);
		vi.spyOn(owner, "send").mockImplementation((data) => {
			send(data);
			sent();
		});
		const busy = streamOpenAICodexResponses(model, context, options);
		await sending;
		const changedAuth = { ...options, apiKey: `${mockToken()}-rotated` };
		expect((await streamOpenAICodexResponses(model, context, changedAuth).result()).stopReason).toBe("stop");
		expect(owner.readyState).toBe(1);
		expect(owner.bodies).toHaveLength(2);
		expect(MockWebSocket.instances[1].readyState).toBe(3);
		expect(MockWebSocket.instances[1].bodies[0].previous_response_id).toBeUndefined();

		closeOpenAICodexWebSocketSessions(options.sessionId);
		await streamOpenAICodexResponses(model, context, changedAuth).result();
		const replacement = MockWebSocket.instances[2];
		owner.complete();
		expect((await busy.result()).stopReason).toBe("stop");
		await streamOpenAICodexResponses(model, context, changedAuth).result();
		expect(MockWebSocket.instances).toHaveLength(3);
		expect(replacement.bodies).toHaveLength(2);
		expect(replacement.readyState).toBe(1);
		expect(global.fetch).not.toHaveBeenCalled();
	});
});

describe("openai-codex streaming", () => {
	it.each(["body transport", "permanent HTTP", "top-level API", "nested API"] as const)(
		"preserves %s failure identity without restarting the provider stream",
		async (failure) => {
			process.env.BASE_CONTEXT_HOME = mkdtempSync(join(tmpdir(), "codex-recovery-"));
			const model: Model<"openai-codex-responses"> = {
				id: "gpt-5.1-codex",
				name: "Fixture Codex",
				api: "openai-codex-responses",
				provider: "openai-codex",
				baseUrl: "https://chatgpt.com/backend-api",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 400000,
				maxTokens: 128000,
			};
			let sentPartial = false;
			const body = new ReadableStream<Uint8Array>({
				pull(controller) {
					if (!sentPartial) {
						sentPartial = true;
						const partial = buildSSEPayload({ status: "completed" }).split("\n\n").slice(0, 3).join("\n\n");
						controller.enqueue(new TextEncoder().encode(`${partial}\n\n`));
					} else {
						controller.error(
							new TypeError("terminated", {
								cause: Object.assign(new Error("socket closed"), { code: "UND_ERR_SOCKET" }),
							}),
						);
					}
				},
			});
			const apiError = { message: "Fixture request rejected", code: "invalid_request_error" };
			const apiEvent =
				failure === "nested API" ? { type: "error", error: apiError } : { type: "error", ...apiError };
			const response =
				failure === "body transport"
					? new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
					: failure === "permanent HTTP"
						? new Response(JSON.stringify({ error: { message: "Denied", code: "overloaded_error" } }), {
								status: 401,
								statusText: "Unauthorized",
							})
						: new Response(`data: ${JSON.stringify(apiEvent)}\n\n`, {
								status: 200,
								headers: { "content-type": "text/event-stream" },
							});
			const fetchMock = vi.fn(async () => response);
			global.fetch = fetchMock as typeof fetch;
			const stream = streamOpenAICodexResponses(
				model,
				{
					messages: [{ role: "user", content: "Hello", timestamp: 0 }],
				},
				{ apiKey: mockToken(), transport: "sse" },
			);
			const events: string[] = [];
			for await (const event of stream) events.push(event.type);
			const result = await stream.result();
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(events.filter((type) => type === "error")).toHaveLength(1);
			expect(result.stopReason).toBe("error");
			const details = result.diagnostics?.find((entry) => entry.type === "provider_stream_failure")?.details;
			if (failure === "body transport") {
				expect(events.filter((type) => type === "start")).toHaveLength(1);
				expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "Hello" }));
				expect(details).toMatchObject({ kind: "transport", providerErrorType: "UND_ERR_SOCKET" });
			} else if (failure === "permanent HTTP") {
				expect(details).toMatchObject({ kind: "auth", status: 401 });
			} else {
				expect(result.errorMessage).toBe(`Codex error: ${apiError.message}`);
				expect(details).toMatchObject({ kind: "invalid_request", providerErrorType: apiError.code });
			}
		},
	);

	it("streams SSE responses into AssistantMessageEventStream", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-codex-stream-"));
		process.env.BASE_CONTEXT_HOME = tempDir;

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toString("base64");
		const token = `aaa.${payload}.bbb`;

		const sse = `${[
			`data: ${JSON.stringify({
				type: "response.output_item.added",
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			})}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hello" }],
				},
			})}`,
			`data: ${JSON.stringify({
				type: "response.completed",
				response: {
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 3,
						total_tokens: 8,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			})}`,
		].join("\n\n")}\n\n`;

		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sse));
				controller.close();
			},
		});

		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				const headers = init?.headers instanceof Headers ? init.headers : undefined;
				expect(headers?.get("Authorization")).toBe(`Bearer ${token}`);
				expect(headers?.get("chatgpt-account-id")).toBe("acc_test");
				expect(headers?.get("OpenAI-Beta")).toBe("responses=experimental");
				expect(headers?.get("originator")).toBe("pi");
				expect(headers?.get("accept")).toBe("text/event-stream");
				expect(headers?.has("x-api-key")).toBe(false);
				return new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});

		global.fetch = fetchMock as typeof fetch;

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};

		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const streamResult = streamOpenAICodexResponses(model, context, { apiKey: token, transport: "sse" });
		let sawTextDelta = false;
		let sawDone = false;

		for await (const event of streamResult) {
			if (event.type === "text_delta") {
				sawTextDelta = true;
			}
			if (event.type === "done") {
				sawDone = true;
				expect(event.message.content.find((c) => c.type === "text")?.text).toBe("Hello");
			}
		}

		expect(sawTextDelta).toBe(true);
		expect(sawDone).toBe(true);
	});

	it("completes after response.completed even when the SSE body stays open", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-codex-stream-"));
		process.env.BASE_CONTEXT_HOME = tempDir;
		const token = mockToken();
		const encoder = new TextEncoder();
		const sse = buildSSEPayload({ status: "completed", includeDone: true });

		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sse));
			},
		});

		global.fetch = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				return new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch;

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};

		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const result = await Promise.race([
			streamOpenAICodexResponses(model, context, { apiKey: token, transport: "sse" }).result(),
			new Promise<never>((_, reject) => {
				setTimeout(() => reject(new Error("Timed out waiting for completed SSE stream")), 1000);
			}),
		]);

		expect(result.content.find((c) => c.type === "text")?.text).toBe("Hello");
		expect(result.stopReason).toBe("stop");
	});

	it("maps response.incomplete to stopReason length even when the SSE body stays open", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-codex-stream-"));
		process.env.BASE_CONTEXT_HOME = tempDir;
		const token = mockToken();
		const encoder = new TextEncoder();
		const sse = buildSSEPayload({ status: "incomplete" });

		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sse));
			},
		});

		global.fetch = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				return new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch;

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};

		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const result = await Promise.race([
			streamOpenAICodexResponses(model, context, { apiKey: token, transport: "sse" }).result(),
			new Promise<never>((_, reject) => {
				setTimeout(() => reject(new Error("Timed out waiting for incomplete SSE stream")), 1000);
			}),
		]);

		expect(result.content.find((c) => c.type === "text")?.text).toBe("Hello");
		expect(result.stopReason).toBe("length");
	});

	it("sets session_id/x-client-request-id headers and prompt_cache_key when sessionId is provided", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-codex-stream-"));
		process.env.BASE_CONTEXT_HOME = tempDir;

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toString("base64");
		const token = `aaa.${payload}.bbb`;

		const sse = `${[
			`data: ${JSON.stringify({
				type: "response.output_item.added",
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			})}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hello" }],
				},
			})}`,
			`data: ${JSON.stringify({
				type: "response.completed",
				response: {
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 3,
						total_tokens: 8,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			})}`,
		].join("\n\n")}\n\n`;

		const sessionId = "test-session-123";
		const captured: { headers: Headers; body: Record<string, unknown> }[] = [];
		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				captured.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });

				return new Response(sse, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});

		global.fetch = fetchMock as typeof fetch;

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};

		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
			tools: [{ name: "lookup", description: "Lookup text", parameters: Type.Object({ value: Type.String() }) }],
		};

		const streamResult = streamOpenAICodexResponses(model, context, { apiKey: token, sessionId, transport: "sse" });
		expect((await streamResult.result()).stopReason).toBe("stop");
		context.tools![0] = {
			name: "lookup_number",
			description: "Lookup number",
			parameters: Type.Object({ value: Type.Number() }),
		};
		const uncached = streamOpenAICodexResponses(model, context, {
			apiKey: token,
			sessionId,
			transport: "sse",
			cacheRetention: "none",
		});
		expect((await uncached.result()).stopReason).toBe("stop");
		expect(captured).toHaveLength(2);
		for (const { headers } of captured) {
			expect(headers.get("session_id")).toBe(sessionId);
			expect(headers.get("x-client-request-id")).toBe(sessionId);
			expect(headers.get("chatgpt-account-id")).toBe("acc_test");
		}
		expect(captured[0].body.prompt_cache_key).toBe(sessionId);
		expect(captured[1].body).not.toHaveProperty("prompt_cache_key");
		expect(captured[0].body.tools).toMatchObject([
			{ name: "lookup", parameters: { properties: { value: { type: "string" } } } },
		]);
		expect(captured[1].body.tools).toMatchObject([
			{ name: "lookup_number", parameters: { properties: { value: { type: "number" } } } },
		]);
	});

	it("preserves gpt-5.5 xhigh reasoning effort from simple options", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-codex-stream-"));
		process.env.BASE_CONTEXT_HOME = tempDir;
		const token = mockToken();
		const sse = buildSSEPayload({ status: "completed" });
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sse));
				controller.close();
			},
		});
		let requestedReasoning: unknown;

		global.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
				requestedReasoning = body?.reasoning;
				return new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch;

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.5",
			name: "GPT-5.5",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			thinkingLevelMap: { xhigh: "xhigh" },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};
		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		await streamSimpleOpenAICodexResponses(model, context, {
			apiKey: token,
			reasoning: "xhigh",
			transport: "sse",
		}).result();

		expect(requestedReasoning).toEqual({ effort: "xhigh", summary: "auto" });
	});

	it.each(["gpt-5.3-codex", "gpt-5.4", "gpt-5.5"])("clamps %s minimal reasoning effort to low", async (modelId) => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-codex-stream-"));
		process.env.BASE_CONTEXT_HOME = tempDir;

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toString("base64");
		const token = `aaa.${payload}.bbb`;

		const sse = `${[
			`data: ${JSON.stringify({
				type: "response.output_item.added",
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			})}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hello" }],
				},
			})}`,
			`data: ${JSON.stringify({
				type: "response.completed",
				response: {
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 3,
						total_tokens: 8,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			})}`,
		].join("\n\n")}\n\n`;

		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sse));
				controller.close();
			},
		});

		let requestedReasoning: unknown;
		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
				requestedReasoning = body?.reasoning;

				return new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});

		global.fetch = fetchMock as typeof fetch;

		const model: Model<"openai-codex-responses"> = {
			id: modelId,
			name: modelId,
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			thinkingLevelMap: { minimal: "low", xhigh: "xhigh" },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};

		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const streamResult = streamOpenAICodexResponses(model, context, {
			apiKey: token,
			transport: "sse",
			reasoningEffort: "minimal",
		});
		const result = await streamResult.result();
		expect(result.stopReason).toBe("stop");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(requestedReasoning).toEqual({ effort: "low", summary: "auto" });
	});

	it.each([
		["gpt-5.1-codex", "flex", 0.5],
		["gpt-5.1-codex", "priority", 2],
		["gpt-5.4", "priority", 2],
		["gpt-5.5", "flex", 0.5],
		["gpt-5.5", "priority", 2.5],
		["gpt-5.6-sol", "priority", 2],
	] as const)(
		"uses the client-sent %s service tier for %s when Codex echoes default",
		async (modelId, serviceTier, multiplier) => {
			const tempDir = mkdtempSync(join(tmpdir(), "pi-codex-stream-"));
			process.env.BASE_CONTEXT_HOME = tempDir;
			const token = mockToken();
			const sse = `${[
				`data: ${JSON.stringify({
					type: "response.output_item.added",
					item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
				})}`,
				`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
				`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
				`data: ${JSON.stringify({
					type: "response.output_item.done",
					item: {
						type: "message",
						id: "msg_1",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "Hello" }],
					},
				})}`,
				`data: ${JSON.stringify({
					type: "response.completed",
					response: {
						status: "completed",
						service_tier: "default",
						usage: {
							input_tokens: 1000000,
							output_tokens: 1000000,
							total_tokens: 2000000,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				})}`,
			].join("\n\n")}\n\n`;

			const encoder = new TextEncoder();
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(encoder.encode(sse));
					controller.close();
				},
			});

			global.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();
				if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
					return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
				}
				if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
					return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
				}
				if (url === "https://chatgpt.com/backend-api/codex/responses") {
					const body = JSON.parse(String(init?.body)) as { service_tier?: string };
					expect(body.service_tier).toBe(serviceTier);
					return new Response(stream, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					});
				}
				return new Response("not found", { status: 404 });
			}) as typeof fetch;

			const model: Model<"openai-codex-responses"> = {
				id: modelId,
				name: modelId === "gpt-5.5" ? "GPT-5.5" : "GPT-5.1 Codex",
				api: "openai-codex-responses",
				provider: "openai-codex",
				baseUrl: "https://chatgpt.com/backend-api",
				reasoning: true,
				input: ["text"],
				cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 400000,
				maxTokens: 128000,
			};

			const context: Context = {
				systemPrompt: "You are a helpful assistant.",
				messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
			};

			const result = await streamOpenAICodexResponses(model, context, {
				apiKey: token,
				serviceTier,
				transport: "sse",
			}).result();

			expect(result.usage.cost.input).toBe(1 * multiplier);
			expect(result.usage.cost.output).toBe(2 * multiplier);
			expect(result.usage.cost.total).toBe(3 * multiplier);
		},
	);

	it("does not set session_id/x-client-request-id headers when sessionId is not provided", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-codex-stream-"));
		process.env.BASE_CONTEXT_HOME = tempDir;

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toString("base64");
		const token = `aaa.${payload}.bbb`;

		const sse = `${[
			`data: ${JSON.stringify({
				type: "response.output_item.added",
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			})}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hello" }],
				},
			})}`,
			`data: ${JSON.stringify({
				type: "response.completed",
				response: {
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 3,
						total_tokens: 8,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			})}`,
		].join("\n\n")}\n\n`;

		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sse));
				controller.close();
			},
		});

		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				const headers = init?.headers instanceof Headers ? init.headers : undefined;
				expect(headers?.has("session_id")).toBe(false);
				expect(headers?.has("x-client-request-id")).toBe(false);

				return new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});

		global.fetch = fetchMock as typeof fetch;

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};

		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const streamResult = streamOpenAICodexResponses(model, context, { apiKey: token, transport: "sse" });
		await streamResult.result();
	});
	it("forwards auto transport from streamSimple options and uses cached websocket context", async () => {
		const token = mockToken();
		const sentBodies: unknown[] = [];

		global.fetch = vi.fn(async () => new Response("unexpected fetch", { status: 500 })) as typeof fetch;

		class MockWebSocket {
			private listeners = new Map<string, Set<(event: unknown) => void>>();

			constructor(_url: string, _protocols?: string | string[] | { headers?: Record<string, string> }) {
				queueMicrotask(() => this.dispatch("open", {}));
			}

			addEventListener(type: string, listener: (event: unknown) => void): void {
				let listeners = this.listeners.get(type);
				if (!listeners) {
					listeners = new Set();
					this.listeners.set(type, listeners);
				}
				listeners.add(listener);
			}

			removeEventListener(type: string, listener: (event: unknown) => void): void {
				this.listeners.get(type)?.delete(listener);
			}

			send(data: string): void {
				sentBodies.push(JSON.parse(data));
				const events = [
					{
						type: "response.output_item.added",
						item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
					},
					{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
					{ type: "response.output_text.delta", delta: "Hello" },
					{
						type: "response.output_item.done",
						item: {
							type: "message",
							id: "msg_1",
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: "Hello" }],
						},
					},
					{
						type: "response.completed",
						response: {
							status: "completed",
							usage: {
								input_tokens: 5,
								output_tokens: 3,
								total_tokens: 8,
								input_tokens_details: { cached_tokens: 0 },
							},
						},
					},
				];
				queueMicrotask(() => {
					for (const event of events) {
						this.dispatch("message", { data: JSON.stringify(event) });
					}
				});
			}

			close(): void {}

			private dispatch(type: string, event: unknown): void {
				for (const listener of this.listeners.get(type) ?? []) {
					listener(event);
				}
			}
		}

		globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};
		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: 1 }],
		};

		await streamSimpleOpenAICodexResponses(model, context, {
			apiKey: token,
			sessionId: "session-auto",
			transport: "auto",
		}).result();

		expect(sentBodies).toHaveLength(1);
		expect(global.fetch).not.toHaveBeenCalled();
		expect(getOpenAICodexWebSocketDebugStats("session-auto")).toMatchObject({
			cachedContextRequests: 1,
			fullContextRequests: 1,
		});

		// The original unconfigured response has no acknowledged attempt or response ID.
		const budget = cachedRequestBudget();
		let measured: ProviderRequestRepresentation | undefined;
		let refusal: unknown;
		const admit = vi.fn(async () => {
			throw new Error("Local budget refusal reached admission");
		});
		const close = vi.spyOn(MockWebSocket.prototype, "close");
		const beforeRefusal = getOpenAICodexWebSocketDebugStats("session-auto");
		const refused = await streamSimpleOpenAICodexResponses(model, context, {
			apiKey: token,
			sessionId: "session-auto",
			transport: "auto",
			onPayload(payload) {
				return {
					...(payload as object),
					input: [{ type: "reasoning", encrypted_content: "fixture-opaque", summary: [] }],
				};
			},
			attempts: {
				measureRequest(request) {
					measured = request;
					const assessment = budget.measure(request);
					expect(assessment).toMatchObject({ status: "unknown", aggressivePacking: false });
					try {
						budget.assert(assessment);
					} catch (error) {
						refusal = error;
						throw error;
					}
					return assessment;
				},
				admit,
				async settle() {
					throw new Error("Local budget refusal reached settlement");
				},
			},
		}).result();
		expect(refused.stopReason).toBe("error");
		expect(refusal).toBeInstanceOf(RequestTokenBudgetError);
		expect(measured?.url).toBe("wss://chatgpt.com/backend-api/codex/responses");
		expect(measured?.retainedPrefix).toBeUndefined();
		expect(admit).not.toHaveBeenCalled();
		expect(close).not.toHaveBeenCalled();
		expect(sentBodies).toHaveLength(1);
		expect(global.fetch).not.toHaveBeenCalled();
		expect(getOpenAICodexWebSocketDebugStats("session-auto")).toEqual(beforeRefusal);
	});

	it("sends only response input deltas in websocket-cached mode", async () => {
		const token = mockToken();
		const sentBodies: unknown[] = [];
		const receipts: ProviderAttemptReceipt[] = [];
		const budget = cachedRequestBudget();
		const measured: ProviderRequestRepresentation[] = [];
		const assessments: RequestTokenAssessment[] = [];
		const refusals: unknown[] = [];
		let pendingBody: unknown;
		let releaseFirstAck!: () => void;
		let firstSettlementStarted!: () => void;
		const firstAck = new Promise<void>((resolve) => {
			releaseFirstAck = resolve;
		});
		const settlementStarted = new Promise<void>((resolve) => {
			firstSettlementStarted = resolve;
		});
		let admitted = 0;
		const attempts: ProviderAttemptObserver = {
			measureRequest(request) {
				measured.push(request);
				const assessment = budget.measure(request);
				assessments.push(assessment);
				try {
					budget.assert(assessment);
				} catch (error) {
					refusals.push(error);
					throw error;
				}
				return assessment;
			},
			async admit() {
				await Promise.resolve();
				return `attempt_${++admitted}`;
			},
			async settle(receipt) {
				receipts.push(receipt);
				if (receipts.length === 1) {
					firstSettlementStarted();
					await firstAck;
				}
			},
		};
		global.fetch = vi.fn(async () => {
			throw new Error("unexpected fetch");
		}) as typeof fetch;
		const responses = [
			{ responseId: "resp_1", messageId: "msg_1", text: "Hello" },
			{ responseId: "resp_2", messageId: "msg_2", text: "Done" },
		];

		class MockWebSocket {
			static OPEN = 1;
			readyState = MockWebSocket.OPEN;
			private listeners = new Map<string, Set<(event: unknown) => void>>();

			constructor(_url: string, _protocols?: string | string[] | { headers?: Record<string, string> }) {
				queueMicrotask(() => this.dispatch("open", {}));
			}

			addEventListener(type: string, listener: (event: unknown) => void): void {
				let listeners = this.listeners.get(type);
				if (!listeners) {
					listeners = new Set();
					this.listeners.set(type, listeners);
				}
				listeners.add(listener);
			}

			removeEventListener(type: string, listener: (event: unknown) => void): void {
				this.listeners.get(type)?.delete(listener);
			}

			send(data: string): void {
				expect(admitted).toBe(sentBodies.length + 1);
				expect(receipts).toHaveLength(sentBodies.length);
				sentBodies.push(JSON.parse(data));
				const response = responses.shift();
				if (!response) throw new Error("unexpected websocket request");
				const events = [
					{ type: "response.created", response: { id: response.responseId } },
					{
						type: "response.output_item.added",
						item: {
							type: "message",
							id: response.messageId,
							role: "assistant",
							status: "in_progress",
							content: [],
						},
					},
					{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
					{ type: "response.output_text.delta", delta: response.text },
					{
						type: "response.output_item.done",
						item: {
							type: "message",
							id: response.messageId,
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: response.text }],
						},
					},
					{
						type: "response.completed",
						response: {
							id: response.responseId,
							model: "gpt-5.1-codex-snapshot",
							status: "completed",
							usage: {
								input_tokens: 5,
								output_tokens: 3,
								total_tokens: 8,
								input_tokens_details: { cached_tokens: 2 },
								output_tokens_details: { reasoning_tokens: 1 },
							},
						},
					},
				];
				queueMicrotask(() => {
					for (const event of events) {
						this.dispatch("message", { data: JSON.stringify(event) });
					}
				});
			}

			close(): void {
				this.readyState = 3;
			}

			private dispatch(type: string, event: unknown): void {
				for (const listener of this.listeners.get(type) ?? []) {
					listener(event);
				}
			}
		}

		globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};
		const firstContext: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: 1 }],
		};

		const firstStream = streamOpenAICodexResponses(model, firstContext, {
			attempts,
			reasoningEffort: "high",
			serviceTier: "priority",
			apiKey: token,
			sessionId: "session-1",
			transport: "websocket-cached",
		});

		const firstEvents = firstStream[Symbol.asyncIterator]();
		let first!: AssistantMessage;
		try {
			const started = await firstEvents.next();
			if (started.done || started.value.type !== "start")
				throw new Error("Expected the existing first response start");
			await settlementStarted;
			// This is the actual completed streamed object, while its ordinary receipt ACK is still pending.
			const pendingContext: Context = {
				...firstContext,
				messages: [
					...firstContext.messages,
					started.value.partial,
					{ role: "user", content: "Now finish", timestamp: 2 },
				],
			};
			const beforeRefusal = getOpenAICodexWebSocketDebugStats("session-1");
			const pending = await streamOpenAICodexResponses(model, pendingContext, {
				attempts,
				reasoningEffort: "high",
				serviceTier: "priority",
				apiKey: token,
				sessionId: "session-1",
				transport: "websocket-cached",
				onPayload(payload) {
					const body = payload as { input: unknown[] };
					return {
						...body,
						input: [...body.input, { type: "reasoning", encrypted_content: "fixture-opaque", summary: [] }],
					};
				},
			}).result();
			expect(pending.stopReason).toBe("error");
			expect(pending.errorMessage).toContain("Request token budget unknown");
			expect(refusals).toHaveLength(1);
			expect(refusals[0]).toBeInstanceOf(RequestTokenBudgetError);
			expect(measured.at(-1)?.retainedPrefix).toBeUndefined();
			pendingBody = JSON.parse(measured.at(-1)!.body!);
			expect(assessments.at(-1)).toMatchObject({ status: "unknown", aggressivePacking: false });
			expect(admitted).toBe(1);
			expect(sentBodies).toHaveLength(1);
			expect(receipts).toHaveLength(1);
			expect(global.fetch).not.toHaveBeenCalled();
			expect(getOpenAICodexWebSocketDebugStats("session-1")).toEqual(beforeRefusal);
		} finally {
			releaseFirstAck();
			first = await firstStream.result();
			await firstEvents.return?.();
		}

		const secondContext: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [...firstContext.messages, first, { role: "user", content: "Now finish", timestamp: 2 }],
		};
		await streamOpenAICodexResponses(model, secondContext, {
			attempts,
			reasoningEffort: "high",
			serviceTier: "priority",
			apiKey: token,
			sessionId: "session-1",
			transport: "websocket-cached",
		}).result();

		expect(sentBodies).toHaveLength(2);
		expect(global.fetch).not.toHaveBeenCalled();
		expect(receipts).toHaveLength(2);
		expect(receipts[0]).toMatchObject({
			attemptId: "attempt_1",
			ordinal: 1,
			transport: "websocket",
			kind: "initial",
			providerResponseId: "resp_1",
			responseModel: "gpt-5.1-codex-snapshot",
			effort: "high",
			serviceTier: "priority",
			outcome: "completed",
			usageCompleteness: "complete",
			usage: { input: 3, inputTotal: 5, output: 3, cacheRead: 2, totalTokens: 8 },
		});
		expect(receipts[1]).toMatchObject({
			attemptId: "attempt_2",
			ordinal: 1,
			transport: "websocket",
			kind: "transport-continuation",
			previousResponseId: "resp_1",
			providerResponseId: "resp_2",
			outcome: "completed",
		});
		expect(receipts[0].rawUsage).toEqual([
			{
				input_tokens: 5,
				output_tokens: 3,
				total_tokens: 8,
				input_tokens_details: { cached_tokens: 2 },
				output_tokens_details: { reasoning_tokens: 1 },
			},
		]);
		for (const receipt of receipts) {
			expect(receipt.providerRequestId).toBeUndefined(); // Session/handshake IDs are not inference IDs.
			expect(receipt.timing.sentAt).toBeGreaterThanOrEqual(receipt.timing.admittedAt);
			expect(receipt.timing.firstContentAt).toBeGreaterThanOrEqual(receipt.timing.firstEventAt!);
		}
		const firstBody = sentBodies[0] as { input: unknown[]; previous_response_id?: string; store?: boolean };
		const secondBody = sentBodies[1] as { input: unknown[]; previous_response_id?: string; store?: boolean };
		expect(firstBody.store).toBe(false);
		expect(firstBody.previous_response_id).toBeUndefined();
		expect(firstBody.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "Say hello" }] }]);
		expect(secondBody.store).toBe(false);
		expect(secondBody.previous_response_id).toBe("resp_1");
		expect(secondBody.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "Now finish" }] }]);
		expect(getOpenAICodexWebSocketDebugStats("session-1")).toMatchObject({
			requests: 2,
			connectionsCreated: 1,
			connectionsReused: 1,
			cachedContextRequests: 2,
			storeTrueRequests: 0,
			fullContextRequests: 1,
			deltaRequests: 1,
			lastDeltaInputItems: 1,
			lastPreviousResponseId: "resp_1",
		});
		const fullRequest = measured.at(-1)!;
		const fullBody = JSON.parse(fullRequest.body!);
		expect(fullRequest.url).toBe("wss://chatgpt.com/backend-api/codex/responses");
		expect(measured[0].retainedPrefix).toBeUndefined();
		expect(fullRequest.retainedPrefix).toEqual({
			inputItems: 2,
			inputTokens: 5,
			outputTokens: 3,
			responseModel: "gpt-5.1-codex-snapshot",
		});
		expect(fullBody.previous_response_id).toBeUndefined();
		expect(fullBody.input).toHaveLength(3);
		expect(fullBody.input[0]).toEqual(firstBody.input[0]);
		expect(fullBody.input[2]).toEqual(secondBody.input[0]);
		expect(pendingBody).toEqual({
			...fullBody,
			input: [...fullBody.input, { type: "reasoning", encrypted_content: "fixture-opaque", summary: [] }],
		}); // The same exact logical prefix was present before ACK; only its observation was unknown.
		expect(assessments.at(-1)).toMatchObject({
			status: "within-estimate",
			limitSource: "explicit-profile",
			contextTokens: 4096,
			retainedInputTokens: 8,
			outputReserveTokens: 64,
			reasoningReservation: "included-in-output",
			serializedBytes: new TextEncoder().encode(fullRequest.body!).byteLength,
			aggressivePacking: false,
		});
		expect(refusals).toHaveLength(1);
	});

	it("falls back to SSE when a Codex websocket never opens before its connection deadline", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const deadline = vi.spyOn(globalThis, "setTimeout");
		const controller = new AbortController();
		const receipts: ProviderAttemptReceipt[] = [];
		const admit = vi.fn(async () => "http-attempt");
		let created!: () => void;
		const socketCreated = new Promise<void>((resolve) => {
			created = resolve;
		});
		let socket!: PendingWebSocket;
		class PendingWebSocket extends EventTarget {
			close = vi.fn();
			send = vi.fn();
			constructor() {
				super();
				socket = this;
				created();
			}
		}
		globalThis.WebSocket = PendingWebSocket as unknown as typeof WebSocket;
		global.fetch = vi.fn(async () => {
			expect(admit).toHaveBeenCalledTimes(1);
			expect(socket.close).toHaveBeenCalledWith(1000, "connection_timeout");
			return new Response(buildSSEPayload({ status: "completed" }), { status: 200 });
		}) as typeof fetch;
		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};
		const stream = streamSimpleOpenAICodexResponses(
			model,
			{
				messages: [{ role: "user", content: "Hello", timestamp: 1 }],
			},
			{
				apiKey: mockToken(),
				transport: "auto",
				sessionId: "opening-timeout",
				timeoutMs: 25,
				signal: controller.signal,
				attempts: {
					admit,
					async settle(receipt) {
						receipts.push(receipt);
					},
				},
			},
		);
		try {
			await socketCreated;
			const removeListener = vi.spyOn(socket, "removeEventListener");
			expect(deadline).toHaveBeenCalledWith(expect.any(Function), 25);
			expect(admit).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(24);
			expect(global.fetch).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			const result = await stream.result();
			expect(result.stopReason).toBe("stop");
			expect(result.content.find((block) => block.type === "text")?.text).toBe("Hello");
			expect(global.fetch).toHaveBeenCalledTimes(1);
			expect(socket.send).not.toHaveBeenCalled();
			expect(receipts).toHaveLength(1);
			expect(receipts[0]).toMatchObject({
				attemptId: "http-attempt",
				ordinal: 1,
				transport: "http",
				kind: "transport-fallback",
				outcome: "completed",
			});
			for (const event of ["open", "error", "close"]) {
				expect(removeListener).toHaveBeenCalledWith(event, expect.any(Function));
			}
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			controller.abort();
			await stream.result();
			vi.restoreAllMocks();
			vi.useRealTimers();
		}
	});

	it("cancels a Codex websocket opening without SSE fallback and clears its default deadline", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const deadline = vi.spyOn(globalThis, "setTimeout");
		const controller = new AbortController();
		const admit = vi.fn(async () => "unexpected-attempt");
		const settle = vi.fn(async () => {});
		let created!: () => void;
		const socketCreated = new Promise<void>((resolve) => {
			created = resolve;
		});
		let socket!: PendingWebSocket;
		class PendingWebSocket extends EventTarget {
			close = vi.fn();
			send = vi.fn();
			constructor() {
				super();
				socket = this;
				created();
			}
		}
		globalThis.WebSocket = PendingWebSocket as unknown as typeof WebSocket;
		global.fetch = vi.fn(async () => {
			throw new Error("Aborted socket opening reached SSE");
		}) as typeof fetch;
		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};
		const stream = streamSimpleOpenAICodexResponses(
			model,
			{
				messages: [{ role: "user", content: "Hello", timestamp: 1 }],
			},
			{
				apiKey: mockToken(),
				transport: "auto",
				sessionId: "opening-abort",
				signal: controller.signal,
				attempts: { admit, settle },
			},
		);
		try {
			await socketCreated;
			const removeListener = vi.spyOn(socket, "removeEventListener");
			expect(deadline).toHaveBeenCalledWith(expect.any(Function), 30_000);
			controller.abort();
			expect((await stream.result()).stopReason).toBe("aborted");
			expect(socket.close).toHaveBeenCalledWith(1000, "aborted");
			expect(socket.close).toHaveBeenCalledTimes(1);
			for (const event of ["open", "error", "close"]) {
				expect(removeListener).toHaveBeenCalledWith(event, expect.any(Function));
			}
			expect(vi.getTimerCount()).toBe(0);
			await vi.advanceTimersByTimeAsync(30_000);
			expect(global.fetch).not.toHaveBeenCalled();
			expect(socket.send).not.toHaveBeenCalled();
			expect(admit).not.toHaveBeenCalled();
			expect(settle).not.toHaveBeenCalled();
		} finally {
			controller.abort();
			await stream.result();
			vi.restoreAllMocks();
			vi.useRealTimers();
		}
	});

	it("settles physical websocket fallback and SSE retry attempts without a stream listener", async () => {
		const delay = vi.spyOn(globalThis, "setTimeout");
		const receipts: ProviderAttemptReceipt[] = [];
		let admitted = 0;
		let sent = 0;
		let completed!: () => void;
		const producerCompleted = new Promise<void>((resolve) => {
			completed = resolve;
		});
		const attempts: ProviderAttemptObserver = {
			async admit() {
				await Promise.resolve();
				return `attempt_${++admitted}`;
			},
			async settle(receipt) {
				receipts.push(receipt);
				if (receipt.outcome === "completed") completed();
			},
		};
		class FailingWebSocket extends EventTarget {
			constructor() {
				super();
				queueMicrotask(() => this.dispatchEvent(new Event("open")));
			}
			send(): void {
				expect(admitted).toBe(++sent);
				throw Object.assign(new Error("websocket send failed"), { code: "ECONNRESET" });
			}
			close(): void {}
		}
		globalThis.WebSocket = FailingWebSocket as unknown as typeof WebSocket;
		global.fetch = vi.fn(async () => {
			expect(admitted).toBe(++sent);
			expect(receipts).toHaveLength(sent - 1);
			return sent === 2
				? new Response("overloaded", {
						status: 503,
						headers: { "x-request-id": "req_retry", "retry-after": "0.025" },
					})
				: new Response(buildSSEPayload({ status: "completed" }), {
						status: 200,
						headers: { "x-request-id": "req_success", authorization: "not-recorded" },
					});
		}) as typeof fetch;
		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};
		const resultStream = streamSimpleOpenAICodexResponses(
			model,
			{
				messages: [{ role: "user", content: "Hello", timestamp: 1 }],
			},
			{ apiKey: mockToken(), transport: "auto", attempts, reasoning: "high" },
		);
		await producerCompleted;
		expect(delay).toHaveBeenCalledWith(expect.any(Function), 25);
		expect((await resultStream.result()).stopReason).toBe("stop");
		expect(global.fetch).toHaveBeenCalledTimes(2);
		expect(
			receipts.map(({ attemptId, ordinal, transport, kind, outcome }) => ({
				attemptId,
				ordinal,
				transport,
				kind,
				outcome,
			})),
		).toEqual([
			{ attemptId: "attempt_1", ordinal: 1, transport: "websocket", kind: "initial", outcome: "failed" },
			{ attemptId: "attempt_2", ordinal: 2, transport: "http", kind: "transport-fallback", outcome: "failed" },
			{ attemptId: "attempt_3", ordinal: 3, transport: "http", kind: "retry", outcome: "completed" },
		]);
		expect(receipts[0].usageCompleteness).toBe("none");
		expect(receipts[1]).toMatchObject({ status: 503, providerRequestId: "req_retry", rawUsage: [], usage: {} });
		expect(receipts[2]).toMatchObject({
			status: 200,
			providerRequestId: "req_success",
			effort: "high",
			usageCompleteness: "complete",
		});
		expect(JSON.stringify(receipts)).not.toContain("not-recorded");
	});
});
