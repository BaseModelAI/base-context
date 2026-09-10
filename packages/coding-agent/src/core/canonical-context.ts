import type { AgentMessage } from "@ponythewhite/base-context-agent";
import { stringifyBoundedJson } from "./bounded-json.js";
import {
	CONTEXT_EPOCH_DETAIL,
	CONTEXT_EPOCH_RENDERER,
	CONTEXT_POLICY_EPOCH_RENDERER,
	CONTEXT_TOOL_EPOCH_RENDERER,
	type ContextEpochCheckpoint,
	type ContextMode,
	type ContextReplayContract,
	contextEpochMode,
	type EpochViewReference,
	readContextEpoch,
	retainedContextRequestContract,
	snapshotContextEpoch,
	type ToolContinuationGroup,
} from "./context-epoch.js";
import type {
	ContextManifestCursor,
	ContextManifestPage,
	ContextRef,
	ContextUpdateRef,
	ContextUpdateTarget,
	IndexedSourceEvent,
} from "./history-index.js";
import { createCompactionSummaryMessage } from "./messages.js";
import {
	PUBLIC_CONTEXT_RENDERER,
	PUBLIC_TOOL_CONTINUATION_RENDERER,
	renderPublicHistory,
	renderToolContinuation,
} from "./public-context.js";
import type { ContextEpochEntryRef, SourceSnapshotRef } from "./request-events.js";
import { type OwnedResourceCapture, renderResourceView } from "./resource-view.js";
import { orderContextToolResults, sessionEntryMessage } from "./session-context-messages.js";
import {
	appendSentAgentMessageToToolResult,
	parsePersistedIpythonSentAgentMessage,
} from "./session-context-updates.js";
import { hydrateCapturedHistoryEntry, type SessionHistoryReadView } from "./session-history-index.js";
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
	readonly pendingPublicMessageGroups?: readonly (readonly number[])[];
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
	readonly mode: ContextMode;
	readonly source: SourceSnapshotRef;
	readonly checkpoint?: ContextEpochCheckpoint;
	readonly checkpointEntry?: ContextEpochEntryRef;
	readonly taskFrame?: CompiledTaskFrame;
	readonly resourceRevision?: string;
	readonly references: readonly (EpochViewReference | null)[];
	/** Uncommitted public candidate plan; never a fabricated accepted checkpoint. */
	readonly continuation?: ContextEpochCheckpoint["continuation"];
	readonly toolContinuations?: readonly ToolContinuationGroup[];
}
const compiledEpochContexts = new WeakMap<readonly AgentMessage[], CompiledEpochContext>();

export function getCanonicalEpochContext(messages: readonly AgentMessage[]): CompiledEpochContext | undefined {
	const context = compiledEpochContexts.get(messages);
	return context ? structuredClone(context) : undefined;
}

/** Detach the request view while keeping its existing captured rendering metadata. */
export function captureCanonicalRequestMessages(messages: readonly AgentMessage[]): AgentMessage[] {
	const views = compiledViewUnits.get(messages);
	const epoch = compiledEpochContexts.get(messages);
	if (!views || !epoch || views.units.length !== messages.length || epoch.references.length !== messages.length)
		throw new Error("Request view boundary requires compiled canonical messages");
	const captured = structuredClone([...messages]);
	compiledViewUnits.set(captured, structuredClone(views));
	compiledEpochContexts.set(captured, structuredClone(epoch));
	for (const [index, message] of messages.entries()) {
		const source = messageSources.get(message);
		if (source) messageSources.set(captured[index], { ...source });
	}
	return captured;
}

