import { isDeepStrictEqual } from "node:util";
import { stringifyBoundedJson } from "./bounded-json.js";
import {
	CONTEXT_EPOCH_DETAIL,
	type ContextEpochCheckpoint,
	type ContextEpochSummary,
	type EpochViewReference,
	readContextEpoch,
	snapshotContextEpoch,
} from "./context-epoch.js";
import type { ContextRef, ContextUpdateTarget, IndexedSourceEvent } from "./history-index.js";
import type { SourceSnapshotRef } from "./request-events.js";
import {
	hydrateCapturedHistoryEntry,
	type SessionHistoryReadLimits,
	type SessionHistoryReadScope,
	type SessionHistoryReadView,
} from "./session-history-index.js";
import type { SessionEntry } from "./session-manager.js";
import { compileTaskFrame, taskFrameLimits } from "./task-frame.js";
import { readTaskStateFromView } from "./task-state-reader.js";

export const readCopiedEpochSource = Symbol("readCopiedEpochSource");

/** Operation-local metadata from the actual old capture, not another body or epoch store. */
export interface CopiedEpochEntry
	extends Pick<
		IndexedSourceEvent,
		"id" | "parentId" | "kind" | "sequence" | "revision" | "locator" | "retention" | "qualification"
	> {
	readonly updateTarget?: ContextUpdateTarget;
}
export interface CapturedEpochCopy {
	readonly sessionId: string;
	readonly sessionFile?: string;
	readonly through: number;
	readonly entries: readonly CopiedEpochEntry[];
	readonly retained: boolean;
}

export function captureEpochCopyEntry(
	entry: SessionEntry,
	source: Omit<CopiedEpochEntry, "updateTarget">,
): CopiedEpochEntry {
	const updateTarget: ContextUpdateTarget | undefined =
		entry.type === "message"
			? entry.message.role === "assistant"
				? { kind: "assistant-usage", targetId: entry.id }
				: entry.message.role === "toolResult" && entry.message.toolName === "ipython"
					? { kind: "ipython-sent-message", toolCallId: entry.message.toolCallId }
					: undefined
			: undefined;
	return {
		id: source.id,
		parentId: source.parentId,
		kind: source.kind,
		sequence: source.sequence,
		revision: source.revision,
		locator: { ...source.locator },
		retention: source.retention,
		qualification: source.qualification,
		...(updateTarget ? { updateTarget } : {}),
	};
}

/** Rebuild only at the explicit copy boundary; later provider reads remain destination-only. */
export async function rebuildCopiedContextEpoch(
	history: SessionHistoryReadScope,
	copied: CapturedEpochCopy,
	limits: SessionHistoryReadLimits,
): Promise<
	{ checkpoint: ContextEpochCheckpoint; tokensBefore: number | null; summary?: ContextEpochSummary } | undefined
