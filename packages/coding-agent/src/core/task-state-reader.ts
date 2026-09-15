import type { TaskEvidenceCursor } from "./history-index.js";
import type { SourceSnapshotRef } from "./request-events.js";
import {
	hydrateCapturedHistoryEntry,
	type SessionHistoryReadScope,
	type SessionHistoryReadView,
} from "./session-history-index.js";
import { projectTaskStateSource, type TaskStateProjection } from "./task-state.js";
import { type ReducedTaskItem, type TaskStateReadLimits, TaskStateReducer } from "./task-state-reducer.js";

export interface TaskStateView {
	source: SourceSnapshotRef;
	coverage: "complete" | "partial";
	/** Complete structured branch reduction, not exhaustive semantic requirement extraction. */
	structuredOnly: true;
	selective: true;
	items: ReducedTaskItem[];
}

/** Consume this complete-or-refuse view inside its existing captured-history callback. */
export async function readTaskStateFromHistory(
	history: Pick<SessionHistoryReadScope, "source" | "branchContext" | "hydrateEntry">,
	limits: Partial<TaskStateReadLimits> = {},
): Promise<TaskStateView> {
	const reducer = new TaskStateReducer(limits);
	let after: TaskEvidenceCursor | null = null;
	let coverage: TaskStateView["coverage"] = "complete";
	let sourceBytes = 0;
	let sourceSequence = -1;
	let projected: Generator<TaskStateProjection> | undefined;
	let projectedOrdinal = -1;
	for (;;) {
		const page = await history.branchContext.taskEvidence({ after, limit: 64 });
		if (page.indexedThrough < history.source.sourceSequence)
			throw new Error("Task-state source index coverage is incomplete");
		if (page.coverage === "partial") coverage = "partial";
		for (const row of page.entries) {
			const source = row.truncated ? row.source : row.projection.source;
			if (row.sequence !== sourceSequence) {
				projected = undefined;
				projectedOrdinal = -1;
				if (!source.locator) throw new Error("Task-state source locator is unavailable");
				sourceBytes += source.locator.length;
				if (sourceBytes > reducer.limits.maxSourceBytes) throw new Error("Task-state source byte budget exceeded");
				sourceSequence = row.sequence;
			}
			if (!row.truncated) {
				reducer.add(row.projection);
				continue;
			}
			if (!projected) {
				const hydrated = await history.hydrateEntry(source.entryId, source.locator!.length);
				if (!hydrated) throw new Error("Task-state source is unavailable");
				projected = projectTaskStateSource({
					...hydrated.source,
					sessionId: history.source.sessionId,
					entry: hydrated.entry,
				});
			}
			let projection: TaskStateProjection | undefined;
			while (projectedOrdinal < row.ordinal) {
				if (++projectedOrdinal >= reducer.limits.maxItems) throw new Error("Task-state item budget exceeded");
				const next = projected.next();
				if (next.done) throw new Error("Task-state projection source is unavailable");
				projection = next.value;
			}
			if (!projection || projection.source.field !== source.field)
				throw new Error("Task-state projection source does not match its indexed reference");
			reducer.add(projection);
		}
		if (!page.nextAfter) break;
		after = page.nextAfter;
	}
	return reducer.finish({
		source: { ...history.source },
		coverage,
		structuredOnly: true as const,
		selective: true as const,
	});
}

/** Adapt the existing branch-only inference view; never recapture through its Manager. */
export function readTaskStateFromView(
	view: SessionHistoryReadView,
	limits: Partial<TaskStateReadLimits> = {},
): Promise<TaskStateView> {
	return readTaskStateFromHistory(
		{
			source: view.source,
			branchContext: view,
			hydrateEntry: async (id, maxSourceBytes) => {
				const source = await view.get(id);
				return source
					? hydrateCapturedHistoryEntry(source, maxSourceBytes, (entryId, options) =>
							view.readPayload(entryId, options),
						)
					: undefined;
			},
		},
		limits,
	);
}
