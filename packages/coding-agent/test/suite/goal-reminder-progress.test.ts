import type { AgentTool } from "@ponythewhite/base-context-agent";
import { fauxAssistantMessage, fauxToolCall } from "@ponythewhite/base-context-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

const ipython: AgentTool = {
	name: "ipython",
	label: "ipython",
	description: "Offline work",
	parameters: Type.Object({ code: Type.String() }),
	execute: async () => ({ content: [{ type: "text", text: "work done" }], details: {} }),
};

function reminders(harness: Harness) {
	return harness
		.eventsOfType("message_end")
		.filter(({ message }) => message.role === "custom" && message.customType === "goal_context");
}

async function notify(harness: Harness, customType: string) {
	await harness.session.sendCustomMessage(
		{ customType, content: "Already collected completion", display: true },
		{ triggerTurn: true },
	);
	await harness.session.waitForIdle();
}

describe("goal reminder progress", () => {
	let harness: Harness;
	afterEach(async () => {
		await harness?.cleanup();
	});

	it("keeps one post-compaction reminder through empty completion-notice turns", async () => {
		harness = await createHarness({
			persistSession: true,
			tools: [ipython],
			models: [{ id: "faux-1", contextWindow: 10_000 }],
			settings: {
				compaction: { enabled: true, reserveTokens: 8_000, keepRecentTokens: 1 },
				autoRefine: { enabled: false },
			},
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "Work remains on the active goal.",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("Prepared.")]);
		await harness.session.prompt("Prepare the task.");
		await harness.session.handleGoalHostRequest("goal.create", { objective: "Finish the task" });
		harness.setResponses([
			fauxAssistantMessage(`Work done, more remains. ${"x".repeat(9_000)}`),
			fauxAssistantMessage(" "),
		]);
		await harness.session.prompt("Make progress.");
		await harness.session.waitForIdle();
		expect(harness.eventsOfType("compaction_end").some((event) => event.result)).toBe(true);
		expect(reminders(harness)).toHaveLength(1);
		const tokensBeforeNotices = harness.session.goalState.tokensUsed;

		harness.setResponses([fauxAssistantMessage(" "), fauxAssistantMessage("")]);
		await notify(harness, "ipython_execution_complete");
		await notify(harness, "job_watch_event");
		expect(reminders(harness)).toHaveLength(1);
		expect(harness.session.goalState).toMatchObject({ status: "active", continuationsUsed: 1 });
		expect(harness.session.goalState.tokensUsed).toBeGreaterThanOrEqual(tokensBeforeNotices);
		expect(harness.getPendingResponseCount()).toBe(0);

		harness.setResponses([fauxAssistantMessage("Completed the next real step."), fauxAssistantMessage("")]);
		await notify(harness, "job_watch_event");
		expect(reminders(harness)).toHaveLength(2);
		expect(harness.session.goalState).toMatchObject({ status: "active", continuationsUsed: 2 });
	});

	it("rearms reminders for tool work and new user input without requiring nonempty final text", async () => {
		harness = await createHarness({ tools: [ipython] });
		await harness.session.handleGoalHostRequest("goal.create", { objective: "Finish the task" });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("ipython", { code: "do_work()" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(" "),
			fauxAssistantMessage(""),
		]);
		await notify(harness, "job_watch_event");
		expect(reminders(harness)).toHaveLength(1);
		expect(harness.session.goalState.continuationsUsed).toBe(1);

		harness.setResponses([fauxAssistantMessage(""), fauxAssistantMessage(" ")]);
		await harness.session.prompt("Continue with the next task step.");
		await harness.session.waitForIdle();
		expect(reminders(harness)).toHaveLength(2);
		expect(harness.session.goalState).toMatchObject({ status: "active", continuationsUsed: 2 });
		expect(harness.getPendingResponseCount()).toBe(0);
	});
});
