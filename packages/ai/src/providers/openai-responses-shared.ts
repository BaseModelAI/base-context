import type OpenAI from "openai";
import type {
	Tool as OpenAITool,
	ResponseCreateParamsStreaming,
	ResponseFunctionCallOutputItemList,
	ResponseFunctionToolCall,
	ResponseInput,
	ResponseInputContent,
	ResponseInputImage,
	ResponseInputText,
	ResponseOutputMessage,
	ResponseReasoningItem,
	ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import { calculateCost } from "../models.js";
import type {
	Api,
	AssistantMessage,
	Context,
	ImageContent,
	Model,
	StopReason,
	TextContent,
	TextSignatureV1,
	ThinkingContent,
	Tool,
	ToolCall,
	Usage,
} from "../types.js";
import type { AssistantMessageEventStream } from "../utils/event-stream.js";
import { shortHash } from "../utils/hash.js";
import { parseStreamingJson } from "../utils/json-parse.js";
import type { ProviderAttemptTracker } from "../utils/provider-attempts.js";
import {
	type ProviderRequestProjection,
	type ProviderRequestRepresentation,
	withRequestBody,
} from "../utils/request-token-budget.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { classifyStreamFailure, StreamFailureError } from "../utils/stream-failure.js";
import { transformMessages } from "./transform-messages.js";

function encodeTextSignatureV1(id: string, phase?: TextSignatureV1["phase"]): string {
	const payload: TextSignatureV1 = { v: 1, id };
	if (phase) payload.phase = phase;
	return JSON.stringify(payload);
}

function parseTextSignature(
	signature: string | undefined,
): { id: string; phase?: TextSignatureV1["phase"] } | undefined {
	if (!signature) return undefined;
	if (signature.startsWith("{")) {
		try {
			const parsed = JSON.parse(signature) as Partial<TextSignatureV1>;
			if (parsed.v === 1 && typeof parsed.id === "string") {
				if (parsed.phase === "commentary" || parsed.phase === "final_answer") {
					return { id: parsed.id, phase: parsed.phase };
				}
				return { id: parsed.id };
			}
		} catch {
			// Fall through to legacy plain-string handling.
		}
	}
	return { id: signature };
}

/** Use the existing text-signature contract only when the full rendered item keeps its legal identity. */
export function matchesResponsesTextSignature(signature: string | undefined, item: unknown): boolean {
	if (
		!item ||
		typeof item !== "object" ||
		!("type" in item) ||
		item.type !== "message" ||
		!("role" in item) ||
		item.role !== "assistant" ||
		!("status" in item) ||
		item.status !== "completed" ||
		!("id" in item) ||
		typeof item.id !== "string" ||
		!item.id ||
		item.id.length > 64
	)
		return false;
	const phase = "phase" in item ? item.phase : undefined;
	if (signature === undefined) return phase === undefined;
	if (signature.startsWith("{")) {
		let encoded: unknown;
		try {
			encoded = JSON.parse(signature);
		} catch {
			return false;
		}
		if (
			!encoded ||
			typeof encoded !== "object" ||
			Array.isArray(encoded) ||
			!("v" in encoded) ||
			encoded.v !== 1 ||
			!("id" in encoded) ||
			typeof encoded.id !== "string" ||
			Object.keys(encoded).some((key) => key !== "v" && key !== "id" && key !== "phase") ||
			("phase" in encoded && encoded.phase !== "commentary" && encoded.phase !== "final_answer")
		)
			return false;
	}
	const parsed = parseTextSignature(signature);
	return parsed !== undefined && parsed.id === item.id && parsed.phase === phase;
}

export interface OpenAIResponsesStreamOptions {
	attempts?: ProviderAttemptTracker;
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	resolveServiceTier?: (
		responseServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
		requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	) => ResponseCreateParamsStreaming["service_tier"] | undefined;
	applyServiceTierPricing?: (
		usage: Usage,
		serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	) => void;
}

export interface ConvertResponsesMessagesOptions {
	includeSystemPrompt?: boolean;
	/** Internal native projection capture during this conversion, never a second conversion. */
	onProjection?: (projection: ProviderRequestProjection) => void;
	pendingPublicMessageGroups?: readonly (readonly number[])[];
}

export interface ConvertResponsesToolsOptions {
	strict?: boolean | null;
}

function captureResponsesProjection<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	transformed: Context["messages"],
	input: ResponseInput,
	messageIndices: readonly (number | null)[],
	pendingPublicMessageGroups: readonly (readonly number[])[],
): ProviderRequestProjection | undefined {
	if (
		!(
			(model.provider === "openai" && model.api === "openai-responses") ||
			(model.provider === "openai-codex" && model.api === "openai-codex-responses")
		)
	)
		return;
	// No speculative conversion: these are the messages and items from the one normal converter pass.
	if (
		transformed.length !== context.messages.length ||
		transformed.some((message, index) => JSON.stringify(message) !== JSON.stringify(context.messages[index]))
	)
		return;
	const items = context.messages.map((): ResponseInput => []);
	for (const [index, sourceIndex] of messageIndices.entries()) {
		if (sourceIndex !== null) items[sourceIndex].push(input[index]);
	}
	const required = pendingPublicMessageGroups.map((indices) => ({
		indices,
		calls: new Map<string, { wireId: string; seen: boolean }>(),
	}));
	const requiredAt = new Map<number, (typeof required)[number]>();
	for (const group of required) {
		if (!group.indices.length || context.messages[group.indices[0]]?.role !== "assistant") return;
		let previous = -1;
		for (const index of group.indices) {
			if (
				!Number.isSafeInteger(index) ||
				index <= previous ||
				index >= context.messages.length ||
				requiredAt.has(index)
			)
				return;
			requiredAt.set(index, group);
			previous = index;
		}
	}
	let replayContract: "complete-context" | "message-groups" = "message-groups";
	const optionalMessageIndices: number[] = [];
	const generatedMessageIndices: number[] = [];
	const pending = new Map<string, { wireId: string; seen: boolean }>();
	const publicMessageGroups: number[][] = [];
	let publicGroup: number[] | undefined;
	const closeCalls = () => {
		const complete = [...pending.values()].every((call) => call.seen);
		if (complete && publicGroup) publicMessageGroups.push(publicGroup);
		publicGroup = undefined;
		pending.clear();
		return complete;
	};
	for (const [index, message] of context.messages.entries()) {
		const rendered = items[index];
		if (!rendered.length) return;
		const requiredGroup = requiredAt.get(index);
		const calls = requiredGroup?.calls ?? pending;
		if (
			requiredGroup &&
			(index === requiredGroup.indices[0] ? message.role !== "assistant" : message.role !== "toolResult")
		)
			return;
		if (message.role === "assistant" || message.role === "user") {
			if (!closeCalls()) return;
		}
		if (message.role === "assistant") {
			publicGroup =
				!requiredGroup && (message.stopReason === "stop" || message.stopReason === "toolUse") ? [index] : undefined;
			if (requiredGroup && message.stopReason !== "toolUse" && message.stopReason !== "stop") return;
			if (
				message.api !== model.api ||
				message.provider !== model.provider ||
				message.model !== model.id ||
				rendered.length !== message.content.length
			)
				return;
			for (const [blockIndex, block] of message.content.entries()) {
				const item = rendered[blockIndex];
				if (block.type === "text") {
					if (!matchesResponsesTextSignature(block.textSignature, item)) return;
					if (block.textSignature === undefined && !generatedMessageIndices.includes(index))
						generatedMessageIndices.push(index);
				} else if (block.type === "thinking") {
					if (!block.thinkingSignature || item.type !== "reasoning") return;
					// Existing whole-message groups suffice only when the reasoning's following item stays in this unit.
					if (
						!message.content
							.slice(blockIndex + 1)
							.some((next) => next.type === "text" || next.type === "toolCall")
					)
						replayContract = "complete-context";
				} else if (block.type === "toolCall") {
					const [callId, itemId] = block.id.split("|");
					if (
						item.type !== "function_call" ||
						item.call_id !== callId ||
						item.id !== itemId ||
						calls.has(block.id) ||
						[...calls.values()].some((call) => call.wireId === callId)
					)
						return;
					calls.set(block.id, { wireId: callId, seen: false });
					if (block.thoughtSignature !== undefined) replayContract = "complete-context";
				}
			}
			if (message.stopReason === "stop" && message.content.length === 1 && message.content[0].type === "text")
				optionalMessageIndices.push(index);
		} else if (message.role === "toolResult") {
			const call = calls.get(message.toolCallId);
			const item = rendered[0];
			if (!call || rendered.length !== 1 || item.type !== "function_call_output" || item.call_id !== call.wireId)
				return;
			if (call.seen || message.content.some((part) => part.type !== "text")) {
				if (requiredGroup) return;
				publicGroup = undefined;
			}
			if (!requiredGroup) publicGroup?.push(index);
			call.seen = true;
		} else if (rendered.length !== 1) return;
	}
	if (!closeCalls()) return;
	for (const group of required) {
		if (!group.calls.size) return;
		publicMessageGroups.push([...group.indices]);
	}
	// These IDs depend on the whole preceding layout, not just tool-message dependencies.
	if (generatedMessageIndices.length) replayContract = "complete-context";
	return {
		kind: "openai-responses-replay-v1",
		replayContract,
		messageIndices,
		optionalMessageIndices,
		generatedMessageIndices,
		publicMessageGroups,
		...(required.length ? { pendingPublicMessageGroups: required.map((group) => [...group.indices]) } : {}),
	};
}

