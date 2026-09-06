import { afterEach, describe, expect, it, vi } from "vitest";
import { streamOpenAIResponses } from "../src/providers/openai-responses.js";
import type { Model, ProviderAttemptReceipt } from "../src/types.js";

const model: Model<"openai-responses"> = {
	id: "test-model",
	name: "Test",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0 },
	contextWindow: 1024,
	maxTokens: 64,
};
const rawUsage = { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 3 } };
function response(): Response {
	const events = [
		{ type: "response.created", response: { id: "response-1", model: "test-model", status: "in_progress" } },
		{
			type: "response.output_item.added",
			item: { id: "message-1", type: "message", role: "assistant", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "", annotations: [] } },
		{ type: "response.output_text.delta", delta: "OK" },
		{
			type: "response.output_item.done",
			item: { id: "message-1", type: "message", content: [{ type: "output_text", text: "OK" }] },
		},
		{
			type: "response.completed",
			response: {
				id: "response-1",
				model: "test-model",
				status: "completed",
				service_tier: "priority",
				usage: rawUsage,
			},
		},
	];
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		status: 200,
		headers: {
			"content-type": "text/event-stream",
			"x-request-id": "request-1",
			"set-cookie": "not-receipt-metadata",
		},
	});
}

afterEach(() => vi.unstubAllGlobals());

describe("physical provider attempts", () => {
	it.each(["Selected model is at capacity.", "retry"])(
		"admits each SDK retry and retains only confirmed capacity: %s",
		async (providerMessage) => {
			const order: string[] = [];
			const receipts: ProviderAttemptReceipt[] = [];
			let release!: () => void;
			const admitted = new Promise<void>((resolve) => {
				release = resolve;
			});
			const fetch = vi.fn(async () => {
				order.push("send");
				return fetch.mock.calls.length === 1
					? new Response(
							JSON.stringify({
								error: { message: providerMessage, type: "server_error", detail: "not-receipt-metadata" },
							}),
							{
								status: 503,
								headers: {
									"content-type": "application/json",
									"retry-after-ms": "1",
									"x-request-id": "failed-request",
								},
							},
						)
					: response();
			});
			vi.stubGlobal("fetch", fetch);
			const stream = streamOpenAIResponses(
				model,
				{ messages: [] },
				{
					apiKey: "not-receipt-metadata",
					maxRetries: 1,
					attempts: {
						async admit(info) {
							order.push(`admit:${info.ordinal}`);
							await admitted;
							return `attempt-${info.ordinal}`;
						},
						async settle(receipt) {
							await Promise.resolve();
							order.push(`settle:${receipt.ordinal}`);
							receipts.push(receipt);
						},
					},
				},
			);
			await Promise.resolve();
			expect(fetch).not.toHaveBeenCalled();
			release();
			const listener = stream[Symbol.asyncIterator]();
			await listener.next();
			await listener.return?.();
			expect((await stream.result()).stopReason).toBe("stop");
			expect(order).toEqual(["admit:1", "send", "settle:1", "admit:2", "send", "settle:2"]);
			expect(receipts[0]).toMatchObject({
				attemptId: "attempt-1",
				outcome: "failed",
				status: 503,
				providerRequestId: "failed-request",
				usage: {},
				rawUsage: [],
				usageCompleteness: "none",
			});
			expect(receipts[1]).toMatchObject({
				attemptId: "attempt-2",
				kind: "retry",
				outcome: "completed",
				providerRequestId: "request-1",
				providerResponseId: "response-1",
				effectiveServiceTier: "priority",
				rawUsage: [rawUsage],
				usage: { input: 7, output: 2, cacheRead: 3, totalTokens: 12 },
				usageCompleteness: "complete",
			});
			expect(receipts[0].capacityConfirmed).toBe(
				providerMessage === "Selected model is at capacity." ? true : undefined,
			);
			expect(receipts[1].capacityConfirmed).toBeUndefined();
			expect(receipts[1].timing.firstContentAt).toBeTypeOf("number");
			expect(JSON.stringify(receipts)).not.toContain("not-receipt-metadata");
		},
	);

	it("retains impossible raw usage without complete negative accounting", async () => {
		const invalid = {
			input_tokens: 10,
			output_tokens: -1,
			total_tokens: 9,
			input_tokens_details: { cached_tokens: 20 },
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						`data: ${JSON.stringify({ type: "response.completed", response: { id: "response-invalid", model: "test-model", status: "completed", usage: invalid } })}\n\n`,
						{ status: 200, headers: { "content-type": "text/event-stream" } },
					),
			),
		);
		let receipt: ProviderAttemptReceipt | undefined;
		await streamOpenAIResponses(
			model,
			{ messages: [] },
			{
				apiKey: "test",
				maxRetries: 0,
				attempts: {
					async admit() {
						return "attempt-invalid";
					},
					async settle(value) {
						receipt = value;
					},
				},
			},
		).result();
		expect(receipt).toMatchObject({ outcome: "completed", rawUsage: [invalid], usageCompleteness: "partial" });
		expect(receipt?.usage.input).toBeUndefined();
		expect(receipt?.usage.output).toBeUndefined();
		expect(receipt?.usage).toEqual({ inputTotal: 10, cacheRead: 20, totalTokens: 9 });
	});

	it("terminates the assistant stream when physical settlement rejects", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => response()),
		);
		let receipt: ProviderAttemptReceipt | undefined;
		const output = await streamOpenAIResponses(
			model,
			{ messages: [] },
			{
				apiKey: "test",
				maxRetries: 0,
				attempts: {
					async admit() {
						return "attempt-1";
					},
					async settle(value) {
						receipt = value;
						throw new Error("sink unavailable");
					},
				},
			},
		).result();
		expect(receipt?.outcome).toBe("completed");
		expect(output.stopReason).toBe("error");
		expect(output.errorMessage).toContain("Attempt settlement failed: sink unavailable");
	});
});
