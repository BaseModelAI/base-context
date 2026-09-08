import type { AgentMessage } from "@ponythewhite/base-context-agent";
import {
	CONTEXT_EPOCH_DETAIL,
	CONTEXT_EPOCH_RENDERER,
	type ContextEpochCheckpoint,
	type EpochViewReference,
	readContextEpoch,
	snapshotContextEpoch,
} from "./context-epoch.js";
import type {
	ContextManifestCursor,
	ContextManifestPage,
	ContextRef,
	ContextUpdateRef,
	ContextUpdateTarget,
} from "./history-index.js";
import { createCompactionSummaryMessage } from "./messages.js";
import type { SourceSnapshotRef } from "./request-events.js";
import { orderContextToolResults, sessionEntryMessage } from "./session-context-messages.js";
import {
	appendSentAgentMessageToToolResult,
	parsePersistedIpythonSentAgentMessage,
} from "./session-context-updates.js";
import type { SessionHistoryReadView } from "./session-history-index.js";
import type { SessionEntry } from "./session-manager.js";
import { type CompiledTaskFrame, compileTaskFrame, type TaskFrameLimits, taskFrameLimits } from "./task-frame.js";
import { readTaskStateFromView } from "./task-state-reader.js";
import { cloneUsage } from "./usage.js";
import { bindMessageReplayUnits, closeViewSelection, type ViewUnit, type ViewUnitLimits } from "./view-units.js";

export interface CanonicalContextLimits {
	maxMessages: number;
	/** Canonical frame bytes, not a tokenizer or an estimate of JavaScript heap size. */
	maxSourceBytes: number;
}

interface CanonicalMessageSource {
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
	readonly entryId: string;
}

const messageSources = new WeakMap<AgentMessage, CanonicalMessageSource>();
export interface CanonicalViewSelectionSource {
	readonly source: SourceSnapshotRef;
	readonly units: readonly ViewUnit[];
	readonly limits: ViewUnitLimits;
}

const compiledViewUnits = new WeakMap<
	readonly AgentMessage[],
	{
		units: readonly ViewUnit[];
		selection: CanonicalViewSelectionSource;
	}
>();

/** Detached rendering metadata only; reading it never changes a compiler or epoch. */
export function getCanonicalViewUnits(messages: readonly AgentMessage[]): readonly ViewUnit[] | undefined {
	const units = compiledViewUnits.get(messages)?.units;
	return units ? structuredClone(units) : undefined;
}

/** Intrinsic dependencies for an explicitly supported native epoch boundary, never the default view policy. */
export function getCanonicalViewSelectionSource(
	messages: readonly AgentMessage[],
): CanonicalViewSelectionSource | undefined {
	const selection = compiledViewUnits.get(messages)?.selection;
	return selection ? structuredClone(selection) : undefined;
}

/** Correlate a detached compiled message with its captured source, without retaining its body. */
export function getCanonicalMessageSource(message: AgentMessage): CanonicalMessageSource | undefined {
	const source = messageSources.get(message);
	return source ? { ...source } : undefined;
}

interface CompiledEpochContext {
	readonly source: SourceSnapshotRef;
	readonly checkpoint?: ContextEpochCheckpoint;
	readonly taskFrame?: CompiledTaskFrame;
	readonly references: readonly (EpochViewReference | null)[];
}
const compiledEpochContexts = new WeakMap<readonly AgentMessage[], CompiledEpochContext>();

export function getCanonicalEpochContext(messages: readonly AgentMessage[]): CompiledEpochContext | undefined {
	const context = compiledEpochContexts.get(messages);
	return context ? structuredClone(context) : undefined;
}

