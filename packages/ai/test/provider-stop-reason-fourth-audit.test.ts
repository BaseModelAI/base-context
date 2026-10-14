import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamGoogle } from "../src/providers/google.js";
import { streamGoogleVertex } from "../src/providers/google-vertex.js";
import type { Context, Model, ProviderAttemptReceipt, StreamOptions } from "../src/types.js";

const model: Omit<Model<"google-generative-ai" | "google-vertex">, "api" | "provider"> = {
	id: "test-model",
	name: "Test",
	baseUrl: "https://example.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0 },
	contextWindow: 1024,
	maxTokens: 64,
};
const context: Context = {
	messages: [{ role: "user", content: "Read file.txt", timestamp: 1 }],
	tools: [{ name: "read_file", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }],
};

afterEach(() => vi.unstubAllGlobals());

describe.each(["google", "google-vertex"] as const)("%s native stop-reason precedence", (provider) => {
	it.each(["STOP", "MALFORMED_FUNCTION_CALL"] as const)(
		"preserves %s after a streamed tool call",
		async (finishReason) => {
			const receipts: ProviderAttemptReceipt[] = [];
			const rawUsage = {
				promptTokenCount: 10,
				cachedContentTokenCount: 0,
				candidatesTokenCount: 2,
				thoughtsTokenCount: 0,
				totalTokenCount: 12,
			};
			const chunks = [
				{
					candidates: [
						{
							index: 0,
							content: {
								role: "model",
								parts: [{ functionCall: { name: "read_file", args: { path: "file.txt" } } }],
							},
						},
					],
				},
				{ candidates: [{ index: 0, finishReason }], usageMetadata: rawUsage },
			];
			const fetch = vi.fn(
				async () =>
					new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""), {
						headers: { "content-type": "text/event-stream" },
					}),
			);
			vi.stubGlobal("fetch", fetch);
			const options: StreamOptions = {
				apiKey: "synthetic-test-key",
				attempts: {
					async admit() {
						return "attempt-1";
					},
					async settle(receipt) {
						receipts.push(receipt);
					},
				},
			};
			const stream =
				provider === "google"
					? streamGoogle({ ...model, api: "google-generative-ai", provider }, context, options)
					: streamGoogleVertex({ ...model, api: "google-vertex", provider }, context, options);
			const output = await stream.result();
			expect(output.stopReason).toBe(finishReason === "STOP" ? "toolUse" : "error");
			if (finishReason !== "STOP") {
				expect(output.stopReasonRaw).toBe(finishReason);
				expect(output.errorMessage).toContain(finishReason);
			}
			expect(output.content).toMatchObject([
				{ type: "toolCall", name: "read_file", arguments: { path: "file.txt" } },
			]);
			expect(output.usage).toMatchObject({ input: 10, output: 2, totalTokens: 12 });
			expect(receipts).toHaveLength(1);
			expect(receipts[0]).toMatchObject({
				rawUsage: [rawUsage],
				usage: { input: 10, output: 2, totalTokens: 12 },
				usageCompleteness: "complete",
			});
			expect(fetch).toHaveBeenCalledTimes(1);
		},
	);
});
