import type { AgentMessage } from "@ponythewhite/base-context-agent";
import { createCustomMessage } from "./messages.js";
import type { SelectedSkillReference } from "./selected-skills.js";
import type { SessionHistoryReadView } from "./session-history-index.js";
import type { CompiledTaskFrame } from "./task-frame.js";
import type { ViewUnit } from "./view-units.js";

/** Keep existing sparse revisions in their original source slots, including after retry omissions. */
export async function insertTaskFrame(
	taskFrame: CompiledTaskFrame,
	referenceFrame: CompiledTaskFrame | undefined,
	taskFrameRebased: boolean,
	messages: AgentMessage[],
	literalSources: ReadonlyMap<AgentMessage, string>,
	unitSources: Map<AgentMessage, ViewUnit>,
	sourceOrder: Map<string, number>,
	view: SessionHistoryReadView,
): Promise<CompiledTaskFrame> {
	if (referenceFrame && taskFrame !== referenceFrame && !taskFrameRebased) {
		const last = messages.at(-1);
		const anchor = last
			? {
					entryId: literalSources.get(last)!,
					side: last.role === "user" || last.role === "custom" ? ("before" as const) : ("after" as const),
				}
			: null;
		taskFrame = { ...taskFrame, anchors: [...taskFrame.anchors.slice(0, -1), anchor] };
	}
	const [base, ...revisions] = structuredClone(taskFrame.messages);
	const frames = [base, ...revisions];
	const frameIds = frames.map((_, index) => JSON.stringify(["task-frame", taskFrame!.origins[index], index]));
	for (const [index, frame] of frames.entries()) {
		unitSources.set(frame, {
			id: frameIds[index],
			sourceRevision: frameIds[index],
			kind: "task-frame",
			exactSources: [JSON.stringify(taskFrame.origins[index])],
			requiredVisibleDependencies: index ? [frameIds[index - 1]] : [],
			authority: "tool-data",
			tokenEstimate: null,
			immutableWithinEpoch: true,
		});
	}
	for (const anchor of taskFrame.anchors) {
		if (!anchor || sourceOrder.has(anchor.entryId)) continue;
		const origin = await view.get(anchor.entryId);
		if (!origin) throw new Error("Task frame insertion source is unavailable");
		sourceOrder.set(anchor.entryId, origin.sequence);
	}
	const positions = new Map(messages.map((message, index) => [literalSources.get(message)!, index]));
	const slots = new Map<number, AgentMessage[]>();
	for (const [index, revision] of revisions.entries()) {
		const anchor = taskFrame.anchors[index];
		let at = 0;
		if (anchor) {
			const position = positions.get(anchor.entryId);
			if (position !== undefined) at = position + (anchor.side === "after" ? 1 : 0);
			else {
				// A later retry may omit that assistant. Keep its source slot, not the newest input slot.
				const ordinal = sourceOrder.get(anchor.entryId);
				if (ordinal === undefined) throw new Error("Task frame insertion source is unavailable");
				at = messages.findIndex((message) => sourceOrder.get(literalSources.get(message)!)! > ordinal);
				if (at < 0) at = messages.length;
			}
		}
		const group = slots.get(at) ?? [];
		group.push(revision);
		slots.set(at, group);
	}
	const literal = messages.splice(0);
	messages.push(base);
	for (let at = 0; at <= literal.length; at++) {
		messages.push(...(slots.get(at) ?? []));
		if (at < literal.length) messages.push(literal[at]);
	}
	return taskFrame;
}

/** Selected versions are source references, not another copy of the skill text. */
export function insertSelectedSkills(
	selectedSkills: ReadonlyMap<string, SelectedSkillReference>,
	messages: AgentMessage[],
	unitSources: Map<AgentMessage, ViewUnit>,
): void {
	if (!selectedSkills.size) return;
	const selections = [...selectedSkills.values()];
	const content = `Selected Skill versions (canonical source references):\n${JSON.stringify(
		selections.map((skill) => ({
			name: skill.name,
			ref: skill.view.ref.entryId,
			revision: skill.view.ref.revision,
			sourceSessionId: skill.view.source.sessionId,
		})),
	)}`;
	const message = createCustomMessage(
		"base-context-selected-skill-versions",
		content,
		false,
		undefined,
		"1970-01-01T00:00:00.000Z",
	);
	messages.unshift(message);
	unitSources.set(message, {
		id: "native-selected-skill-versions",
		sourceRevision: JSON.stringify(selections),
		kind: "literal",
		exactSources: selections.map((skill) => skill.view.ref.entryId),
		requiredVisibleDependencies: [],
		authority: "tool-data",
		tokenEstimate: null,
		immutableWithinEpoch: true,
	});
}
