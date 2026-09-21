import type { Model } from "@ponythewhite/base-context-ai";
import { afterEach, expect, it, vi } from "vitest";
import { InferenceCoordinator } from "../src/core/inference-coordinator.js";
import type { BoundRequestSink, RequestPurpose } from "../src/core/request-events.js";

const model: Model<"openai-responses"> = {
	api: "openai-responses",
	provider: "openai",
	id: "fixture",
	name: "Fixture",
	baseUrl: "https://example.invalid/v1",
	input: ["text"],
	reasoning: false,
	contextWindow: 4096,
	maxTokens: 20,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
type CacheApi = "openai-responses" | "openai-codex-responses";
function cacheCase(api: CacheApi) {
	const { compat: _compat, ...shared } = model;
	const codex = api === "openai-codex-responses";
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } }),
	).toString("base64url");
	return {
		model: {
			...shared,
			api,
			provider: codex ? "openai-codex" : "openai",
			baseUrl: codex ? "https://chatgpt.com/backend-api" : shared.baseUrl,
		},
		options: { apiKey: codex ? `fixture.${payload}.fixture` : "fixture", maxRetries: 0, transport: "sse" as const },
	};
}
const context = { messages: [{ role: "user" as const, content: "Local fixture", timestamp: 1 }] };
function sink(sessionId: string): BoundRequestSink {
	return {
		source: Promise.resolve({ sessionId, leafId: "leaf", sourceSequence: 1, persistent: false }),
		retain() {},
		async release() {},
		async persist() {},
	};
}
function captureBodies() {
	const bodies: Record<string, unknown>[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: unknown, init?: RequestInit) => {
			bodies.push(JSON.parse(init!.body as string));
			const events = [
				{ type: "response.created", response: { id: "fixture-response", model: "fixture", status: "in_progress" } },
				{
					type: "response.output_item.added",
					item: { id: "msg", type: "message", role: "assistant", content: [] },
				},
				{ type: "response.content_part.added", part: { type: "output_text", text: "", annotations: [] } },
				{ type: "response.output_text.delta", delta: "OK" },
				{
					type: "response.output_item.done",
					item: { id: "msg", type: "message", content: [{ type: "output_text", text: "OK" }] },
				},
				{
					type: "response.completed",
					response: {
						id: "fixture-response",
						model: "fixture",
						status: "completed",
						usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
					},
				},
			];
			return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
				headers: { "content-type": "text/event-stream" },
			});
		}),
	);
	return bodies;
}

afterEach(() => vi.unstubAllGlobals());

it.each(["openai-responses", "openai-codex-responses"] as const)(
	"uses captured purpose-separated cache identities: %s",
	async (api) => {
		const fixture = cacheCase(api);
		const bodies = captureBodies();
		let current = sink("source-a");
		const requests = new InferenceCoordinator(() => current);
		const captured = requests.capture();
		try {
			current = sink("source-b");
			const purposes: RequestPurpose[] = ["main", "child", "summary", "refine", "native-control", "refine"];
			for (const purpose of purposes) {
				const result = await captured.complete(fixture.model, context, fixture.options, { purpose });
				expect(result.stopReason).toBe("stop");
			}
			await requests.complete(fixture.model, context, fixture.options, { purpose: "refine" });
			expect(bodies.map((body) => body.prompt_cache_key)).toEqual([
				"source-a",
				"source-a",
				"summary:source-a",
				"refine:source-a",
				"native-control:source-a",
				"refine:source-a",
				"refine:source-b",
			]);
		} finally {
			await captured.dispose();
			await requests.dispose();
		}
	},
);

it.each(["openai-responses", "openai-codex-responses"] as const)(
	"preserves explicit cache identity and opt-out: %s",
	async (api) => {
		const fixture = cacheCase(api);
		const bodies = captureBodies();
		const requests = new InferenceCoordinator(() => sink("source"));
		try {
			for (const cacheRetention of ["short", "none"] as const) {
				const result = await requests.complete(
					fixture.model,
					context,
					{
						...fixture.options,
						sessionId: "explicit-key",
						cacheRetention,
					},
					{ purpose: "summary" },
				);
				expect(result.stopReason).toBe("stop");
			}
			expect(bodies[0].prompt_cache_key).toBe("explicit-key");
			expect(bodies[1]).not.toHaveProperty("prompt_cache_key");
		} finally {
			await requests.dispose();
		}
	},
);
