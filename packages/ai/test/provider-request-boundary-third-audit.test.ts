import { afterEach, describe, expect, it, vi } from "vitest";
import { streamMistral } from "../src/providers/mistral.js";
import type { Context, Model, ProviderAttemptReceipt } from "../src/types.js";
import type { ProviderRequestRepresentation } from "../src/utils/request-token-budget.js";

const model: Model<"mistral-conversations"> = {
	id: "test-model",
	name: "Test",
	api: "mistral-conversations",
	provider: "mistral",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1024,
	maxTokens: 64,
};
const context: Context = { messages: [{ role: "user", content: "Hello", timestamp: 1 }] };

function response(): Response {
	const event = {
		id: "response-1",
		model: "test-model",
		object: "chat.completion.chunk",
		created: 1,
		choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
		usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
	};
	return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
		headers: { "content-type": "text/event-stream", "x-request-id": "request-1" },
	});
}

afterEach(() => vi.unstubAllGlobals());

describe("native Request transport boundary", () => {
	it("measures the Mistral SDK's serialized Request body before admission", async () => {
		const measured: ProviderRequestRepresentation[] = [];
		const receipts: ProviderAttemptReceipt[] = [];
		let sentBody = "";
		const fetch = vi.fn(async (request: Request) => {
			sentBody = await request.text();
			return response();
		});
		vi.stubGlobal("fetch", fetch);
		const output = await streamMistral(model, context, {
			apiKey: "synthetic-test-key",
			maxTokens: 32,
			attempts: {
				measureRequest(request) {
					measured.push(request);
					return undefined;
				},
				async admit() {
					expect(measured).toHaveLength(1);
					return "attempt-1";
				},
				async settle(receipt) {
					receipts.push(receipt);
				},
			},
		}).result();
		expect(output.stopReason, output.errorMessage).toBe("stop");
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(measured[0]).toMatchObject({ url: "https://example.invalid/v1/chat/completions", body: sentBody });
		expect(JSON.parse(sentBody)).toMatchObject({ model: "test-model", max_tokens: 32 });
		expect(receipts).toHaveLength(1);
		expect(receipts[0]).toMatchObject({ outcome: "completed", usage: { inputTotal: 10, output: 2 } });
	});

	it("does not send or record sentAt when Mistral admission cancels the Request", async () => {
		const controller = new AbortController();
		const receipts: ProviderAttemptReceipt[] = [];
		const fetch = vi.fn(async () => response());
		vi.stubGlobal("fetch", fetch);
		const output = await streamMistral(model, context, {
			apiKey: "synthetic-test-key",
			signal: controller.signal,
			attempts: {
				async admit() {
					controller.abort();
					return "attempt-1";
				},
				async settle(receipt) {
					receipts.push(receipt);
				},
			},
		}).result();
		expect(output.stopReason).toBe("aborted");
		expect(fetch.mock.calls.length).toBe(0);
		expect(receipts).toHaveLength(1);
		expect(receipts[0]).toMatchObject({ outcome: "cancelled", usageCompleteness: "none" });
		expect(receipts[0].timing.sentAt).toBeUndefined();
	});
	it("rejects Mistral EOF before a terminal choice and retains reported usage", async () => {
		const receipts: ProviderAttemptReceipt[] = [];
		const event = {
			id: "response-1",
			model: "test-model",
			object: "chat.completion.chunk",
			created: 1,
			choices: [
				{
					index: 0,
					delta: {
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: "call-1",
								type: "function",
								function: { name: "read_file", arguments: '{"path":"file.txt"' },
							},
						],
					},
					finish_reason: null,
				},
			],
			usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
		};
		const fetch = vi.fn(
			async () =>
				new Response(`data: ${JSON.stringify(event)}\n\n`, {
					headers: { "content-type": "text/event-stream" },
				}),
		);
		vi.stubGlobal("fetch", fetch);
		const output = await streamMistral(model, context, {
			apiKey: "synthetic-test-key",
			attempts: {
				async admit() {
					return "attempt-1";
				},
				async settle(receipt) {
					receipts.push(receipt);
				},
			},
		}).result();
		expect(output.stopReason).toBe("error");
		expect(output.errorMessage).toContain("before finish_reason");
		expect(output.usage).toMatchObject({ input: 10, output: 2 });
		expect(output.content).toMatchObject([{ type: "toolCall", name: "read_file", arguments: { path: "file.txt" } }]);
		expect(output.content[0]).not.toHaveProperty("partialArgs");
		expect(receipts).toHaveLength(1);
		expect(receipts[0]).toMatchObject({ outcome: "interrupted", usage: { inputTotal: 10, output: 2 } });
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});
