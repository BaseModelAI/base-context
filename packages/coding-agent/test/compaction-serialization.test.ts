import type { Message } from "@ponythewhite/base-context-ai";
import { describe, expect, it } from "vitest";
import { serializeConversation } from "../src/core/compaction/utils.js";
import { PUBLIC_TOOL_CONTINUATION_RENDERER } from "../src/core/public-context.js";

describe("serializeConversation", () => {
	it("should truncate long tool results", () => {
		const longContent = `HEAD${"h".repeat(1500)}MIDDLE${"m".repeat(3000)}FINAL_ERROR`;
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "ipython",
				content: [{ type: "text", text: longContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		const excerpt = result.slice("[Tool result (ipython)]: ".length);
		expect(result).toContain("[Tool result (ipython)]: HEAD");
		expect(excerpt.endsWith("FINAL_ERROR")).toBe(true);
		expect(excerpt).not.toContain("MIDDLE");
		expect(excerpt.length).toBeLessThanOrEqual(2000);
		const marker = excerpt.match(/\n\n\[\.\.\. (\d+) characters omitted\]\n\n/)!;
		expect(Number(marker[1]) + excerpt.length - marker[0].length).toBe(longContent.length);
	});

	it("should not truncate short tool results", () => {
		const shortContent = "x".repeat(1500);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "ipython",
				content: [{ type: "text", text: shortContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toBe(`[Tool result (ipython)]: ${shortContent}`);
		expect(result).not.toContain("truncated");
	});

	it("pairs reordered results with local call indices and labels an unmatched error", () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "provider-call-one", name: "ipython", arguments: { code: "1" } },
					{ type: "toolCall", id: "provider-call-two", name: "ipython", arguments: { code: "2" } },
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 0,
			},
			...[
				{ id: "provider-call-two", text: "second failed", isError: true },
				{ id: "provider-call-one", text: "first passed", isError: false },
				{ id: "unmatched", text: "orphan error", isError: true },
			].map(
				({ id, text, isError }): Message => ({
					role: "toolResult",
					toolCallId: id,
					toolName: "ipython",
					content: [{ type: "text", text }],
					isError,
					timestamp: 0,
				}),
			),
		];
		const original = structuredClone(messages);
		expect(serializeConversation(messages)).toBe(
			'[Assistant tool calls]: #1 ipython(code="1"); #2 ipython(code="2")\n\n' +
				"[Tool result (ipython, error) #2]: second failed\n\n" +
				"[Tool result (ipython) #1]: first passed\n\n" +
				"[Tool result (ipython, error)]: orphan error",
		);
		expect(messages).toEqual(original);
	});

	it("leaves qualified tool continuations unchanged instead of treating them as public history", () => {
		const content = `Recorded tool continuation data. Intent acknowledgment records intent only.\n${JSON.stringify({
			entryId: "result-entry",
			role: "toolResult",
			content: [{ type: "text", text: "x".repeat(5000) }],
		})}`;
		expect(
			serializeConversation([
				{
					role: "custom",
					customType: PUBLIC_TOOL_CONTINUATION_RENDERER,
					content,
					display: false,
					timestamp: 0,
				},
			]),
		).toBe(`[User]: ${content}`);
	});

	it("should not truncate assistant or user messages", () => {
		const longText = "y".repeat(5000);
		const messages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: longText }],
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [{ type: "text", text: longText }],
				api: "anthropic",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).not.toContain("truncated");
		expect(result).toContain(longText);
	});
});
