import { afterEach, describe, expect, it, vi } from "vitest";
import { streamOpenAIResponses } from "../src/providers/openai-responses.js";
import type { Model, ProviderAttemptReceipt } from "../src/types.js";
import {
	type ProviderRequestRepresentation,
	type RequestTokenAssessment,
	RequestTokenBudget,
} from "../src/utils/request-token-budget.js";

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

// Explicit synthetic estimate/usage fixtures, not a Sol/Astra tokenizer or calibrated bound.
function requestProfile() {
	return {
		id: "fixture-estimate",
		revision: "fixture-v1",
		api: "openai-responses" as const,
		provider: "openai" as const,
		url: "https://example.invalid/v1/responses",
		model: "test-model",
		authMode: "fixture-api-key",
		templateRevision: "fixture-template",
		replayFamily: "fixture-text",
		contextTokens: 4096,
		outputCeilingTokens: 64,
		estimate: { tokensPerUtf8Byte: 1, templateTokens: 9, marginTokens: 17 },
	};
}

const rawUsage = { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 3 } };
function response(usage = rawUsage): Response {
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
				usage,
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
			const written = providerMessage === "retry" ? 4 : undefined;
			const reportedUsage = {
				...rawUsage,
				input_tokens_details: {
					...rawUsage.input_tokens_details,
					...(written === undefined ? {} : { cache_write_tokens: written }),
				},
			};
			const pricedModel = { ...model, cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.25 } };
			const order: string[] = [];
			const receipts: ProviderAttemptReceipt[] = [];
			const profile = requestProfile();
			const budget = new RequestTokenBudget({ mode: "enforce", profiles: [profile] });
			profile.contextTokens = 1;
			profile.estimate.marginTokens = 4096; // Caller changes must not alter the constructor snapshot.
			const measured: ProviderRequestRepresentation[] = [];
			const assessments: RequestTokenAssessment[] = [];
			const admittedAssessments: (RequestTokenAssessment | undefined)[] = [];
			const wireBodies: string[] = [];
			const finalPayload = {
				model: "test-model",
				stream: true,
				store: false,
				instructions: "Exact fixture instructions: 保留 Foo.ts",
				input: [{ role: "user", content: [{ type: "input_text", text: "漢字 and case-sensitive Foo.ts" }] }],
				tools: [
					{
						type: "function",
						name: "read",
						description: "读取 Foo.ts",
						parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
					},
				],
				max_output_tokens: 24,
				reasoning: { effort: "high" },
			};
			const expectedPayload = structuredClone(finalPayload);
			let release!: () => void;
			const admitted = new Promise<void>((resolve) => {
				release = resolve;
			});
			const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
				if (typeof init?.body !== "string") throw new Error("Expected the actual serialized SDK request body");
				expect(measured.at(-1)).toEqual({
					api: "openai-responses",
					provider: "openai",
					url: "https://example.invalid/v1/responses",
					body: init.body,
				});
				wireBodies.push(init.body);
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
					: response(reportedUsage);
			});
			vi.stubGlobal("fetch", fetch);
			const stream = streamOpenAIResponses(
				pricedModel,
				{ messages: [] },
				{
					apiKey: "not-receipt-metadata",
					maxRetries: 1,
					onPayload: () => finalPayload,
					attempts: {
						measureRequest(request) {
							measured.push(request);
							const assessment = budget.measure(request);
							assessments.push(assessment);
							budget.assert(assessment);
							return assessment;
						},
						async admit(info) {
							order.push(`admit:${info.ordinal}`);
							admittedAssessments.push(info.requestBudget);
							finalPayload.instructions = "Changed after the finalized payload was captured";
							finalPayload.input[0].content[0].text = "Changed during admission";
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
			const result = await stream.result();
			expect(result.stopReason).toBe("stop");
			expect(result.usage).toMatchObject({
				input: 7 - (written ?? 0),
				output: 2,
				cacheRead: 3,
				cacheWrite: written ?? 0,
				totalTokens: 12,
			});
			expect(result.usage.cost.total).toBeCloseTo(
				(2 * (7 - (written ?? 0) + 2 * 2 + 3 * 0.5 + (written ?? 0) * 1.25)) / 1_000_000,
				12,
			);
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
				rawUsage: [reportedUsage],
				usage: { input: 7 - (written ?? 0), inputTotal: 10, output: 2, cacheRead: 3, totalTokens: 12 },
				usageCompleteness: "complete",
			});
			if (written === undefined) {
				expect(receipts[1].usage.cacheWrite).toBeUndefined();
			} else {
				expect(receipts[1].usage.cacheWrite).toBe(written);
			}
			expect(receipts[0].capacityConfirmed).toBe(
				providerMessage === "Selected model is at capacity." ? true : undefined,
			);
			expect(receipts[1].capacityConfirmed).toBeUndefined();
			expect(receipts[1].timing.firstContentAt).toBeTypeOf("number");
			expect(JSON.stringify(receipts)).not.toContain("not-receipt-metadata");
			expect(wireBodies.map((body) => JSON.parse(body))).toEqual([expectedPayload, expectedPayload]);
			expect(receipts.map((receipt) => receipt.requestBudget)).toEqual(admittedAssessments);
			for (const [index, receipt] of receipts.entries())
				expect(receipt.requestBudget).toBe(admittedAssessments[index]);
			for (const assessment of assessments) {
				expect(assessment).toMatchObject({
					limitSource: "explicit-profile",
					counter: "conservative-profile-estimate",
					status: "within-estimate",
					contextTokens: 4096,
					outputReserveTokens: 24,
					reasoningReservation: "included-in-output",
					marginTokens: 17,
					availableInputTokens: 4055,
					aggressivePacking: false,
					calibration: { state: "unknown", samples: 0 },
				});
			}
			const lastRequest = measured.at(-1)!;
			expect(budget.measure(lastRequest).calibration).toMatchObject({ state: "unknown", samples: 0 });
			// Both existing settlement callbacks have ACKed before stream.result() returned above.
			budget.observe(receipts[0]);
			expect(budget.measure(lastRequest).calibration).toMatchObject({ state: "unknown", samples: 0 });
			budget.observe(receipts[1]);
			const observed = budget.measure(lastRequest);
			expect(receipts[1].usage.inputTotal).toBe(10); // Includes cache reads and any reported cache writes.
			expect(observed.calibration).toEqual({
				state: "observed",
				samples: 1,
				maxUnderestimateTokens: 0,
				maxOverestimateTokens: receipts[1].requestBudget!.estimatedInputTokens! - 10,
			});
			expect(observed.aggressivePacking).toBe(false);
		},
	);

	it("retains impossible raw usage without complete negative accounting", async () => {
		const budget = new RequestTokenBudget({ mode: "observe", profiles: [requestProfile()] });
		let measured: ProviderRequestRepresentation | undefined;
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
					measureRequest(request) {
						measured = request;
						const assessment = budget.measure(request);
						budget.assert(assessment);
						return assessment;
					},
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
		budget.observe(receipt!); // The existing partial settlement has already returned its ACK.
		expect(budget.measure(measured!).calibration).toMatchObject({ state: "unknown", samples: 0 });

		const fetchCount = vi.mocked(globalThis.fetch).mock.calls.length;
		const refusedAdmit = vi.fn(async () => {
			throw new Error("Refused request reached admission");
		});
		const enforced = new RequestTokenBudget({
			mode: "enforce",
			profiles: [{ ...requestProfile(), contextTokens: 1 }],
		});
		let refusal: RequestTokenAssessment | undefined;
		const refused = await streamOpenAIResponses(
			model,
			{ messages: [] },
			{
				apiKey: "test",
				maxRetries: 0,
				attempts: {
					measureRequest(request) {
						refusal = enforced.measure(request);
						enforced.assert(refusal);
						return refusal;
					},
					admit: refusedAdmit,
					async settle() {},
				},
			},
		).result();
		expect(refused.stopReason).toBe("error");
		expect(refused.errorMessage).toContain("Request token budget over-budget");
		expect(refusal).toMatchObject({ status: "over-budget", contextTokens: 1, aggressivePacking: false });
		expect(refusedAdmit).not.toHaveBeenCalled();
		expect(globalThis.fetch).toHaveBeenCalledTimes(fetchCount);

		for (const body of [
			{
				model: "test-model",
				input: [{ role: "user", content: [{ type: "input_image", image_url: "https://example.invalid/image" }] }],
			},
			{ model: "test-model", input: [{ type: "reasoning", encrypted_content: "fixture-opaque", summary: [] }] },
			{ model: "test-model", input: [], previous_response_id: "external-fixture-state" },
		]) {
			expect(
				budget.measure({
					api: "openai-responses",
					provider: "openai",
					url: "https://example.invalid/v1/responses",
					body: JSON.stringify(body),
				}),
			).toMatchObject({ status: "unknown", estimatedInputTokens: null, aggressivePacking: false });
		}
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