> {
	const view = history.branchContext;
	const manifest = await view.contextManifest({ limit: 1 });
	if (manifest.selection !== "known") throw new Error("Copied context selection is unavailable");
	const selected = manifest.summaryRef;
	if (!selected) return;
	const metadata = await view.get(selected.entryId);
	if (!metadata) throw new Error("Copied context summary source is unavailable");
	const hydrated = await hydrateCapturedHistoryEntry(metadata, limits.maxSourceBytes, view.readPayload);
	if (!hydrated || hydrated.entry.type !== "compaction") throw new Error("Copied context summary is unavailable");
	const entry = hydrated.entry;
	if (!entry.details || typeof entry.details !== "object" || !(CONTEXT_EPOCH_DETAIL in entry.details)) return;
	const oldById = new Map<string, CopiedEpochEntry>();
	for (const source of copied.entries) if (!oldById.has(source.id)) oldById.set(source.id, source);
	const origin = oldById.get(entry.id);
	if (origin?.qualification !== "native-context-epoch" || hydrated.source.qualification !== "native-context-epoch")
		throw new Error("Copied context epoch has no qualified source");
	const checkpoint = readContextEpoch(entry.details, limits.maxSourceBytes);
	if (!checkpoint || checkpoint.literalTailId !== entry.firstKeptEntryId || !view.atSnapshot)
		throw new Error("Copied context epoch boundary is unavailable");
	if (copied.entries.length > limits.maxEntries || checkpoint.views.length > limits.maxEntries)
		throw new Error("Copied context epoch item budget exceeded");
	stringifyBoundedJson(copied, limits.maxSourceBytes);
	const oldByRevision = new Map([...oldById.values()].map((source) => [source.revision, source]));
	const destination = new Map<string, IndexedSourceEvent>();
	for (const source of oldById.values()) {
		const actual = await history.get(source.id);
		if (actual) destination.set(source.id, actual);
	}
	const prefixViews = new Map<string, SessionHistoryReadView>();
	const prefix = async (source: SourceSnapshotRef): Promise<SessionHistoryReadView> => {
		if (
			source.sessionId !== copied.sessionId ||
			source.sessionFile !== copied.sessionFile ||
			!source.persistent ||
			!Number.isSafeInteger(source.sourceSequence) ||
			source.sourceSequence < 0 ||
			source.sourceSequence > copied.through
		)
			throw new Error("Copied epoch recipe is outside the captured old source");
		const key = JSON.stringify(source);
		const existing = prefixViews.get(key);
		if (existing) return existing;
		let leafId = source.leafId;
		if (leafId !== null && (!oldById.has(leafId) || oldById.get(leafId)!.sequence > source.sourceSequence))
			throw new Error("Copied epoch leaf is outside its captured prefix");
		const seen = new Set<string>();
		while (leafId !== null && !destination.has(leafId)) {
			if (seen.has(leafId)) throw new Error("Copied epoch parent path is unresolved");
			seen.add(leafId);
			const old = oldById.get(leafId);
			if (!old) throw new Error("Copied epoch parent source is unavailable");
			leafId = old.parentId;
		}
		const rows = [...oldById.values()]
			.filter((old) => old.sequence <= source.sourceSequence)
			.flatMap((old) => {
				const actual = destination.get(old.id);
				return actual ? [actual] : [];
			});
		const last = rows.reduce<IndexedSourceEvent | undefined>(
			(previous, actual) => (!previous || actual.sequence > previous.sequence ? actual : previous),
			undefined,
		);
		if (!last) throw new Error("Copied epoch prefix has no preserved source");
		const narrowed = await view.atSnapshot!({ ...view.source, leafId, sourceSequence: last.sequence });
		prefixViews.set(key, narrowed);
		return narrowed;
	};
	await prefix(checkpoint.source);
	const views: EpochViewReference[] = [];
	for (const pinned of checkpoint.views) {
		const old = oldById.get(pinned.ref.entryId);
		if (
			!old ||
			old.revision !== pinned.ref.revision ||
			old.sequence !== pinned.ref.sequence ||
			old.kind !== pinned.ref.kind ||
			!isDeepStrictEqual(old.locator, pinned.ref.locator)
		)
			throw new Error("Copied epoch recipe does not match its captured source");
		const read = await prefix(pinned.source);
		const actual = await read.get(old.id);
		if (!actual || actual.kind !== old.kind) throw new Error("Copied epoch view source is unavailable");
		const ref: ContextRef = {
			entryId: actual.id,
			sequence: actual.sequence,
			kind: pinned.ref.kind,
			locator: { ...actual.locator },
			revision: actual.revision,
			authority: actual.authority,
			qualification: actual.qualification,
			retention: actual.retention,
		};
		let sourceRevision = actual.revision;
		if (ref.kind !== "compaction") {
			const original: unknown = JSON.parse(pinned.sourceRevision);
			if (
				!Array.isArray(original) ||
				original[0] !== old.revision ||
				original.some((revision) => typeof revision !== "string")
			)
				throw new Error("Copied epoch frozen revisions are unavailable");
			const updates = old.updateTarget ? (await read.contextUpdates(old.updateTarget)).refs : [];
			const expected = original.slice(1).map((revision) => oldByRevision.get(revision));
			if (
				expected.some((source) => !source || source.sequence > pinned.source.sourceSequence) ||
				!isDeepStrictEqual(
					expected.map((source) => source!.id),
					updates.map((source) => source.entryId),
				)
			)
				throw new Error("Copied epoch update sources were not preserved");
			sourceRevision = JSON.stringify([actual.revision, ...updates.map((update) => update.revision)]);
		} else if (pinned.sourceRevision !== old.revision || pinned.retainedMessageCount === undefined) {
			throw new Error("Copied epoch summary source is unavailable");
		}
		views.push({
			source: read.source,
			ref,
			sourceRevision,
			...(pinned.retainedMessageCount === undefined ? {} : { retainedMessageCount: pinned.retainedMessageCount }),
			...(pinned.rendering === undefined ? {} : { rendering: pinned.rendering }),
		});
	}
	if (!(await view.get(checkpoint.literalTailId))) throw new Error("Copied epoch literal tail is unavailable");
	const tasks = await readTaskStateFromView(view, {
		maxItems: limits.maxEntries,
		maxSourceBytes: limits.maxSourceBytes,
		maxViewBytes: limits.maxSourceBytes,
	});
	const taskFrame = compileTaskFrame(tasks, taskFrameLimits({ maxBytes: Math.min(16_384, limits.maxSourceBytes) }));
	const lowered =
		copied.retained || origin.retention === "retained-import" || hydrated.source.retention === "retained-import";
	const inherited =
		checkpoint.version === 5 && lowered ? { ...checkpoint, pendingRequestContract: undefined } : checkpoint;
	const { replayContract, publicWindow: _publicWindow, continuation, ...unchanged } = inherited;
	const rebuiltContinuation = continuation
		? {
				kind: continuation.kind,
				publicTailThrough: (await prefix(continuation.publicTailThrough)).source,
			}
		: undefined;
	const rebuilt = snapshotContextEpoch(
		{
			...unchanged,
			source: view.source,
			views,
			taskFrame,
			resourceRevision: undefined, // Explicit copies must capture their destination owner anew.
			...(rebuiltContinuation ? { continuation: rebuiltContinuation } : {}),
			...(!lowered && replayContract !== undefined ? { replayContract } : {}),
		},
		limits.maxSourceBytes,
	);
	return {
		checkpoint: rebuilt,
		tokensBefore: entry.tokensBefore,
		...(checkpoint.includeSummary
			? {
					summary: {
						summary: entry.summary,
						details: { ...entry.details },
						fromHook: entry.fromHook,
						customInstructions: entry.customInstructions, // The copied original alone retains its model usage.
					},
				}
			: {}),
	};
}
