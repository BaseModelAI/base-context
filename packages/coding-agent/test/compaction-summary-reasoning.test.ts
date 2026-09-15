import type { AgentMessage } from "@ponythewhite/base-context-agent";
import type { AssistantMessage, Model } from "@ponythewhite/base-context-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateSummary } from "../src/core/compaction/index.js";
import type { InferenceCoordinator } from "../src/core/inference-coordinator.js";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@ponythewhite/base-context-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ponythewhite/base-context-ai")>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

function createModel(reasoning: boolean): Model<"anthropic-messages"> {
	return {
		id: reasoning ? "reasoning-model" : "non-reasoning-model",
		name: reasoning ? "Reasoning Model" : "Non-reasoning Model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	};
}

const mockSummaryResponse: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "## Goal\nTest summary" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	usage: {
		input: 10,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 20,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
};

const messages: AgentMessage[] = [{ role: "user", content: "Summarize this.", timestamp: Date.now() }];

describe("generateSummary reasoning options", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue(mockSummaryResponse);
	});

	it("uses the provided thinking level for reasoning-capable models", async () => {
		const complete = vi.fn<InferenceCoordinator["complete"]>().mockResolvedValue(mockSummaryResponse);
		const requests = { complete } as unknown as InferenceCoordinator;
		await generateSummary(
			messages,
			createModel(true),
			2000,
			"test-key",
			{ "X-ACP-Model-Request-ID": "summary-request" },
			undefined,
			undefined,
			undefined,
			"medium",
			requests,
		);

		expect(complete).toHaveBeenCalledTimes(1);
		expect(complete.mock.calls[0][2]).toMatchObject({
			reasoning: "medium",
			apiKey: "test-key",
		});
		expect(complete.mock.calls[0][3]).toEqual({
			purpose: "summary",
			purposeDetail: "compaction",
			operationId: "summary-request",
			semanticEdgeId: "summary-request",
		});
		expect(completeSimpleMock).not.toHaveBeenCalled();
	});

	it("does not set reasoning when thinking is off", async () => {
		await generateSummary(
			messages,
			createModel(true),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"off",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			apiKey: "test-key",
		});
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("reasoning");
	});

	it("does not set reasoning for non-reasoning models", async () => {
		await generateSummary(
			messages,
			createModel(false),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"medium",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			apiKey: "test-key",
		});
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("reasoning");
	});
});
