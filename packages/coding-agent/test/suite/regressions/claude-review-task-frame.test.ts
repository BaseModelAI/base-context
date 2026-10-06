import { fauxAssistantMessage, type Message } from "@ponythewhite/base-context-ai";
import { expect, it } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.js";
import { createHarness, getMessageText } from "../harness.js";

function frameTexts(messages: readonly Message[]): string[] {
	return messages.map(getMessageText).filter((text) => text.startsWith("Recorded task context."));
}

it("sends each visible user prompt once without TaskFrame revision messages", async () => {
	const harness = await createHarness({
		persistSession: true,
		settings: { compaction: { enabled: false }, autoRefine: { enabled: false } },
	});
	const requests: Message[][] = [];
	try {
		harness.setResponses(
			Array.from({ length: 3 }, () => (context) => {
				requests.push(structuredClone(context.messages));
				return fauxAssistantMessage("Acknowledged.");
			}),
		);
		const prompts = [
			"Keep warehouse codes ASCII.",
			"Do not change public column names.",
			"Use only Python standard library.",
		];
		for (const prompt of prompts) await harness.session.prompt(prompt);
		expect(harness.faux.state.callCount).toBe(3);
		expect(requests).toHaveLength(3);
		for (const [index, messages] of requests.entries()) {
			expect(frameTexts(messages)).toEqual([]);
			for (const prompt of prompts.slice(0, index + 1)) {
				expect(messages.filter((message) => getMessageText(message).includes(prompt))).toHaveLength(1);
			}
		}
	} finally {
		await harness.cleanup();
	}
});

it("keeps compacted instructions ahead of a long newest prompt across cold replay and branch navigation", async () => {
	const settings = { compaction: { enabled: false, keepRecentTokens: 1 }, autoRefine: { enabled: false } };
	const harness = await createHarness({ persistSession: true, settings });
	let reopened: Awaited<ReturnType<typeof createHarness>> | undefined;
	const older = `Warehouse codes must stay ASCII. ${"Older exact constraint. ".repeat(32)}`;
	const newest = `Current literal prompt. ${"z".repeat(1500)}`;
	try {
		harness.setResponses([fauxAssistantMessage("First answer"), fauxAssistantMessage("Second answer")]);
		await harness.session.prompt(older);
		const firstLeaf = harness.sessionManager.getLeafId()!;
		await harness.session.prompt("Prepare the next step.");
		harness.setResponses([
			fauxAssistantMessage("Earlier work summarized."),
			fauxAssistantMessage("Turn summarized."),
		]);
		await harness.session.compact();
		let captured: Message[] = [];
		harness.setResponses([
			(context) => {
				captured = structuredClone(context.messages);
				return fauxAssistantMessage("Continued.");
			},
		]);
		await harness.session.prompt(newest);
		const frames = frameTexts(captured);
		expect(frames).toHaveLength(1);
		const frame = JSON.parse(frames[0].slice(frames[0].indexOf("\n") + 1));
		expect(frame.rows).toContainEqual(expect.objectContaining({ text: older }));
		expect(frames.join("\n")).not.toContain(newest);
		expect(captured.filter((message) => getMessageText(message).includes(newest))).toHaveLength(1);
		const file = harness.sessionManager.getSessionFile()!;
		await harness.session.disposeAsync();
		await harness.sessionManager.close();
		reopened = await createHarness({ sessionManager: await SessionManager.open(file), settings });
		reopened.setResponses([
			(context) => {
				captured = structuredClone(context.messages);
				return fauxAssistantMessage("Resumed.");
			},
		]);
		await reopened.session.prompt("Continue after reopening.");
		expect(frameTexts(captured).join("\n")).toContain(older);
		await reopened.sessionManager.branchTo(firstLeaf);
		reopened.setResponses([
			(context) => {
				captured = structuredClone(context.messages);
				return fauxAssistantMessage("Branched.");
			},
		]);
		await reopened.session.prompt("Take another branch.");
		expect(frameTexts(captured)).toEqual([]);
		expect(captured.filter((message) => getMessageText(message).includes(older))).toHaveLength(1);
		expect(captured.map(getMessageText).join("\n")).not.toContain(newest);
	} finally {
		await reopened?.cleanup();
		await harness.cleanup();
	}
});
