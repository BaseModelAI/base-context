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
		// Preserve the Manager's resolved usage overlays on detached canonical entries.
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
