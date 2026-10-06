import type { AgentMessage } from "@ponythewhite/base-context-agent";
import type { canonicalEntryReader } from "./canonical-context-source.js";
import type { ContextEpochCheckpoint, EpochViewReference } from "./context-epoch.js";
import type { ContextRef, ContextUpdateTarget } from "./history-index.js";
import { createCompactionSummaryMessage } from "./messages.js";
import { PUBLIC_CONTEXT_RENDERER, renderPublicHistory } from "./public-context.js";
import { isNativeSkillSelection, type SelectedSkillReference, selectedSkillCapture } from "./selected-skills.js";
import { sessionEntryMessage } from "./session-context-messages.js";
import {
	appendSentAgentMessageToToolResult,
	parsePersistedIpythonSentAgentMessage,
} from "./session-context-updates.js";
import { hydrateCapturedHistoryEntry, type SessionHistoryReadView } from "./session-history-index.js";
import { cloneUsage } from "./usage.js";
import type { ViewUnit } from "./view-units.js";

export interface CanonicalMessageSource {
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
	readonly entryId: string;
}

export const messageSources = new WeakMap<AgentMessage, CanonicalMessageSource>();

/** Hydrate literal source records, apply canonical updates, then preserve their rendering metadata. */
export function canonicalMessageRenderer(
	view: SessionHistoryReadView,
	hydrate: ReturnType<typeof canonicalEntryReader>["hydrate"],
	countBytes: (ref: Pick<ContextRef, "locator">) => void,
	sourceOrder: Map<string, number>,
	selectedSkills: Map<string, SelectedSkillReference>,
	omitted: ReadonlySet<string>,
	maxSourceBytes: number,
	checkpoint?: ContextEpochCheckpoint,
) {
	const toolSourceIds = new Set(
		checkpoint?.toolContinuations?.flatMap((group) => [
			group.assistantEntryId,
			...group.calls.flatMap((call) => (call.result ? [call.result.id] : [])),
		]),
	);
	const publicTail = checkpoint?.continuation?.publicTailThrough;
	let publicBytes = 0;
	const messages: AgentMessage[] = [];
	const renderedMessages = new Map<AgentMessage, AgentMessage>();
	const literalSources = new Map<AgentMessage, string>();
	const unitSources = new Map<AgentMessage, ViewUnit>();
	const epochReferences = new Map<AgentMessage, EpochViewReference>();
	const sourceUnit = (ref: ContextRef, kind: ViewUnit["kind"]): ViewUnit => ({
		id: JSON.stringify([view.source.sessionId, view.source.sessionFile, ref.entryId]),
		sourceRevision: ref.revision,
		kind,
		exactSources: [ref.entryId],
		requiredVisibleDependencies: [],
		authority:
			kind === "recovery"
				? "tool-data"
				: ref.authority === "user"
					? "user"
					: ref.authority === "assistant"
						? "assistant-public"
						: ref.authority === "runtime"
							? "tool-data"
							: "unrecorded",
		tokenEstimate: null,
		immutableWithinEpoch: true,
	});
	const addSummary = async (ref: ContextRef, readView: SessionHistoryReadView, retainedMessageCount: number) => {
		const summary = await hydrate(ref, undefined, readView);
		if (summary.type !== "compaction") throw new Error("Canonical context summary has the wrong source kind");
		const message = createCompactionSummaryMessage(
			summary.summary,
			summary.tokensBefore,
			summary.timestamp,
			summary.customInstructions,
			retainedMessageCount,
		);
		messages.push(message);
		literalSources.set(message, ref.entryId);
		unitSources.set(message, sourceUnit(ref, "fixed-view"));
		epochReferences.set(message, {
			source: readView.source,
			ref,
			sourceRevision: ref.revision,
			retainedMessageCount,
		});
		sourceOrder.set(ref.entryId, -1);
	};
	const addLiteral = async (ref: ContextRef, readView: SessionHistoryReadView, pinned?: EpochViewReference) => {
		const entry = await hydrate(ref, undefined, readView);
		// Internal capture records never interrupt a native assistant/tool-result group.
		// Retained records remain recoverable data, but cannot mint a new selection.
		const skill = ref.qualification === "native-recovery" ? selectedSkillCapture(entry) : undefined;
		if (skill) {
			if (
				skill.producer === "model" &&
				isNativeSkillSelection(ref) &&
				(!checkpoint || ref.sequence > checkpoint.source.sourceSequence)
			) {
				selectedSkills.set(skill.descriptor.name, {
					name: skill.descriptor.name,
					view: {
						source: view.source,
						ref: { ...ref, kind: "custom_message" },
						sourceRevision: JSON.stringify([ref.revision]),
					},
				});
			}
			return;
		}
		const origin = entry.type === "message" || entry.type === "custom_message" ? entry.nativeOrigin : undefined;
		if (
			ref.qualification === "native-admission" &&
			ref.retention !== "retained-import" &&
			origin?.kind === "input" &&
			origin.recordRole === "primary" &&
			origin.selectedSkillRef &&
			(!checkpoint || ref.sequence > checkpoint.source.sourceSequence) &&
			![...selectedSkills.values()].some((skill) => skill.view.ref.entryId === origin.selectedSkillRef?.entryId)
		) {
			if (
				origin.selectedSkillRef.sessionId !== view.source.sessionId ||
				origin.selectedSkillRef.sessionFile !== view.source.sessionFile
			)
				throw new Error("Admitted skill selection belongs to another source");
			const actual = await view.get(origin.selectedSkillRef.entryId);
			if (
				!actual ||
				(actual.kind !== "custom" && actual.kind !== "custom_message") ||
				actual.qualification !== "native-recovery"
			)
				throw new Error("Admitted input selected skill source is unavailable");
			countBytes(actual);
			const captured = await hydrateCapturedHistoryEntry(actual, actual.locator.length, view.readPayload);
			const selected = captured ? selectedSkillCapture(captured.entry) : undefined;
			if (!selected) throw new Error("Admitted input has no captured skill version");
			selectedSkills.set(selected.descriptor.name, {
				name: selected.descriptor.name,
				view: {
					source: view.source,
					sourceRevision: JSON.stringify([actual.revision]),
					ref: {
						entryId: actual.id,
						sequence: actual.sequence,
						kind: actual.kind,
						locator: actual.locator,
						revision: actual.revision,
						authority: actual.authority,
						qualification: actual.qualification,
						retention: actual.retention,
					},
				},
			});
		}
		const original = sessionEntryMessage(entry);
		if (!original) throw new Error("Canonical context reference is not a visible context entry");
		// These IDs come from actual native retry controls, not inferred transcript membership or stop reasons.
		if (original.role === "assistant" && omitted.has(ref.entryId)) return;
		// Neither canonical updates nor replaceable transforms may mutate cached source entries.
		const message = structuredClone(original);
		const revisions = [ref.revision];
		const exactSources = [ref.entryId];
		if (message.role === "assistant") {
			const target: ContextUpdateTarget = { kind: "assistant-usage", targetId: ref.entryId };
			for (const update of (await readView.contextUpdates(target)).refs) {
				countBytes(update);
				const entry = await hydrate(update, target, readView);
				revisions.push(update.revision);
				exactSources.push(update.entryId);
				if (entry.type !== "child_usage_attributed") throw new Error("Canonical usage update kind mismatch");
				message.usage = cloneUsage(entry.aggregateUsage);
			}
		} else if (message.role === "toolResult" && message.toolName === "ipython") {
			const target: ContextUpdateTarget = { kind: "ipython-sent-message", toolCallId: message.toolCallId };
			for (const update of (await readView.contextUpdates(target)).refs) {
				countBytes(update); // Charge each application, even when the source record is cached.
				const entry = await hydrate(update, target, readView);
				revisions.push(update.revision);
				exactSources.push(update.entryId);
				const sent = entry.type === "custom" ? parsePersistedIpythonSentAgentMessage(entry.data) : undefined;
				if (!sent || sent.toolCallId !== message.toolCallId)
					throw new Error("Canonical sent-message update mismatch");
				appendSentAgentMessageToToolResult(message, message.toolCallId, sent.message);
			}
		}
		const publicHistory =
			!toolSourceIds.has(ref.entryId) &&
			(pinned?.rendering === PUBLIC_CONTEXT_RENDERER ||
				(!pinned && publicTail !== undefined && ref.sequence <= publicTail.sourceSequence));
		const rendered = publicHistory ? renderPublicHistory(message, ref.entryId, maxSourceBytes) : message;
		if (publicHistory) {
			publicBytes += Buffer.byteLength(JSON.stringify(rendered), "utf8");
			if (publicBytes > maxSourceBytes) throw new Error("Public summary view byte budget exceeded");
		}
		if (message.role === "assistant")
			messageSources.set(rendered, {
				sessionId: view.source.sessionId,
				sessionFile: view.source.sessionFile,
				entryId: ref.entryId,
			});
		messages.push(message);
		renderedMessages.set(message, rendered);
		literalSources.set(rendered, ref.entryId);
		unitSources.set(rendered, {
			...sourceUnit(
				ref,
				message.role === "toolResult" &&
					ref.qualification === "native-recovery" &&
					ref.retention !== "retained-import"
					? "recovery"
					: message.role === "toolResult" ||
							(message.role === "assistant" && message.content.some((part) => part.type === "toolCall"))
						? "replay-group"
						: "literal",
			),
			sourceRevision: JSON.stringify(rendered !== message ? [...revisions, PUBLIC_CONTEXT_RENDERER] : revisions),
			exactSources,
		});
		const revision = JSON.stringify(revisions);
		if (pinned && pinned.sourceRevision !== revision)
			throw new Error("Context epoch view no longer matches its frozen source revisions");
		if (pinned && unitSources.get(rendered)!.kind !== "recovery")
			unitSources.set(rendered, { ...unitSources.get(rendered)!, kind: "fixed-view" });
		epochReferences.set(rendered, {
			source: readView.source,
			ref,
			sourceRevision: revision,
			...(rendered !== message ? { rendering: PUBLIC_CONTEXT_RENDERER } : {}),
		});
		sourceOrder.set(ref.entryId, ref.sequence);
	};
	return { messages, renderedMessages, literalSources, unitSources, epochReferences, addSummary, addLiteral };
}
