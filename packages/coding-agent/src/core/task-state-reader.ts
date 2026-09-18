import type { TaskEvidenceCursor, TaskEvidencePage } from "./history-index.js";
import type { SourceSnapshotRef } from "./request-events.js";
import {
	hydrateCapturedHistoryEntry,
	type SessionHistoryReadScope,
	type SessionHistoryReadView,
} from "./session-history-index.js";
import { projectTaskStateSource, type TaskStateProjection } from "./task-state.js";
import {
	type ReducedTaskItem,
	type TaskStateReadLimits,
	TaskStateReducer,
	taskStateReadLimits,
} from "./task-state-reducer.js";

export interface TaskStateView {
	source: SourceSnapshotRef;
	coverage: "complete" | "partial";
	/** Complete structured branch reduction, not exhaustive semantic requirement extraction. */
	structuredOnly: true;
	selective: true;
	items: ReducedTaskItem[];
}

type TaskHistory = Pick<SessionHistoryReadScope, "source" | "branchContext" | "hydrateEntry">;
interface Reduction {
	reducer: TaskStateReducer;
	sourceBytes: number;
	identity?: TaskEvidencePage["sourceIdentity"];
	view?: TaskStateView;
}

/** Consume this complete-or-refuse view inside its existing captured-history callback. */
export function readTaskStateFromHistory(
	history: TaskHistory,
	limits: Partial<TaskStateReadLimits> = {},
): Promise<TaskStateView> {
	return reduceHistory(history, { reducer: new TaskStateReducer(limits), sourceBytes: 0 });
}

async function reduceHistory(
	history: TaskHistory,
	state: Reduction,
	firstPage?: TaskEvidencePage,
): Promise<TaskStateView> {
	const { reducer } = state;
	let after: TaskEvidenceCursor | null = null;
	let coverage: TaskStateView["coverage"] = "complete";
	let sourceBytes = state.sourceBytes;
	let sourceSequence = -1;
	let projected: Generator<TaskStateProjection> | undefined;
	let projectedOrdinal = -1;
	for (;;) {
		const page: TaskEvidencePage = firstPage ?? (await history.branchContext.taskEvidence({ after, limit: 64 }));
		firstPage = undefined;
		state.identity = page.sourceIdentity;
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
	state.sourceBytes = sourceBytes;
	state.view = reducer.finish({
		source: { ...history.source },
		coverage,
		structuredOnly: true as const,
		selective: true as const,
	});
	return state.view;
}

/** Adapt the existing branch-only inference view; never recapture through its Manager. */
function taskHistory(view: SessionHistoryReadView): TaskHistory {
	return {
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
	};
}

export function readTaskStateFromView(
	view: SessionHistoryReadView,
	limits: Partial<TaskStateReadLimits> = {},
): Promise<TaskStateView> {
	return readTaskStateFromHistory(taskHistory(view), limits);
}

/** Compiler-owned derived state only. Returned views are internal and must not be mutated. */
export class TaskStateReadCache {
	private state?: Reduction;
	private generation = 0;

	clear(): void {
		this.generation++;
		this.state = undefined;
	}

	async read(view: SessionHistoryReadView, supplied: Partial<TaskStateReadLimits> = {}): Promise<TaskStateView> {
		const limits = taskStateReadLimits(supplied);
		const cached = this.state;
		const generation = ++this.generation;
		// A failed or overlapping read cannot publish a partially mutated reducer.
		this.state = undefined;
		const previous = cached?.view?.source;
		let compatible = Boolean(
			cached?.identity &&
				previous &&
				previous.sessionId === view.source.sessionId &&
				previous.sessionFile === view.source.sessionFile &&
				previous.persistent === view.source.persistent &&
				previous.sourceSequence <= view.source.sourceSequence &&
				Object.entries(limits).every(
					([key, value]) => cached!.reducer.limits[key as keyof TaskStateReadLimits] === value,
				),
		);
		if (compatible && previous!.leafId !== view.source.leafId) {
			const oldLeaf = previous!.leafId === null ? undefined : await view.get(previous!.leafId);
			const newLeaf = view.source.leafId === null ? undefined : await view.get(view.source.leafId);
			// Moving to a pre-existing descendant is branch navigation, not an append.
			compatible = Boolean(oldLeaf && newLeaf && newLeaf.sequence > previous!.sourceSequence);
		}
		let state: Reduction = compatible ? cached! : { reducer: new TaskStateReducer(limits), sourceBytes: 0 };
		let page = await view.taskEvidence({
			after: compatible ? { sequence: previous!.sourceSequence, ordinal: Number.MAX_SAFE_INTEGER } : null,
			limit: 64,
		});
		if (
			compatible &&
			(!page.sourceIdentity ||
				page.sourceIdentity.journalPath !== cached!.identity!.journalPath ||
				page.sourceIdentity.dev !== cached!.identity!.dev ||
				page.sourceIdentity.ino !== cached!.identity!.ino)
		) {
			state = { reducer: new TaskStateReducer(limits), sourceBytes: 0 };
			compatible = false;
			page = await view.taskEvidence({ after: null, limit: 64 });
		}
		if (page.indexedThrough < view.source.sourceSequence)
			throw new Error("Task-state source index coverage is incomplete");
		const unchanged =
			compatible &&
			previous!.sourceSequence === view.source.sourceSequence &&
			previous!.leafId === view.source.leafId &&
			page.entries.length === 0 &&
			!page.nextAfter &&
			page.coverage === state.view!.coverage;
		const result = unchanged ? state.view! : await reduceHistory(taskHistory(view), state, page);
		if (generation === this.generation) this.state = state;
		return result;
	}
}