/** Called only for the actual current adapter's mandatory whole-group public candidate. */
export function prepareToolContinuationWindow(messages: readonly AgentMessage[]): {
	messages: AgentMessage[];
	replacements: readonly { messageIndex: number; text: string }[];
} {
	const captured = captureCanonicalRequestMessages(messages);
	const views = compiledViewUnits.get(captured)!;
	const epoch = compiledEpochContexts.get(captured)!;
	const groups = views.selection.pendingPublicMessageGroups;
	if (!groups?.length || groups.length !== epoch.toolContinuations?.length)
		throw new Error("Tool continuation requires its captured native source plan");
	const maxBytes = views.selection.limits.maxMetadataBytes;
	const references = [...epoch.references];
	const replacements: { messageIndex: number; text: string }[] = [];
	const markers = new Set(groups.map((group) => `public-tool-continuation:${views.units[group[0]].id}`));
	const renderedGroups = new Map<number, ToolContinuationGroup>();
	for (const [groupIndex, members] of groups.entries()) {
		const group = epoch.toolContinuations![groupIndex];
		if (references[members[0]]?.ref.entryId !== group.assistantEntryId)
			throw new Error("Tool continuation original group changed");
		for (const index of members) {
			const reference = references[index];
			if (!reference) throw new Error("Tool continuation source is unavailable");
			const original = captured[index];
			const rendered = renderToolContinuation(original, reference.ref.entryId, epoch.source, group, maxBytes);
			const source = messageSources.get(original);
			if (source) messageSources.set(rendered, source);
			captured[index] = rendered;
			references[index] = { ...reference, rendering: PUBLIC_TOOL_CONTINUATION_RENDERER };
			replacements.push({ messageIndex: index, text: rendered.content });
			renderedGroups.set(index, group);
		}
	}
	stringifyBoundedJson(captured, maxBytes);
	const publicUnits = views.units.map(
		(unit, index): ViewUnit => ({
			...unit,
			sourceRevision: renderedGroups.has(index)
				? JSON.stringify([unit.sourceRevision, PUBLIC_TOOL_CONTINUATION_RENDERER, renderedGroups.get(index)])
				: unit.sourceRevision,
			unavailableDependencies: unit.unavailableDependencies?.filter((id) => !markers.has(id)),
		}),
	);
	compiledViewUnits.set(captured, {
		units: publicUnits,
		selection: { ...views.selection, units: publicUnits, pendingPublicMessageGroups: undefined },
	});
	compiledEpochContexts.set(captured, { ...epoch, references });
	return { messages: captured, replacements };
}

/** Deterministic public data only. The actual adapter must permit and accept this candidate. */
export function preparePublicContextWindow(messages: readonly AgentMessage[]):
	| {
			messages: AgentMessage[];
			replacements: readonly { messageIndex: number; text: string }[];
	  }
	| undefined {
	const captured = captureCanonicalRequestMessages(messages);
	const views = compiledViewUnits.get(captured)!;
	const epoch = compiledEpochContexts.get(captured)!;
	const maxBytes = views.selection.limits.maxMetadataBytes;
	const references = [...epoch.references];
	const replacements: { messageIndex: number; text: string }[] = [];
	for (const [index, message] of captured.entries()) {
		if (message.role !== "assistant" && message.role !== "toolResult") continue;
		// Public v1 has no media representation. Do not disturb an otherwise valid native request.
		if (message.content.some((part) => !["text", "toolCall", "thinking"].includes(part.type))) return;
		const reference = references[index];
		if (!reference) throw new Error("Public request view requires its captured source");
		const rendered = renderPublicHistory(message, reference.ref.entryId, maxBytes);
		if (rendered.role !== "custom" || typeof rendered.content !== "string")
			throw new Error("Public request view has no standalone text");
		const source = messageSources.get(message);
		if (source) messageSources.set(rendered, source);
		captured[index] = rendered;
		references[index] = { ...reference, rendering: PUBLIC_CONTEXT_RENDERER };
		replacements.push({ messageIndex: index, text: rendered.content });
	}
	if (!replacements.length) return;
	stringifyBoundedJson(captured, maxBytes);
	const publicIndices = new Set(replacements.map((replacement) => replacement.messageIndex));
	const renderedUnit = (unit: ViewUnit, index: number): ViewUnit =>
		publicIndices.has(index)
			? { ...unit, sourceRevision: JSON.stringify([unit.sourceRevision, PUBLIC_CONTEXT_RENDERER]) }
			: unit;
	compiledViewUnits.set(captured, {
		units: views.units.map(renderedUnit),
		selection: { ...views.selection, units: views.selection.units.map(renderedUnit) },
	});
	compiledEpochContexts.set(captured, {
		...epoch,
		references,
		continuation: { kind: "portable-checkpoint", publicTailThrough: epoch.source },
	});
	return { messages: captured, replacements };
}

