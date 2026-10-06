import type { AgentMessage } from "@ponythewhite/base-context-agent";
import { stringifyBoundedJson } from "./bounded-json.js";
import type { CachedContextEntry } from "./canonical-context-source.js";
import {
	CONTEXT_INTERRUPTED_TOOL_RENDERER,
	type ContextEpochCheckpoint,
	type ContextMode,
	type EpochViewReference,
	type ToolContinuationGroup,
} from "./context-epoch.js";
import type { ContextRef, IndexedSourceEvent } from "./history-index.js";
import { PUBLIC_TOOL_CONTINUATION_RENDERER } from "./public-context.js";
import type { SourceSnapshotRef } from "./request-events.js";
import { hydrateCapturedHistoryEntry, type SessionHistoryReadView } from "./session-history-index.js";
import type { ViewUnit } from "./view-units.js";

/** Reconstruct whole interrupted tool groups from their existing captured intent and outcome records. */
export async function collectToolContinuations(
	view: SessionHistoryReadView,
	messages: readonly AgentMessage[],
	replayUnits: readonly ViewUnit[],
	epochReferences: ReadonlyMap<AgentMessage, EpochViewReference>,
	next: ReadonlyMap<string, CachedContextEntry>,
	countBytes: (ref: Pick<ContextRef, "locator">) => void,
	maxMessages: number,
	maxSourceBytes: number,
	checkpoint: ContextEpochCheckpoint | undefined,
	mode: ContextMode,
	allowPendingToolPublic: boolean,
	purpose: "request" | "read",
) {
	const frozenGroups = checkpoint?.toolContinuations ?? [];
	const assistantSequences = messages
		.flatMap((message) => {
			const reference = epochReferences.get(message);
			return message.role === "assistant" && reference ? [reference.ref.sequence] : [];
		})
		.sort((left, right) => left - right);
	const candidates = messages.flatMap((message, index) => {
		if (message.role !== "assistant") return [];
		const reference = epochReferences.get(message);
		const prior = frozenGroups.find((group) => group.assistantEntryId === reference?.ref.entryId);
		if (!prior && !replayUnits[index].unavailableDependencies?.some((id) => id.startsWith("tool-result:"))) return [];
		if (!reference || reference.ref.retention === "retained-import")
			throw new Error("Tool continuation requires its original assistant source");
		return [
			{
				message,
				index,
				reference,
				prior,
				nextAssistantSequence: assistantSequences.find((sequence) => sequence > reference.ref.sequence) ?? Infinity,
				unqualifiedIntent: false,
				intents: new Map<number, Awaited<ReturnType<typeof hydrateCapturedHistoryEntry>>>(),
			},
		];
	});
	if (frozenGroups.length !== candidates.filter((candidate) => candidate.prior).length)
		throw new Error("Committed tool continuation lost its original group");
	if (purpose === "request" && candidates.length && (!allowPendingToolPublic || mode === "off"))
		throw new Error("Tool continuation requires an enabled native public request boundary");
	const readToolEvidence = async (metadata: IndexedSourceEvent) => {
		const cached = next.get(metadata.id);
		if (cached?.revision === metadata.revision) return { entry: cached.entry, source: metadata };
		countBytes(metadata);
		return hydrateCapturedHistoryEntry(metadata, maxSourceBytes, view.readPayload);
	};
	const acceptIntent = async (metadata: IndexedSourceEvent, selected = candidates) => {
		if (metadata.kind !== "tool_intent") return;
		const hydrated = await readToolEvidence(metadata);
		const entry = hydrated.entry;
		if (entry.type !== "tool_intent") return;
		const invocation = entry.invocation;
		const ownerMatch = selected.find((item) => item.reference.ref.entryId === entry.assistant?.entryId);
		const candidate =
			ownerMatch ??
			selected.find(
				(item) =>
					metadata.sequence > item.reference.ref.sequence &&
					metadata.sequence < item.nextAssistantSequence &&
					item.message.content.some(
						(part) =>
							part.type === "toolCall" && part.id === invocation.toolCallId && part.name === invocation.toolName,
					),
			);
		if (!candidate) return;
		// A present but unqualified/copied intent is not an absence of admission.
		if (
			metadata.qualification !== "native-tool-execution" ||
			metadata.retention === "retained-import" ||
			entry.assistant?.sessionId !== view.source.sessionId ||
			entry.assistant.sessionFile !== view.source.sessionFile ||
			entry.assistant.entryId !== candidate.reference.ref.entryId
		) {
			candidate.unqualifiedIntent = true;
			return;
		}
		const call = candidate.message.content.filter((part) => part.type === "toolCall")[invocation.sourceOrder];
		if (
			!Number.isSafeInteger(invocation.sourceOrder) ||
			!call ||
			call.id !== invocation.toolCallId ||
			call.name !== invocation.toolName ||
			!invocation.executionId ||
			entry.id !== `${invocation.executionId}:intent` ||
			metadata.sequence <= candidate.reference.ref.sequence ||
			candidate.intents.has(invocation.sourceOrder)
		)
			throw new Error("Tool continuation has ambiguous original intent");
		candidate.intents.set(invocation.sourceOrder, hydrated);
	};
	const absentPrefixes = new Map<string, { source: SourceSnapshotRef; candidates: typeof candidates }>();
	for (const candidate of candidates) {
		if (!candidate.prior) continue;
		if (!Array.isArray(candidate.prior.calls)) throw new Error("Invalid committed tool continuation");
		for (const call of candidate.prior.calls) {
			if (call.admission === "absent") {
				if (
					checkpoint?.renderer !== CONTEXT_INTERRUPTED_TOOL_RENDERER ||
					!call.source ||
					call.source.sourceSequence < candidate.reference.ref.sequence ||
					call.intent !== undefined ||
					call.executionId !== undefined ||
					call.outcome !== undefined ||
					call.result !== undefined
				)
					throw new Error("Invalid committed absent tool admission");
				const key = JSON.stringify(call.source);
				const prefix = absentPrefixes.get(key) ?? { source: call.source, candidates: [] as typeof candidates };
				if (!prefix.candidates.includes(candidate)) prefix.candidates.push(candidate);
				absentPrefixes.set(key, prefix);
				continue;
			}
			const actual = await view.get(call.intent.id);
			if (!actual || actual.revision !== call.intent.revision || actual.sequence !== call.intent.sequence)
				throw new Error("Committed tool intent is unavailable on this captured branch");
			await acceptIntent(actual, [candidate]);
		}
	}
	const scanIntents = async (readView: SessionHistoryReadView, selected: typeof candidates) => {
		let after = Math.min(...selected.map((candidate) => candidate.reference.ref.sequence));
		let scanned = 0;
		for (;;) {
			const page = await readView.page(after, Math.min(128, maxMessages - scanned + 1));
			scanned += page.events.length;
			if (scanned > maxMessages) throw new Error("Tool continuation source item budget exceeded");
			if (page.coverage !== "complete") throw new Error("Tool continuation source coverage is incomplete");
			for (const metadata of page.events) {
				// Frozen qualified refs were already checked exactly, not another execution.
				if (
					!selected.some((candidate) =>
						[...candidate.intents.values()].some((intent) => intent.source.id === metadata.id),
					)
				)
					await acceptIntent(metadata, selected);
			}
			if (page.nextAfter === null) break;
			if (page.nextAfter <= after) throw new Error("Tool continuation source page did not advance");
			after = page.nextAfter;
		}
	};
	const newGroups = candidates.filter((candidate) => !candidate.prior);
	if (newGroups.length) await scanIntents(view, newGroups);
	for (const prefix of absentPrefixes.values()) {
		if (!view.atSnapshot) throw new Error("Absent tool admission requires its captured source");
		await scanIntents(await view.atSnapshot(prefix.source), prefix.candidates);
	}
	const checkAbsentScope = async (candidate: (typeof candidates)[number]) => {
		const entry = next.get(candidate.reference.ref.entryId)?.entry;
		const output = entry?.type === "message" ? entry.requestOutput : undefined;
		// This correlation limits the public-history scope. It never qualifies a tool owner or outcome.
		if (
			!output ||
			typeof output.operationId !== "string" ||
			!output.operationId ||
			!Array.isArray(output.attemptIds) ||
			output.attemptIds.some((id) => typeof id !== "string") ||
			!output.source ||
			output.source.sessionId !== view.source.sessionId ||
			output.source.sessionFile !== view.source.sessionFile ||
			!output.source.persistent ||
			!Number.isSafeInteger(output.source.sourceSequence) ||
			output.source.sourceSequence >= candidate.reference.ref.sequence ||
			!view.atSnapshot
		)
			throw new Error("View-unit replay group is incomplete: original tool owner is unqualified");
		await view.atSnapshot(output.source);
	};
	const toolContinuations: ToolContinuationGroup[] = [];
	const pendingPublicMessageGroups: number[][] = [];
	for (const candidate of candidates) {
		const toolCalls = candidate.message.content.filter((part) => part.type === "toolCall");
		if (
			!toolCalls.length ||
			candidate.unqualifiedIntent ||
			(candidate.prior && candidate.prior.calls.length !== toolCalls.length)
		)
			throw new Error("View-unit replay group is incomplete: original tool owner is unqualified");
		if (candidate.intents.size !== toolCalls.length) await checkAbsentScope(candidate);
		const members = [candidate.index];
		const calls: ToolContinuationGroup["calls"][number][] = [];
		for (let order = 0; order < toolCalls.length; order++) {
			const intent = candidate.intents.get(order);
			const original = candidate.prior?.calls[order];
			if (!intent) {
				if (original && original.admission !== "absent")
					throw new Error("Committed tool intent is unavailable on this captured branch");
				if (
					messages.some((message) => {
						const sequence = epochReferences.get(message)?.ref.sequence;
						return (
							message.role === "toolResult" &&
							message.toolCallId === toolCalls[order].id &&
							sequence !== undefined &&
							sequence > candidate.reference.ref.sequence &&
							sequence < candidate.nextAssistantSequence
						);
					})
				)
					throw new Error("Tool outcome lacks its original finalized owner");
				calls.push(original ?? { admission: "absent", source: { ...view.source } });
				continue;
			}
			if (original?.admission === "absent") throw new Error("Committed absent tool admission changed");
			if (intent.entry.type !== "tool_intent") throw new Error("Invalid native tool intent");
			const invocation = intent.entry.invocation;
			if (original && (original.executionId !== invocation.executionId || original.intent.id !== intent.source.id))
				throw new Error("Committed tool execution identity changed");
			const actual = await view.get(invocation.executionId);
			let outcome: Exclude<ToolContinuationGroup["calls"][number]["outcome"], undefined> = "outcome_unknown";
			if (actual) {
				if (
					actual.kind !== "message" ||
					actual.retention === "retained-import" ||
					(actual.qualification !== "native-tool-execution" && actual.qualification !== "native-recovery") ||
					actual.sequence <= intent.source.sequence
				)
					throw new Error("Tool outcome lacks its original finalized owner");
				const { entry } = await readToolEvidence(actual);
				if (
					entry.type !== "message" ||
					entry.message.role !== "toolResult" ||
					entry.execution?.executionId !== invocation.executionId ||
					!("invocationId" in entry.execution) ||
					entry.execution.invocationId !== intent.source.id ||
					entry.execution.sourceOrder !== order ||
					entry.execution.toolCallId !== invocation.toolCallId ||
					entry.execution.toolName !== invocation.toolName ||
					entry.message.toolCallId !== invocation.toolCallId ||
					entry.message.toolName !== invocation.toolName ||
					!["not_started", "completed", "failed", "outcome_unknown"].includes(entry.execution.executionOutcome)
				)
					throw new Error("Tool outcome does not match its original captured intent");
				outcome = entry.execution.executionOutcome;
				const index = messages.findIndex((message) => {
					const ref = epochReferences.get(message)?.ref;
					return ref?.entryId === actual.id && ref.revision === actual.revision;
				});
				if (index <= candidate.index)
					throw new Error("Finalized tool outcome is absent from its whole public group");
				members.push(index);
			}
			if (
				original?.result &&
				(!actual ||
					original.result.id !== actual.id ||
					original.result.sequence !== actual.sequence ||
					original.result.revision !== actual.revision)
			)
				throw new Error("Committed finalized tool outcome is unavailable on this captured branch");
			calls.push({
				executionId: invocation.executionId,
				intent: { id: intent.source.id, sequence: intent.source.sequence, revision: intent.source.revision },
				outcome,
				...(actual ? { result: { id: actual.id, sequence: actual.sequence, revision: actual.revision } } : {}),
			});
		}
		// Older summaries can retain an absent-call plan for a failed, provider-filtered reply.
		// Validate its captured absence above, but keep that reply only in canonical history.
		if (
			(candidate.message.stopReason === "error" || candidate.message.stopReason === "aborted") &&
			calls.every((call) => call.admission === "absent")
		)
			continue;
		toolContinuations.push({ assistantEntryId: candidate.reference.ref.entryId, calls });
		pendingPublicMessageGroups.push(members.sort((left, right) => left - right));
	}
	const publicSourceIds = new Set(
		pendingPublicMessageGroups.flatMap((group) =>
			group.map((index) => epochReferences.get(messages[index])!.ref.entryId),
		),
	);
	if (
		checkpoint?.views.some(
			(pinned) => pinned.rendering === PUBLIC_TOOL_CONTINUATION_RENDERER && !publicSourceIds.has(pinned.ref.entryId),
		)
	)
		throw new Error("Committed tool rendering has no matching whole-group recipe");
	stringifyBoundedJson(toolContinuations, maxSourceBytes);
	return { toolContinuations, pendingPublicMessageGroups };
}
