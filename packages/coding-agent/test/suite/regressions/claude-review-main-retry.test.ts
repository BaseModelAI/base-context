import { fauxAssistantMessage } from "@ponythewhite/base-context-ai";
import { expect, it } from "vitest";
import { createHarness } from "../harness.js";

function temporaryFailure() {
	const message = fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 Service Unavailable" });
	message.diagnostics = [
		{ type: "provider_stream_failure", timestamp: Date.now(), details: { kind: "server_error", status: 503 } },
	];
	return message;
}

it("honors a MAIN retry limit and resets it for the next prompt", async () => {
	const harness = await createHarness({
		persistSession: true,
		settings: {
			compaction: { enabled: false },
			autoRefine: { enabled: false },
			retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
		},
	});
	try {
		harness.setResponses([temporaryFailure(), temporaryFailure(), temporaryFailure()]);
		await harness.session.prompt("First task.");
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual([1, 2]);
		expect(harness.eventsOfType("auto_retry_end")).toEqual([
			expect.objectContaining({ success: false, attempt: 2, finalError: "503 Service Unavailable" }),
		]);
		expect(harness.session.retryAttempt).toBe(0);
		expect(harness.session.isRetrying).toBe(false);
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
		harness.setResponses([temporaryFailure(), fauxAssistantMessage("Recovered on the next task.")]);
		await harness.session.prompt("Next task.");
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual([1, 2, 1]);
		expect(harness.eventsOfType("auto_retry_end").at(-1)).toMatchObject({ success: true, attempt: 1 });
		expect(harness.session.retryAttempt).toBe(0);
	} finally {
		await harness.cleanup();
	}
});

it("does not retry MAIN when maxRetries is zero", async () => {
	const harness = await createHarness({
		settings: {
			compaction: { enabled: false },
			autoRefine: { enabled: false },
			retry: { enabled: true, maxRetries: 0, baseDelayMs: 1 },
		},
	});
	try {
		harness.setResponses([temporaryFailure()]);
		await harness.session.prompt("Do not retry this task.");
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		expect(harness.session.isRetrying).toBe(false);
	} finally {
		await harness.cleanup();
	}
});