/** A candidate only. The caller must ACK the canonical checkpoint before adoption or send. */
export function prepareCanonicalEpoch(
	messages: readonly AgentMessage[],
	selectedUnitIds: readonly string[],
	representation: string,
	maxBytes: number,
): { checkpoint: ContextEpochCheckpoint; messages: AgentMessage[] } {
	const context = compiledEpochContexts.get(messages);
	const units = getCanonicalViewUnits(messages);
	if (!context || !units || units.length !== messages.length || context.references.length !== messages.length)
		throw new Error("Context epoch requires its captured compiler output");
	const selected = new Set(selectedUnitIds);
	if (selected.size !== selectedUnitIds.length || [...selected].some((id) => !units.some((unit) => unit.id === id)))
		throw new Error("Context epoch selection has an unknown or repeated unit");
	const chosen: AgentMessage[] = [];
	const views: EpochViewReference[] = [];
	for (const [index, unit] of units.entries()) {
		if (!selected.has(unit.id)) {
			if (unit.kind === "task-frame") throw new Error("Context epoch cannot omit its task frame");
			continue;
		}
		chosen.push(messages[index]);
		const reference = context.references[index];
		if (reference) views.push(reference);
	}
	const tail = views.pop();
	if (!tail || tail.ref.kind === "compaction") throw new Error("Context epoch literal tail is unavailable");
	const lastLiteral = context.references.filter((ref) => ref !== null).at(-1);
	if (lastLiteral?.ref.entryId !== tail.ref.entryId)
		throw new Error("Context epoch cannot omit the current literal tail");
	return {
		checkpoint: snapshotContextEpoch(
			{
				version: 1,
				renderer: CONTEXT_EPOCH_RENDERER,
				source: context.source,
				representation,
				views,
				taskFrame: context.taskFrame,
				literalTailId: tail.ref.entryId,
			},
			maxBytes,
		),
		messages: chosen,
	};
}

interface CachedEntry {
	revision: string;
	entry: SessionEntry;
}

type KnownManifest = Extract<ContextManifestPage, { selection: "known" }>;

/** Exact active-context reconstruction. It never silently chooses a last-N transcript. */
export class CanonicalContextCompiler {
	private source?: SourceSnapshotRef;
	private entries = new Map<string, CachedEntry>();
	private sourceBytes = 0;
	private messageCount = 0;
	private taskFrame?: CompiledTaskFrame;
	private taskBoundary?: string;

	/** Membership in the last successful active-source cache, including explicitly omitted responses. */
	hasActiveEntry(entryId: string): boolean {
		return this.entries.has(entryId);
	}