/** Read mode only from the same qualified compaction owner used by the compiler. */
export async function readCanonicalContextMode(
	view: SessionHistoryReadView,
	maxBytes: number,
	initial: ContextMode,
): Promise<ContextMode> {
	const manifest = await view.contextManifest({ limit: 1 });
	if (manifest.selection !== "known") throw new Error("Context mode source is unavailable");
	if (!manifest.summaryRef) return initial;
	const metadata = await view.get(manifest.summaryRef.entryId);
	if (!metadata) throw new Error("Context mode checkpoint is unavailable");
	const hydrated = await hydrateCapturedHistoryEntry(metadata, maxBytes, view.readPayload);
	if (!hydrated || hydrated.entry.type !== "compaction") throw new Error("Context mode checkpoint is unavailable");
	const details = hydrated.entry.details;
	if (!details || typeof details !== "object" || !(CONTEXT_EPOCH_DETAIL in details)) return initial;
	if (hydrated.source.qualification !== "native-context-epoch" || hydrated.source.retention === "retained-import")
		throw new Error("Context mode checkpoint is not qualified on this source");
	return contextEpochMode(readContextEpoch(details, maxBytes), initial);
}

/** Policy changes retain the current recipe; generated overlays are not archived conversation. */
export function prepareContextModeEpoch(
	messages: readonly AgentMessage[],
	mode: ContextMode,
	maxBytes: number,
	freshContextContract = false,
): { checkpoint: ContextEpochCheckpoint; messages: AgentMessage[] } {
	const context = compiledEpochContexts.get(messages);
	const units = getCanonicalViewUnits(messages);
	if (!context || !units || units.length !== messages.length)
		throw new Error("Context mode requires captured canonical views");
	if (context.toolContinuations?.length)
		throw new Error("Tool continuation cannot enter a policy-only context checkpoint");
	const chosen = messages.filter(
		(_, index) => units[index].kind !== "task-frame" && units[index].kind !== "resource-view",
	);
	const views = context.references.filter((reference): reference is EpochViewReference => reference !== null);
	const tail = views.at(-1);
	// A metadata-only fresh branch uses its existing source leaf; no fake user input is appended.
	const literalTailId = tail && tail.ref.kind !== "compaction" ? views.pop()!.ref.entryId : context.source.leafId;
	if (!literalTailId) throw new Error("Context mode requires a canonical source boundary");
	return {
		checkpoint: snapshotContextEpoch(
			{
				version: 5,
				renderer: CONTEXT_POLICY_EPOCH_RENDERER,
				mode,
				policyOnly: true,
				representation: null,
				source: context.source,
				views,
				literalTailId,
				requestContract: retainedContextRequestContract(context.checkpoint),
				...(mode === "off" && !context.checkpoint && freshContextContract
					? { pendingRequestContract: true as const }
					: {}),
				replayContract: context.checkpoint?.replayContract,
				publicWindow: context.checkpoint?.publicWindow,
				continuation: context.checkpoint?.continuation,
				// Retain the existing bounded anchor recipe for explicit re-enable; off never injects it.
				taskFrame: context.taskFrame ?? context.checkpoint?.taskFrame,
			},
			maxBytes,
		),
		messages: [...chosen],
	};
}

