import type { AssistantMessage, Model } from "@ponythewhite/base-context-ai";
import { afterEach, expect, it, vi } from "vitest";
import { type ProxyAssistantMessageEvent, streamProxy } from "../src/proxy.js";

const model: Model<"openai-responses"> = {
	id: "fixture",
	name: "fixture",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
};
const usage: AssistantMessage["usage"] = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

afterEach(() => vi.unstubAllGlobals());

it.each(["complete", "interrupted"] as const)("settles the %s proxy response", async (state) => {
	const events: ProxyAssistantMessageEvent[] = [
		{ type: "start" },
		{ type: "text_start", contentIndex: 0 },
		{ type: "text_delta", contentIndex: 0, delta: "partial response" },
	];
	if (state === "complete") events.push({ type: "done", reason: "stop", usage });
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""))),
	);
	const stream = streamProxy(model, { messages: [] }, { proxyUrl: "https://example.invalid", authToken: "fixture" });
	const received = [];
	for await (const event of stream) received.push(event);
	expect(received.at(-1)?.type).toBe(state === "complete" ? "done" : "error");
	const result = await stream.result();
	expect(result.content).toEqual([{ type: "text", text: "partial response" }]);
	if (state === "complete") {
		expect(result.stopReason).toBe("stop");
		expect(result.usage).toEqual(usage);
	} else {
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Proxy stream ended without a terminal event");
	}
});
