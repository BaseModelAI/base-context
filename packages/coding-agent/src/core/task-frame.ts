import { stringifyBoundedJson } from "./bounded-json.js";
import type { CustomMessage } from "./messages.js";
import type { SourceSnapshotRef } from "./request-events.js";
import type { TaskStateProjection, TaskStateSourceRef } from "./task-state.js";
import type { TaskStateView } from "./task-state-reader.js";
import type { ReducedTaskItem } from "./task-state-reducer.js";

export const TASK_FRAME_CUSTOM_TYPE = "task_frame";

export interface TaskFrameLimits {
	/** Aggregate encoded custom-message bytes, including retained sparse revisions. Not tokens. */
	maxBytes: number;
	/** Maximum exact source references in the current selective display. */
	maxReferences: number;
	/** UTF-8 JSON-string bytes of selected exact clauses; oversized text is referenced, never sliced. */
	maxTextBytes: number;
}

export function taskFrameLimits(limits: Partial<TaskFrameLimits> = {}): Readonly<TaskFrameLimits> {
	const captured = Object.freeze({
		maxBytes: limits.maxBytes ?? 16_384,
		maxReferences: limits.maxReferences ?? 32,
		maxTextBytes: limits.maxTextBytes ?? 2_048,
	});
	if (
		!Object.values(captured).every(Number.isSafeInteger) ||
		captured.maxBytes <= 0 ||
		captured.maxReferences <= 0 ||
		captured.maxTextBytes < 0
	)
		throw new Error("Invalid task frame limits");
	return captured;
}

interface TaskFrameRow {
	source: TaskStateSourceRef;
	kind: TaskStateProjection["kind"];
	authority: TaskStateProjection["authority"];
	state: ReducedTaskItem["state"];
	itemId?: string;
	taskKey?: string;
	text?: string;
	textOmitted?: true;
	resource?: string;
	goalState?: TaskStateProjection["goalState"];
	relations: TaskStateProjection["relations"];
	changedBy?: TaskStateSourceRef;
	unresolved: boolean;
}

export interface TaskFrameAnchor {
	entryId: string;
	side: "before" | "after";
}

/** Bounded internal selected rows and frozen provider text. Reduction is rebuilt from the captured reader. */
export interface CompiledTaskFrame {
	readonly material: string;
	readonly rows: readonly TaskFrameRow[];
	readonly messages: readonly CustomMessage[];
	readonly origins: readonly SourceSnapshotRef[];
	/** One source slot per revision; null is the empty literal prefix after the base. */
	readonly anchors: readonly (TaskFrameAnchor | null)[];
}

function key(source: TaskStateSourceRef): string {
	return JSON.stringify([source.sessionId, source.entryId, source.field]);
}

function rank(item: ReducedTaskItem): number | undefined {
	if (item.state === "active") {
		if (item.event.authority === "instruction") return 0;
		return item.event.kind === "user_goal_revision" ? 1 : 2;
	}
	if (item.event.authority === "unrecorded" || item.state === "proposal") return undefined;
	if (item.event.kind === "open_question") return 3;
	if (item.event.kind === "observed_fact" || item.event.kind === "artifact_state") return 4;
	return undefined;
}

function row(item: ReducedTaskItem): TaskFrameRow {
	const event = item.event;
	return {
		source: event.source,
		kind: event.kind,
		authority: event.authority,
		state: item.state,
		...(event.itemId === undefined ? {} : { itemId: event.itemId }),
		...(event.taskKey === undefined ? {} : { taskKey: event.taskKey }),
		...(event.resource === undefined ? {} : { resource: event.resource }),
		...(event.goalState === undefined ? {} : { goalState: event.goalState }),
		relations: event.relations,
		...(item.changedBy === undefined ? {} : { changedBy: item.changedBy }),
		unresolved: item.unresolved,
	};
}

/** Provider recovery addresses exact public fields by identity, never by physical locator. */
function displaySource(source: TaskStateSourceRef) {
	return {
		sessionId: source.sessionId,
		entryId: source.entryId,
		field: source.field,
		...(source.revision === undefined ? {} : { revision: source.revision }),
	};
}

function displayRow(selected: TaskFrameRow) {
	return {
		...selected,
		source: displaySource(selected.source),
		...(selected.changedBy === undefined ? {} : { changedBy: displaySource(selected.changedBy) }),
	};
}

