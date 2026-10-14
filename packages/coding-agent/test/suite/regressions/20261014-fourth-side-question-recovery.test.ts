import { fauxAssistantMessage } from "@ponythewhite/base-context-ai";
import { describe, expect, it } from "vitest";
import { type SideQuestionEvent, startSideQuestion } from "../../../src/core/side-question.js";
import { createHarness } from "../harness.js";

function connectionFailure() {
	return {
		...fauxAssistantMessage("", { stopReason: "error", errorMessage: "Network connection lost." }),
		diagnostics: [
			{
				type: "provider_stream_failure" as const,
				timestamp: Date.now(),
				details: { kind: "transport", providerErrorType: "ECONNRESET" },
			},
		],
	};
}

describe("side-question recovery terminal status", () => {
	it.each([true, false])("reports the final response after recovery succeeds=%s", async (recovers) => {
		const harness = await createHarness({
			rlmDepth: 0,
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
		});
		try {
			harness.setResponses([
				connectionFailure(),
				recovers ? fauxAssistantMessage("Recovered answer") : connectionFailure(),
			]);
			const events: SideQuestionEvent[] = [];
			const run = startSideQuestion(harness.session.agent, "recovery", "Side question", (event) => {
				events.push(event);
			});
			await run.done;

			expect(harness.faux.state.callCount).toBe(2);
			expect(events.at(-1)).toMatchObject(
				recovers
					? { status: "complete", answer: "Recovered answer" }
					: { status: "error", errorMessage: "Network connection lost." },
			);
			expect(harness.session.messages).toEqual([]);
		} finally {
			await harness.cleanup();
		}
	});
});
