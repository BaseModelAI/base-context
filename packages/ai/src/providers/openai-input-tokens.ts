import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";
import type { Api, Provider } from "../types.js";

const record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

/** Only typed text/call/result replay is estimable locally. Media, encrypted state and references are unknown. */
function textContent(value: unknown): boolean {
	return (
		value === null ||
		typeof value === "string" ||
		(Array.isArray(value) &&
			value.every(
				(part) =>
					record(part) &&
					["text", "input_text", "output_text", "refusal", "summary_text"].includes(String(part.type)) &&
					(typeof part.text === "string" || typeof part.refusal === "string"),
			))
	);
}

export function textInput(api: Api, input: unknown): boolean {
	if (typeof input === "string") return api !== "openai-completions";
	if (!Array.isArray(input)) return false;
	return input.every((item) => {
		if (!record(item)) return false;
		if (api === "openai-completions") {
			return (
				["system", "developer", "user", "assistant", "tool"].includes(String(item.role)) &&
				!item.audio &&
				!item.reasoning_details &&
				textContent(item.content ?? null)
			);
		}
		if (item.type === "function_call") return typeof item.arguments === "string";
		if (item.type === "function_call_output") return textContent(item.output);
		if (item.type === "reasoning") return false;
		return (
			(item.type === undefined || item.type === "message") &&
			["system", "developer", "user", "assistant"].includes(String(item.role)) &&
			textContent(item.content)
		);
	});
}

// These are the model-visible fields, not transport/cache/sampling/output-limit metadata.
const responseVisibleFields = [
	"instructions",
	"input",
	"tools",
	"text",
	"tool_choice",
	"parallel_tool_calls",
	"personality",
	"reasoning",
];
const completionVisibleFields = ["messages", "tools", "response_format", "tool_choice", "parallel_tool_calls"];
const responseFields = new Set([
	...responseVisibleFields,
	"model",
	"stream",
	"stream_options",
	"store",
	"include",
	"max_output_tokens",
	"temperature",
	"top_p",
	"service_tier",
	"prompt_cache_key",
	"prompt_cache_retention",
	"metadata",
	"user",
	"safety_identifier",
	"truncation",
	"previous_response_id",
	"conversation",
]);
const completionFields = new Set([
	...completionVisibleFields,
	"model",
	"stream",
	"stream_options",
	"store",
	"max_tokens",
	"max_completion_tokens",
	"temperature",
	"top_p",
	"service_tier",
	"prompt_cache_key",
	"prompt_cache_retention",
	"metadata",
	"user",
	"safety_identifier",
	"n",
	"stop",
	"seed",
	"frequency_penalty",
	"presence_penalty",
	"logit_bias",
	"logprobs",
	"top_logprobs",
	"reasoning_effort",
	"modalities",
]);

/** Unsupported endpoint forms retain the caller's old byte/unknown policy. */
export function openAIVisibleInput(
	api: Api,
	provider: Provider,
	body: Record<string, unknown>,
): Record<string, unknown> | undefined {
	if (
		(provider !== "openai" && provider !== "openai-codex") ||
		!["openai-responses", "openai-codex-responses", "openai-completions"].includes(api)
	)
		return;
	const completions = api === "openai-completions";
	const allowed = completions ? completionFields : responseFields;
	if (
		Object.keys(body).some((key) => !allowed.has(key)) ||
		!textInput(api, body[completions ? "messages" : "input"]) ||
		(body.instructions != null && typeof body.instructions !== "string")
	)
		return;
	if (
		body.tools != null &&
		(!Array.isArray(body.tools) ||
			!body.tools.every(
				(tool) =>
					record(tool) &&
					tool.type === "function" &&
					(completions
						? record(tool.function) && typeof tool.function.name === "string"
						: typeof tool.name === "string"),
			))
	)
		return;
	const visibleFields = completions ? completionVisibleFields : responseVisibleFields;
	return Object.fromEntries(visibleFields.filter((key) => body[key] !== undefined).map((key) => [key, body[key]]));
}

let tokenizer: Tiktoken | undefined;
/** BPE estimate of supported visible text/JSON. The profile supplies chat-template overhead and margin. */
export function estimateOpenAIInput(visible: Record<string, unknown>): number {
	tokenizer ??= new Tiktoken(o200kBase);
	// Literal special-token spellings in user/tool text are ordinary text, never control tokens.
	return tokenizer.encode(JSON.stringify(visible), [], []).length;
}
