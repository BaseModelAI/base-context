import type { SessionHistoryReadLimits } from "./session-history-index.js";
import type { ReadonlySessionManager, SessionEntry } from "./session-manager.js";

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
	return projectUserMessages(entries);
}

function projectUserMessages(entries: readonly SessionEntry[]): Array<{ entryId: string; text: string }> {
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

/** UI picker limits cover user-message candidates, not unrelated archive payloads. */
export async function readVisibleUserMessagesForForking(
	manager: ReadonlySessionManager,
	limits: SessionHistoryReadLimits = DEFAULT_FORK_MESSAGE_LIMITS,
): Promise<Array<{ entryId: string; text: string }>> {
	const { maxEntries, maxSourceBytes } = limits;
	if (
		!Number.isSafeInteger(maxEntries) ||
		maxEntries <= 0 ||
		!Number.isSafeInteger(maxSourceBytes) ||
		maxSourceBytes <= 0
	)
		throw new Error("Invalid history materialization limits");
	if (!manager.supportsCapturedHistoryReads())
		return readUserMessagesForForking(manager, { maxEntries, maxSourceBytes });
	return manager.readSourceHistory(async (history) => {
		const entries: SessionEntry[] = [];
		let sourceBytes = 0;
		let after = 0;
		for (;;) {
			const page = await history.page(after);
			if (page.indexedThrough < history.source.sourceSequence)
				throw new Error("Captured history has incomplete index coverage");
			for (const reference of page.events) {
				// The index classifies assistant/runtime messages; hydrated user roles are still checked below.
				if (
					reference.kind !== "message" ||
					reference.authority === "assistant" ||
					reference.authority === "runtime"
				)
					continue;
				if (entries.length >= maxEntries) throw new Error("History entry budget exceeded");
				if (sourceBytes + reference.locator.length > maxSourceBytes)
					throw new Error("History source byte budget exceeded");
				const hydrated = await history.hydrateEntry(reference.id, maxSourceBytes - sourceBytes);
				if (!hydrated) throw new Error("Fork message source is unavailable");
				sourceBytes += reference.locator.length;
				entries.push(hydrated.entry);
			}
			if (page.nextAfter === null) break;
			after = page.nextAfter;
		}
		return projectUserMessages(entries);
	});
}
