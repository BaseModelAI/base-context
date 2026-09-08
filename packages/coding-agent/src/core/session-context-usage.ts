import { calculateContextTokens } from "./compaction/index.js";
import { getLatestCompactionEntry, type SessionManager } from "./session-manager.js";
import { cloneUsage } from "./usage.js";

/** Source-backed availability only; token estimates still use the caller's working messages. */
export class ContextUsageReader {
	private cache?: { key: string; available: boolean };

	async hasPostCompactionUsage(manager: SessionManager, maxSourceBytes: number): Promise<boolean> {
		if (!manager.supportsCapturedHistoryReads()) {
			const entries = await manager.readBranch(undefined, { maxEntries: 16_384, maxSourceBytes });
			const compaction = getLatestCompactionEntry(entries);
			if (!compaction) return true;
			const boundary = entries.lastIndexOf(compaction);
			for (let index = entries.length - 1; index > boundary; index--) {
				const entry = entries[index];
				if (entry.type !== "message" || entry.message.role !== "assistant") continue;
				const assistant = entry.message;
				if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error")
					return calculateContextTokens(assistant.usage) > 0;
			}
			return false;
		}
		return manager.readSourceHistory(async (view) => {
			const bootstrap = await view.branchBootstrap();
			if (!bootstrap.latestCompaction) return true;
			const ref = bootstrap.contextUsageAssistant;
			if (!ref) return false;
			const updates = await view.branchContext.contextUpdates({ kind: "assistant-usage", targetId: ref.id });
			const sourceBytes =
				ref.locator.length + updates.refs.reduce((bytes, update) => bytes + update.locator.length, 0);
			if (sourceBytes > maxSourceBytes) throw new Error("Context usage source byte budget exceeded");
			const key = JSON.stringify([
				view.source.sessionId,
				view.source.sessionFile,
				ref.revision,
				...updates.refs.map((update) => update.revision),
			]);
			if (this.cache?.key === key) return this.cache.available;
			const hydrated = await view.hydrateEntry(ref.id, maxSourceBytes);
			if (!hydrated || hydrated.entry.type !== "message" || hydrated.entry.message.role !== "assistant")
				throw new Error("Context usage assistant source is unavailable");
			let usage = hydrated.entry.message.usage;
			for (const update of updates.refs) {
				const related = await view.hydrateEntry(update.entryId, maxSourceBytes);
				if (!related || related.entry.type !== "child_usage_attributed")
					throw new Error("Context usage update source is unavailable");
				usage = cloneUsage(related.entry.aggregateUsage);
			}
			const available = calculateContextTokens(usage) > 0;
			this.cache = { key, available };
			return available;
		});
	}
}