/** A candidate only. The caller must ACK the canonical checkpoint before adoption or send. */
export function prepareCanonicalEpoch(
	messages: readonly AgentMessage[],
	selectedUnitIds: readonly string[],
	representation: string,
	maxBytes: number,
	replayContract: ContextReplayContract = "complete-context",
	publicWindow = false,
): {
	checkpoint: ContextEpochCheckpoint & { readonly version: 4 | 6; readonly representation: string };
	messages: AgentMessage[];
} {
	const context = compiledEpochContexts.get(messages);
	const units = getCanonicalViewUnits(messages);
	if (!context || !units || units.length !== messages.length || context.references.length !== messages.length)
		throw new Error("Context epoch requires its captured compiler output");
	if (compiledViewUnits.get(messages)?.selection.pendingPublicMessageGroups?.length)
		throw new Error("Tool continuation requires its accepted public representation");
	if (context.toolContinuations?.length && (!publicWindow || replayContract !== "message-groups"))
		throw new Error("Tool continuation epoch requires its actual public replay contract");
	const selected = new Set(selectedUnitIds);
	if (selected.size !== selectedUnitIds.length || [...selected].some((id) => !units.some((unit) => unit.id === id)))
		throw new Error("Context epoch selection has an unknown or repeated unit");
	const chosen: AgentMessage[] = [];
	const views: EpochViewReference[] = [];
	for (const [index, unit] of units.entries()) {
		if (!selected.has(unit.id)) {
			if (unit.kind === "task-frame") throw new Error("Context epoch cannot omit its task frame");
			if (unit.kind === "resource-view") throw new Error("Context epoch cannot omit its current resource view");
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
				version: context.toolContinuations?.length ? 6 : 4,
				renderer: context.toolContinuations?.length ? CONTEXT_TOOL_EPOCH_RENDERER : CONTEXT_EPOCH_RENDERER,
				...(context.toolContinuations?.length ? { toolContinuations: context.toolContinuations } : {}),
				source: context.source,
				representation,
				replayContract,
				...(publicWindow ? { publicWindow: true as const } : {}),
				...((context.continuation ?? context.checkpoint?.continuation)
					? { continuation: context.continuation ?? context.checkpoint?.continuation }
					: {}),
				views,
				taskFrame: context.taskFrame,
				resourceRevision: context.resourceRevision,
				literalTailId: tail.ref.entryId,
			},
			maxBytes,
		),
		messages: chosen,
	};
}

/** Use only a replay contract granted to these recovery results by an actual accepted request. */
export function canonicalRecoveryBoundary(messages: readonly AgentMessage[]): string | undefined {
	const context = compiledEpochContexts.get(messages);
	const units = getCanonicalViewUnits(messages);
	if (!context || !units) throw new Error("Recovery compaction requires captured canonical views");
	if (context.toolContinuations?.length)
		throw new Error("Tool continuation cannot enter an older recovery summary recipe");
	const recoveries = units.flatMap((unit, index) => (unit.kind === "recovery" ? [context.references[index]] : []));
	if (!recoveries.length) return;
	const checkpoint = context.checkpoint;
	if (
		!checkpoint?.representation ||
		checkpoint.replayContract !== "message-groups" ||
		recoveries.some((reference) => !reference || reference.ref.sequence > checkpoint.source.sourceSequence)
	)
		throw new Error("Recovery compaction requires an accepted replay contract for its selected results");
	return checkpoint.literalTailId;
}

