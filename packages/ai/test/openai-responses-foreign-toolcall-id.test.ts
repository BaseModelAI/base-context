import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { convertResponsesMessages } from "../src/providers/openai-responses-shared.js";
import type { AssistantMessage, Context, ToolResultMessage, Usage } from "../src/types.js";
import { shortHash } from "../src/utils/hash.js";
import type { ProviderRequestProjection } from "../src/utils/request-token-budget.js";

const COPILOT_RAW_TOOL_CALL_ID =
	"call_4VnzVawQXPB9MgYib7CiQFEY|I9b95oN1wD/cHXKTw3PpRkL6KkCtzTJhUxMouMWYwHeTo2j3htzfSk7YPx2vifiIM4g3A8XXyOj8q4Bt6SLUG7gqY1E3ELkrkVQNHglRfUmWj84lqxJY+Puieb3VKyX0FB+83TUzn91cDMF/4gzt990IzqVrc+nIb9RRscRD070Du16q1glydVjWR0SBJsE6TbY/esOjFpqplogQqrajm1eI++f3eLi73R6q7hVusY0QbeFySVxABCjhN0lXB04caBe1rzHjYzul6MAXj7uq+0r17VLq+yrtyYhN12wkmFqHeqTyEei6EFPbMy24Nc+IbJlkP0OCg02W+gOnyBFcbi2ctvJFSOhSjt1CqBdqCnnhwUqXjbWiT0wh3DmLScRgTHmGkaI+oAcQQjfic65nxj+TnEkReA==";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("OpenAI Responses foreign tool call ID normalization", () => {
	it("hashes foreign Copilot tool item IDs into a bounded Codex-safe fc_<hash> shape", () => {
		const model = getModel("openai-codex", "gpt-5.3-codex");
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: COPILOT_RAW_TOOL_CALL_ID,
					name: "edit",
					arguments: { path: "src/styles/app.css" },
				},
			],
			api: "openai-responses",
			provider: "github-copilot",
			model: "gpt-5.3-codex",
			usage,
			stopReason: "toolUse",
			timestamp: Date.now() - 2000,
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: COPILOT_RAW_TOOL_CALL_ID,
			toolName: "edit",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: Date.now() - 1000,
		};
		const context: Context = {
			systemPrompt: "You are concise.",
			messages: [{ role: "user", content: "Use the tool.", timestamp: Date.now() - 3000 }, assistant, toolResult],
		};

		const input = convertResponsesMessages(model, context, new Set(["openai", "openai-codex", "opencode"]));
		const functionCall = input.find((item) => item.type === "function_call");

		expect(functionCall).toBeDefined();
		expect(functionCall?.type).toBe("function_call");
		if (!functionCall || functionCall.type !== "function_call") {
			throw new Error("Expected function_call item");
		}

		const expectedItemId = `fc_${shortHash(COPILOT_RAW_TOOL_CALL_ID.split("|")[1]!)}`;
		expect(functionCall.id).toBe(expectedItemId);
		expect(functionCall.id?.length ?? 0).toBeLessThanOrEqual(64);
		expect(functionCall.id).toMatch(/^fc_[A-Za-z0-9]+$/);
	});
});

describe("OpenAI Responses text item IDs", () => {
	const model = getModel("openai-codex", "gpt-5.3-codex");
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "text", text: "First" },
			{ type: "text", text: "Second" },
		],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason: "stop",
		timestamp: 0,
	};

	it("keeps ordinary SDK input positional while giving each unsigned block a distinct ID", () => {
		let projection: ProviderRequestProjection | undefined;
		const input = convertResponsesMessages(model, { messages: [assistant] }, new Set([model.provider]), {
			onProjection(value) {
				projection = value;
			},
		});
		expect(input).toMatchObject([{ id: "msg_0_0" }, { id: "msg_0_1" }]);
		expect(projection).toMatchObject({ replayContract: "complete-context", generatedMessageIndices: [0] });
	});

	it("retains source-backed item IDs after removing an earlier optional message", () => {
		const earlier: AssistantMessage = { ...assistant, content: [{ type: "text", text: "Optional" }] };
		let projection: ProviderRequestProjection | undefined;
		const full = convertResponsesMessages(model, { messages: [earlier, assistant] }, new Set([model.provider]), {
			responsesMessageIds: [10, 20],
			onProjection(value) {
				projection = value;
			},
		});
		expect(projection).toMatchObject({
			replayContract: "message-groups",
			generatedMessageIndices: [],
			optionalMessageIndices: [0],
		});
		const selected = convertResponsesMessages(model, { messages: [assistant] }, new Set([model.provider]), {
			responsesMessageIds: [20],
			onProjection(value) {
				projection = value;
			},
		});
		expect(selected).toEqual(full.slice(1));
		expect(selected).toMatchObject([{ id: "msg_src_20_0" }, { id: "msg_src_20_1" }]);
		expect(projection).toMatchObject({ replayContract: "message-groups", generatedMessageIndices: [] });
	});

	it("keeps missing or misaligned source identities positional", () => {
		for (const responsesMessageIds of [[], [undefined]]) {
			let projection: ProviderRequestProjection | undefined;
			const input = convertResponsesMessages(model, { messages: [assistant] }, new Set([model.provider]), {
				responsesMessageIds,
				onProjection(value) {
					projection = value;
				},
			});
			expect(input).toMatchObject([{ id: "msg_0_0" }, { id: "msg_0_1" }]);
			expect(projection).toMatchObject({ replayContract: "complete-context", generatedMessageIndices: [0] });
		}
		let projection: ProviderRequestProjection | undefined;
		const transformed = convertResponsesMessages(
			model,
			{
				messages: [{ ...assistant, stopReason: "aborted" }, assistant],
			},
			new Set([model.provider]),
			{
				responsesMessageIds: [10, 20],
				onProjection(value) {
					projection = value;
				},
			},
		);
		expect(transformed).toMatchObject([{ id: "msg_0_0" }, { id: "msg_0_1" }]);
		expect(projection).toBeUndefined();
	});

	it("keeps provider-issued text IDs and phases instead of replacing them", () => {
		const input = convertResponsesMessages(
			model,
			{
				messages: [
					{
						...assistant,
						content: [
							{ type: "text", text: "First", textSignature: "msg_provider_first" },
							{
								type: "text",
								text: "Second",
								textSignature: JSON.stringify({ v: 1, id: "msg_provider_second", phase: "final_answer" }),
							},
						],
					},
				],
			},
			new Set([model.provider]),
			{ responsesMessageIds: [20] },
		);
		expect(input).toMatchObject([{ id: "msg_provider_first" }, { id: "msg_provider_second", phase: "final_answer" }]);
	});
});
