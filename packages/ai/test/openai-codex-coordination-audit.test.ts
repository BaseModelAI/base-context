import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeOpenAICodexWebSocketSessions,
	streamOpenAICodexResponses,
} from "../src/providers/openai-codex-responses.js";
import { streamOpenAIResponses } from "../src/providers/openai-responses.js";
import type { Context, Model, ProviderAttemptReceipt } from "../src/types.js";

const model: Model<"openai-codex-responses"> = {
	id: "gpt-5.1-codex",
	name: "Fixture Codex",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};
const context: Context = { messages: [{ role: "user", content: "Hello", timestamp: 0 }] };
const payload = Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } }),
).toString("base64");
const options = {
	apiKey: `aaa.${payload}.bbb`,
	sessionId: "coordination-audit",
	transport: "websocket-cached" as const,
};

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

class MockWebSocket extends EventTarget {
	static instances: MockWebSocket[] = [];
	static created = () => {};
	readyState = 0;

	constructor() {
		super();
		MockWebSocket.instances.push(this);
		MockWebSocket.created();
	}

	open(): void {
		this.readyState = 1;
		this.dispatchEvent(new Event("open"));
	}

	send(): void {
		queueMicrotask(() => {
			this.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({
						type: "response.completed",
						response: { id: "resp_fixture", status: "completed", output: [] },
					}),
				}),
			);
		});
	}

	close(): void {
		this.readyState = 3;
	}
}

function installTransport() {
	MockWebSocket.instances = [];
	MockWebSocket.created = () => {};
	vi.stubGlobal("WebSocket", MockWebSocket);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new Error("Unexpected HTTP transport");
		}),
	);
}

afterEach(() => {
	closeOpenAICodexWebSocketSessions();
	for (const socket of MockWebSocket.instances) socket.close();
	vi.unstubAllGlobals();
});

describe("Codex connection coordination", () => {
	it.each(["codex", "responses"])(
		"does not accept a %s SSE EOF without a terminal response as success",
		async (provider) => {
			installTransport();
			vi.stubGlobal(
				"fetch",
				vi.fn(
					async () =>
						new Response("", {
							status: 200,
							headers: { "content-type": "text/event-stream" },
						}),
				),
			);
			const receipts: ProviderAttemptReceipt[] = [];
			const requestOptions = {
				...options,
				transport: "sse" as const,
				attempts: {
					admit: async () => "truncated-response",
					settle: async (receipt: ProviderAttemptReceipt) => {
						receipts.push(receipt);
					},
				},
			};
			const responseStream =
				provider === "codex"
					? streamOpenAICodexResponses(model, context, requestOptions)
					: streamOpenAIResponses(
							{ ...model, api: "openai-responses", provider: "openai" },
							context,
							requestOptions,
						);
			const result = await responseStream.result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("before response.completed");
			expect(receipts).toHaveLength(1);
			expect(receipts[0].outcome).toBe("interrupted");
			expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		},
	);

	it("settles an SSE admission cancelled before send without a sent timestamp", async () => {
		installTransport();
		const controller = new AbortController();
		const receipts: ProviderAttemptReceipt[] = [];
		const result = await streamOpenAICodexResponses(model, context, {
			...options,
			transport: "sse",
			signal: controller.signal,
			attempts: {
				admit: async () => {
					controller.abort();
					return "cancelled-admission";
				},
				settle: async (receipt) => {
					receipts.push(receipt);
				},
			},
		}).result();
		expect(result.stopReason).toBe("aborted");
		expect(globalThis.fetch).not.toHaveBeenCalled();
		expect(receipts).toHaveLength(1);
		expect(receipts[0].outcome).toBe("cancelled");
		expect(receipts[0].timing.sentAt).toBeUndefined();
	});

	it("reuses a completed connection and closes it on session cleanup", async () => {
		installTransport();
		const created = deferred();
		MockWebSocket.created = created.resolve;
		const first = streamOpenAICodexResponses(model, context, options);
		await created.promise;
		const socket = MockWebSocket.instances[0];
		socket.open();
		expect((await first.result()).stopReason).toBe("stop");
		expect((await streamOpenAICodexResponses(model, context, options).result()).stopReason).toBe("stop");
		expect(MockWebSocket.instances).toHaveLength(1);
		closeOpenAICodexWebSocketSessions(options.sessionId);
		expect(socket.readyState).toBe(3);
	});

	it("does not orphan the first connection when two initial handshakes overlap", async () => {
		installTransport();
		const bothCreated = deferred();
		MockWebSocket.created = () => {
			if (MockWebSocket.instances.length === 2) bothCreated.resolve();
		};
		const first = streamOpenAICodexResponses(model, context, options);
		const second = streamOpenAICodexResponses(model, context, options);
		await bothCreated.promise;
		const [firstSocket, secondSocket] = MockWebSocket.instances;
		firstSocket.open();
		expect((await first.result()).stopReason).toBe("stop");
		secondSocket.open();
		expect((await second.result()).stopReason).toBe("stop");
		closeOpenAICodexWebSocketSessions(options.sessionId);
		expect(MockWebSocket.instances.map((socket) => socket.readyState)).toEqual([3, 3]);
	});

	it("does not open a connection after cancellation during payload preparation", async () => {
		installTransport();
		const controller = new AbortController();
		MockWebSocket.created = () => queueMicrotask(() => MockWebSocket.instances[0].open());
		const result = await streamOpenAICodexResponses(model, context, {
			...options,
			signal: controller.signal,
			onPayload: async () => {
				controller.abort();
			},
		}).result();
		expect(result.stopReason).toBe("aborted");
		expect(MockWebSocket.instances).toHaveLength(0);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
});
