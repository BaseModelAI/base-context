import type { AgentMessage } from "@ponythewhite/base-context-agent";
import { stringifyBoundedJson } from "./bounded-json.js";
import type { CustomMessage } from "./messages.js";

export const PUBLIC_CONTEXT_RENDERER = "public-history/1";

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
