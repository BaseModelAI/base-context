import type { Api, AssistantMessage, Model } from "@ponythewhite/base-context-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyRefinementProposal,
	generateRefinementId,
	type HarnessState,
	mergeRefinementHistory,
	refineHarness,
	reviewAutoRefine,
} from "../src/core/refinement/index.js";

const { completeInferenceMock } = vi.hoisted(() => ({ completeInferenceMock: vi.fn() }));
vi.mock("../src/core/inference-coordinator.js", () => ({
	completeInference: completeInferenceMock,
	InferenceCoordinator: class {},
}));

const model: Model<Api> = {
	id: "refine-test",
	name: "Refinement test",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://unused.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_000,
	maxTokens: 4096,
};

function state(): HarnessState {
	return { schema: 1, entries: { prompt: {}, memory: {}, skill: {}, subagent: {} }, refinements: [] };
}

function response(stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [
			{
				type: "text",
				text: JSON.stringify({
					summary: "Remember a preference",
					rationale: "The user requested it",
					expectedOutcome: "Remember the preference",
					edits: [
						{ action: "create", kind: "memory", id: "preference", title: "Preference", content: "Be concise" },
					],
					shouldRefine: true,
				}),
			},
		],
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 1,
	};
}

beforeEach(() => completeInferenceMock.mockReset());

describe("refinement cancellation settlement", () => {
	it("applies completed JSON and accepts a completed review", async () => {
		completeInferenceMock.mockResolvedValue(response("stop"));
		const harness = state();
		const result = await refineHarness([], harness, [], model, "unused");
		expect(result.appliedEdits[0].applied).toBe(true);
		expect(harness.entries.memory.preference.content).toBe("Be concise");
		await expect(
			reviewAutoRefine([], harness, [], model, "unused", {
				reason: "turn_interval",
				turnsSinceLastReview: 1,
			}),
		).resolves.toMatchObject({ shouldRefine: true });
	});

	it.each(["provider", "signal"] as const)("does not use complete JSON after %s cancellation", async (kind) => {
		const controller = new AbortController();
		completeInferenceMock.mockImplementation(async () => {
			if (kind === "signal") controller.abort();
			return response(kind === "provider" ? "aborted" : "stop");
		});
		const harness = state();
		await expect(refineHarness([], harness, [], model, "unused", {}, undefined, controller.signal)).rejects.toThrow(
			/abort/i,
		);
		expect(harness.entries.memory).toEqual({});
		expect(harness.refinements).toEqual([]);
		await expect(
			reviewAutoRefine(
				[],
				harness,
				[],
				model,
				"unused",
				{
					reason: "turn_interval",
					turnsSinceLastReview: 1,
				},
				undefined,
				controller.signal,
			),
		).rejects.toThrow(/abort/i);
	});
});

it("retains independent refinements started in the same millisecond", () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-10-13T12:00:00.000Z"));
	try {
		const results = ["first", "second"].map((summary) =>
			applyRefinementProposal(
				state(),
				{ summary, rationale: "", expectedOutcome: "", edits: [] },
				{ id: generateRefinementId(), scope: "global" },
			),
		);
		expect(results[0].id).not.toBe(results[1].id);
		expect(mergeRefinementHistory(results, [])).toHaveLength(2);
	} finally {
		vi.useRealTimers();
	}
});