/** Called only at the actual official-route native public-window gate. */
export function bindResponsesPublicWindow(
	request: ProviderRequestRepresentation,
	projection: ProviderRequestProjection,
	onPendingPublicEncoded?: (body: string) => void,
): ProviderRequestProjection {
	return {
		...projection,
		publicWindow: true,
		encodePublicWindow(replacements) {
			if (
				!request.body ||
				!replacements.length ||
				replacements.length > projection.messageIndices.length ||
				!projection.publicMessageGroups
			)
				return;
			const texts = new Map<number, string>();
			for (const replacement of replacements) {
				if (
					!Number.isSafeInteger(replacement.messageIndex) ||
					typeof replacement.text !== "string" ||
					texts.has(replacement.messageIndex)
				)
					return;
				texts.set(replacement.messageIndex, replacement.text);
			}
			const covered = new Set<number>();
			for (const group of projection.publicMessageGroups) {
				if (!group.some((index) => texts.has(index))) continue;
				if (!group.every((index) => texts.has(index))) return;
				for (const index of group) covered.add(index);
			}
			if (
				covered.size !== texts.size ||
				projection.pendingPublicMessageGroups?.some((group) => group.some((index) => !texts.has(index)))
			)
				return;
			const body = JSON.parse(request.body) as { input: ResponseInput };
			if (body.input.length !== projection.messageIndices.length) return;
			const input: ResponseInput = [];
			const messageIndices: Array<number | null> = [];
			const emitted = new Set<number>();
			for (const [itemIndex, messageIndex] of projection.messageIndices.entries()) {
				if (messageIndex !== null && texts.has(messageIndex)) {
					if (emitted.has(messageIndex)) continue;
					emitted.add(messageIndex);
					input.push({
						role: "user",
						content: [{ type: "input_text", text: sanitizeSurrogates(texts.get(messageIndex)!) }],
					});
				} else input.push(body.input[itemIndex]);
				messageIndices.push(messageIndex);
			}
			const encoded = withRequestBody(request, JSON.stringify({ ...body, input }));
			if (projection.pendingPublicMessageGroups?.length) onPendingPublicEncoded?.(encoded.body!);
			return {
				request: encoded,
				projection: {
					kind: projection.kind,
					replayContract: projection.replayContract,
					publicWindow: true,
					messageIndices,
					optionalMessageIndices: projection.optionalMessageIndices,
					generatedMessageIndices: projection.generatedMessageIndices,
				},
			};
		},
	};
}