/** Retain exact recovery evidence. An accepted public-window transition replaces whole old protocol groups. */
export function prepareRecoveryCompaction(
	messages: readonly AgentMessage[],
	firstKeptEntryId: string,
	maxBytes: number,
): ContextEpochCheckpoint | undefined {
	const boundary = canonicalRecoveryBoundary(messages);
	const context = compiledEpochContexts.get(messages);
	const publicWindow =
		context?.checkpoint?.publicWindow === true && context.checkpoint.replayContract === "message-groups";
	if (!boundary && !publicWindow) return;
	if (!context) throw new Error("Recovery compaction requires captured canonical views");
	const selection = getCanonicalViewSelectionSource(messages)!;
	const cut = context.references.findIndex((reference) => reference?.ref.entryId === firstKeptEntryId);
	const lastProved = boundary
		? context.references.findIndex((reference) => reference?.ref.entryId === boundary)
		: messages.length - 1;
	if (cut < 0 || lastProved < 0 || cut > lastProved)
		throw new Error("Recovery compaction must retain its unmeasured literal tail");
	const units = bindMessageReplayUnits(messages, selection.units, selection.limits, "message-groups");
	// A mode transition cannot strand any outstanding native call, including one in the retained tail.
	closeViewSelection(
		units,
		units.map((unit) => unit.id),
		selection.limits,
	);
	const roots = units.filter((unit) => unit.kind === "recovery").map((unit) => unit.id);
	const closed = new Set(closeViewSelection(units, roots, selection.limits).map((unit) => unit.id));
	let renderedBytes = 0;
	const views = context.references.flatMap((reference, index): EpochViewReference[] => {
		if (!reference || (index < cut && !closed.has(units[index].id))) return [];
		const message = messages[index];
		const rendered = publicWindow ? renderPublicHistory(message, reference.ref.entryId, maxBytes) : message;
		if (publicWindow) {
			renderedBytes += Buffer.byteLength(JSON.stringify(rendered), "utf8");
			if (renderedBytes > maxBytes) throw new Error("Public summary view byte budget exceeded");
		}
		return index < cut
			? [
					{
						...reference,
						...(rendered !== message ? { rendering: PUBLIC_CONTEXT_RENDERER } : {}),
					},
				]
			: [];
	});
	if (!views.length && !publicWindow) return;
	return snapshotContextEpoch(
		{
			version: 4,
			renderer: CONTEXT_EPOCH_RENDERER,
			source: context.source,
			representation: null,
			includeSummary: true,
			replayContract: "message-groups",
			...(publicWindow
				? {
						continuation: {
							kind: "harness-summary" as const,
							publicTailThrough: context.source,
						},
					}
				: {}),
			views,
			resourceRevision: context.resourceRevision,
			literalTailId: firstKeptEntryId,
		},
		maxBytes,
	);
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
		resourceCapture?: OwnedResourceCapture,
		initialContextMode: ContextMode = "on",
		allowPendingToolPublic = false,
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
		const mode = contextEpochMode(checkpoint, initialContextMode);
		const publicTail = checkpoint?.continuation?.publicTailThrough;
		if (publicTail) {
			if (!view.atSnapshot) throw new Error("Public summary transition requires its captured source");
			await view.atSnapshot(publicTail);
		}
		let publicBytes = 0;
		const boundary = JSON.stringify([first.summaryRef?.entryId ?? null, first.summaryRef?.revision ?? null]);
		let resetFrame =
			previousSource?.sessionId !== view.source.sessionId ||
			previousSource?.sessionFile !== view.source.sessionFile ||
			previousBoundary !== boundary ||
			(previousSource !== undefined && previousSource.sourceSequence > view.source.sourceSequence);
		if (!resetFrame && previousFrame && previousSource?.leafId && previousSource.leafId !== view.source.leafId)
			resetFrame = !(await view.get(previousSource.leafId));
		const tasks =
			mode === "off"
				? undefined
				: await readTaskStateFromView(view, {
						maxItems: maxMessages,
						maxSourceBytes,
						maxViewBytes: maxSourceBytes,
					});
		let taskSequence = -1;
		for (const { event } of tasks?.items ?? []) {
			if (event.source.sequence === taskSequence) continue;
			taskSequence = event.source.sequence;
			// The task reader has already required an exact locator for every represented frame.
			countBytes({ locator: event.source.locator! });
		}
		const referenceFrame = resetFrame ? checkpoint?.taskFrame : previousFrame;
		let taskFrame = tasks ? compileTaskFrame(tasks, frameLimits, referenceFrame) : undefined;
		const resource =
			mode === "on" && resourceCapture && (resourceCapture.enabled || checkpoint)
				? renderResourceView(resourceCapture)
				: undefined;
		if (resource) {
			sourceBytes += resource.bytes;
			if (sourceBytes > maxSourceBytes) throw new Error("Canonical context source byte budget exceeded");
		}
		const messageCount =
			first.activeMessageCount +
			(checkpoint ? checkpoint.views.length + (checkpoint.includeSummary ? 1 : 0) : first.summaryRef ? 1 : 0) +
			(taskFrame?.messages.length ?? 0) +
			(resource ? 1 : 0);
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
		if (first.summaryRef && (!checkpoint || checkpoint.includeSummary))
			await addSummary(first.summaryRef, view, first.retainedMessageCount);
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
			const publicHistory =
				pinned?.rendering === PUBLIC_CONTEXT_RENDERER ||
				(!pinned && publicTail !== undefined && ref.sequence <= publicTail.sourceSequence);
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
			messages.push(rendered);
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
		if (checkpoint) {
			if (!view.atSnapshot) throw new Error("Context epoch requires a captured native prefix reader");
			const prefixViews = new Map<string, SessionHistoryReadView>();
			const seen = new Set<string>();
			for (const pinned of checkpoint.views) {
				if (
					pinned.rendering !== undefined &&
					((pinned.rendering === PUBLIC_TOOL_CONTINUATION_RENDERER
						? checkpoint.version !== 6
						: pinned.rendering !== PUBLIC_CONTEXT_RENDERER ||
							(checkpoint.version !== 3 &&
								checkpoint.version !== 4 &&
								checkpoint.version !== 5 &&
								checkpoint.version !== 6)) ||
						pinned.ref.kind === "compaction")
				)
					throw new Error("Unsupported context epoch view rendering");
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
		if (resource) {
			// Current owned display is regenerated; a stored acceptance marker is never a live view.
			const at = messages[0] && unitSources.get(messages[0])?.kind === "task-frame" ? 1 : 0;
			messages.splice(at, 0, resource.message);
			unitSources.set(resource.message, resource.unit);
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
		const replayUnits = bindMessageReplayUnits(messages, sourceUnits, unitLimits);
		const frozenGroups = checkpoint?.toolContinuations ?? [];
		const candidates = messages.flatMap((message, index) => {
			if (message.role !== "assistant") return [];
			const reference = epochReferences.get(message);
			const prior = frozenGroups.find((group) => group.assistantEntryId === reference?.ref.entryId);
			if (!prior && !replayUnits[index].unavailableDependencies?.some((id) => id.startsWith("tool-result:")))
				return [];
			if (!reference || reference.ref.retention === "retained-import")
				throw new Error("Tool continuation requires its original assistant source");
			return [
				{
					message,
					index,
					reference,
					prior,
					intents: new Map<number, Awaited<ReturnType<typeof hydrateCapturedHistoryEntry>>>(),
				},
			];
		});
		if (frozenGroups.length !== candidates.filter((candidate) => candidate.prior).length)
			throw new Error("Committed tool continuation lost its original group");
		if (candidates.length && (!allowPendingToolPublic || mode === "off"))
			throw new Error("Tool continuation requires an enabled native public request boundary");
		const readToolEvidence = async (metadata: IndexedSourceEvent) => {
			const cached = next.get(metadata.id);
			if (cached?.revision === metadata.revision) return { entry: cached.entry, source: metadata };
			countBytes(metadata);
			return hydrateCapturedHistoryEntry(metadata, maxSourceBytes, view.readPayload);
		};
		const acceptIntent = async (metadata: IndexedSourceEvent) => {
			if (
				metadata.kind !== "tool_intent" ||
				metadata.qualification !== "native-tool-execution" ||
				metadata.retention === "retained-import"
			)
				return;
			const hydrated = await readToolEvidence(metadata);
			const entry = hydrated.entry;
			if (
				entry.type !== "tool_intent" ||
				entry.assistant?.sessionId !== view.source.sessionId ||
				entry.assistant.sessionFile !== view.source.sessionFile
			)
				return;
			const candidate = candidates.find((item) => item.reference.ref.entryId === entry.assistant?.entryId);
			if (!candidate) return;
			const invocation = entry.invocation;
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
		for (const candidate of candidates) {
			if (!candidate.prior) continue;
			if (!Array.isArray(candidate.prior.calls)) throw new Error("Invalid committed tool continuation");
			for (const call of candidate.prior.calls) {
				const actual = await view.get(call.intent.id);
				if (!actual || actual.revision !== call.intent.revision || actual.sequence !== call.intent.sequence)
					throw new Error("Committed tool intent is unavailable on this captured branch");
				await acceptIntent(actual);
			}
		}
		const newGroups = candidates.filter((candidate) => !candidate.prior);
		if (newGroups.length) {
			let after = Math.min(...newGroups.map((candidate) => candidate.reference.ref.sequence));
			let scanned = 0;
			for (;;) {
				const page = await view.page(after, Math.min(128, maxMessages - scanned + 1));
				scanned += page.events.length;
				if (scanned > maxMessages) throw new Error("Tool continuation source item budget exceeded");
				if (page.coverage !== "complete") throw new Error("Tool continuation source coverage is incomplete");
				for (const metadata of page.events) {
					// Frozen intent refs were already read exactly; do not count them twice as another execution.
					if (
						!candidates.some((candidate) => candidate.prior?.calls.some((call) => call.intent.id === metadata.id))
					)
						await acceptIntent(metadata);
				}
				if (page.nextAfter === null) break;
				if (page.nextAfter <= after) throw new Error("Tool continuation source page did not advance");
				after = page.nextAfter;
			}
		}
		const toolContinuations: ToolContinuationGroup[] = [];
		const pendingPublicMessageGroups: number[][] = [];
		for (const candidate of candidates) {
			const toolCalls = candidate.message.content.filter((part) => part.type === "toolCall");
			if (
				!toolCalls.length ||
				candidate.intents.size !== toolCalls.length ||
				(candidate.prior && candidate.prior.calls.length !== toolCalls.length)
			)
				throw new Error("View-unit replay group is incomplete: original tool owner is unqualified");
			const members = [candidate.index];
			const calls: ToolContinuationGroup["calls"][number][] = [];
			for (let order = 0; order < toolCalls.length; order++) {
				const intent = candidate.intents.get(order)!;
				if (intent.entry.type !== "tool_intent") throw new Error("Invalid native tool intent");
				const invocation = intent.entry.invocation;
				const original = candidate.prior?.calls[order];
				if (
					original &&
					(original.executionId !== invocation.executionId || original.intent.id !== intent.source.id)
				)
					throw new Error("Committed tool execution identity changed");
				const actual = await view.get(invocation.executionId);
				let outcome: ToolContinuationGroup["calls"][number]["outcome"] = "outcome_unknown";
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
				(pinned) =>
					pinned.rendering === PUBLIC_TOOL_CONTINUATION_RENDERER && !publicSourceIds.has(pinned.ref.entryId),
			)
		)
			throw new Error("Committed tool rendering has no matching whole-group recipe");
		stringifyBoundedJson(toolContinuations, maxSourceBytes);
		const units = pendingPublicMessageGroups.length
			? bindMessageReplayUnits(messages, sourceUnits, unitLimits, "complete-context", pendingPublicMessageGroups)
			: replayUnits;
		const pendingMarkers = new Set(
			pendingPublicMessageGroups.map((group) => `public-tool-continuation:${units[group[0]].id}`),
		);
		// Check every ordinary dependency now. Return the original unadmittable units, not native replay permission.
		closeViewSelection(
			units.map((unit) => ({
				...unit,
				unavailableDependencies: unit.unavailableDependencies?.filter((id) => !pendingMarkers.has(id)),
			})),
			units.map((unit) => unit.id),
			unitLimits,
		);
		const closedUnits = units;
		const messagesByUnit = new Map(units.map((unit, index) => [unit.id, messages[index]]));
		const closedMessages = closedUnits.map((unit) => messagesByUnit.get(unit.id)!);
		// A frozen literal is immutable inside this epoch, not permanently mandatory at its next ACK boundary.
		const selectionUnits = sourceUnits.map((unit, index): ViewUnit => {
			const message = messages[index];
			if (unit.kind !== "fixed-view" || message.role !== "assistant") return unit;
			return {
				...unit,
				kind: message.content.some((part) => part.type === "toolCall") ? "replay-group" : "literal",
			};
		});
		compiledViewUnits.set(closedMessages, {
			units: closedUnits,
			selection: {
				source: { ...view.source },
				units: selectionUnits,
				limits: unitLimits,
				...(pendingPublicMessageGroups.length ? { pendingPublicMessageGroups } : {}),
			},
		});
		compiledEpochContexts.set(closedMessages, {
			mode,
			source: { ...view.source },
			checkpoint,
			checkpointEntry:
				checkpoint && first.summaryRef
					? { sessionId: view.source.sessionId, entryId: first.summaryRef.entryId }
					: undefined,
			taskFrame,
			resourceRevision: resource?.revision,
			references: closedMessages.map((message) => epochReferences.get(message) ?? null),
			...(toolContinuations.length ? { toolContinuations } : {}),
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