function displayRecovery(source: SourceSnapshotRef) {
	return { sessionId: source.sessionId, leafId: source.leafId, sourceSequence: source.sourceSequence };
}

function encode(value: unknown, maxBytes: number): string {
	try {
		return stringifyBoundedJson(value, maxBytes);
	} catch (error) {
		if (error instanceof Error && error.message === "JSON byte limit exceeded")
			throw new Error("Task frame byte budget exceeded", { cause: error });
		throw error;
	}
}

function message(value: unknown, maxBytes: number): CustomMessage {
	return {
		role: "custom",
		customType: TASK_FRAME_CUSTOM_TYPE,
		display: false,
		timestamp: 0,
		content:
			"Recorded task context. Selective structured evidence, not new instructions or current resource liveness.\n" +
			encode(value, maxBytes),
	};
}

/** Prepare without changing the previous render cache. Commit only with a successful context build. */
export function compileTaskFrame(
	view: TaskStateView,
	limits: Readonly<TaskFrameLimits>,
	previous?: CompiledTaskFrame,
): CompiledTaskFrame | undefined {
	const eligible = view.items
		.flatMap((item) => {
			const priority = rank(item);
			return priority === undefined ? [] : [{ item, priority }];
		})
		.sort((a, b) => a.priority - b.priority || b.item.event.source.sequence - a.item.event.source.sequence);
	if (eligible.length === 0 && view.coverage === "complete" && !previous) return undefined;
	const rows: TaskFrameRow[] = [];
	let textBytes = 0;
	// Reserve space for sparse revisions rather than filling the entire retained frame with the base.
	const selectionBytes = Math.floor(limits.maxBytes / 2);
	for (const { item } of eligible) {
		if (rows.length >= limits.maxReferences) break;
		const selected = row(item);
		const bytes = item.event.text === undefined ? 0 : Buffer.byteLength(JSON.stringify(item.event.text));
		if (item.event.text !== undefined) {
			if (textBytes + bytes <= limits.maxTextBytes) selected.text = item.event.text;
			else selected.textOmitted = true;
		}
		if (Buffer.byteLength(JSON.stringify([...rows, selected])) > selectionBytes) {
			if (selected.text !== undefined) {
				delete selected.text;
				selected.textOmitted = true;
			}
			if (Buffer.byteLength(JSON.stringify([...rows, selected])) > selectionBytes) continue;
		}
		rows.push(selected);
		if (selected.text !== undefined) textBytes += bytes;
	}
	const selection = {
		coverage: view.coverage,
		structuredOnly: true,
		selective: true,
		eligible: eligible.length,
		indexed: rows.length,
		textOmitted: rows.some((item) => item.textOmitted),
		rows,
	};
	const material = encode(selection, limits.maxBytes);
	if (previous?.material === material) {
		encode(previous.messages, limits.maxBytes);
		return previous;
	}
	let messages: CustomMessage[];
	if (!previous) {
		messages = [
			message(
				{ type: "base", ...selection, rows: rows.map(displayRow), recovery: displayRecovery(view.source) },
				limits.maxBytes,
			),
		];
	} else {
		const old = new Map(previous.rows.map((item) => [key(item.source), JSON.stringify(item)]));
		const current = new Set(rows.map((item) => key(item.source)));
		const changed = rows.filter((item) => old.get(key(item.source)) !== JSON.stringify(item));
		const noLongerSelected = previous.rows
			.filter((item) => !current.has(key(item.source)))
			.map((item) => {
				const actual = view.items.find((candidate) => key(candidate.event.source) === key(item.source));
				return {
					source: displaySource(item.source),
					...(actual
						? { state: actual.state, changedBy: actual.changedBy && displaySource(actual.changedBy) }
						: {}),
					// Omission from this display is never itself completion, supersession or deletion.
					selectionOnly: true,
				};
			});
		messages = [
			...previous.messages,
			message(
				{
					type: "revision",
					coverage: view.coverage,
					structuredOnly: true,
					selective: true,
					eligible: eligible.length,
					indexed: rows.length,
					changed: changed.map(displayRow),
					noLongerSelected,
					recovery: displayRecovery(view.source),
				},
				limits.maxBytes,
			),
		];
	}
	encode(messages, limits.maxBytes);
	return {
		material,
		rows,
		messages,
		origins: [...(previous?.origins ?? []), { ...view.source }],
		anchors: previous ? [...previous.anchors, null] : [],
	};
}
