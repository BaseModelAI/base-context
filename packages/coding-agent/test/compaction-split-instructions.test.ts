import type * as ai from "@ponythewhite/base-context-ai";
import { type AssistantMessage, type Context, getModel } from "@ponythewhite/base-context-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type CompactionPreparation, compact } from "../src/core/compaction/compaction.js";
import { createFileOps } from "../src/core/compaction/utils.js";

const { completeSimpleMock } = vi.hoisted(() => ({ completeSimpleMock: vi.fn() }));
vi.mock("@ponythewhite/base-context-ai", async (importOriginal) => ({
	...(await importOriginal<typeof ai>()),
	completeSimple: completeSimpleMock,
}));

const response: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "Summary" }],
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
	timestamp: 0,
};

describe("split compaction custom instructions", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue(response);
	});

	it.each([true, false])("includes the instructions in every summary call (prior history: %s)", async (hasHistory) => {
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "retained-tail",
			messagesToSummarize: hasHistory ? [{ role: "user", content: "Previous task", timestamp: 0 }] : [],
			turnPrefixMessages: [{ role: "user", content: "Current task: report exact failure", timestamp: 1 }],
			isSplitTurn: true,
			tokensBefore: 1000,
			fileOps: createFileOps(),
			settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 100 },
		};
		const instructions = "Preserve verbatim: FAILURE_REPORT_42. Keep the unresolved report requirement binding.";
		await compact(preparation, getModel("anthropic", "claude-sonnet-4-5"), "test-key", undefined, instructions);

		expect(completeSimpleMock).toHaveBeenCalledTimes(hasHistory ? 2 : 1);
		for (const call of completeSimpleMock.mock.calls) {
			const context = call[1] as Context;
			const content = context.messages[0].content;
			const text =
				typeof content === "string"
					? content
					: content.map((block) => (block.type === "text" ? block.text : "")).join("");
			expect(text).toContain(instructions);
			expect(text.indexOf("<user-instructions>")).toBeGreaterThan(text.indexOf("</conversation>"));
		}
	});
});