export function convertResponsesMessages<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	allowedToolCallProviders: ReadonlySet<string>,
	options?: ConvertResponsesMessagesOptions,
): ResponseInput {
	const messages: ResponseInput = [];

	const normalizeIdPart = (part: string): string => {
		const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
		const normalized = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
		return normalized.replace(/_+$/, "");
	};

	const buildForeignResponsesItemId = (itemId: string): string => {
		const normalized = `fc_${shortHash(itemId)}`;
		return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
	};

	const normalizeToolCallId = (id: string, _targetModel: Model<TApi>, source: AssistantMessage): string => {
		if (!allowedToolCallProviders.has(model.provider)) return normalizeIdPart(id);
		if (!id.includes("|")) return normalizeIdPart(id);
		const [callId, itemId] = id.split("|");
		const normalizedCallId = normalizeIdPart(callId);
		const isForeignToolCall = source.provider !== model.provider || source.api !== model.api;
		let normalizedItemId = isForeignToolCall ? buildForeignResponsesItemId(itemId) : normalizeIdPart(itemId);
		// OpenAI Responses API requires item id to start with "fc"
		if (!normalizedItemId.startsWith("fc_")) {
			normalizedItemId = normalizeIdPart(`fc_${normalizedItemId}`);
		}
		return `${normalizedCallId}|${normalizedItemId}`;
	};

	const pendingPublicMessageGroups = options?.onProjection ? (options.pendingPublicMessageGroups ?? []) : [];
	const transformedMessages = transformMessages(
		context.messages,
		model,
		normalizeToolCallId,
		pendingPublicMessageGroups,
	);

	const includeSystemPrompt = options?.includeSystemPrompt ?? true;
	if (includeSystemPrompt && context.systemPrompt) {
		const role = model.reasoning ? "developer" : "system";
		messages.push({
			role,
			content: sanitizeSurrogates(context.systemPrompt),
		});
	}

	const messageIndices: Array<number | null> | undefined = options?.onProjection
		? messages.map(() => null)
		: undefined;
	let msgIndex = 0;
	for (const [sourceIndex, msg] of transformedMessages.entries()) {
		const firstItem = messages.length;
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				messages.push({
					role: "user",
					content: [{ type: "input_text", text: sanitizeSurrogates(msg.content) }],
				});
			} else {
				const content: ResponseInputContent[] = msg.content.map((item): ResponseInputContent => {
					if (item.type === "text") {
						return {
							type: "input_text",
							text: sanitizeSurrogates(item.text),
						} satisfies ResponseInputText;
					}
					return {
						type: "input_image",
						detail: "auto",
						image_url: `data:${item.mimeType};base64,${item.data}`,
					} satisfies ResponseInputImage;
				});
				if (content.length === 0) continue;
				messages.push({
					role: "user",
					content,
				});
			}
		} else if (msg.role === "assistant") {
			const output: ResponseInput = [];
			const assistantMsg = msg as AssistantMessage;
			const isDifferentModel =
				assistantMsg.model !== model.id &&
				assistantMsg.provider === model.provider &&
				assistantMsg.api === model.api;

			for (const block of msg.content) {
				if (block.type === "thinking") {
					if (block.thinkingSignature) {
						const reasoningItem = JSON.parse(block.thinkingSignature) as ResponseReasoningItem;
						output.push(reasoningItem);
					}
				} else if (block.type === "text") {
					const textBlock = block as TextContent;
					const parsedSignature = parseTextSignature(textBlock.textSignature);
					// OpenAI requires id to be max 64 characters
					let msgId = parsedSignature?.id;
					if (!msgId) {
						msgId = `msg_${msgIndex}`;
					} else if (msgId.length > 64) {
						msgId = `msg_${shortHash(msgId)}`;
					}
					output.push({
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: sanitizeSurrogates(textBlock.text), annotations: [] }],
						status: "completed",
						id: msgId,
						phase: parsedSignature?.phase,
					} satisfies ResponseOutputMessage);
				} else if (block.type === "toolCall") {
					const toolCall = block as ToolCall;
					const [callId, itemIdRaw] = toolCall.id.split("|");
					let itemId: string | undefined = itemIdRaw;

					// For different-model messages, set id to undefined to avoid pairing validation.
					// OpenAI tracks which fc_xxx IDs were paired with rs_xxx reasoning items.
					// By omitting the id, we avoid triggering that validation (like cross-provider does).
					if (isDifferentModel && itemId?.startsWith("fc_")) {
						itemId = undefined;
					}

					output.push({
						type: "function_call",
						id: itemId,
						call_id: callId,
						name: toolCall.name,
						arguments: JSON.stringify(toolCall.arguments),
					});
				}
			}
			if (output.length === 0) continue;
			messages.push(...output);
		} else if (msg.role === "toolResult") {
			const textResult = msg.content
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			const hasImages = msg.content.some((c): c is ImageContent => c.type === "image");
			const hasText = textResult.length > 0;
			const [callId] = msg.toolCallId.split("|");

			let output: string | ResponseFunctionCallOutputItemList;
			if (hasImages && model.input.includes("image")) {
				const contentParts: ResponseFunctionCallOutputItemList = [];

				if (hasText) {
					contentParts.push({
						type: "input_text",
						text: sanitizeSurrogates(textResult),
					});
				}

				for (const block of msg.content) {
					if (block.type === "image") {
						contentParts.push({
							type: "input_image",
							detail: "auto",
							image_url: `data:${block.mimeType};base64,${block.data}`,
						});
					}
				}

				output = contentParts;
			} else {
				output = sanitizeSurrogates(hasText ? textResult : hasImages ? "(see attached image)" : "");
			}

			messages.push({
				type: "function_call_output",
				call_id: callId,
				output,
			});
		}
		if (messageIndices) {
			for (let index = firstItem; index < messages.length; index++) messageIndices.push(sourceIndex);
		}
		msgIndex++;
	}
	if (messageIndices) {
		const projection = captureResponsesProjection(
			model,
			context,
			transformedMessages,
			messages,
			messageIndices,
			pendingPublicMessageGroups,
		);
		if (projection) options!.onProjection!(projection);
	}
	return messages;
}

