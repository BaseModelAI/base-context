import type { SessionHistoryReadLimits } from "./session-history-index.js";
import type { ReadonlySessionManager } from "./session-manager.js";

export const DEFAULT_FORK_MESSAGE_LIMITS: Readonly<SessionHistoryReadLimits> = Object.freeze({
	maxEntries: 16_384,
	maxSourceBytes: 64 * 1024 * 1024,
});

/**
 * Complete source order, including other branches; refuse rather than return a clipped picker.
 * Limits count all entries before text filtering. Native bytes are frame bytes;
 * resident bytes are serialized header/entry JSON, not a heap estimate.
 */
export async function readUserMessagesForForking(
	manager: ReadonlySessionManager,
	limits: SessionHistoryReadLimits = DEFAULT_FORK_MESSAGE_LIMITS,
): Promise<Array<{ entryId: string; text: string }>> {
	const capturedLimits = { ...limits };
	const entries = manager.supportsCapturedHistoryReads()
		? (await manager.materializeSourceHistory(capturedLimits)).entries.map(({ entry }) => entry)
		: manager.materializeResidentHistory(capturedLimits).entries;
	const result: Array<{ entryId: string; text: string }> = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const content = entry.message.content;
		let text = "";
		if (typeof content === "string") text = content;
		else if (Array.isArray(content)) {
			text = content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("");
		}
		if (text) result.push({ entryId: entry.id, text });
	}
	return result;
}
