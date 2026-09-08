import { GOAL_STATE_CUSTOM_TYPE, isPersistedGoalState } from "./goals.js";
import type { JournalFrameRetention, NativeEntryQualification } from "./journal-frame.js";
import type { NativeEntryOrigin } from "./session-entry-origin.js";

export const TASK_STATE_CUSTOM_TYPE = "task_state";
export const TASK_STATE_SCHEMA = "base-context.task-state/v1";

export const TASK_STATE_KINDS = [
	"user_requirement",
	"user_goal_revision",
	"observed_fact",
	"model_hypothesis",
	"model_plan",
	"decision",
	"artifact_state",
	"open_question",
] as const;
export type TaskStateKind = (typeof TASK_STATE_KINDS)[number];
export type TaskStateAuthority = "instruction" | "user" | "assistant-public" | "tool-data" | "unrecorded";
export type TaskStateOperation = "declare" | "amend" | "complete" | "supersede" | "observe";

export interface TaskStateLocator {
	path: string;
	offset: number;
	length: number;
}

export interface TaskStateSource {
	sessionId: string;
	sequence: number;
	locator?: TaskStateLocator;
	revision?: string;
	/** Decoded frame/import control, not a claim inside entry data. */
	retention?: JournalFrameRetention;
	/** Decoded canonical producer control; entry.nativeOrigin alone is only a claim. */
	qualification?: NativeEntryQualification;
	entry: {
		id: string;
		parentId: string | null;
		type: string;
		customType?: string;
		data?: unknown;
		details?: unknown;
		message?: unknown;
		nativeOrigin?: unknown;
	};
}

export interface TaskStateSourceRef {
	sessionId: string;
	entryId: string;
	sequence: number;
	/** JSON Pointer within the canonical source entry, not a new canonical ID. */
	field: string;
	locator?: TaskStateLocator;
	revision?: string;
	retention?: JournalFrameRetention;
	qualification?: NativeEntryQualification;
}

export interface TaskStateOriginalSource {
	sessionId?: string;
	entryId?: string;
	field?: string;
	observationRef?: string;
	toolCallId?: string;
}

export interface TaskStateRelation {
	kind: "supersedes" | "superseded_by" | "completes";
	itemId: string;
}

export interface TaskStateEventData {
	schema: typeof TASK_STATE_SCHEMA;
	taskKey?: string;
	itemId: string;
	kind: TaskStateKind;
	text?: string;
	operation: TaskStateOperation;
	relations?: readonly TaskStateRelation[];
	originalSource?: TaskStateOriginalSource;
	/** A payload claim only. It cannot establish native source authority. */
	authority?: string;
}

