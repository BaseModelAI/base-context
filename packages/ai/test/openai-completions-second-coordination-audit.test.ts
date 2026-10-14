import { afterEach, describe, expect, it, vi } from "vitest";
import { streamOpenAICompletions } from "../src/providers/openai-completions.js";
import type { Context, Model, ProviderAttemptReceipt } from "../src/types.js";

const model: Model<"openai-completions"> = {
	id: "fixture-completions",
	name: "Fixture Completions",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://example.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32000,
	maxTokens: 4096,
};
const context: Context = { messages: [{ role: "user", content: "Hello", timestamp: 0 }] };

function installStream(chunks: object[]): void {
	const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("");
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(body, { headers: { "content-type": "text/event-stream" } })),
	);
}

function observe(receipts: ProviderAttemptReceipt[]) {
	return {
		admit: async () => "fixture-attempt",
		settle: async (receipt: ProviderAttemptReceipt) => {
			receipts.push(receipt);
		},
	};
}

afterEach(() => vi.unstubAllGlobals());

describe("Chat Completions EOF coordination", () => {
	it("accepts a terminal choice and retains the following usage-only chunk", async () => {
		installStream([
			{ id: "completion-fixture", choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: "stop" }] },
			{ id: "completion-fixture", choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } },
		]);
		const receipts: ProviderAttemptReceipt[] = [];
		const result = await streamOpenAICompletions(model, context, {
			apiKey: "fixture-key",
			maxRetries: 0,
			attempts: observe(receipts),
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
		expect(result.usage.totalTokens).toBe(12);
		expect(receipts).toHaveLength(1);
		expect(receipts[0]).toMatchObject({
			outcome: "completed",
			usageCompleteness: "complete",
			usage: { inputTotal: 10, output: 2 },
		});
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	it("rejects EOF during a tool call while preserving reported usage and parsed arguments", async () => {
		installStream([
			{
				id: "completion-fixture",
				choices: [
					{
						index: 0,
						finish_reason: null,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call-fixture",
									type: "function",
									function: { name: "read", arguments: '{"path":"file.txt"' },
								},
							],
						},
					},
				],
				usage: { prompt_tokens: 10, completion_tokens: 2 },
			},
		]);
		const receipts: ProviderAttemptReceipt[] = [];
		const result = await streamOpenAICompletions(model, context, {
			apiKey: "fixture-key",
			maxRetries: 0,
			attempts: observe(receipts),
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("before finish_reason");
		expect(result.content).toEqual([
			{ type: "toolCall", id: "call-fixture", name: "read", arguments: { path: "file.txt" } },
		]);
		expect(result.usage.totalTokens).toBe(12);
		expect(receipts).toHaveLength(1);
		expect(receipts[0]).toMatchObject({
			outcome: "interrupted",
			usageCompleteness: "partial",
			usage: { inputTotal: 10, output: 2 },
		});
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});
});
