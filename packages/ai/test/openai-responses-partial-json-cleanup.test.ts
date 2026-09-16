import type { Response, ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it, vi } from "vitest";
import { processResponsesStream } from "../src/providers/openai-responses-shared.js";
import type { AssistantMessage, AssistantMessageEvent, Model } from "../src/types.js";
import { AssistantMessageEventStream } from "../src/utils/event-stream.js";

function createOutput(model: Model<"openai-responses">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
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
	};
}

async function* createFunctionCallEvents(argumentsJson: string): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.output_item.added",
		item: {
			type: "function_call",
			id: "fc_test",
			call_id: "call_test",
			name: "edit",
			arguments: "",
		},
	} as ResponseStreamEvent;
	yield {
		type: "response.function_call_arguments.delta",
		delta: '{"path":"README.md"',
	} as ResponseStreamEvent;
	yield {
		type: "response.function_call_arguments.delta",
		delta: ',"content":"updated"}',
	} as ResponseStreamEvent;
	yield {
		type: "response.function_call_arguments.done",
		arguments: argumentsJson,
	} as ResponseStreamEvent;
	yield {
		type: "response.output_item.done",
		item: {
			type: "function_call",
			id: "fc_test",
			call_id: "call_test",
			name: "edit",
			arguments: argumentsJson,
		},
	} as ResponseStreamEvent;
}

describe("openai responses stream handling", () => {
	const model: Model<"openai-responses"> = {
		id: "gpt-5-mini",
		name: "GPT-5 Mini",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	};

	it("removes partialJson from persisted tool-call blocks at output_item.done", async () => {
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();
		const pushSpy = vi.spyOn(stream, "push");
		const argumentsJson = '{"path":"README.md","content":"updated"}';

		await processResponsesStream(createFunctionCallEvents(argumentsJson), output, stream, model);

		expect(output.content).toHaveLength(1);
		const persistedToolCall = output.content[0];
		expect(persistedToolCall?.type).toBe("toolCall");
		if (!persistedToolCall || persistedToolCall.type !== "toolCall") {
			throw new Error("Expected toolCall block");
		}
		expect(persistedToolCall.arguments).toEqual({ path: "README.md", content: "updated" });
		expect("partialJson" in persistedToolCall).toBe(false);

		const emittedEvents = pushSpy.mock.calls.map(([event]) => event as AssistantMessageEvent);
		const toolCallEnd = emittedEvents.find((event) => event.type === "toolcall_end");
		expect(toolCallEnd).toBeDefined();
		if (!toolCallEnd || toolCallEnd.type !== "toolcall_end") {
			throw new Error("Expected toolcall_end event");
		}
		expect(toolCallEnd.toolCall).toBe(persistedToolCall);
		expect("partialJson" in toolCallEnd.toolCall).toBe(false);
	});

	it("keeps interleaved tool calls separate and uses their final arguments", async () => {
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();
		const pushSpy = vi.spyOn(stream, "push");
		const first = {
			type: "function_call" as const,
			id: "fc_first",
			call_id: "call_first",
			name: "edit",
			arguments: "",
		};
		const second = {
			type: "function_call" as const,
			id: "fc_second",
			call_id: "call_second",
			name: "read",
			arguments: "",
		};
		async function* events(): AsyncIterable<ResponseStreamEvent> {
			yield { type: "response.output_item.added", output_index: 0, sequence_number: 0, item: first };
			yield { type: "response.output_item.added", output_index: 1, sequence_number: 1, item: second };
			yield {
				type: "response.function_call_arguments.delta",
				output_index: 1,
				sequence_number: 2,
				item_id: second.id,
				delta: '{"path":"second.txt"}',
			};
			yield {
				type: "response.function_call_arguments.delta",
				output_index: 0,
				sequence_number: 3,
				item_id: first.id,
				delta: '{"path":"draft.txt"}',
			};
			yield {
				type: "response.output_item.done",
				output_index: 1,
				sequence_number: 4,
				item: { ...second, arguments: '{"path":"second.txt"}' },
			};
			yield {
				type: "response.output_item.done",
				output_index: 0,
				sequence_number: 5,
				item: { ...first, arguments: '{"path":"final.txt"}' },
			};
		}

		await processResponsesStream(events(), output, stream, model);

		expect(output.content).toEqual([
			{ type: "toolCall", id: "call_first|fc_first", name: "edit", arguments: { path: "final.txt" } },
			{ type: "toolCall", id: "call_second|fc_second", name: "read", arguments: { path: "second.txt" } },
		]);
		expect(
			pushSpy.mock.calls.flatMap(([event]) =>
				event.type === "toolcall_end" ? [[event.contentIndex, event.toolCall.id]] : [],
			),
		).toEqual([
			[1, "call_second|fc_second"],
			[0, "call_first|fc_first"],
		]);
	});

	it("records final usage and length stop for an incomplete response", async () => {
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();
		const response: Response = {
			id: "resp_incomplete",
			created_at: 0,
			output_text: "",
			object: "response",
			model: model.id,
			status: "incomplete",
			error: null,
			incomplete_details: { reason: "max_output_tokens" },
			instructions: null,
			metadata: null,
			output: [],
			parallel_tool_calls: true,
			temperature: null,
			tool_choice: "auto",
			tools: [],
			top_p: null,
			usage: {
				input_tokens: 20,
				input_tokens_details: { cached_tokens: 5, cache_write_tokens: 0 },
				output_tokens: 7,
				output_tokens_details: { reasoning_tokens: 2 },
				total_tokens: 27,
			},
		};
		async function* events(): AsyncIterable<ResponseStreamEvent> {
			yield { type: "response.incomplete", sequence_number: 0, response };
		}

		await processResponsesStream(events(), output, stream, model);

		expect(output.responseId).toBe("resp_incomplete");
		expect(output.stopReason).toBe("length");
		expect(output.usage).toMatchObject({ input: 15, cacheRead: 5, output: 7, totalTokens: 27 });
	});
});
