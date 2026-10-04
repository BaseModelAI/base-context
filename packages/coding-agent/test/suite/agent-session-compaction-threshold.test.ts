import { type AssistantMessage, fauxAssistantMessage } from "@ponythewhite/base-context-ai";
import { describe, expect, it } from "vitest";
import { shouldCompact } from "../../src/core/compaction/compaction.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
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

describe("Codex context defaults", () => {
	it("uses the direct inclusive threshold without the fixed floor or reserve cap", () => {
		const manager = SettingsManager.inMemory();
		const settings = manager.getCompactionSettings();
		for (const model of [
			{ provider: "deepseek", id: "deepseek-flash", contextWindow: 1_048_576 },
			{ provider: "openai-codex", id: "gpt-6.1-sol", contextWindow: 272_000 },
			{ provider: "openai-codex", id: "gpt-6-astra", contextWindow: 100_000 },
		]) {
			const policy = manager.getCompactionContextPolicy(model)!;
			const limit = Math.floor(model.contextWindow * 0.9);
			expect(shouldCompact(limit - 1, model.contextWindow, settings, model.contextWindow, policy)).toBe(false);
			expect(shouldCompact(limit, model.contextWindow, settings, model.contextWindow, policy)).toBe(true);
			expect(shouldCompact(limit, model.contextWindow, { ...settings, enabled: false }, 0, policy)).toBe(false);
		}
		const model = { provider: "deepseek", id: "deepseek-flash", contextWindow: 100_000 };
		for (const compaction of [
			{ targetTokens: 70_000 },
			{ targetTokens: "model-limit" as const },
			{ reserveTokens: 10_000 },
			{ keepRecentTokens: 1 },
		]) {
			const explicit = SettingsManager.inMemory({ compaction });
			expect(explicit.getCompactionContextPolicy(model)).toBeUndefined();
			expect(explicit.getCompactionSettings()).toMatchObject(compaction);
		}
	});

	it("defers a finished turn to the next request and reports the resolved usable window", async () => {
		const harness = await createHarness({
			rlmDepth: 2,
			provider: "deepseek",
			persistSession: true,
			models: [{ id: "deepseek-flash", contextWindow: 100_000 }],
			tools: [],
			resourceLoader: { ...createTestResourceLoader(), getSystemPrompt: () => "You are a test assistant." },
			settings: { autoRefine: { enabled: false } },
		});
		try {
			harness.setResponses([
				() => fauxAssistantMessage("Historical work recorded."),
				() => fauxAssistantMessage("Finished above the threshold."),
				(_context, options) => {
					expect(options?.maxTokens).toBeUndefined();
					return fauxAssistantMessage("Deferred checkpoint summary.");
				},
				() => fauxAssistantMessage("Next request completed."),
			]);
			await harness.session.prompt(`Historical work: ${"old ".repeat(25_000)}`);
			const seedUsage = (harness.session.messages.at(-1) as AssistantMessage).usage;
			await harness.session.prompt("x".repeat((91_000 - seedUsage.input - seedUsage.cacheRead) * 2));
			await harness.session.waitForHeadlessIdle();
			const usage = (await harness.session.getContextUsage())!;
			expect(usage.contextWindow).toBe(95_000);
			expect(usage.tokens).toBeGreaterThanOrEqual(90_000);
			expect(usage.percent).toBe((usage.tokens! / 95_000) * 100);
			expect(harness.getModel().contextWindow).toBe(100_000);
			expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
			await harness.session.prompt("Continue with the next request.");
			await harness.session.waitForHeadlessIdle();
			expect(harness.eventsOfType("compaction_end")).toMatchObject([
				{ reason: "threshold", result: { summary: "Deferred checkpoint summary." }, aborted: false },
			]);
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			await harness.cleanup();
		}
	});
});
