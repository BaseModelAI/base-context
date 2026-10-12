import type { AgentMessage } from "@ponythewhite/base-context-agent";
import type * as ai from "@ponythewhite/base-context-ai";
import { type AssistantMessage, getModel, type Model } from "@ponythewhite/base-context-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildSummarizationPrompt,
	type CompactionPreparation,
	compact,
	generateBranchSummary,
	generateSummary,
} from "../src/core/compaction/index.js";
import { createFileOps, SUMMARIZATION_SYSTEM_PROMPT, serializeConversation } from "../src/core/compaction/utils.js";
import type { InferenceCoordinator } from "../src/core/inference-coordinator.js";
import { convertToLlm } from "../src/core/messages.js";
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

	it("serializes null tool arguments literally without mutating history", () => {
		const history: AssistantMessage[] = [
			{
				...mockSummaryResponse,
				content: [
					{
						type: "toolCall",
						id: "null-args",
						name: "ipython",
						arguments: null as unknown as Record<string, unknown>,
					},
					{ type: "toolCall", id: "object-args", name: "ipython", arguments: { code: "print(1)", count: 2 } },
				],
			},
		];
		const originalHistory = structuredClone(history);

		expect(serializeConversation(history)).toBe(
			'[Assistant tool calls]: ipython(null); ipython(code="print(1)", count=2)',
		);
		expect(history).toEqual(originalHistory);
	});

	it("preserves binding requirements in initial and updated summary prompts", async () => {
		const requirements: AgentMessage[] = [
			{ role: "user", content: "Payroll must follow the original company rules.", timestamp: 1 },
			{ ...mockSummaryResponse, content: [{ type: "text", text: "Consider using the new union rules instead." }] },
		];
		const previousSummaries = [
			undefined,
			"## Constraints & Preferences\n- Payroll must follow the original company rules.",
		];
		for (const previousSummary of previousSummaries) {
			await generateSummary(
				requirements,
				createModel(false),
				2000,
				"test-key",
				undefined,
				undefined,
				previousSummary ? "" : undefined,
				previousSummary,
			);
		}

		expect(completeSimpleMock).toHaveBeenCalledTimes(2);
		for (const [index, call] of completeSimpleMock.mock.calls.entries()) {
			const previousSummary = previousSummaries[index];
			const instructions = buildSummarizationPrompt(undefined, previousSummary).replace(
				/^The messages above/,
				"The messages in <conversation> tags",
			);
			const evidence = `<conversation>\n${serializeConversation(convertToLlm(requirements))}\n</conversation>${previousSummary ? `\n\n<previous-summary>\n${previousSummary}\n</previous-summary>` : ""}`;
			expect(call[1]).toEqual({
				systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: `${instructions}\n\n${evidence}` }],
						timestamp: expect.any(Number),
					},
				],
			});
			const prompt = JSON.stringify(call[1]);
			expect(prompt).toContain("[User]: Payroll must follow the original company rules.");
			expect(prompt).toContain("[Assistant]: Consider using the new union rules instead.");
			expect(prompt).toContain("original force, scope, and conditions, subject to higher-priority instructions");
			expect(prompt).toContain("until a later user instruction changes or withdraws them");
			expect(prompt).toContain("progress or assistant suggestions alone do not change them");
			expect(prompt).toContain("not merely as past decisions or optional suggestions");
			expect(prompt).toContain("Distinguish settled decisions from unaccepted recommendations");
			expect(prompt).toContain("do not invent new recommendations");
			expect(prompt).toContain("Never instruct the next assistant to relax still-binding constraints");
		}
		expect(JSON.stringify(completeSimpleMock.mock.calls[1][1])).toContain(
			"still-binding requirements and constraints remain relevant",
		);
	});

	it("keeps the same rules in a split-turn prefix with a later user change", async () => {
		await compact(
			{
				firstKeptEntryId: "kept",
				messagesToSummarize: [],
				turnPrefixMessages: [
					{ role: "user", content: "Payroll must follow the original company rules.", timestamp: 1 },
					{
						role: "user",
						content: "Use the new union rules for overtime only; keep all other company rules.",
						timestamp: 2,
					},
				],
				isSplitTurn: true,
				tokensBefore: 90_000,
				fileOps: createFileOps(),
				settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
			},
			createModel(false),
			"test-key",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		const context = completeSimpleMock.mock.calls[0][1];
		const text: string = context.messages[0].content[0].text;
		expect(context.systemPrompt).toBe(SUMMARIZATION_SYSTEM_PROMPT);
		expect(text).toMatch(/^The conversation in <conversation> tags is the PREFIX of a turn/);
		expect(text.slice(0, text.indexOf("\n\n<conversation>"))).toContain(
			"Never instruct the next assistant to relax still-binding constraints.",
		);
		expect(text).toContain(
			"\n\n<conversation>\n[User]: Payroll must follow the original company rules.\n\n[User]: Use the new union rules for overtime only; keep all other company rules.\n</conversation>",
		);
		const prompt = JSON.stringify(context);
		expect(prompt).toContain("PREFIX of a turn");
		expect(prompt).toContain("[User]: Use the new union rules for overtime only; keep all other company rules.");
		expect(prompt).toContain("original force, scope, and conditions, subject to higher-priority instructions");
		expect(prompt).toContain("until a later user instruction changes or withdraws them");
		expect(prompt).toContain("progress or assistant suggestions alone do not change them");
		expect(prompt).toContain("not merely as past decisions or optional suggestions");
		expect(prompt).toContain("Distinguish settled decisions from unaccepted recommendations");
		expect(prompt).toContain("do not invent new recommendations");
		expect(prompt).toContain("Never instruct the next assistant to relax still-binding constraints");
	});

	it("keeps custom history instructions after conversation and prior-summary evidence", async () => {
		const previousSummary = "## Goal\nContinue the existing task.";
		for (const customInstructions of ["Preserve the messages above verbatim.", " "]) {
			await generateSummary(
				messages,
				createModel(false),
				2000,
				"test-key",
				undefined,
				undefined,
				customInstructions,
				previousSummary,
			);
			const context = completeSimpleMock.mock.lastCall![1];
			expect(context).toEqual({
				systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: [
							{
								type: "text",
								text: `<conversation>\n[User]: Summarize this.\n</conversation>\n\n<previous-summary>\n${previousSummary}\n</previous-summary>\n\n${buildSummarizationPrompt(customInstructions, previousSummary)}`,
							},
						],
						timestamp: expect.any(Number),
					},
				],
			});
		}
		expect(completeSimpleMock).toHaveBeenCalledTimes(2);
	});

	it("prefixes default branch instructions but leaves custom append and replacement prompts unchanged", async () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "branch-message",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				message: messages[0],
			},
		];
		const options = { model: createModel(false), apiKey: "test-key", signal: new AbortController().signal };
		const conversation = "<conversation>\n[User]: Summarize this.\n</conversation>";
		await generateBranchSummary(entries, options);
		const context = completeSimpleMock.mock.lastCall![1];
		const text: string = context.messages[0].content[0].text;
		expect(context.systemPrompt).toBe(SUMMARIZATION_SYSTEM_PROMPT);
		expect(text).toMatch(/^Create a structured summary of this conversation branch/);
		expect(text.endsWith(`\n\n${conversation}`)).toBe(true);
		const instructions = text.slice(0, -(conversation.length + 2));
		expect(instructions).toContain(
			"Keep each section concise. Preserve exact file paths, function names, and error messages.",
		);
		const customInstructions = "Summarize the messages above in one paragraph.";
		for (const replaceInstructions of [false, true]) {
			await generateBranchSummary(entries, { ...options, customInstructions, replaceInstructions });
			expect(completeSimpleMock.mock.lastCall![1]).toEqual({
				systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: [
							{
								type: "text",
								text: `${conversation}\n\n${replaceInstructions ? customInstructions : `${instructions}\n\nAdditional focus: ${customInstructions}`}`,
							},
						],
						timestamp: expect.any(Number),
					},
				],
			});
		}
		expect(completeSimpleMock).toHaveBeenCalledTimes(3);
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
