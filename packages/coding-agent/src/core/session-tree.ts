import { stringifyBoundedJson } from "./bounded-json.js";
import type { SessionHistoryReadLimits } from "./session-history-index.js";
import type { ReadonlySessionManager, SessionEntry, SessionTreeFlatNode, SessionTreeNode } from "./session-manager.js";
import { cloneUsage } from "./usage.js";

/** Whole-source limits, including entries hidden from the visible tree. */
export const DEFAULT_SESSION_TREE_LIMITS: Readonly<SessionHistoryReadLimits> = Object.freeze({
	maxEntries: 16_384,
	maxSourceBytes: 64 * 1024 * 1024,
});

/** SessionManager's existing label and hidden-parent policy, on a complete bounded source. */
export function buildSessionTreeFlatNodes(entries: readonly SessionEntry[]): SessionTreeFlatNode[] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const labelsById = new Map<string, string>();
	const labelTimestampsById = new Map<string, string>();
	for (const entry of entries) {
		if (entry.type !== "label") continue;
		if (entry.label) {
			labelsById.set(entry.targetId, entry.label);
			labelTimestampsById.set(entry.targetId, entry.timestamp);
		} else {
			labelsById.delete(entry.targetId);
			labelTimestampsById.delete(entry.targetId);
		}
	}
	return entries
		.filter(
			(entry): entry is SessionTreeFlatNode["entry"] => entry.type !== "tool_intent" && entry.type !== "request",
		)
		.map((entry) => {
			let parentId = entry.parentId;
			let parent = parentId ? byId.get(parentId) : undefined;
			while (parent?.type === "tool_intent" || parent?.type === "request") {
				parentId = parent.parentId;
				parent = parentId ? byId.get(parentId) : undefined;
			}
			return {
				entry: parentId === entry.parentId ? entry : { ...entry, parentId },
				label: labelsById.get(entry.id),
				labelTimestamp: labelTimestampsById.get(entry.id),
			};
		});
}

/** Extracted getTree policy: source-order roots and timestamp-ordered children. */
export function buildSessionTreeFromFlatNodes(flatNodes: readonly SessionTreeFlatNode[]): SessionTreeNode[] {
	const nodeMap = new Map<string, SessionTreeNode>();
	const roots: SessionTreeNode[] = [];
	for (const flatNode of flatNodes) nodeMap.set(flatNode.entry.id, { ...flatNode, children: [] });
	for (const flatNode of flatNodes) {
		const entry = flatNode.entry;
		const node = nodeMap.get(entry.id)!;
		if (entry.parentId === null || entry.parentId === entry.id) roots.push(node);
		else {
			const parent = nodeMap.get(entry.parentId);
			if (parent) parent.children.push(node);
			else roots.push(node);
		}
	}
	const stack: SessionTreeNode[] = [...roots];
	while (stack.length > 0) {
		const node = stack.pop()!;
		node.children.sort((a, b) => new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime());
		stack.push(...node.children);
	}
	return roots;
}

function applyTreeUsageOverlays(entries: SessionEntry[]): void {
	const assistants = new Map(
		entries
			.filter((entry) => entry.type === "message" && entry.message.role === "assistant")
			.map((entry) => [entry.id, entry]),
	);
	for (const entry of entries) {
		if (entry.type !== "child_usage_attributed") continue;
		const target = assistants.get(entry.targetId);
		if (target?.type === "message" && target.message.role === "assistant")
			target.message.usage = cloneUsage(entry.aggregateUsage);
	}
}

