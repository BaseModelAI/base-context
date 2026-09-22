import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel, streamSimple } from "../src/index.js";

afterEach(() => vi.unstubAllGlobals());

describe("GPT-6 Sol and Luna provider routing", () => {
	it.each([
		["openai", "gpt-6-sol"],
		["openai", "gpt-6-luna"],
		["openai-codex", "gpt-6-sol"],
		["openai-codex", "gpt-6-luna"],
	] as const)("serializes %s/%s through its native Responses adapter", async (provider, id) => {
		const model = getModel(provider, id);
		const requests: { url: string; body: Record<string, unknown> }[] = [];
		const item = { type: "message", id: "msg_test", role: "assistant", content: [] };
		const events = [
			{ type: "response.output_item.added", output_index: 0, item },
			{
				type: "response.content_part.added",
				output_index: 0,
				content_index: 0,
				part: { type: "output_text", text: "" },
			},
			{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Ready" },
			{
				type: "response.completed",
				response: {
					id: "resp_test",
					model: id,
					status: "completed",
					usage: {
						input_tokens: 10,
						output_tokens: 1,
						total_tokens: 11,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				requests.push({
					url: input instanceof Request ? input.url : String(input),
					body: JSON.parse(String(init?.body)) as Record<string, unknown>,
				});
				return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
					headers: { "content-type": "text/event-stream" },
				});
			}),
		);
		const token = `test.${Buffer.from(
			JSON.stringify({
				"https://api.openai.com/auth": { chatgpt_account_id: "test-account" },
			}),
		).toString("base64url")}.test`;
		const result = await streamSimple(
			model,
			{
				systemPrompt: "Use the Python tool when needed.",
				messages: [{ role: "user", content: "Say ready", timestamp: 0 }],
				tools: [{ name: "ipython", description: "Run Python", parameters: Type.Object({ code: Type.String() }) }],
			},
			{ apiKey: provider === "openai" ? "test-key" : token, reasoning: "max", transport: "sse" },
		).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "Ready" }));
		expect(result.model).toBe(id);
		expect(requests).toHaveLength(1);
		expect(requests[0].url).toBe(
			provider === "openai"
				? "https://api.openai.com/v1/responses"
				: "https://chatgpt.com/backend-api/codex/responses",
		);
		expect(requests[0].body).toMatchObject({
			model: id,
			reasoning: { effort: "max" },
			tools: [{ type: "function", name: "ipython" }],
		});
	});
});
