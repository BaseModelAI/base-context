import { type AssistantMessage, fauxAssistantMessage } from "@ponythewhite/base-context-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.js";

describe("regression #3982: message_end cost override", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) {
			await harnesses.pop()?.cleanup();
		}
	});

	it("allows extensions to replace finalized assistant usage cost", async () => {
		let originalAssistant: AssistantMessage | undefined;
		const expectedContent = [{ type: "text" as const, text: "mutated during message_end" }];
		const harness = await createHarness({
			persistSession: true,
			extensionFactories: [
				(pi) => {
					pi.on("message_end", async (event) => {
						if (event.message.role !== "assistant") return;
						originalAssistant = event.message;
						event.message.content = expectedContent;
						await Promise.resolve();

						return {
							message: {
								...event.message,
								usage: {
									...event.message.usage,
									cost: {
										...event.message.usage.cost,
										total: 0.123,
									},
								},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		expect(harness.sessionManager.supportsCapturedHistoryReads()).toBe(true);
		harness.setResponses([fauxAssistantMessage("hello")]);

		await harness.session.prompt("hi");

		const assistantMessage = harness.session.messages.find((message) => message.role === "assistant");
		expect(assistantMessage?.role).toBe("assistant");
		if (assistantMessage?.role !== "assistant") {
			throw new Error("missing assistant message");
		}
		expect(assistantMessage).toBe(originalAssistant);
		expect(assistantMessage.content).toEqual(expectedContent);
		expect(assistantMessage.usage.cost.total).toBe(0.123);

		const messageEnd = harness.eventsOfType("message_end").find((event) => event.message.role === "assistant");
		expect(messageEnd?.message.role).toBe("assistant");
		if (messageEnd?.message.role !== "assistant") {
			throw new Error("missing assistant message_end event");
		}
		expect(messageEnd.message.usage.cost.total).toBe(0.123);
		const agentEnd = harness.eventsOfType("agent_end").at(-1);
		if (!agentEnd || agentEnd.refusal) throw new Error("missing complete native agent_end");
		expect(agentEnd.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		const output = agentEnd.messages.find((message) => message.role === "assistant");
		expect(output).toEqual(assistantMessage);
		expect(output).not.toBe(originalAssistant);
		if (!output || output.role !== "assistant") throw new Error("missing finalized native assistant output");
		expect(output.content).not.toBe(originalAssistant!.content);
		const persisted = (await harness.sessionManager.readEntries()).find(
			(entry) => entry.type === "message" && entry.message.role === "assistant",
		);
		expect(persisted).toMatchObject({
			type: "message",
			message: { content: expectedContent, usage: { cost: { total: 0.123 } } },
		});
	});
});
