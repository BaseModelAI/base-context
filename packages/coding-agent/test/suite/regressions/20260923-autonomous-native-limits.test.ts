import type { AgentTool } from "@ponythewhite/base-context-agent";
import { fauxAssistantMessage, fauxToolCall } from "@ponythewhite/base-context-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../harness.js";

describe("2026-09-23 autonomous native tool-loop limits", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	it.each(["maxTurns", "maxTokens", "timeoutMs"] as const)(
		"stops at %s after a completed tool turn, before another native request",
		async (limit) => {
			let executed = 0;
			const tool: AgentTool = {
				name: "step",
				label: "Step",
				description: "Complete one local step",
				parameters: Type.Object({}),
				execute: async () => {
					executed++;
					if (limit === "timeoutMs") {
						const now = Date.now();
						vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
					}
					return { content: [{ type: "text", text: "completed" }], details: {} };
				},
			};
			const harness = await createHarness({
				persistSession: true,
				tools: [tool],
				autonomous: { enabled: true, [limit]: limit === "timeoutMs" ? 60_000 : 1 },
			});
			harnesses.push(harness);
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("step", {}, { id: "step-1" }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("step", {}, { id: "step-2" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("Done."),
			]);

			await harness.session.prompt("Work through the local steps");

			expect(harness.faux.state.callCount).toBe(1);
			expect(executed).toBe(1);
			expect(harness.session.messages.at(-1)).toMatchObject({
				role: "toolResult",
				toolCallId: "step-1",
				isError: false,
			});
			expect(harness.session.getAutonomousStatus()).toMatchObject({ turnsUsed: 1, continuationsUsed: 0 });
		},
	);

	it("allows the last permitted continuation to finish its native tool loop", async () => {
		const tool: AgentTool = {
			name: "step",
			label: "Step",
			description: "Complete one local step",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "completed" }], details: {} }),
		};
		const harness = await createHarness({
			persistSession: true,
			tools: [tool],
			autonomous: { enabled: true, maxContinuations: 1 },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("I should continue."),
			fauxAssistantMessage(fauxToolCall("step", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("Done."),
		]);

		await harness.session.prompt("Work through the local steps");

		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.session.getAutonomousStatus()).toMatchObject({ turnsUsed: 3, continuationsUsed: 1 });
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});
});