/** UI projection limits cover visible entries, not excluded request/tool-intent bodies. */
export async function readVisibleSessionTreeFlatNodes(
	manager: ReadonlySessionManager,
	limits: SessionHistoryReadLimits = DEFAULT_SESSION_TREE_LIMITS,
): Promise<{ flatNodes: SessionTreeFlatNode[]; leafId: string | null }> {
	const { maxEntries, maxSourceBytes } = limits;
	if (
		!Number.isSafeInteger(maxEntries) ||
		maxEntries <= 0 ||
		!Number.isSafeInteger(maxSourceBytes) ||
		maxSourceBytes <= 0
	)
		throw new Error("Invalid history materialization limits");
	if (!manager.supportsCapturedHistoryReads())
		return readSessionTreeFlatNodes(manager, { maxEntries, maxSourceBytes });
	return manager.readSourceHistory(async (history) => {
		const entries: SessionEntry[] = [];
		const visibleIds = new Set<string>();
		let sourceBytes = 0;
		let after = 0;
		for (;;) {
			const page = await history.page(after);
			if (page.indexedThrough < history.source.sourceSequence)
				throw new Error("Captured history has incomplete index coverage");
			for (const ref of page.events) {
				if (ref.kind === "request" || ref.kind === "tool_intent") continue;
				if (entries.length >= maxEntries) throw new Error("History entry budget exceeded");
				if (sourceBytes + ref.locator.length > maxSourceBytes)
					throw new Error("History source byte budget exceeded");
				const hydrated = await history.hydrateEntry(ref.id, maxSourceBytes - sourceBytes);
				if (!hydrated) throw new Error("Session tree entry source is unavailable");
				sourceBytes += ref.locator.length;
				let parentId = ref.parentId;
				// Resolve excluded parent chains as metadata; never retain or hydrate their bodies.
				while (parentId !== null && !visibleIds.has(parentId)) {
					const parent = await history.get(parentId);
					if (!parent || (parent.kind !== "request" && parent.kind !== "tool_intent")) break;
					parentId = parent.parentId;
				}
				hydrated.entry.parentId = parentId;
				entries.push(hydrated.entry);
				visibleIds.add(ref.id);
			}
			if (page.nextAfter === null) break;
			after = page.nextAfter;
		}
		applyTreeUsageOverlays(entries);
		const result = { flatNodes: buildSessionTreeFlatNodes(entries), leafId: history.source.leafId };
		// Labels and resolved usage are also part of the bounded visible response.
		stringifyBoundedJson(result, maxSourceBytes);
		return result;
	});
}

export async function readVisibleSessionTree(
	manager: ReadonlySessionManager,
	limits: SessionHistoryReadLimits = DEFAULT_SESSION_TREE_LIMITS,
): Promise<{ tree: SessionTreeNode[]; leafId: string | null }> {
	const { flatNodes, leafId } = await readVisibleSessionTreeFlatNodes(manager, limits);
	return { tree: buildSessionTreeFromFlatNodes(flatNodes), leafId };
}

/** Complete or refuse. Never widen a branch read or return a last-N tree. */
export async function readSessionTreeFlatNodes(
	manager: ReadonlySessionManager,
	limits: SessionHistoryReadLimits = DEFAULT_SESSION_TREE_LIMITS,
): Promise<{ flatNodes: SessionTreeFlatNode[]; leafId: string | null }> {
	const capturedLimits = { ...limits };
	let entries: SessionEntry[];
	let leafId: string | null;
	if (manager.supportsCapturedHistoryReads()) {
		const history = await manager.materializeSourceHistory(capturedLimits);
		entries = history.entries.map(({ entry }) => entry);
		leafId = history.source.leafId;
		applyTreeUsageOverlays(entries);
	} else {
		// Explicit readonly/legacy/in-memory views keep their captured resident data.
		// Their byte limit counts serialized header/entry JSON, not canonical frames.
		const history = manager.materializeResidentHistory(capturedLimits);
		entries = history.entries;
		leafId = history.leafId;
	}
	return { flatNodes: buildSessionTreeFlatNodes(entries), leafId };
}

export async function readSessionTree(
	manager: ReadonlySessionManager,
	limits: SessionHistoryReadLimits = DEFAULT_SESSION_TREE_LIMITS,
): Promise<{ tree: SessionTreeNode[]; leafId: string | null }> {
	const { flatNodes, leafId } = await readSessionTreeFlatNodes(manager, limits);
	return { tree: buildSessionTreeFromFlatNodes(flatNodes), leafId };
}
