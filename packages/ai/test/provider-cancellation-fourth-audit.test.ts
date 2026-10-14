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
const context: Context = { messages: [{ role: "user", content: "Hello", timestamp: 1 }] };

function response(): Response {
	return new Response(
		`data: ${JSON.stringify({
			candidates: [{ content: { role: "model", parts: [{ text: "OK" }] }, finishReason: "STOP", index: 0 }],
		})}\n\n`,
		{ headers: { "content-type": "text/event-stream" } },
	);
}

afterEach(() => vi.unstubAllGlobals());

describe("Google native cancellation ownership", () => {
	it.each(["google", "google-vertex"] as const)(
		"does not send %s after cancellation during payload preparation",
		async (provider) => {
			const controller = new AbortController();
			const receipts: ProviderAttemptReceipt[] = [];
			const fetch = vi.fn(async () => response());
			vi.stubGlobal("fetch", fetch);
			const options: StreamOptions = {
				apiKey: "synthetic-test-key",
				signal: controller.signal,
				async onPayload() {
					await Promise.resolve();
					controller.abort();
				},
				// Exercise the observer and no-observer native paths without real credentials.
				attempts:
					provider === "google"
						? {
								async admit() {
									return "attempt-1";
								},
								async settle(receipt) {
									receipts.push(receipt);
								},
							}
						: undefined,
			};
			const stream =
				provider === "google"
					? streamGoogle({ ...model, api: "google-generative-ai", provider }, context, options)
					: streamGoogleVertex({ ...model, api: "google-vertex", provider }, context, options);
			const output = await stream.result();
			expect(output.stopReason).toBe("aborted");
			expect(fetch).not.toHaveBeenCalled();
			expect(output.content).toEqual([]);
			if (provider === "google") {
				expect(receipts).toHaveLength(1);
				expect(receipts[0]).toMatchObject({ outcome: "cancelled", usageCompleteness: "none" });
				expect(receipts[0].timing.sentAt).toBeUndefined();
			} else {
				expect(receipts).toEqual([]);
			}
		},
	);
});
