import { fauxAssistantMessage } from "@ponythewhite/base-context-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { BashOperations } from "../../../src/core/tools/bash.js";
import { createHarness, getAssistantTexts, type Harness } from "../harness.js";

describe("issue #2151 waitForIdle with a blocked input pump", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	it("yields to IO while bash blocks queued input and delivers arrivals during the wait", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const session = harness.session;
		let releaseBash!: () => void;
		const gate = new Promise<{ exitCode: number | null }>((resolve) => {
			releaseBash = () => resolve({ exitCode: 0 });
		});
		const operations: BashOperations = { exec: async () => gate };
		const bash = session.executeBash("blocked", undefined, { operations });
		expect(session.isBashRunning).toBe(true);
		harness.setResponses([fauxAssistantMessage("first done"), fauxAssistantMessage("second done")]);
		const firstPrompt = session.prompt("queued while bash runs");
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(session.hasPendingSessionWork).toBe(true);

		const idle = session.waitForIdle();
		let secondPrompt: Promise<void> | undefined;
		setImmediate(() => {
			secondPrompt = session.prompt("queued during park");
			secondPrompt.catch(() => undefined);
			releaseBash();
		});
		await idle;
		await bash;
		await firstPrompt;
		await secondPrompt;
		expect(getAssistantTexts(harness)).toEqual(["first done", "second done"]);
		expect(session.hasPendingAdmissionWaiters).toBe(false);
	});

	it("settles a parked wait when queued work is cancelled without leaking a checkpoint waiter", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const session = harness.session;
		let releaseBash!: () => void;
		const gate = new Promise<{ exitCode: number | null }>((resolve) => {
			releaseBash = () => resolve({ exitCode: 0 });
		});
		const operations: BashOperations = { exec: async () => gate };
		const bash = session.executeBash("blocked", undefined, { operations });
		const prompt = session.prompt("cancel before delivery");
		const rejected = expect(prompt).rejects.toThrow("Prompt aborted before delivery");
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(session.hasPendingSessionWork).toBe(true);

		const idle = session.waitForIdle();
		setImmediate(() => {
			session.requestAbort();
			releaseBash();
		});
		await idle;
		await bash;
		await rejected;
		expect(getAssistantTexts(harness)).toEqual([]);
		expect(session.hasPendingSessionWork).toBe(false);
		expect(session.hasPendingAdmissionWaiters).toBe(false);
	});
});
