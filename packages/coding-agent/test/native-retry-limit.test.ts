import * as ai from "@ponythewhite/base-context-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InferenceCoordinator } from "../src/core/inference-coordinator.js";

const model: ai.Model<"openai-responses"> = {
	api: "openai-responses",
	provider: "openai",
	id: "test",
	name: "Test",
	baseUrl: "https://example.invalid",
	input: ["text"],
	reasoning: false,
	contextWindow: 1000,
	maxTokens: 20,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context: ai.Context = { messages: [{ role: "user", content: "test", timestamp: 1 }] };

function response(failed: boolean): ai.AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [{ type: "text", text: failed ? "" : "OK" }],
		timestamp: 1,
		stopReason: failed ? "error" : "stop",
		...(failed
			? {
					errorMessage: "Provider unavailable",
					diagnostics: [
						{ type: "provider_stream_failure", timestamp: 1, details: { kind: "server_error", status: 503 } },
					],
				}
			: {}),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

afterEach(() => vi.restoreAllMocks());

describe("native auxiliary retry limits", () => {
	it.each([0, 2, undefined])("honors maxRetries=%s independently for each invocation", async (maxRetries) => {
		const requests = new InferenceCoordinator(() => ({
			source: Promise.resolve({ sessionId: "retry-test", leafId: "leaf", sourceSequence: 1, persistent: false }),
			retain: () => {},
			release: async () => {},
			persist: async () => {},
		}));
		requests.setProviderRecoveryPolicy(() => ({ enabled: true, maxRetries, baseDelayMs: 0, maxRetryDelayMs: 1 }));
		let sends = 0;
		vi.spyOn(ai, "streamSimple").mockImplementation((_model, _context, options) => {
			const events = ai.createAssistantMessageEventStream();
			void (async () => {
				const descriptor: ai.ProviderAttemptInfo = {
					api: model.api,
					provider: model.provider,
					model: model.id,
					transport: "http",
					ordinal: 1,
					kind: "initial",
				};
				const attemptId = await options!.attempts!.admit(descriptor);
				const message = response(++sends < 5);
				await options!.attempts!.settle({
					...descriptor,
					attemptId,
					outcome: message.stopReason === "error" ? "failed" : "completed",
					rawUsage: [],
					usage: {},
					usageCompleteness: "none",
					timing: { queuedAt: 1, admittedAt: 2, sentAt: 3, settledAt: 4 },
				});
				if (message.stopReason === "error") events.push({ type: "error", reason: "error", error: message });
				else events.push({ type: "done", reason: "stop", message });
				events.end(message);
			})();
			return events;
		});
		try {
			for (let invocation = 0; invocation < 2; invocation++) {
				sends = 0;
				const message = await requests.complete(model, context, undefined, { purpose: "summary" });
				expect(sends).toBe(maxRetries === undefined ? 5 : maxRetries + 1);
				expect(message.stopReason).toBe(maxRetries === undefined ? "stop" : "error");
				expect(requests.hasPending).toBe(false);
			}
		} finally {
			await requests.dispose();
		}
	});
});
