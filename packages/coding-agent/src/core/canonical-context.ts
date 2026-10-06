import type { AgentMessage } from "@ponythewhite/base-context-agent";
import { stringifyBoundedJson } from "./bounded-json.js";
import { insertSelectedSkills, insertTaskFrame } from "./canonical-context-overlays.js";
import {
	type CanonicalMessageSource,
	canonicalMessageRenderer,
	messageSources,
} from "./canonical-context-rendering.js";
import { type CachedContextEntry, canonicalEntryReader, readCanonicalManifest } from "./canonical-context-source.js";
import { collectToolContinuations } from "./canonical-context-tools.js";
import {
	CONTEXT_EPOCH_DETAIL,
	CONTEXT_EPOCH_RENDERER,
	CONTEXT_INTERRUPTED_TOOL_RENDERER,
	CONTEXT_POLICY_EPOCH_RENDERER,
	CONTEXT_SKILL_EPOCH_RENDERER,
	CONTEXT_TOOL_EPOCH_RENDERER,
	CONTEXT_TOOL_SUMMARY_RENDERER,
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
import type { ContextManifestCursor, ContextRef } from "./history-index.js";
import {
	PUBLIC_CONTEXT_RENDERER,
	PUBLIC_TOOL_CONTINUATION_RENDERER,
	renderPublicHistory,
	renderToolContinuation,
} from "./public-context.js";
import type { ContextEpochEntryRef, SourceSnapshotRef } from "./request-events.js";
import { type OwnedResourceCapture, renderResourceView } from "./resource-view.js";
import type { SelectedSkillReference } from "./selected-skills.js";
import { orderContextToolResults } from "./session-context-messages.js";
import { hydrateCapturedHistoryEntry, type SessionHistoryReadView } from "./session-history-index.js";
import type { SessionEntry } from "./session-manager.js";
import { type CompiledTaskFrame, compileTaskFrame, type TaskFrameLimits, taskFrameLimits } from "./task-frame.js";
import { TaskStateReadCache } from "./task-state-reader.js";
import { bindMessageReplayUnits, closeViewSelection, type ViewUnit, type ViewUnitLimits } from "./view-units.js";

export interface CanonicalContextLimits {
	maxMessages: number;
	/** Canonical frame bytes, not a tokenizer or an estimate of JavaScript heap size. */
	maxSourceBytes: number;
}

export interface CanonicalViewSelectionSource {
	readonly source: SourceSnapshotRef;
	readonly units: readonly ViewUnit[];
	readonly limits: ViewUnitLimits;
	readonly pendingPublicMessageGroups?: readonly (readonly number[])[];
	/** A new base or retained epoch must be ACKed before native transport, even without a token budget. */
	readonly requiresEpoch?: true;
	/** Ask the actual adapter to record replay permission; unsupported full replay remains unchanged. */
	readonly recoveryContractRequested?: true;
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
	/** A captured observation or summary input never authorizes a MAIN epoch. */
	readonly readOnly?: true;
	readonly mode: ContextMode;
	readonly source: SourceSnapshotRef;
	readonly checkpoint?: ContextEpochCheckpoint;
	readonly checkpointEntry?: ContextEpochEntryRef;
	readonly selectedSkills?: readonly SelectedSkillReference[];
	readonly taskFrame?: CompiledTaskFrame;
	readonly taskFrameRebased?: true;
	readonly resourceRevision?: string;
	readonly references: readonly (EpochViewReference | null)[];
	/** Exact retained recovery members of a qualified summary's frozen source, not a sequence interval. */
	readonly inheritedRecoveryCoverage?: readonly EpochViewReference[];
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
	if (compiledEpochContexts.get(messages)?.readOnly)
		throw new Error("Read-only context cannot authorize a provider epoch");
	return renderToolContinuationWindow(messages);
}

/** Source-backed public facts shared by observations, summaries, and measured request candidates. */
function renderToolContinuationWindow(messages: readonly AgentMessage[]): {
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
	// Reads need whole tool groups, not the unadmittable request's whole-context dependency star.
	const units = epoch.readOnly
		? bindMessageReplayUnits(captured, views.selection.units, views.selection.limits, "message-groups", groups)
		: views.units;
	const publicUnits = units.map(
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
export function preparePublicContextWindow(
	messages: readonly AgentMessage[],
	firstMessageIndex = 0,
):
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
		if (index < firstMessageIndex || (message.role !== "assistant" && message.role !== "toolResult")) continue;
		if (message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted"))
			continue;
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

/** Literal suffixes follow source append order, not the restored tool-call display order. */
function latestLiteralReference(references: readonly (EpochViewReference | null)[]): EpochViewReference | undefined {
	let latest: EpochViewReference | undefined;
	for (const reference of references) {
		if (reference && reference.ref.kind !== "compaction" && (!latest || reference.ref.sequence > latest.ref.sequence))
			latest = reference;
	}
	return latest;
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
	const tail = latestLiteralReference(context.references);
	const views = context.references.filter(
		(reference): reference is EpochViewReference => reference !== null && reference !== tail,
	);
	// A metadata-only fresh branch uses its existing source leaf; no fake user input is appended.
	const literalTailId = tail?.ref.entryId ?? context.source.leafId;
	if (!literalTailId) throw new Error("Context mode requires a canonical source boundary");
	return {
		checkpoint: snapshotContextEpoch(
			{
				version: 5,
				renderer: context.selectedSkills?.length ? CONTEXT_SKILL_EPOCH_RENDERER : CONTEXT_POLICY_EPOCH_RENDERER,
				...(context.selectedSkills?.length ? { selectedSkills: context.selectedSkills } : {}),
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
	if (context.readOnly) throw new Error("Read-only context cannot authorize a provider epoch");
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
			if (unit.id === "native-selected-skill-versions")
				throw new Error("Context epoch cannot omit its selected skill references");
			continue;
		}
		chosen.push(messages[index]);
		const reference = context.references[index];
		if (reference) views.push(reference);
	}
	const tail = latestLiteralReference(context.references);
	if (!tail) throw new Error("Context epoch literal tail is unavailable");
	const tailIndex = views.indexOf(tail);
	if (tailIndex < 0) throw new Error("Context epoch cannot omit the current literal tail");
	views.splice(tailIndex, 1);
	return {
		checkpoint: snapshotContextEpoch(
			{
				version: context.toolContinuations?.length ? 6 : 4,
				renderer: context.toolContinuations?.some((group) =>
					group.calls.some((call) => call.admission === "absent"),
				)
					? CONTEXT_INTERRUPTED_TOOL_RENDERER
					: context.selectedSkills?.length
						? CONTEXT_SKILL_EPOCH_RENDERER
						: context.toolContinuations?.length
							? CONTEXT_TOOL_EPOCH_RENDERER
							: CONTEXT_EPOCH_RENDERER,
				...(context.selectedSkills?.length ? { selectedSkills: context.selectedSkills } : {}),
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

/** Missing prerequisite only; source, closure and projection failures remain ordinary errors. */
export class MissingRecoveryReplayContractError extends Error {
	constructor() {
		super("Recovery compaction requires an accepted replay contract for its selected results");
		this.name = "MissingRecoveryReplayContractError";
	}
}

/** Compaction-only permission captured from a validated native candidate, never a send admission. */
export interface RecoveryCompactionAuthorization {
	readonly source: SourceSnapshotRef;
	readonly recoveries: readonly EpochViewReference[];
	readonly resourceRevision?: string;
	readonly publicWindow: boolean;
	readonly isSourceCurrent?: () => boolean;
}

function sameRecoverySource(left: SourceSnapshotRef, right: SourceSnapshotRef, ownerStillCurrent = false): boolean {
	return (
		JSON.stringify(left) === JSON.stringify(right) ||
		(ownerStillCurrent &&
			left.sessionId === right.sessionId &&
			left.sessionFile === right.sessionFile &&
			left.persistent === right.persistent)
	);
}

function sameRecoveryReference(
	left: EpochViewReference,
	right: EpochViewReference,
	ownerStillCurrent = false,
): boolean {
	return (
		sameRecoverySource(left.source, right.source, ownerStillCurrent) &&
		JSON.stringify(left.ref) === JSON.stringify(right.ref) &&
		left.sourceRevision === right.sourceRevision
	);
}

/** Use accepted coverage, or the exact actual-projection permit of a rejected oversized candidate. */
export function canonicalRecoveryBoundary(
	messages: readonly AgentMessage[],
	authorization?: RecoveryCompactionAuthorization,
): string | undefined {
	const context = compiledEpochContexts.get(messages);
	const units = getCanonicalViewUnits(messages);
	if (!context || !units) throw new Error("Recovery compaction requires captured canonical views");
	if (context.toolContinuations?.length && !context.readOnly)
		throw new Error("Tool continuation summary requires its captured public read view");
	const recoveries = units.flatMap((unit, index) => (unit.kind === "recovery" ? [context.references[index]] : []));
	if (authorization) {
		// The captured native owner may certify bookkeeping-only appends, never new context or a branch change.
		const ownerStillCurrent = authorization.isSourceCurrent?.();
		if (
			ownerStillCurrent === false ||
			!sameRecoverySource(context.source, authorization.source, ownerStillCurrent === true) ||
			context.resourceRevision !== authorization.resourceRevision ||
			recoveries.length !== authorization.recoveries.length ||
			recoveries.some(
				(reference) =>
					!reference ||
					!authorization.recoveries.some((covered) =>
						sameRecoveryReference(reference, covered, ownerStillCurrent === true),
					),
			)
		)
			throw new Error("Recovery compaction authorization no longer matches its captured source");
		return recoveries.length ? latestLiteralReference(context.references)?.ref.entryId : undefined;
	}
	if (!recoveries.length) return;
	const checkpoint = context.checkpoint;
	const inherited = checkpoint?.includeSummary === true && checkpoint.replayContract === "message-groups";
	if (
		checkpoint?.replayContract !== "message-groups" ||
		recoveries.some(
			(reference) =>
				!reference ||
				(checkpoint.representation
					? reference.ref.sequence > checkpoint.source.sourceSequence
					: !inherited ||
						!context.inheritedRecoveryCoverage?.some((covered) => sameRecoveryReference(reference, covered))),
		)
	)
		throw new MissingRecoveryReplayContractError();
	return checkpoint.literalTailId;
}

/** Summarize older recovery output while retaining the current suffix and whole tool continuations. */
export function prepareRecoveryCompaction(
	messages: readonly AgentMessage[],
	firstKeptEntryId: string,
	maxBytes: number,
	authorization?: RecoveryCompactionAuthorization,
): ContextEpochCheckpoint | undefined {
	const boundary = canonicalRecoveryBoundary(messages, authorization);
	const context = compiledEpochContexts.get(messages);
	const publicWindow = authorization
		? authorization.publicWindow
		: context?.checkpoint?.publicWindow === true && context.checkpoint.replayContract === "message-groups";
	if (!boundary && !publicWindow && !context?.selectedSkills?.length && !context?.toolContinuations?.length) return;
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
	const toolGroups = new Set(context.toolContinuations?.map((group) => group.assistantEntryId));
	// Recovery qualification authenticates its source; it is not a permanent retention request.
	// Pre-cut output is covered by the summary. Keep tool continuations whole until their own boundary.
	const roots = units
		.filter((_, index) => toolGroups.has(context.references[index]?.ref.entryId ?? ""))
		.map((unit) => unit.id);
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
	if (!views.length && !publicWindow && !context.selectedSkills?.length && !toolGroups.size) return;
	return snapshotContextEpoch(
		{
			...(toolGroups.size ? { version: 8 as const, mode: context.mode } : { version: 4 as const }),
			renderer: context.toolContinuations?.some((group) => group.calls.some((call) => call.admission === "absent"))
				? CONTEXT_INTERRUPTED_TOOL_RENDERER
				: toolGroups.size
					? CONTEXT_TOOL_SUMMARY_RENDERER
					: context.selectedSkills?.length
						? CONTEXT_SKILL_EPOCH_RENDERER
						: CONTEXT_EPOCH_RENDERER,
			...(toolGroups.size ? { toolContinuations: context.toolContinuations } : {}),
			...(context.selectedSkills?.length ? { selectedSkills: context.selectedSkills } : {}),
			source: context.source,
			representation: null,
			includeSummary: true,
			...(toolGroups.size && publicWindow ? { publicWindow: true as const } : {}),
			replayContract:
				boundary || publicWindow ? "message-groups" : (context.checkpoint?.replayContract ?? "complete-context"),
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

/** Recover the exact selected suffix of a prior summary, without treating a sequence range as coverage. */
async function readInheritedRecoveryCoverage(
	view: SessionHistoryReadView,
	checkpoint: ContextEpochCheckpoint | undefined,
	closedMessages: readonly AgentMessage[],
	closedUnits: readonly ViewUnit[],
	epochReferences: ReadonlyMap<AgentMessage, EpochViewReference>,
	next: ReadonlyMap<string, CachedContextEntry>,
	hydrate: ReturnType<typeof canonicalEntryReader>["hydrate"],
	maxMessages: number,
	maxSourceBytes: number,
): Promise<EpochViewReference[]> {
	const inheritedRecoveryCoverage: EpochViewReference[] = [];
	if (
		checkpoint?.includeSummary &&
		checkpoint.replayContract === "message-groups" &&
		closedUnits.some((unit) => unit.kind === "recovery")
	) {
		const prefix = await view.atSnapshot!(checkpoint.source);
		const suffix = new Map<string, ContextRef>();
		const frozenViews = new Map<string, EpochViewReference>();
		let capturedMessages = 0;
		let retained = false;
		let cursor: ContextManifestCursor | undefined;
		for (;;) {
			const page = await prefix.contextManifest({ cursor, limit: 128 });
			if (page.selection !== "known") throw new Error("Summary recovery source is unavailable");
			if (!cursor && page.summaryRef) {
				// The frozen source may itself have pinned views before its literal manifest.
				const entry = await hydrate(page.summaryRef, undefined, prefix);
				const metadata = await prefix.get(page.summaryRef.entryId);
				const prior =
					entry.type === "compaction" &&
					metadata?.qualification === "native-context-epoch" &&
					metadata.retention !== "retained-import"
						? readContextEpoch(entry.details, maxSourceBytes)
						: undefined;
				if ((!prior || prior.includeSummary) && page.summaryRef.entryId === checkpoint.literalTailId)
					retained = true;
				capturedMessages += prior?.views.length ?? 0;
				for (const pinned of prior?.views ?? []) {
					if (pinned.ref.entryId === checkpoint.literalTailId) retained = true;
					if (retained) {
						suffix.set(pinned.ref.entryId, pinned.ref);
						frozenViews.set(pinned.ref.entryId, pinned);
					}
				}
			}
			for (const ref of page.refs) {
				if (ref.entryId === checkpoint.literalTailId) retained = true;
				if (retained) suffix.set(ref.entryId, ref);
			}
			capturedMessages += page.refs.length;
			if (capturedMessages > maxMessages) throw new Error("Summary recovery source exceeds its message budget");
			if (!page.nextCursor) break;
			cursor = page.nextCursor;
		}
		for (const [index, message] of closedMessages.entries()) {
			if (closedUnits[index].kind !== "recovery") continue;
			const reference = epochReferences.get(message)!;
			if (checkpoint.views.some((covered) => sameRecoveryReference(reference, covered))) {
				inheritedRecoveryCoverage.push(reference);
				continue;
			}
			const frozen = suffix.get(reference.ref.entryId);
			if (!frozen || JSON.stringify(frozen) !== JSON.stringify(reference.ref)) continue;
			const pinned = frozenViews.get(frozen.entryId);
			if (pinned) {
				if (reference.sourceRevision === pinned.sourceRevision) inheritedRecoveryCoverage.push(reference);
				continue;
			}
			const revisions = [frozen.revision];
			const entry = next.get(frozen.entryId)?.entry;
			if (entry?.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "ipython") {
				const updates = await prefix.contextUpdates({
					kind: "ipython-sent-message",
					toolCallId: entry.message.toolCallId,
				});
				revisions.push(...updates.refs.map((update) => update.revision));
			}
			if (reference.sourceRevision === JSON.stringify(revisions)) inheritedRecoveryCoverage.push(reference);
		}
	}
	return inheritedRecoveryCoverage;
}

/** Exact active-context reconstruction. It never silently chooses a last-N transcript. */
export class CanonicalContextCompiler {
	private source?: SourceSnapshotRef;
	private entries = new Map<string, CachedContextEntry>();
	private sourceBytes = 0;
	private messageCount = 0;
	private taskFrame?: CompiledTaskFrame;
	private taskBoundary?: string;
	private readonly taskState = new TaskStateReadCache();
	private generation = 0;
	private forceTaskFrameRebase = false;

	requestTaskFrameRebase(): void {
		this.forceTaskFrameRebase = true;
	}

	clear(): void {
		this.generation++;
		this.taskState.clear();
		this.forceTaskFrameRebase = false;
		this.entries.clear();
		this.source = undefined;
		this.sourceBytes = 0;
		this.messageCount = 0;
		this.taskFrame = undefined;
		this.taskBoundary = undefined;
	}

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
		purpose: "request" | "read" = "request",
	): Promise<AgentMessage[]> {
		const generation = this.generation;
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
		const manifest = await readCanonicalManifest(view, maxMessages, maxSourceBytes);
		const { first, refs, sourceOrder, countBytes } = manifest;
		const { next, hydrate } = canonicalEntryReader(view, this.entries);
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
		const selectedSkills = new Map((checkpoint?.selectedSkills ?? []).map((skill) => [skill.name, skill]));
		for (const skill of selectedSkills.values()) {
			if (!view.atSnapshot) throw new Error("Selected skill epoch requires its original prefix");
			const prefix = await view.atSnapshot(skill.view.source);
			const actual = await prefix.get(skill.view.ref.entryId);
			if (
				!actual ||
				actual.kind !== skill.view.ref.kind ||
				!["custom_message", "custom"].includes(actual.kind) ||
				actual.qualification !== "native-recovery" ||
				actual.revision !== skill.view.ref.revision ||
				actual.sequence !== skill.view.ref.sequence ||
				JSON.stringify(actual.locator) !== JSON.stringify(skill.view.ref.locator) ||
				skill.view.sourceRevision !== JSON.stringify([actual.revision])
			)
				throw new Error("Selected skill epoch source is unavailable");
		}
		const publicTail = checkpoint?.continuation?.publicTailThrough;
		if (publicTail) {
			if (!view.atSnapshot) throw new Error("Public summary transition requires its captured source");
			await view.atSnapshot(publicTail);
		}
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
				: await this.taskState.read(view, {
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
		if (resetFrame || (referenceFrame && referenceFrame.messages.length <= 1)) this.forceTaskFrameRebase = false;
		const forceRebase = purpose === "request" && this.forceTaskFrameRebase;
		const resource =
			mode === "on" && resourceCapture && (resourceCapture.enabled || checkpoint)
				? renderResourceView(resourceCapture)
				: undefined;
		if (resource) countBytes({ locator: { length: resource.bytes } });

		const { messages, renderedMessages, literalSources, unitSources, epochReferences, addSummary, addLiteral } =
			canonicalMessageRenderer(
				view,
				hydrate,
				countBytes,
				sourceOrder,
				selectedSkills,
				omitted,
				maxSourceBytes,
				checkpoint,
			);
		if (first.summaryRef && (!checkpoint || checkpoint.includeSummary))
			await addSummary(first.summaryRef, view, first.retainedMessageCount);
		if (checkpoint) {
			if (!view.atSnapshot) throw new Error("Context epoch requires a captured native prefix reader");
			const prefixViews = new Map<string, SessionHistoryReadView>();
			const seen = new Set<string>();
			for (const pinned of checkpoint.views) {
				if (
					pinned.rendering !== undefined &&
					((pinned.rendering === PUBLIC_TOOL_CONTINUATION_RENDERER
						? checkpoint.version !== 6 && checkpoint.version !== 8
						: pinned.rendering !== PUBLIC_CONTEXT_RENDERER ||
							(checkpoint.version !== 3 &&
								checkpoint.version !== 4 &&
								checkpoint.version !== 5 &&
								checkpoint.version !== 6 &&
								checkpoint.version !== 8)) ||
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
		// Public renderings hide tool roles; restore call order while the source roles are still available.
		orderContextToolResults(messages);
		for (const [index, message] of messages.entries()) messages[index] = renderedMessages.get(message) ?? message;
		let taskFrame = tasks
			? compileTaskFrame(
					tasks,
					frameLimits,
					forceRebase ? undefined : referenceFrame,
					messages.flatMap((message) => {
						if (message.role !== "user") return [];
						const reference = epochReferences.get(message)!;
						return [
							{
								sessionId: reference.source.sessionId,
								entryId: reference.ref.entryId,
								revision: reference.ref.revision,
								text:
									typeof message.content === "string"
										? [message.content]
										: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
							},
						];
					}),
				)
			: undefined;
		const taskFrameRebased = Boolean(
			mode === "on" &&
				referenceFrame &&
				taskFrame !== referenceFrame &&
				(!taskFrame || taskFrame.messages.length === 1),
		);
		const messageCount =
			first.activeMessageCount +
			(checkpoint ? checkpoint.views.length + (checkpoint.includeSummary ? 1 : 0) : first.summaryRef ? 1 : 0) +
			(taskFrame?.messages.length ?? 0) +
			(resource ? 1 : 0);
		if (messageCount > maxMessages) throw new Error("Canonical context message budget exceeded");
		if (taskFrame)
			taskFrame = await insertTaskFrame(
				taskFrame,
				referenceFrame,
				taskFrameRebased,
				messages,
				literalSources,
				unitSources,
				sourceOrder,
				view,
			);
		if (resource) {
			// Current owned display is regenerated; a stored acceptance marker is never a live view.
			const at = messages[0] && unitSources.get(messages[0])?.kind === "task-frame" ? 1 : 0;
			messages.splice(at, 0, resource.message);
			unitSources.set(resource.message, resource.unit);
		}
		insertSelectedSkills(selectedSkills, messages, unitSources);
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
		if (selectedSkills.size) {
			const tailIndex = messages
				.map((message, index) => (epochReferences.has(message) ? index : -1))
				.filter((index) => index >= 0)
				.at(-1);
			if (tailIndex !== undefined) {
				const tail = sourceUnits[tailIndex];
				sourceUnits[tailIndex] = {
					...tail,
					requiredVisibleDependencies: [
						...new Set([...tail.requiredVisibleDependencies, "native-selected-skill-versions"]),
					],
				};
			}
		}
		const replayUnits = bindMessageReplayUnits(messages, sourceUnits, unitLimits);
		const { toolContinuations, pendingPublicMessageGroups } = await collectToolContinuations(
			view,
			messages,
			replayUnits,
			epochReferences,
			next,
			countBytes,
			maxMessages,
			maxSourceBytes,
			checkpoint,
			mode,
			allowPendingToolPublic,
			purpose,
		);
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
				...(mode === "on" && (taskFrameRebased || checkpoint) ? { requiresEpoch: true as const } : {}),
				...(mode === "on" && sourceUnits.some((unit) => unit.kind === "recovery")
					? { recoveryContractRequested: true as const }
					: {}),
				...(pendingPublicMessageGroups.length ? { pendingPublicMessageGroups } : {}),
			},
		});
		const inheritedRecoveryCoverage = await readInheritedRecoveryCoverage(
			view,
			checkpoint,
			closedMessages,
			closedUnits,
			epochReferences,
			next,
			hydrate,
			maxMessages,
			maxSourceBytes,
		);
		compiledEpochContexts.set(closedMessages, {
			...(inheritedRecoveryCoverage.length ? { inheritedRecoveryCoverage } : {}),
			...(purpose === "read" ? { readOnly: true as const } : {}),
			mode,
			source: { ...view.source },
			checkpoint,
			checkpointEntry:
				checkpoint && first.summaryRef
					? { sessionId: view.source.sessionId, entryId: first.summaryRef.entryId }
					: undefined,
			taskFrame,
			...(taskFrameRebased ? { taskFrameRebased: true as const } : {}),
			resourceRevision: resource?.revision,
			references: closedMessages.map((message) => epochReferences.get(message) ?? null),
			...(selectedSkills.size ? { selectedSkills: [...selectedSkills.values()] } : {}),
			...(toolContinuations.length ? { toolContinuations } : {}),
		});
		if (generation !== this.generation) throw new Error("Canonical context owner changed during compilation");
		this.entries = next;
		// A rebased candidate is not the committed prefix. Adopt it from the next ACKed checkpoint.
		this.taskFrame = taskFrameRebased ? referenceFrame : taskFrame;
		this.taskBoundary = boundary;
		this.source = view.source;
		this.sourceBytes = manifest.sourceBytes;
		this.messageCount = messageCount;
		return purpose === "read" && pendingPublicMessageGroups.length
			? renderToolContinuationWindow(closedMessages).messages
			: closedMessages;
	}
}
