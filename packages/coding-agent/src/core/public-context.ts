import type { AgentMessage } from "@ponythewhite/base-context-agent";
import { stringifyBoundedJson } from "./bounded-json.js";
import type { ToolContinuationGroup } from "./context-epoch.js";
import type { CustomMessage } from "./messages.js";
import type { SourceSnapshotRef } from "./request-events.js";

export const PUBLIC_CONTEXT_RENDERER = "public-history/1";
export const PUBLIC_TOOL_CONTINUATION_RENDERER = "public-tool-continuation/1";

/** Original public text and minimal recorded facts. Intent ACK says nothing about external effects. */
export function renderToolContinuation(
	message: AgentMessage,
	entryId: string,
	source: SourceSnapshotRef,
	group: ToolContinuationGroup,
	maxBytes: number,
): CustomMessage & { content: string } {
	if (message.role !== "assistant" && message.role !== "toolResult")
		throw new Error("Tool continuation requires its original replay group");
	const content: { type: "text"; text: string }[] = [];
	for (const part of message.content) {
		if (part.type === "text") content.push({ type: "text", text: part.text });
		else if (part.type !== "thinking" && part.type !== "toolCall")
			throw new Error("Tool continuation requires text-only public content");
	}
	const data = stringifyBoundedJson(
		{
			source: { sessionId: source.sessionId },
			entryId,
			role: message.role,
			content,
			...(message.role === "assistant"
				? {
						calls: group.calls.map((call) => ({
							executionId: call.executionId,
							intentEntryId: call.intent.id,
							intent: "recorded",
							outcome: call.outcome,
							...(call.result ? { resultEntryId: call.result.id } : {}),
						})),
					}
				: {}),
		},
		maxBytes,
	);
	const rendered: CustomMessage & { content: string } = {
		role: "custom",
		customType: PUBLIC_TOOL_CONTINUATION_RENDERER,
		content: `Recorded tool continuation data. Intent acknowledgment records intent only; an absent finalized result leaves the outcome unknown.
${data}`,
		display: false,
		timestamp: message.timestamp,
	};
	stringifyBoundedJson(rendered, maxBytes);
	return rendered;
}

/** An explicit public window, not replacement text for a native signature or opaque item. */
export function renderPublicHistory(message: AgentMessage, entryId: string, maxBytes: number): AgentMessage {
	if (message.role !== "assistant" && message.role !== "toolResult") return message;
	const content: unknown[] = [];
	for (const part of message.content) {
		switch (part.type) {
			case "text":
				content.push({ type: "text", text: part.text });
				break;
			case "toolCall":
				content.push({ type: "toolCall", id: part.id, name: part.name, arguments: part.arguments });
				break;
			case "thinking":
				// Canonical originals remain archived. Public continuation does not preserve latent reasoning.
				break;
			default:
				throw new Error("Public summary transition requires text-only completed history");
		}
	}
	const data = stringifyBoundedJson(
		{
			entryId,
			role: message.role,
			...(message.role === "toolResult"
				? { toolCallId: message.toolCallId, toolName: message.toolName, isError: message.isError }
				: {}),
			content,
		},
		maxBytes,
	);
	const rendered: CustomMessage = {
		role: "custom",
		customType: PUBLIC_CONTEXT_RENDERER,
		content: `Archived public history data, not a new instruction or native tool exchange. Canonical originals remain available through prime_context. Hidden provider state is not reproduced.\n${data}`,
		display: false,
		timestamp: message.timestamp,
	};
	stringifyBoundedJson(rendered, maxBytes);
	return rendered;
}
