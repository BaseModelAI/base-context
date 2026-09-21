import { type AssistantMessage, fauxAssistantMessage } from "@ponythewhite/base-context-ai";
import { describe, expect, it } from "vitest";
import { createTestResourceLoader } from "../utilities.js";
import { createHarness } from "./harness.js";

describe("default automatic compaction across recursive session depths", () => {
	it.each([0, 1, 2, 3])("ninety percent (depth %i)", async (rlmDepth) => {
		const harness = await createHarness({
			rlmDepth,
			persistSession: true,
			models: [{ id: "faux-1", contextWindow: 272_000 }],
			tools: [],
			resourceLoader: { ...createTestResourceLoader(), getSystemPrompt: () => "You are a test assistant." },
			settings: { autoRefine: { enabled: false } },
		});
		try {
			expect(harness.settingsManager.getCompactionSettings()).toEqual({
				enabled: true,
				reserveTokens: 16_384,
				keepRecentTokens: 20_000,
			});
			harness.setResponses([
				() => fauxAssistantMessage("Historical work recorded."),
				() => fauxAssistantMessage("Below the threshold."),
				() => fauxAssistantMessage("Above the threshold."),
				() => fauxAssistantMessage("Ninety-percent checkpoint summary."),
			]);

			await harness.session.prompt(`Historical work: ${"old ".repeat(30_000)}`);
			const seedUsage = (harness.session.messages.at(-1) as AssistantMessage).usage;
			// Faux counts new chars/4 in both input and cacheWrite; cached input counts once.
			await harness.session.prompt("x".repeat((240_000 - seedUsage.input - seedUsage.cacheRead) * 2));
			const belowTokens = (await harness.session.getContextUsage())!.tokens!;
			expect(belowTokens).toBeGreaterThan(239_800);
			expect(belowTokens).toBeLessThan(244_800);
			expect(harness.eventsOfType("compaction_start")).toHaveLength(0);

			const belowUsage = (harness.session.messages.at(-1) as AssistantMessage).usage;
			await harness.session.prompt("y".repeat((245_000 - belowUsage.input - belowUsage.cacheRead) * 2));
			await harness.session.waitForHeadlessIdle();
			const outcomes = harness.eventsOfType("compaction_end");
			expect(outcomes).toHaveLength(1);
			expect(outcomes[0]).toMatchObject({
				reason: "threshold",
				result: { summary: "Ninety-percent checkpoint summary." },
				aborted: false,
			});
			expect(outcomes[0].result!.tokensBefore).toBeGreaterThan(244_800);
			expect(outcomes[0].result!.tokensBefore).toBeLessThan(245_800);
			expect(
				(await harness.sessionManager.readEntries()).filter((entry) => entry.type === "compaction"),
			).toHaveLength(1);
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			await harness.cleanup();
		}
	});
});