export function convertResponsesTools(tools: Tool[], options?: ConvertResponsesToolsOptions): OpenAITool[] {
	const strict = options?.strict === undefined ? false : options.strict;
	return tools.map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters as any, // TypeBox already generates JSON Schema
		strict,
	}));
}

/** Observe one decoded provider event, including failures transformed by transport-specific adapters. */
export function observeResponsesEvent(event: ResponseStreamEvent, attempts?: ProviderAttemptTracker): void {
	attempts?.event(
		("delta" in event && typeof event.delta === "string" && event.delta.length > 0) ||
			(event.type === "response.output_item.added" && event.item.type === "function_call"),
	);
	if ("response" in event) {
		const response = event.response;
		if (response.error) attempts?.providerError(response.error);
		attempts?.response({
			providerResponseId: response.id,
			responseModel: response.model,
			effectiveEffort: response.reasoning?.effort ?? undefined,
			effectiveServiceTier: response.service_tier,
		});
		const terminal =
			event.type === "response.completed" ||
			event.type === "response.failed" ||
			event.type === "response.incomplete";
		if (response.usage) {
			const usage = response.usage;
			const cached = usage.input_tokens_details?.cached_tokens;
			attempts?.usage(
				response.usage,
				{
					input:
						cached !== undefined && usage.input_tokens !== undefined ? usage.input_tokens - cached : undefined,
					inputTotal: usage.input_tokens,
					output: usage.output_tokens,
					cacheRead: cached,
					totalTokens: usage.total_tokens,
				},
				terminal ? "complete" : "partial",
			);
		}
		if (terminal) {
			attempts?.terminal(
				response.status === "failed" ? "failed" : response.status === "cancelled" ? "cancelled" : "completed",
			);
		}
	} else if (event.type === "error") {
		attempts?.providerError(event);
		attempts?.terminal("failed");
	}
}

