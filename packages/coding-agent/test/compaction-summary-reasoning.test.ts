import type { AgentMessage } from "@ponythewhite/base-context-agent";
import type * as ai from "@ponythewhite/base-context-ai";
import { type AssistantMessage, getModel, type Model } from "@ponythewhite/base-context-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CompactionPreparation,
	compact,
	generateBranchSummary,
	generateSummary,
} from "../src/core/compaction/index.js";
import { createFileOps } from "../src/core/compaction/utils.js";
import type { InferenceCoordinator } from "../src/core/inference-coordinator.js";
import type { SessionEntry } from "../src/core/session-manager.js";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@ponythewhite/base-context-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof ai>();
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

	it("omits parity summary caps including internal capacity caps and uses the branch usable window", async () => {
		const model = { ...getModel("deepseek", "deepseek-flash"), contextWindow: 100_000 };
		const complete = vi.fn<InferenceCoordinator["complete"]>().mockResolvedValue(mockSummaryResponse);
		const requests = { complete, getRequestTokenBudgetOptions: () => undefined } as unknown as InferenceCoordinator;
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "kept",
			messagesToSummarize: messages,
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 90_000,
			fileOps: createFileOps(),
			settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
		};
		await compact(
			preparation,
			model,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			requests,
			() => 10,
		);
		await generateSummary(
			messages,
			model,
			16_384,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			requests,
		);
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "older",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: `older marker ${"x".repeat(200_000)}`, timestamp: 1 },
			},
			{
				type: "message",
				id: "newer",
				parentId: "older",
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "y".repeat(160_000), timestamp: 2 },
			},
		];
		await generateBranchSummary(entries, {
			model,
			apiKey: "test-key",
			requests,
			signal: new AbortController().signal,
		});
		expect(complete).toHaveBeenCalledTimes(4);
		for (const call of complete.mock.calls) expect(call[2]?.maxTokens).toBeUndefined();
		expect(JSON.stringify(complete.mock.calls[3][1])).toContain("older marker");
		await generateBranchSummary(entries, {
			model,
			apiKey: "test-key",
			requests,
			signal: new AbortController().signal,
			reserveTokens: 20_000,
		});
		expect(JSON.stringify(complete.mock.calls[4][1])).not.toContain("older marker");
	});

	it("preserves explicit output overrides and enforced request-budget pressure", async () => {
		const model = getModel("deepseek", "deepseek-flash");
		const complete = vi.fn<InferenceCoordinator["complete"]>().mockResolvedValue(mockSummaryResponse);
		const requests = {
			complete,
			getRequestTokenBudgetOptions: () => ({ mode: "enforce", profiles: [] }),
		} as unknown as InferenceCoordinator;
		await generateSummary(
			messages,
			model,
			16_384,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			requests,
			77,
		);
		expect(complete.mock.calls[0][2]?.maxTokens).toBe(77);
		await compact(
			{
				firstKeptEntryId: "kept",
				messagesToSummarize: messages,
				turnPrefixMessages: messages,
				isSplitTurn: true,
				tokensBefore: 90_000,
				fileOps: createFileOps(),
				settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
			},
			model,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			requests,
			() => 10,
		);
		expect(complete.mock.calls.slice(1).map((call) => call[2]?.maxTokens)).toEqual([6, 4]);
	});
});
