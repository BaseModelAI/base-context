import { afterEach, describe, expect, it, vi } from "vitest";
import { streamGoogle } from "../src/providers/google.js";
import { streamGoogleVertex } from "../src/providers/google-vertex.js";
import { streamMistral } from "../src/providers/mistral.js";
import type { Context, Model, ProviderAttemptReceipt, StreamOptions } from "../src/types.js";

const model: Omit<Model<"google-generative-ai" | "google-vertex" | "mistral-conversations">, "api" | "provider"> = {
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

afterEach(() => vi.unstubAllGlobals());

describe("native SDK physical attempts", () => {
	it.each(["google", "google-vertex", "mistral"] as const)(
		"admits and settles the %s transport with observed usage",
		async (provider) => {
			const order: string[] = [];
			const receipts: ProviderAttemptReceipt[] = [];
			const rawUsage =
				provider === "google"
					? {
							promptTokenCount: 10,
							cachedContentTokenCount: 3,
							candidatesTokenCount: 2,
							thoughtsTokenCount: 1,
							totalTokenCount: 13,
						}
					: provider === "google-vertex"
						? { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 }
						: { promptTokens: 10, completionTokens: 2, totalTokens: 12 };
			const event =
				provider === "mistral"
					? {
							id: "response-1",
							model: "model-snapshot",
							object: "chat.completion.chunk",
							created: 1,
							choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
							usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
						}
					: {
							responseId: "response-1",
							modelVersion: "model-snapshot",
							candidates: [
								{ content: { role: "model", parts: [{ text: "OK" }] }, finishReason: "STOP", index: 0 },
							],
							usageMetadata: rawUsage,
						};
			const fetch = vi.fn(async () => {
				expect(order).toEqual(["admit", "admitted"]);
				order.push("send");
				return new Response(
					`data: ${JSON.stringify(event)}\n\n${provider === "mistral" ? "data: [DONE]\n\n" : ""}`,
					{
						status: 200,
						headers: { "content-type": "text/event-stream", "x-request-id": "request-1" },
					},
				);
			});
			vi.stubGlobal("fetch", fetch);
			let release!: () => void;
			const admission = new Promise<void>((resolve) => {
				release = resolve;
			});
			let notifyAdmission!: () => void;
			const admissionStarted = new Promise<void>((resolve) => {
				notifyAdmission = resolve;
			});
			const options: StreamOptions = {
				apiKey: "test-api-key",
				attempts: {
					async admit() {
						order.push("admit");
						notifyAdmission();
						await admission;
						order.push("admitted");
						return "attempt-1";
					},
					async settle(receipt) {
						await Promise.resolve();
						order.push("settle");
						receipts.push(receipt);
					},
				},
			};
			const stream =
				provider === "google"
					? streamGoogle({ ...model, api: "google-generative-ai", provider }, context, options)
					: provider === "google-vertex"
						? streamGoogleVertex({ ...model, api: "google-vertex", provider }, context, options)
						: streamMistral({ ...model, api: "mistral-conversations", provider }, context, options);
			await Promise.race([
				admissionStarted,
				stream.result().then((output) => {
					throw new Error(output.errorMessage ?? "Stream ended without admission");
				}),
			]);
			expect(fetch).not.toHaveBeenCalled();
			release();
			const output = await stream.result();
			expect(output.stopReason, output.errorMessage).toBe("stop");
			expect(output.content).toMatchObject([{ type: "text", text: "OK" }]);
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(order).toEqual(["admit", "admitted", "send", "settle"]);
			expect(receipts).toHaveLength(1);
			expect(receipts[0]).toMatchObject({
				attemptId: "attempt-1",
				ordinal: 1,
				kind: "initial",
				transport: "http",
				outcome: "completed",
				status: 200,
				providerRequestId: "request-1",
				providerResponseId: "response-1",
				responseModel: "model-snapshot",
				rawUsage: [rawUsage],
				usageCompleteness: provider === "google-vertex" ? "partial" : "complete",
			});
			expect(receipts[0].usage).toEqual(
				provider === "google"
					? { input: 7, inputTotal: 10, output: 3, cacheRead: 3, totalTokens: 13 }
					: provider === "google-vertex"
						? { inputTotal: 10, totalTokens: 12 }
						: { inputTotal: 10, output: 2, totalTokens: 12 },
			);
			expect(receipts[0].timing.sentAt).toBeGreaterThanOrEqual(receipts[0].timing.admittedAt);
			expect(receipts[0].timing.firstContentAt).toBeTypeOf("number");
		},
		5000,
	);
});