export async function processResponsesStream<TApi extends Api>(
	openaiStream: AsyncIterable<ResponseStreamEvent>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<TApi>,
	options?: OpenAIResponsesStreamOptions,
): Promise<void> {
	let currentItem: ResponseReasoningItem | ResponseOutputMessage | ResponseFunctionToolCall | null = null;
	let currentBlock: ThinkingContent | TextContent | (ToolCall & { partialJson: string }) | null = null;
	const blocks = output.content;
	const blockIndex = () => blocks.length - 1;

	for await (const event of openaiStream) {
		observeResponsesEvent(event, options?.attempts);
		if (event.type === "response.created") {
			output.responseId = event.response.id;
		} else if (event.type === "response.output_item.added") {
			const item = event.item;
			if (item.type === "reasoning") {
				currentItem = item;
				currentBlock = { type: "thinking", thinking: "" };
				output.content.push(currentBlock);
				stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
			} else if (item.type === "message") {
				currentItem = item;
				currentBlock = { type: "text", text: "" };
				output.content.push(currentBlock);
				stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
			} else if (item.type === "function_call") {
				currentItem = item;
				currentBlock = {
					type: "toolCall",
					id: `${item.call_id}|${item.id}`,
					name: item.name,
					arguments: {},
					partialJson: item.arguments || "",
				};
				output.content.push(currentBlock);
				stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
			}
		} else if (event.type === "response.reasoning_summary_part.added") {
			if (currentItem && currentItem.type === "reasoning") {
				currentItem.summary = currentItem.summary || [];
				currentItem.summary.push(event.part);
			}
		} else if (event.type === "response.reasoning_summary_text.delta") {
			if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
				currentItem.summary = currentItem.summary || [];
				const lastPart = currentItem.summary[currentItem.summary.length - 1];
				if (lastPart) {
					currentBlock.thinking += event.delta;
					lastPart.text += event.delta;
					stream.push({
						type: "thinking_delta",
						contentIndex: blockIndex(),
						delta: event.delta,
						partial: output,
					});
				}
			}
		} else if (event.type === "response.reasoning_summary_part.done") {
			if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
				currentItem.summary = currentItem.summary || [];
				const lastPart = currentItem.summary[currentItem.summary.length - 1];
				if (lastPart) {
					currentBlock.thinking += "\n\n";
					lastPart.text += "\n\n";
					stream.push({
						type: "thinking_delta",
						contentIndex: blockIndex(),
						delta: "\n\n",
						partial: output,
					});
				}
			}
		} else if (event.type === "response.reasoning_text.delta") {
			if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
				currentBlock.thinking += event.delta;
				stream.push({
					type: "thinking_delta",
					contentIndex: blockIndex(),
					delta: event.delta,
					partial: output,
				});
			}
		} else if (event.type === "response.content_part.added") {
			if (currentItem?.type === "message") {
				currentItem.content = currentItem.content || [];
				if (event.part.type === "output_text" || event.part.type === "refusal") {
					currentItem.content.push(event.part);
				}
			}
		} else if (event.type === "response.output_text.delta") {
			if (currentItem?.type === "message" && currentBlock?.type === "text") {
				if (!currentItem.content || currentItem.content.length === 0) {
					continue;
				}
				const lastPart = currentItem.content[currentItem.content.length - 1];
				if (lastPart?.type === "output_text") {
					currentBlock.text += event.delta;
					lastPart.text += event.delta;
					stream.push({
						type: "text_delta",
						contentIndex: blockIndex(),
						delta: event.delta,
						partial: output,
					});
				}
			}
		} else if (event.type === "response.refusal.delta") {
			if (currentItem?.type === "message" && currentBlock?.type === "text") {
				if (!currentItem.content || currentItem.content.length === 0) {
					continue;
				}
				const lastPart = currentItem.content[currentItem.content.length - 1];
				if (lastPart?.type === "refusal") {
					currentBlock.text += event.delta;
					lastPart.refusal += event.delta;
					stream.push({
						type: "text_delta",
						contentIndex: blockIndex(),
						delta: event.delta,
						partial: output,
					});
				}
			}
		} else if (event.type === "response.function_call_arguments.delta") {
			if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
				currentBlock.partialJson += event.delta;
				currentBlock.arguments = parseStreamingJson(currentBlock.partialJson);
				stream.push({
					type: "toolcall_delta",
					contentIndex: blockIndex(),
					delta: event.delta,
					partial: output,
				});
			}
		} else if (event.type === "response.function_call_arguments.done") {
			if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
				const previousPartialJson = currentBlock.partialJson;
				currentBlock.partialJson = event.arguments;
				currentBlock.arguments = parseStreamingJson(currentBlock.partialJson);

				if (event.arguments.startsWith(previousPartialJson)) {
					const delta = event.arguments.slice(previousPartialJson.length);
					if (delta.length > 0) {
						stream.push({
							type: "toolcall_delta",
							contentIndex: blockIndex(),
							delta,
							partial: output,
						});
					}
				}
			}
		} else if (event.type === "response.output_item.done") {
			const item = event.item;

			if (item.type === "reasoning" && currentBlock?.type === "thinking") {
				const summaryText = item.summary?.map((s) => s.text).join("\n\n") || "";
				const contentText = item.content?.map((c) => c.text).join("\n\n") || "";
				currentBlock.thinking = summaryText || contentText || currentBlock.thinking;
				currentBlock.thinkingSignature = JSON.stringify(item);
				stream.push({
					type: "thinking_end",
					contentIndex: blockIndex(),
					content: currentBlock.thinking,
					partial: output,
				});
				currentBlock = null;
			} else if (item.type === "message" && currentBlock?.type === "text") {
				currentBlock.text = item.content.map((c) => (c.type === "output_text" ? c.text : c.refusal)).join("");
				currentBlock.textSignature = encodeTextSignatureV1(item.id, item.phase ?? undefined);
				stream.push({
					type: "text_end",
					contentIndex: blockIndex(),
					content: currentBlock.text,
					partial: output,
				});
				currentBlock = null;
			} else if (item.type === "function_call") {
				const args =
					currentBlock?.type === "toolCall" && currentBlock.partialJson
						? parseStreamingJson(currentBlock.partialJson)
						: parseStreamingJson(item.arguments || "{}");

				let toolCall: ToolCall;
				if (currentBlock?.type === "toolCall") {
					// Finalize in-place and strip the scratch buffer so replay only
					// carries parsed arguments.
					currentBlock.arguments = args;
					delete (currentBlock as { partialJson?: string }).partialJson;
					toolCall = currentBlock;
				} else {
					toolCall = {
						type: "toolCall",
						id: `${item.call_id}|${item.id}`,
						name: item.name,
						arguments: args,
					};
				}

				currentBlock = null;
				stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
			}
		} else if (event.type === "response.completed") {
			const response = event.response;
			if (response?.id) {
				output.responseId = response.id;
			}
			if (response?.usage) {
				const cachedTokens = response.usage.input_tokens_details?.cached_tokens || 0;
				output.usage = {
					// OpenAI includes cached tokens in input_tokens, so subtract to get non-cached input
					input: (response.usage.input_tokens || 0) - cachedTokens,
					output: response.usage.output_tokens || 0,
					cacheRead: cachedTokens,
					cacheWrite: 0,
					totalTokens: response.usage.total_tokens || 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				};
			}
			calculateCost(model, output.usage);
			if (options?.applyServiceTierPricing) {
				const serviceTier = options.resolveServiceTier
					? options.resolveServiceTier(response?.service_tier, options.serviceTier)
					: (response?.service_tier ?? options.serviceTier);
				options.applyServiceTierPricing(output.usage, serviceTier);
			}
			output.stopReason = mapStopReason(response?.status);
			if (output.content.some((b) => b.type === "toolCall") && output.stopReason === "stop") {
				output.stopReason = "toolUse";
			}
			if (output.stopReason === "error" && response?.status) {
				output.stopReasonRaw = response.status;
			}
		} else if (event.type === "error") {
			throw new StreamFailureError(`Error Code ${event.code}: ${event.message}`, {
				kind: classifyStreamFailure(event.code ?? undefined),
				providerErrorType: event.code ?? undefined,
			});
		} else if (event.type === "response.failed") {
			const error = event.response?.error;
			const details = event.response?.incomplete_details;
			const providerErrorType = error?.code ?? details?.reason;
			const msg = error
				? `${error.code || "unknown"}: ${error.message || "no message"}`
				: details?.reason
					? `incomplete: ${details.reason}`
					: "Unknown error (no error details in response)";
			throw new StreamFailureError(msg, {
				kind: classifyStreamFailure(providerErrorType),
				providerErrorType,
			});
		}
	}
}

function mapStopReason(status: OpenAI.Responses.ResponseStatus | undefined): StopReason {
	if (!status) return "stop";
	switch (status) {
		case "completed":
			return "stop";
		case "incomplete":
			return "length";
		case "failed":
		case "cancelled":
			return "error";
		case "in_progress":
		case "queued":
			return "stop";
		default: {
			const _exhaustive: never = status;
			throw new Error(`Unhandled stop reason: ${_exhaustive}`);
		}
	}
}
