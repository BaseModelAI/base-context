import type { ExtensionAPI } from "../../src/index.js";

/** Local SSE replies through the real instrumented adapter, never a custom transport bypass. */
export default function registerEng4685FauxRefineProvider(pi: ExtensionAPI): void {
	const replies = [
		"Hello from the faux provider.",
		JSON.stringify({ shouldRefine: true, rationale: "process fixture review" }),
		JSON.stringify({
			summary: "No edits needed",
			rationale: "process fixture empty proposal",
			edits: [],
			expectedOutcome: "No changes",
		}),
	];
	let nextReply = 0;
	globalThis.fetch = async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url !== "https://faux.invalid/v1/chat/completions") {
			throw new Error(`Unexpected fixture request: ${url}`);
		}
		const body = input instanceof Request ? await input.json() : JSON.parse(String(init?.body));
		if (body.model !== "faux" || body.stream !== true) throw new Error("Unexpected fixture request body");
		const content = replies[nextReply++];
		if (content === undefined) throw new Error("No more local process fixture replies queued");
		const chunk = {
			id: `chatcmpl-process-${nextReply}`,
			object: "chat.completion.chunk",
			created: 0,
			model: "faux",
			choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: "stop" }],
			usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
		};
		return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
			headers: { "content-type": "text/event-stream" },
		});
	};
	pi.registerProvider("faux", {
		api: "openai-completions",
		apiKey: "faux-key",
		baseUrl: "https://faux.invalid/v1",
		models: [
			{
				id: "faux",
				name: "Faux process fixture",
				reasoning: false,
				input: ["text"],
				contextWindow: 128000,
				maxTokens: 8192,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		],
	});
}