	async compile(
		view: SessionHistoryReadView,
		limits: CanonicalContextLimits,
		omittedAssistantIds: ReadonlySet<string> = new Set(),
		frameOptions: Partial<TaskFrameLimits> = {},
	): Promise<AgentMessage[]> {
		const frameLimits = taskFrameLimits(frameOptions);
		const previousSource = this.source;
		const previousFrame = this.taskFrame;
		const previousBoundary = this.taskBoundary;
		const omitted = new Set(omittedAssistantIds);
		const { maxMessages, maxSourceBytes } = limits;
		if (
			!Number.isSafeInteger(maxMessages) ||
			maxMessages <= 0 ||
			!Number.isSafeInteger(maxSourceBytes) ||
			maxSourceBytes <= 0
		)
			throw new Error("Invalid canonical context limits");
		if (
			this.source?.sessionId !== view.source.sessionId ||
			this.source?.sessionFile !== view.source.sessionFile ||
			this.messageCount > maxMessages ||
			this.sourceBytes > maxSourceBytes
		) {
			this.entries.clear();
			this.sourceBytes = 0;
			this.messageCount = 0;
		}
		let first: KnownManifest | undefined;
		let cursor: ContextManifestCursor | undefined;
		let expected = 0;
		let sourceBytes = 0;
		const refs: ContextRef[] = [];
		const sourceOrder = new Map<string, number>();
		const countBytes = (ref: Pick<ContextRef, "locator">) => {
			sourceBytes += ref.locator.length;
			if (sourceBytes > maxSourceBytes) throw new Error("Canonical context source byte budget exceeded");
		};
		for (;;) {
			const page = await view.contextManifest({ cursor, limit: 128 });
			if (page.selection !== "known") throw new Error(`Canonical context selection is ${page.selection}`);
			if (!first) {
				first = page;
				if (page.activeMessageCount + (page.summaryRef ? 1 : 0) > maxMessages)
					throw new Error("Canonical context message budget exceeded");
				expected = page.activeBase + 1;
				if (page.summaryRef) countBytes(page.summaryRef);
			} else if (
				page.activeBase !== first.activeBase ||
				page.activeMessageCount !== first.activeMessageCount ||
				page.retainedMessageCount !== first.retainedMessageCount ||
				page.summaryRef?.entryId !== first.summaryRef?.entryId ||
				page.summaryRef?.revision !== first.summaryRef?.revision
			) {
				throw new Error("Canonical context manifest changed during its captured read");
			}
			for (const ref of page.refs) {
				if (ref.ordinal !== expected++) throw new Error("Canonical context manifest skipped an active message");
				countBytes(ref);
				refs.push(ref);
				sourceOrder.set(ref.entryId, ref.sequence);
			}
			if (!page.nextCursor) break;
			if (!page.refs.length || page.nextCursor.nextOrdinal !== expected)
				throw new Error("Canonical context manifest did not advance");
			cursor = page.nextCursor;
		}
		if (refs.length !== first.activeMessageCount) throw new Error("Canonical context manifest is incomplete");

		const next = new Map<string, CachedEntry>();
		const hydrate = async (
			ref: ContextRef | ContextUpdateRef,
			target?: ContextUpdateTarget,
			readView: SessionHistoryReadView = view,
		): Promise<SessionEntry> => {
			const cached = this.entries.get(ref.entryId);
			if (cached?.revision === ref.revision) {
				next.set(ref.entryId, cached);
				return cached.entry;
			}
			const fragments: string[] = [];
			let offset = 0;
			let part = target
				? await readView.readContextUpdatePayload(ref.entryId, target)
				: await readView.readPayload(ref.entryId);
			for (;;) {
				if (!part || part.byteOffset !== offset || part.byteLength <= 0)
					throw new Error("Canonical context payload is unavailable or incomplete");
				offset += part.byteLength;
				if (offset > ref.locator.length) throw new Error("Canonical context payload exceeds its source locator");
				fragments.push(part.text);
				if (!part.nextCursor) break;
				part = target
					? await readView.readContextUpdatePayload(ref.entryId, target, { cursor: part.nextCursor })
					: await readView.readPayload(ref.entryId, { cursor: part.nextCursor });
			}
			const value: unknown = JSON.parse(fragments.join(""));
			if (
				!value ||
				typeof value !== "object" ||
				!("id" in value) ||
				value.id !== ref.entryId ||
				!("type" in value) ||
				value.type !== ref.kind
			)
				throw new Error("Canonical context payload does not match its source reference");
			const entry = value as SessionEntry;
			next.set(ref.entryId, { revision: ref.revision, entry });
			return entry;
		};
		let checkpoint: ContextEpochCheckpoint | undefined;
		let summaryEntry: SessionEntry | undefined;
		if (first.summaryRef) {
			summaryEntry = await hydrate(first.summaryRef);
			if (summaryEntry.type !== "compaction") throw new Error("Canonical context summary has the wrong source kind");
			if (
				summaryEntry.details &&
				typeof summaryEntry.details === "object" &&
				CONTEXT_EPOCH_DETAIL in summaryEntry.details
			) {
				const source = await view.get(first.summaryRef.entryId);
				if (source?.qualification !== "native-context-epoch" || source.retention === "retained-import")
					throw new Error("Context epoch checkpoint is not qualified on this source");
				checkpoint = readContextEpoch(summaryEntry.details, maxSourceBytes);
				if (
					!checkpoint ||
					checkpoint.literalTailId !== summaryEntry.firstKeptEntryId ||
					checkpoint.views.length + first.activeMessageCount > maxMessages
				)
					throw new Error("Context epoch checkpoint does not match its retained boundary");
			}
		}
		const boundary = JSON.stringify([first.summaryRef?.entryId ?? null, first.summaryRef?.revision ?? null]);
		let resetFrame =
			previousSource?.sessionId !== view.source.sessionId ||
			previousSource?.sessionFile !== view.source.sessionFile ||
			previousBoundary !== boundary ||
			(previousSource !== undefined && previousSource.sourceSequence > view.source.sourceSequence);
		if (!resetFrame && previousFrame && previousSource?.leafId && previousSource.leafId !== view.source.leafId)
			resetFrame = !(await view.get(previousSource.leafId));
		const tasks = await readTaskStateFromView(view, {
			maxItems: maxMessages,
			maxSourceBytes,
			maxViewBytes: maxSourceBytes,
		});
		let taskSequence = -1;
		for (const { event } of tasks.items) {
			if (event.source.sequence === taskSequence) continue;
			taskSequence = event.source.sequence;
			// The task reader has already required an exact locator for every represented frame.
			countBytes({ locator: event.source.locator! });
		}
		const referenceFrame = resetFrame ? checkpoint?.taskFrame : previousFrame;
		let taskFrame = compileTaskFrame(tasks, frameLimits, referenceFrame);
		const messageCount =
			first.activeMessageCount +
			(checkpoint?.views.length ?? (first.summaryRef ? 1 : 0)) +
			(taskFrame?.messages.length ?? 0);
		if (messageCount > maxMessages) throw new Error("Canonical context message budget exceeded");

		const messages: AgentMessage[] = [];
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
		if (first.summaryRef && !checkpoint) await addSummary(first.summaryRef, view, first.retainedMessageCount);
		const addLiteral = async (ref: ContextRef, readView: SessionHistoryReadView, pinned?: EpochViewReference) => {
			const original = sessionEntryMessage(await hydrate(ref, undefined, readView));
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
			if (message.role === "assistant")
				messageSources.set(message, {
					sessionId: view.source.sessionId,
					sessionFile: view.source.sessionFile,
					entryId: ref.entryId,
				});
			messages.push(message);
			literalSources.set(message, ref.entryId);
			unitSources.set(message, {
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
				sourceRevision: JSON.stringify(revisions),
				exactSources,
			});
			const revision = JSON.stringify(revisions);
			if (pinned && pinned.sourceRevision !== revision)
				throw new Error("Context epoch view no longer matches its frozen source revisions");
			if (pinned && unitSources.get(message)!.kind !== "recovery")
				unitSources.set(message, { ...unitSources.get(message)!, kind: "fixed-view" });
			epochReferences.set(message, { source: readView.source, ref, sourceRevision: revision });
			sourceOrder.set(ref.entryId, ref.sequence);
		};
		if (checkpoint) {
			if (!view.atSnapshot) throw new Error("Context epoch requires a captured native prefix reader");
			const prefixViews = new Map<string, SessionHistoryReadView>();
			const seen = new Set<string>();
			for (const pinned of checkpoint.views) {
				if (seen.has(pinned.ref.entryId) || refs.some((ref) => ref.entryId === pinned.ref.entryId))
					throw new Error("Context epoch view overlaps its literal tail");
				seen.add(pinned.ref.entryId);
				countBytes(pinned.ref);
				const key = JSON.stringify(pinned.source);
				let prefix = prefixViews.get(key);
				if (!prefix) {
					prefix = await view.atSnapshot(pinned.source);
					prefixViews.set(key, prefix);
				}
				const actual = await prefix.get(pinned.ref.entryId);
				if (
					!actual ||
					actual.revision !== pinned.ref.revision ||
					actual.kind !== pinned.ref.kind ||
					actual.sequence !== pinned.ref.sequence ||
					JSON.stringify(actual.locator) !== JSON.stringify(pinned.ref.locator)
				)
					throw new Error("Context epoch view source is unavailable");
				if (pinned.ref.kind === "compaction") {
					if (pinned.retainedMessageCount === undefined)
						throw new Error("Context epoch summary count is unavailable");
					await addSummary(pinned.ref, prefix, pinned.retainedMessageCount);
				} else await addLiteral(pinned.ref, prefix, pinned);
			}
		}
		for (const ref of refs) await addLiteral(ref, view);
		orderContextToolResults(messages);
		if (taskFrame) {
			if (referenceFrame && taskFrame !== referenceFrame) {
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
		}
		const unitLimits = {
			maxUnits: maxMessages,
			maxDependencies: Math.min(Number.MAX_SAFE_INTEGER, maxMessages * 4),
			maxMetadataBytes: maxSourceBytes,
		};
		const sourceUnits = messages.map((message) => {
			const unit = unitSources.get(message);
			if (!unit) throw new Error("Compiled view unit has no captured source");
			return unit;
		});
		const units = bindMessageReplayUnits(messages, sourceUnits, unitLimits);
		// Keep the full context, but refuse incomplete replay before returning provider-bound messages.
		const closedUnits = closeViewSelection(
			units,
			units.map((unit) => unit.id),
			unitLimits,
		);
		const messagesByUnit = new Map(units.map((unit, index) => [unit.id, messages[index]]));
		const closedMessages = closedUnits.map((unit) => messagesByUnit.get(unit.id)!);
		compiledViewUnits.set(closedMessages, {
			units: closedUnits,
			selection: { source: { ...view.source }, units: sourceUnits, limits: unitLimits },
		});
		compiledEpochContexts.set(closedMessages, {
			source: { ...view.source },
			checkpoint,
			taskFrame,
			references: closedMessages.map((message) => epochReferences.get(message) ?? null),
		});
		this.entries = next;
		this.taskFrame = taskFrame;
		this.taskBoundary = boundary;
		this.source = view.source;
		this.sourceBytes = sourceBytes;
		this.messageCount = messageCount;
		return closedMessages;
	}
}
