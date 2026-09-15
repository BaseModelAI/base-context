import { stringifyBoundedJson } from "./bounded-json.js";
import type { TaskStateKind, TaskStateProjection, TaskStateSourceRef } from "./task-state.js";

export interface TaskStateReadLimits {
	/** Projection records plus explicit relation edges processed by this view. */
	maxItems: number;
	/** Distinct canonical source-frame bytes read or represented by the view. */
	maxSourceBytes: number;
	/** Encoded projection and result bytes, each admitted under this limit. */
	maxViewBytes: number;
}

export function taskStateReadLimits(limits: Partial<TaskStateReadLimits> = {}): Readonly<TaskStateReadLimits> {
	const captured = Object.freeze({
		maxItems: limits.maxItems ?? 16_384,
		maxSourceBytes: limits.maxSourceBytes ?? 64 * 1024 * 1024,
		maxViewBytes: limits.maxViewBytes ?? 64 * 1024 * 1024,
	});
	if (!Object.values(captured).every((value) => Number.isSafeInteger(value) && value > 0))
		throw new Error("Invalid task-state read limits");
	return captured;
}

export interface ReducedTaskItem {
	/** Exact evidence, including claims and source fields; never replaced by normalized text. */
	event: TaskStateProjection;
	state: "active" | "superseded" | "completed" | "proposal" | "descriptive";
	changedBy?: TaskStateSourceRef;
	/** The original relation is retained in event; missing/ambiguous targets are not inferred. */
	unresolved: boolean;
}

function requirement(kind: TaskStateKind): boolean {
	return kind === "user_requirement" || kind === "user_goal_revision";
}

function authoritative(event: TaskStateProjection): boolean {
	return (event.authority === "user" || event.authority === "instruction") && event.attribution === "source-backed";
}

/** Request-local reduction of already-qualified canonical projections, not a second task store. */
export class TaskStateReducer {
	private readonly items: ReducedTaskItem[] = [];
	private readonly identities = new Map<string, ReducedTaskItem[]>();
	private workItems = 0;
	private projectionBytes = 0;
	readonly limits: Readonly<TaskStateReadLimits>;

	constructor(limits: Partial<TaskStateReadLimits> = {}) {
		this.limits = taskStateReadLimits(limits);
	}

	private key(event: TaskStateProjection, kind: TaskStateKind, id: string): string {
		// Scope, kind and literal ID are separate from display text. Empty and absent keys differ.
		return JSON.stringify([event.source.sessionId, event.taskKey ?? null, kind, id]);
	}

	private resolve(item: ReducedTaskItem, kind: TaskStateKind, id: string, state: "superseded" | "completed"): void {
		const targets = (this.identities.get(this.key(item.event, kind, id)) ?? []).filter(
			(target) =>
				target.state === "active" &&
				(target.event.authority !== "instruction" || item.event.authority === "instruction"),
		);
		if (targets.length !== 1) {
			item.unresolved = true;
			return;
		}
		targets[0].state = state;
		targets[0].changedBy = item.event.source;
	}

	add(projection: TaskStateProjection): void {
		this.workItems += 1 + projection.relations.length;
		if (this.workItems > this.limits.maxItems) throw new Error("Task-state item budget exceeded");
		const json = stringifyBoundedJson(projection, this.limits.maxViewBytes - this.projectionBytes);
		this.projectionBytes += Buffer.byteLength(json);
		const event = JSON.parse(json) as TaskStateProjection;
		const admittedRequirement = requirement(event.kind) && authoritative(event);
		const item: ReducedTaskItem = {
			event,
			state: admittedRequirement ? "active" : event.attribution === "proposal" ? "proposal" : "descriptive",
			unresolved: false,
		};
		if (admittedRequirement) {
			for (const relation of event.relations) {
				if (relation.kind === "supersedes" || relation.kind === "completes") {
					this.resolve(
						item,
						event.kind,
						relation.itemId,
						relation.kind === "completes" ? "completed" : "superseded",
					);
				} else {
					// A claimed successor does not identify a prior target revision. Keep both addressable.
					item.unresolved = true;
				}
			}
			if (
				event.relations.length === 0 &&
				(event.operation === "amend" || event.operation === "supersede" || event.operation === "complete")
			) {
				if (event.itemId === undefined) item.unresolved = true;
				else
					this.resolve(
						item,
						event.kind,
						event.itemId,
						event.operation === "complete" ? "completed" : "superseded",
					);
			}
			if (event.operation === "complete") item.state = "completed";
		} else if (
			(event.authority === "user" || event.authority === "tool-data" || event.authority === "instruction") &&
			(event.goalState?.operation === "complete" || event.goalState?.operation === "clear")
		) {
			// An acknowledged native goal control can close that goal, not unrelated requirements.
			const id = event.goalState.previousGoalId ?? event.goalState.goalId;
			if (id === undefined) item.unresolved = true;
			else this.resolve(item, "user_goal_revision", id, "completed");
		}
		this.items.push(item);
		if (admittedRequirement && event.itemId !== undefined) {
			const key = this.key(event, event.kind, event.itemId);
			const versions = this.identities.get(key) ?? [];
			versions.push(item);
			this.identities.set(key, versions);
		}
	}

	/** Complete detached output or refusal; no last-N selection and no implicit retirement. */
	finish<Metadata extends object>(metadata: Metadata): Metadata & { items: ReducedTaskItem[] } {
		return JSON.parse(
			stringifyBoundedJson({ ...metadata, items: this.items }, this.limits.maxViewBytes),
		) as Metadata & { items: ReducedTaskItem[] };
	}
}
