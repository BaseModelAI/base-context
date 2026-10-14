import { fauxAssistantMessage, type Usage } from "@ponythewhite/base-context-ai";
import { describe, expect, it } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.js";
import { createHarness, type Harness } from "../harness.js";

function completedUsage(h: Harness): Usage {
	const assistant = h
		.eventsOfType("message_end")
		.map((event) => event.message)
		.find((message) => message.role === "assistant");
	if (assistant?.role !== "assistant") throw new Error("Missing terminal assistant message");
	expect(assistant.usage.input + assistant.usage.output + assistant.usage.cacheWrite).toBeGreaterThan(0);
	return assistant.usage;
}

describe("failed work usage", () => {
	it.each(["error", "aborted"] as const)(
		"charges %s output once to goal and autonomous budgets",
		async (stopReason) => {
			const h = await createHarness({
				persistSession: true,
				rlmDepth: 0,
				autonomous: { enabled: true },
				settings: { retry: { enabled: false }, compaction: { enabled: false } },
			});
			try {
				h.setResponses([
					fauxAssistantMessage("partial", { stopReason, errorMessage: "failed after billed output" }),
				]);
				await h.session.prompt("/goal --budget 1000000 finish the task");
				await h.session.waitForIdle();
				const usage = completedUsage(h);
				expect(h.session.goalState.tokensUsed).toBe(usage.input + usage.output);
				expect(h.session.getAutonomousStatus()).toMatchObject({
					turnsUsed: stopReason === "error" ? 0 : 1,
					tokensUsed: usage.input + usage.output + usage.cacheWrite,
				});
			} finally {
				await h.cleanup();
			}
		},
	);

	it.each(["error", "aborted"] as const)(
		"attributes %s native child output once without adding a parent response",
		async (stopReason) => {
			const parent = await createHarness({
				persistSession: true,
				rlmDepth: 0,
				settings: { retry: { enabled: false }, compaction: { enabled: false } },
			});
			let child: AgentSession | undefined;
			let pause: { release(): void } | undefined;
			parent.session.subscribe((event) => {
				if (event.type === "rlm_child_update") child ??= parent.session.getRlmChildSession(event.child.id);
			});
			try {
				parent.setResponses([
					fauxAssistantMessage("delegate"),
					fauxAssistantMessage("partial", { stopReason, errorMessage: "failed after billed output" }),
				]);
				await parent.session.promptAndWait("parent task");
				const source = parent.session.messages
					.slice()
					.reverse()
					.find((message) => message.role === "assistant");
				if (source?.role !== "assistant") throw new Error("Missing native parent response");
				const before = structuredClone(source.usage);
				pause = parent.session.acquireSessionInputPause();
				await parent.session.runRlmChild("child task");
				await Promise.all([...(Reflect.get(parent.session, "_rlmRunTasks") as Set<Promise<void>>)]);
				const terminal = child?.messages
					.slice()
					.reverse()
					.find((message) => message.role === "assistant");
				if (terminal?.role !== "assistant") throw new Error("Missing native child response");
				expect(terminal.stopReason).toBe(stopReason);
				expect(terminal.usage.input + terminal.usage.output + terminal.usage.cacheWrite).toBeGreaterThan(0);
				const expected = structuredClone(before);
				for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const)
					expected[field] += terminal.usage[field];
				for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
					expected.cost[field] += terminal.usage.cost[field];
				expect(source.usage).toEqual(expected);
				expect(
					parent.eventsOfType("message_end").filter((event) => event.message.role === "assistant"),
				).toHaveLength(1);
			} finally {
				await parent.cleanup();
				pause?.release();
			}
		},
	);
});