export interface TaskStateProjection {
	source: TaskStateSourceRef;
	taskKey?: string;
	/** Absent when the source supplied no item identity; source.field still locates it exactly. */
	itemId?: string;
	kind: TaskStateKind;
	text?: string;
	resource?: string;
	operation: TaskStateOperation;
	relations: readonly TaskStateRelation[];
	originalSource?: TaskStateOriginalSource;
	/** Authority requires qualified native origin at an expected message/control location. */
	authority: TaskStateAuthority;
	attribution: "proposal" | "descriptive" | "source-backed";
	claimedAuthority?: string;
	importCoverage?: {
		kind: "legacy-bounded-snapshot";
		earlierItemsMayHaveBeenLost: true;
		source: "unrecorded" | "unverified";
	};
	goalState?: {
		goalId?: string;
		previousGoalId?: string;
		status: string;
		operation?: Extract<NativeEntryOrigin, { kind: "goal_operation" }>["operation"];
	};
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function values(value: unknown): readonly unknown[] {
	return Array.isArray(value) ? value : [];
}

function sourceRef(source: TaskStateSource, field: string): TaskStateSourceRef {
	return {
		sessionId: source.sessionId,
		entryId: source.entry.id,
		sequence: source.sequence,
		field,
		locator: source.locator,
		revision: source.revision,
		...(source.retention === undefined ? {} : { retention: source.retention }),
		...(source.qualification === undefined ? {} : { qualification: source.qualification }),
	};
}

function originalSource(value: unknown): TaskStateOriginalSource | undefined {
	const input = record(value);
	if (!input) return undefined;
	const result = {
		sessionId: text(input.sessionId),
		entryId: text(input.entryId),
		field: text(input.field),
		observationRef: text(input.observationRef),
		toolCallId: text(input.toolCallId),
	};
	return Object.values(result).some((value) => value !== undefined) ? result : undefined;
}

function relations(value: unknown): TaskStateRelation[] {
	const result: TaskStateRelation[] = [];
	for (const candidate of values(value)) {
		const relation = record(candidate);
		if (
			relation &&
			(relation.kind === "supersedes" || relation.kind === "superseded_by" || relation.kind === "completes") &&
			typeof relation.itemId === "string"
		) {
			result.push({ kind: relation.kind, itemId: relation.itemId });
		}
	}
	return result;
}

export interface TaskStateImportCoverage {
	taskKey?: string;
	earlierItemsMayHaveBeenLost: true;
}

function legacySnapshotSource(source: TaskStateSource):
	| {
			snapshot: Record<string, unknown>;
			field: string;
	  }
	| undefined {
	const { entry } = source;
	let snapshot: Record<string, unknown> | undefined;
	let field: string;
	if (entry.type === "custom" && entry.customType === "prime-context.task-snapshot") {
		snapshot = record(entry.data);
		field = "/data";
	} else if (entry.type === "compaction") {
		const details = record(entry.details);
		if (details?.schema !== "prime-context.reference-compaction/v1") return undefined;
		snapshot = record(details.taskSnapshot);
		field = "/details/taskSnapshot";
	} else {
		return undefined;
	}
	return snapshot?.schema === "prime-context.task-snapshot/v2" ? { snapshot, field } : undefined;
}

/** Coverage belongs to the source snapshot, including snapshots that yield no items. */
export function getTaskStateImportCoverage(source: TaskStateSource): TaskStateImportCoverage | undefined {
	const legacy = legacySnapshotSource(source);
	return legacy ? { taskKey: text(legacy.snapshot.taskKey), earlierItemsMayHaveBeenLost: true } : undefined;
}

type LegacyDetails = Pick<TaskStateProjection, "itemId" | "originalSource" | "resource"> & {
	relations?: readonly TaskStateRelation[];
};

function* legacySnapshot(
	source: TaskStateSource,
	snapshot: Record<string, unknown>,
	field: string,
): Generator<TaskStateProjection> {
	const taskKey = text(snapshot.taskKey);
	const item = (
		kind: TaskStateKind,
		path: string,
		content: string | undefined,
		details: LegacyDetails = {},
	): TaskStateProjection => ({
		source: sourceRef(source, `${field}/${path}`),
		taskKey,
		kind,
		text: content,
		operation: "observe",
		relations: [],
		...details,
		authority: "unrecorded",
		attribution: "proposal",
		importCoverage: {
			kind: "legacy-bounded-snapshot",
			earlierItemsMayHaveBeenLost: true,
			source: details.originalSource ? "unverified" : "unrecorded",
		},
	});
	if (typeof snapshot.objective === "string") {
		yield item("user_goal_revision", "objective", snapshot.objective, {
			originalSource: originalSource({ entryId: snapshot.objectiveSourceEntryId }),
		});
	}
	for (const [index, value] of values(snapshot.explicitConstraints).entries()) {
		const constraint = record(value);
		if (!constraint || typeof constraint.text !== "string") continue;
		const supersededBy = text(constraint.supersededBy);
		yield item("user_requirement", `explicitConstraints/${index}`, constraint.text, {
			itemId: text(constraint.id),
			originalSource: originalSource({ entryId: constraint.sourceEntryId }),
			relations: supersededBy === undefined ? [] : [{ kind: "superseded_by", itemId: supersededBy }],
		});
	}
	if (typeof snapshot.focus === "string") yield item("model_plan", "focus", snapshot.focus);
	for (const [index, value] of values(snapshot.openItems).entries()) {
		const open = record(value);
		if (!open || typeof open.text !== "string") continue;
		yield item("model_plan", `openItems/${index}`, open.text, { itemId: text(open.id) });
	}
	for (const [index, ref] of values(snapshot.pinnedObservationIds).entries()) {
		if (typeof ref !== "string") continue;
		yield item("observed_fact", `pinnedObservationIds/${index}`, undefined, {
			originalSource: originalSource({ observationRef: ref }),
		});
	}
	for (const [index, value] of values(snapshot.actionableObservations).entries()) {
		const observation = record(value);
		if (!observation || typeof observation.text !== "string") continue;
		yield item("observed_fact", `actionableObservations/${index}`, observation.text, {
			resource: text(observation.resource),
			originalSource: originalSource({
				observationRef: observation.observationRef,
				toolCallId: observation.sourceToolCallId,
			}),
		});
	}
	for (const [index, value] of values(snapshot.artifacts).entries()) {
		const artifact = record(value);
		if (!artifact || typeof artifact.pathOrId !== "string") continue;
		yield item("artifact_state", `artifacts/${index}`, text(artifact.description), {
			itemId: artifact.pathOrId,
			resource: artifact.pathOrId,
			originalSource: originalSource({ toolCallId: artifact.sourceToolCallId }),
		});
	}
}

function* nativeInput(source: TaskStateSource): Generator<TaskStateProjection> {
	const message = record(source.entry.message);
	const origin = record(source.entry.nativeOrigin);
	const submitted = record(origin?.submitted);
	if (
		source.entry.type !== "message" ||
		message?.role !== "user" ||
		origin?.version !== 1 ||
		origin.kind !== "input" ||
		typeof origin.actionId !== "string" ||
		!origin.actionId ||
		typeof origin.recordId !== "string" ||
		!origin.recordId ||
		(origin.inputSource !== "interactive" && origin.inputSource !== "rpc") ||
		origin.recordRole !== "primary" ||
		typeof submitted?.text !== "string"
	)
		return;
	const qualified = source.qualification === "native-admission" && source.retention !== "retained-import";
	const input = (value: string, field: string): TaskStateProjection => ({
		source: sourceRef(source, field),
		kind: "user_requirement",
		text: value,
		operation: "observe",
		relations: [],
		authority: qualified ? "user" : "unrecorded",
		attribution: qualified ? "source-backed" : "proposal",
		...(!qualified ? { claimedAuthority: "user" } : {}),
	});
	// These are complete source text fields, not extracted or inferred individual requirements.
	yield input(submitted.text, "/nativeOrigin/submitted/text");
	for (const [index, value] of values(submitted.content).entries()) {
		const part = record(value);
		if (part?.type === "text" && typeof part.text === "string") {
			yield input(part.text, `/nativeOrigin/submitted/content/${index}/text`);
		}
	}
}

function nativeGoalOrigin(
	entry: TaskStateSource["entry"],
): Extract<NativeEntryOrigin, { kind: "goal_operation" }> | undefined {
	const origin = record(entry.nativeOrigin);
	if (
		entry.type !== "custom" ||
		entry.customType !== GOAL_STATE_CUSTOM_TYPE ||
		origin?.version !== 1 ||
		origin.kind !== "goal_operation"
	)
		return undefined;
	const operation = (["create", "revise", "complete", "pause", "resume", "clear"] as const).find(
		(value) => value === origin.operation,
	);
	const actor = (["interactive", "rpc", "extension", "internal", "runtime"] as const).find(
		(value) => value === origin.actor,
	);
	if (!operation || !actor) return undefined;
	return {
		version: 1,
		kind: "goal_operation",
		operation,
		actor,
		actionId: text(origin.actionId),
		submittedText: text(origin.submittedText),
		previousGoalId: text(origin.previousGoalId),
	};
}

/**
 * Decode one canonical source event. This is not a reducer or a bounded task snapshot.
 * Relations are supplied claims, not permission to retire authoritative requirements.
 * Original text remains addressable through source even when no structured item is decoded.
 */
export function* projectTaskStateSource(source: TaskStateSource): Generator<TaskStateProjection> {
	if (source.retention !== undefined && source.retention !== "retained-import")
		throw new Error("Unsupported task source retention");
	if (source.qualification !== undefined && source.qualification !== "native-admission")
		throw new Error("Unsupported task source qualification");
	const retained = source.retention === "retained-import";
	const qualified = source.qualification === "native-admission" && !retained;
	const { entry } = source;
	const data = record(entry.data);
	if (entry.type === "message") {
		yield* nativeInput(source);
		return;
	}
	if (entry.type === "custom" && entry.customType === TASK_STATE_CUSTOM_TYPE && data?.schema === TASK_STATE_SCHEMA) {
		const kind = TASK_STATE_KINDS.find((kind) => kind === data.kind);
		const operation = data.operation;
		if (
			!kind ||
			typeof data.itemId !== "string" ||
			(operation !== "declare" &&
				operation !== "amend" &&
				operation !== "complete" &&
				operation !== "supersede" &&
				operation !== "observe")
		) {
			return;
		}
		yield {
			source: sourceRef(source, "/data"),
			taskKey: text(data.taskKey),
			itemId: data.itemId,
			kind,
			text: text(data.text),
			operation,
			relations: relations(data.relations),
			originalSource: originalSource(data.originalSource),
			authority: "unrecorded",
			attribution: "proposal",
			claimedAuthority: text(data.authority),
		};
	} else if (entry.type === "custom" && entry.customType === GOAL_STATE_CUSTOM_TYPE && isPersistedGoalState(data)) {
		const origin = nativeGoalOrigin(entry);
		const userControl =
			origin &&
			(origin.actor === "interactive" || origin.actor === "rpc") &&
			typeof origin.actionId === "string" &&
			origin.actionId.length > 0 &&
			typeof origin.submittedText === "string";
		const userRevision = userControl && (origin.operation === "create" || origin.operation === "revise");
		yield {
			source: sourceRef(source, "/data"),
			itemId: text(data.goalId),
			kind: userRevision ? "user_goal_revision" : "observed_fact",
			text: text(data.objective),
			operation: userRevision ? (origin.operation === "revise" ? "amend" : "declare") : "observe",
			relations:
				userRevision && origin.operation === "revise" && origin.previousGoalId !== undefined
					? [{ kind: "supersedes", itemId: origin.previousGoalId }]
					: [],
			originalSource: userControl
				? {
						sessionId: source.sessionId,
						entryId: entry.id,
						field: "/nativeOrigin/submittedText",
					}
				: undefined,
			authority: !qualified
				? "unrecorded"
				: userControl
					? "user"
					: origin?.actor === "runtime"
						? "tool-data"
						: "unrecorded",
			attribution:
				retained || (!qualified && (userControl || origin?.actor === "runtime"))
					? "proposal"
					: userRevision
						? "source-backed"
						: "descriptive",
			...(!qualified && (userControl || origin?.actor === "runtime")
				? { claimedAuthority: userControl ? "user" : "tool-data" }
				: {}),
			goalState: {
				goalId: text(data.goalId),
				status: data.status,
				operation: origin?.operation,
				...(origin?.previousGoalId === undefined ? {} : { previousGoalId: origin.previousGoalId }),
			},
		};
	} else {
		const legacy = legacySnapshotSource(source);
		if (legacy) yield* legacySnapshot(source, legacy.snapshot, legacy.field);
	}
}
