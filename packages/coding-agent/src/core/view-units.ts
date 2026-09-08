import type { AgentMessage } from "@ponythewhite/base-context-agent";
import { stringifyBoundedJson } from "./bounded-json.js";

/** Source-backed rendering metadata. It never owns canonical message bodies. */
export interface ViewUnit {
	readonly id: string;
	readonly sourceRevision: string;
	readonly kind: "literal" | "fixed-view" | "recovery" | "task-frame" | "replay-group";
	readonly exactSources: readonly string[];
	readonly requiredVisibleDependencies: readonly string[];
	readonly authority: "instruction" | "user" | "assistant-public" | "tool-data" | "unrecorded";
	/** Unknown until supplied by the resolved model/template counter. */
	readonly tokenEstimate: number | null;
	readonly immutableWithinEpoch: boolean;
	/** A selected open replay group must refuse rather than invent missing results. */
	readonly unavailableDependencies?: readonly string[];
}

export interface ViewUnitLimits {
	maxUnits: number;
	maxDependencies: number;
	maxMetadataBytes: number;
}

function admit(units: readonly ViewUnit[], limits: ViewUnitLimits): Map<string, ViewUnit> {
	if (
		!Number.isSafeInteger(limits.maxUnits) ||
		limits.maxUnits <= 0 ||
		!Number.isSafeInteger(limits.maxDependencies) ||
		limits.maxDependencies <= 0 ||
		!Number.isSafeInteger(limits.maxMetadataBytes) ||
		limits.maxMetadataBytes <= 0
	)
		throw new Error("Invalid view-unit limits");
	if (units.length > limits.maxUnits) throw new Error("View-unit item budget exceeded");
	const byId = new Map<string, ViewUnit>();
	let edges = 0;
	for (const unit of units) {
		if (byId.has(unit.id)) throw new Error("Duplicate view-unit identity");
		edges += unit.requiredVisibleDependencies.length + (unit.unavailableDependencies?.length ?? 0);
		if (edges > limits.maxDependencies) throw new Error("View-unit dependency budget exceeded");
		byId.set(unit.id, unit);
	}
	stringifyBoundedJson(units, limits.maxMetadataBytes);
	return byId;
}

/** Resolve the full closure, then restore source order. No partial prefix is returned. */
export function closeViewSelection(
	units: readonly ViewUnit[],
	selectedIds: readonly string[],
	limits: ViewUnitLimits,
): readonly ViewUnit[] {
	const byId = admit(units, limits);
	if (selectedIds.length > limits.maxUnits) throw new Error("View-unit selection budget exceeded");
	const selected = new Set<string>();
	const visit = (id: string): void => {
		const unit = byId.get(id);
		if (!unit) throw new Error("Required visible view unit is unavailable");
		if (unit.unavailableDependencies?.length) throw new Error("View-unit replay group is incomplete");
		selected.add(id);
	};
	for (const id of selectedIds) visit(id);
	// Set iteration includes newly inserted entries and handles mutual replay edges.
	for (const id of selected) for (const dependency of byId.get(id)!.requiredVisibleDependencies) visit(dependency);
	return units.filter((unit) => selected.has(unit.id));
}

/**
 * Link whole-message replay groups; no text, media, signature or raw field is rewritten.
 * The adapter must explicitly permit message grouping. Otherwise selection retains the
 * entire context, including unknown opaque/program/caller relationships.
 */
export function bindMessageReplayUnits(
	messages: readonly AgentMessage[],
	units: readonly ViewUnit[],
	limits: ViewUnitLimits,
	policy: "complete-context" | "message-groups" = "complete-context",
): readonly ViewUnit[] {
	admit(units, limits);
	if (messages.length !== units.length) throw new Error("View units do not match their messages");
	const edges = units.map((unit) => new Set(unit.requiredVisibleDependencies));
	const missing = units.map((unit) => new Set(unit.unavailableDependencies));
	let edgeCount = edges.reduce((count, values, index) => count + values.size + missing[index].size, 0);
	const add = (index: number, id: string) => {
		if (edges[index].has(id)) return;
		if (++edgeCount > limits.maxDependencies) throw new Error("View-unit dependency budget exceeded");
		edges[index].add(id);
	};
	const calls = new Map<string, { index: number; results: number }>();
	const closeCalls = () => {
		for (const [id, call] of calls)
			if (!call.results) {
				if (++edgeCount > limits.maxDependencies) throw new Error("View-unit dependency budget exceeded");
				missing[call.index].add(`tool-result:${id}`);
			}
		calls.clear();
	};
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message.role === "assistant") {
			closeCalls();
			for (const part of message.content)
				if (part.type === "toolCall") {
					if (calls.has(part.id)) throw new Error("Ambiguous tool call in a replay group");
					calls.set(part.id, { index, results: 0 });
				}
		} else if (message.role === "toolResult") {
			const call = calls.get(message.toolCallId);
			if (call) {
				add(index, units[call.index].id);
				add(call.index, units[index].id);
				call.results++;
			} else {
				if (++edgeCount > limits.maxDependencies) throw new Error("View-unit dependency budget exceeded");
				missing[index].add(`tool-call:${message.toolCallId}`);
			}
		}
	}
	closeCalls();
	if (policy === "complete-context" && units.length) {
		// A star gives whole-context closure without a quadratic dependency graph.
		for (let index = 1; index < units.length; index++) {
			add(0, units[index].id);
			add(index, units[0].id);
		}
	}
	const bound = units.map((unit, index) =>
		Object.freeze({
			...unit,
			exactSources: Object.freeze([...unit.exactSources]),
			requiredVisibleDependencies: Object.freeze([...edges[index]]),
			unavailableDependencies: Object.freeze([...missing[index]]),
		}),
	);
	admit(bound, limits);
	return bound;
}
