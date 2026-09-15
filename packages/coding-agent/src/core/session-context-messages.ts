import type { AgentMessage } from "@ponythewhite/base-context-agent";
import { createBranchSummaryMessage, createCustomMessage } from "./messages.js";
import type { SessionEntry } from "./session-manager.js";

/** Context visibility precedes provider filtering (including bash and UI-only custom messages). */
export function sessionEntryMessage(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") return entry.message;
	if (entry.type === "custom_message")
		return createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp);
	if (entry.type === "branch_summary" && entry.summary)
		return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
	return undefined;
}

/** Restore complete tool-result runs after all retained context pages have been assembled. */
export function orderContextToolResults(messages: AgentMessage[]): void {
	let callOrder = new Map<string, number>();
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message.role === "assistant") {
			callOrder = new Map(
				message.content.filter((part) => part.type === "toolCall").map((call, order) => [call.id, order]),
			);
		} else if (message.role === "toolResult" && callOrder.size > 1) {
			let end = index + 1;
			while (end < messages.length && messages[end].role === "toolResult") end++;
			const results = messages.slice(index, end);
			results.sort((left, right) => {
				if (left.role !== "toolResult" || right.role !== "toolResult") return 0;
				return (callOrder.get(left.toolCallId) ?? Infinity) - (callOrder.get(right.toolCallId) ?? Infinity);
			});
			messages.splice(index, results.length, ...results);
			index = end - 1;
		}
	}
}
