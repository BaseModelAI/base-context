import { fauxAssistantMessage } from "@ponythewhite/base-context-ai";
import { describe, expect, it, vi } from "vitest";
import { GOAL_STATE_CUSTOM_TYPE, type GoalState } from "../../../src/core/goals.js";
import { createHarness } from "../harness.js";
import { createDeferred } from "../scheduling.js";

describe("goal usage publication", () => {
	it.each([false, true])(
		"preserves completion and usage across publication (replace source: %s)",
		async (replaceSource) => {
			const h = await createHarness({
				persistSession: true,
				rlmDepth: 0,
				settings: { retry: { enabled: false }, compaction: { enabled: false } },
			});
			const entered = createDeferred();
			const release = createDeferred();
			let prompt: Promise<void> | undefined;
			try {
				await h.session.handleGoalHostRequest("goal.create", {
					objective: "Finish the task",
					token_budget: 1000000,
				});
				const append = h.sessionManager.appendCustomEntry.bind(h.sessionManager);
				let holdUsageFlush = false;
				vi.spyOn(h.sessionManager, "appendCustomEntry").mockImplementation(async (type, data) => {
					const result = await append(type, data);
					if (type === GOAL_STATE_CUSTOM_TYPE && (data as GoalState).tokensUsed > 0) holdUsageFlush = true;
					return result;
				});
				const flush = h.sessionManager.flushNow.bind(h.sessionManager);
				vi.spyOn(h.sessionManager, "flushNow").mockImplementation(async () => {
					await flush();
					if (!holdUsageFlush) return;
					holdUsageFlush = false;
					entered.resolve();
					await release.promise;
				});
				h.setResponses([fauxAssistantMessage("partial", { stopReason: "error", errorMessage: "billed output" })]);
				prompt = h.session.promptAndWait("Make progress");
				await entered.promise;
				const completion = h.session.handleGoalHostRequest("goal.complete");
				const completionResult = completion.then(
					() => undefined,
					(error: unknown) => error,
				);
				if (replaceSource) await h.sessionManager.branchTo(null);
				release.resolve();
				if (replaceSource) {
					expect(await completionResult).toMatchObject({ message: "Goal completion owner changed" });
					await prompt.catch(() => {});
					expect(h.session.goalState.status).not.toBe("complete");
					return;
				}
				expect(await completionResult).toBeUndefined();
				await prompt;
				const assistant = h
					.eventsOfType("message_end")
					.map(({ message }) => message)
					.find((message) => message.role === "assistant");
				if (assistant?.role !== "assistant") throw new Error("Missing assistant output");
				const tokensUsed = assistant.usage.input + assistant.usage.output;
				expect(tokensUsed).toBeGreaterThan(0);
				expect(h.session.goalState).toMatchObject({ status: "complete", active: false, tokensUsed });
				const history = await h.sessionManager.readBranch();
				const latest = history
					.filter((entry) => entry.type === "custom" && entry.customType === GOAL_STATE_CUSTOM_TYPE)
					.at(-1);
				expect(latest).toMatchObject({ data: { status: "complete", tokensUsed } });
			} finally {
				release.resolve();
				await prompt?.catch(() => {});
				vi.restoreAllMocks();
				await h.cleanup();
			}
		},
	);
});
