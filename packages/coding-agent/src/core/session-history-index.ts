import {
	type CanonicalPayloadCursor,
	type CanonicalPayloadFragment,
	MAX_CANONICAL_PAYLOAD_PART_BYTES,
} from "./canonical-payload-parts.js";
import {
	type BranchBootstrapState,
	type ContextManifestOptions,
	type ContextManifestPage,
	type ContextUpdates,
	type ContextUpdateTarget,
	HistoryIndex,
	type HistoryIndexPage,
	type HistoryPayloadReadOptions,
	type IndexedSourceEvent,
	type IpythonSentMessagesOptions,
	type IpythonSentMessagesPage,
	type ParentPathOptions,
	type ParentPathPage,
	type SourceBootstrapState,
	type TaskEvidenceOptions,
	type TaskEvidencePage,
} from "./history-index.js";
import type { BoundRequestSink, SourceSnapshotRef } from "./request-events.js";
import type { SessionJournalState } from "./session-journal-owner.js";
import type { SessionEntry } from "./session-manager.js";

/** One source/branch frontier shared by every operation in a captured request. */
export interface SessionHistoryReadView {
	readonly source: SourceSnapshotRef;
	/** A narrower ancestor/prefix on this same capture; its lifetime never outlives the parent read. */
	atSnapshot?(source: SourceSnapshotRef): Promise<SessionHistoryReadView>;
	contextManifest(options?: ContextManifestOptions): Promise<ContextManifestPage>;
	contextUpdates(target: ContextUpdateTarget): Promise<ContextUpdates>;
	readContextUpdatePayload(
		id: string,
		target: ContextUpdateTarget,
		options?: HistoryPayloadReadOptions,
	): Promise<CanonicalPayloadFragment | undefined>;
	get(id: string): Promise<IndexedSourceEvent | undefined>;
	page(after?: number, limit?: number): Promise<HistoryIndexPage>;
	search(query: string, limit?: number): Promise<HistoryIndexPage>;
	taskEvidence(options?: TaskEvidenceOptions): Promise<TaskEvidencePage>;
	readPayload(id: string, options?: HistoryPayloadReadOptions): Promise<CanonicalPayloadFragment | undefined>;
}

export interface BoundHistoryReadSink<View> extends Omit<BoundRequestSink, "readHistory"> {
	readHistory<T>(read: (view: View) => Promise<T>): Promise<T>;
}

export interface BoundSessionRequestSink extends BoundHistoryReadSink<SessionHistoryReadView> {}

export interface SessionHistoryReadLimits {
	maxEntries: number;
	/** Canonical frame bytes, not a decoded heap or tokenizer estimate. */
	maxSourceBytes: number;
}

export interface HydratedSessionHistoryEntry {
	entry: SessionEntry;
	/** Includes the exact locator/revision and lowering-only retention outside the payload. */
	source: IndexedSourceEvent;
}

export interface MaterializedSessionHistory {
	source: SourceSnapshotRef;
	scope: "branch" | "source";
	entries: HydratedSessionHistoryEntry[];
	sourceBytes: number;
}

/** Bootstrap refs and booleans from the same pinned branch used for exact hydration. */
export interface SessionBranchBootstrapState extends BranchBootstrapState {
	readonly source: SourceSnapshotRef;
}

/** Exact parent-chain metadata from one captured canonical source and leaf. */
export interface SessionParentPathPage extends ParentPathPage {
	readonly source: SourceSnapshotRef;
}

/** Consume iterators inside the owning read callback. Materialized results are detached. */
export interface SessionHistoryReadScope {
	readonly source: SourceSnapshotRef;
	readonly scope: "branch" | "source";
	readonly branchContext: SessionHistoryReadView;
	/** Select the captured branch even when invoked from an explicit whole-source scope. */
	branchBootstrap(): Promise<SessionBranchBootstrapState>;
	/** Chronological parent chain only; attached request evidence is not an ancestor. */
	parentPath(options?: ParentPathOptions): Promise<SessionParentPathPage>;
	/** Source scope only: use another leaf without changing the captured source or branchContext. */
	parentPathFrom(leafId: string | null, options?: ParentPathOptions): Promise<SessionParentPathPage>;
	/** Explicit whole-source relations, clipped to this captured prefix. */
	sourceLabel(targetId: string): Promise<IndexedSourceEvent | undefined>;
	sourceAssistantUsage(targetId: string): Promise<IndexedSourceEvent | undefined>;
	/** Exact sent-message refs on the original captured parent branch, even before a tool result. */
	ipythonSentMessages(toolCallId: string, options?: IpythonSentMessagesOptions): Promise<IpythonSentMessagesPage>;
	get(id: string): Promise<IndexedSourceEvent | undefined>;
	page(after?: number, limit?: number): Promise<HistoryIndexPage>;
	search(query: string, limit?: number): Promise<HistoryIndexPage>;
	readPayload(id: string, options?: HistoryPayloadReadOptions): Promise<CanonicalPayloadFragment | undefined>;
	hydrateEntry(id: string, maxSourceBytes: number): Promise<HydratedSessionHistoryEntry | undefined>;
	iterateEntries(limits: SessionHistoryReadLimits): AsyncGenerator<HydratedSessionHistoryEntry>;
	materialize(limits: SessionHistoryReadLimits): Promise<MaterializedSessionHistory>;
}

export type HistoryReadQuery = <T>(operation: () => Promise<T>) => Promise<T>;

/** Existing inference/request views remain strictly branch-scoped. */
export function createBranchHistoryReadView(
	index: HistoryIndex,
	source: SourceSnapshotRef,
	query: HistoryReadQuery,
): SessionHistoryReadView {
	const sessionId = source.sessionId;
	const scope = { leafId: source.leafId, through: source.sourceSequence };
	return Object.freeze({
		source,
		atSnapshot: async (requested: SourceSnapshotRef) => {
			const captured = Object.freeze({ ...requested });
			if (
				captured.sessionId !== sessionId ||
				captured.sessionFile !== source.sessionFile ||
				captured.persistent !== source.persistent ||
				!Number.isSafeInteger(captured.sourceSequence) ||
				captured.sourceSequence < 0 ||
				captured.sourceSequence > source.sourceSequence
			)
				throw new Error("Context epoch snapshot is outside its captured source");
			if (captured.leafId !== null) {
				const leaf = await query(() => index.get(sessionId, captured.leafId!, scope));
				if (!leaf || leaf.sequence > captured.sourceSequence)
					throw new Error("Context epoch snapshot is outside its captured branch");
			}
			return createBranchHistoryReadView(index, captured, query);
		},
		contextManifest: (options: ContextManifestOptions = {}) =>
			query(() => index.contextManifest(sessionId, scope, options)),
		contextUpdates: (target: ContextUpdateTarget) => query(() => index.contextUpdates(sessionId, scope, target)),
		readContextUpdatePayload: (id: string, target: ContextUpdateTarget, options: HistoryPayloadReadOptions = {}) =>
			query(() => index.readContextUpdatePayload(sessionId, id, scope, target, options)),
		get: (id: string) => query(() => index.get(sessionId, id, scope)),
		page: (after = 0, limit = 64) => query(() => index.page(sessionId, after, scope.through, limit, scope)),
		search: (text: string, limit = 16) => query(() => index.search(sessionId, text, scope.through, limit, scope)),
		taskEvidence: (options: TaskEvidenceOptions = {}) => query(() => index.taskEvidence(sessionId, scope, options)),
		readPayload: (id: string, options: HistoryPayloadReadOptions = {}) =>
			query(() => index.readPayload(sessionId, id, scope, options)),
	});
}

function positiveLimit(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0;
}

/** Reuse the same bounded payload/identity hydration for a captured branch adapter. */
export async function hydrateCapturedHistoryEntry(
	metadata: IndexedSourceEvent,
	maxSourceBytes: number,
	readPayload: SessionHistoryReadView["readPayload"],
): Promise<HydratedSessionHistoryEntry> {
	if (metadata.locator.length > maxSourceBytes) throw new Error("History entry source byte budget exceeded");
	const chunks: string[] = [];
	let bytes = 0;
	let cursor: CanonicalPayloadCursor | undefined;
	do {
		const fragment = await readPayload(metadata.id, {
			cursor,
			maxBytes: Math.min(MAX_CANONICAL_PAYLOAD_PART_BYTES, maxSourceBytes - bytes),
		});
		if (!fragment) throw new Error("Captured history entry payload is unavailable");
		bytes += fragment.byteLength;
		if (bytes > maxSourceBytes) throw new Error("History entry source byte budget exceeded");
		chunks.push(fragment.text);
		cursor = fragment.nextCursor ?? undefined;
	} while (cursor);
	const entry = JSON.parse(chunks.join("")) as SessionEntry;
	if (
		!entry ||
		typeof entry !== "object" ||
		entry.id !== metadata.id ||
		entry.type !== metadata.kind ||
		entry.parentId !== metadata.parentId
	)
		throw new Error("Canonical history entry does not match indexed identity");
	return { entry, source: metadata };
}

/** Source access is selected explicitly, never by widening a coordinator's branch view. */
export function createSessionHistoryReadScope(
	index: HistoryIndex,
	source: SourceSnapshotRef,
	query: HistoryReadQuery,
	scope: "branch" | "source",
): SessionHistoryReadScope {
	const sessionId = source.sessionId;
	const branch = { leafId: source.leafId, through: source.sourceSequence };
	const get = (id: string) =>
		query(() =>
			scope === "branch" ? index.get(sessionId, id, branch) : index.getSource(sessionId, id, source.sourceSequence),
		);
	const page = (after = 0, limit = 64) =>
		query(() => index.page(sessionId, after, source.sourceSequence, limit, scope === "branch" ? branch : undefined));
	const readPayload = (id: string, options: HistoryPayloadReadOptions = {}) =>
		query(() =>
			scope === "branch"
				? index.readPayload(sessionId, id, branch, options)
				: index.readSourcePayload(sessionId, id, source.sourceSequence, options),
		);

	const hydrate = (metadata: IndexedSourceEvent, maxSourceBytes: number) =>
		hydrateCapturedHistoryEntry(metadata, maxSourceBytes, readPayload);

	async function* iterateEntries(limits: SessionHistoryReadLimits): AsyncGenerator<HydratedSessionHistoryEntry> {
		const { maxEntries, maxSourceBytes } = limits;
		if (!positiveLimit(maxEntries) || !positiveLimit(maxSourceBytes))
			throw new Error("Invalid history materialization limits");
		let after = 0;
		let entries = 0;
		let sourceBytes = 0;
		while (true) {
			const selected = await page(after, Math.min(64, maxEntries - entries + 1));
			if (selected.indexedThrough < source.sourceSequence)
				throw new Error("Captured history has incomplete index coverage");
			for (const metadata of selected.events) {
				if (++entries > maxEntries) throw new Error("History entry budget exceeded");
				if (sourceBytes + metadata.locator.length > maxSourceBytes)
					throw new Error("History source byte budget exceeded");
				const hydrated = await hydrate(metadata, maxSourceBytes - sourceBytes);
				sourceBytes += metadata.locator.length;
				yield hydrated;
			}
			if (selected.nextAfter === null) return;
			after = selected.nextAfter;
		}
	}

	return Object.freeze({
		source,
		scope,
		branchContext: createBranchHistoryReadView(index, source, query),
		branchBootstrap: () => query(async () => ({ ...(await index.branchBootstrap(sessionId, branch)), source })),
		parentPath: (options: ParentPathOptions = {}) =>
			query(async () => ({ ...(await index.parentPath(sessionId, branch, options)), source })),
		parentPathFrom: (leafId: string | null, options: ParentPathOptions = {}) =>
			query(async () => {
				if (scope !== "source") throw new Error("Parent path selection requires a source-scoped history read");
				return {
					...(await index.parentPath(sessionId, { leafId, through: source.sourceSequence }, options)),
					source,
				};
			}),
		sourceLabel: (targetId: string) => query(() => index.sourceLabel(sessionId, targetId, source.sourceSequence)),
		sourceAssistantUsage: (targetId: string) =>
			query(() => index.sourceAssistantUsage(sessionId, targetId, source.sourceSequence)),
		ipythonSentMessages: (toolCallId: string, options: IpythonSentMessagesOptions = {}) =>
			query(() => index.ipythonSentMessages(sessionId, branch, toolCallId, options)),
		get,
		page,
		search: (text: string, limit = 16) =>
			query(() =>
				index.search(sessionId, text, source.sourceSequence, limit, scope === "branch" ? branch : undefined),
			),
		readPayload,
		hydrateEntry: async (id: string, maxSourceBytes: number) => {
			if (!positiveLimit(maxSourceBytes)) throw new Error("Invalid history entry source byte budget");
			const metadata = await get(id);
			return metadata ? hydrate(metadata, maxSourceBytes) : undefined;
		},
		iterateEntries: (limits: SessionHistoryReadLimits) => iterateEntries({ ...limits }),
		materialize: async (limits: SessionHistoryReadLimits) => {
			const entries: HydratedSessionHistoryEntry[] = [];
			let sourceBytes = 0;
			for await (const entry of iterateEntries(limits)) {
				entries.push(entry);
				sourceBytes += entry.source.locator.length;
			}
			return { source, scope, entries, sourceBytes };
		},
	});
}

/** A derived, coalescing feed. Canonical source ACKs do not depend on index availability. */
export class SessionHistoryIndex {
	private index?: HistoryIndex;
	private latest?: SessionJournalState;
	private indexedThrough = -1;
	private pumping?: Promise<void>;
	private failure?: unknown;
	private closing?: Promise<void>;

	constructor(
		private readonly sessionId: string,
		private readonly path: string,
	) {}

	/** Retain at most one newer snapshot while the external worker indexes a prefix. */
	publish(snapshot: SessionJournalState): void {
		if (this.closing) return;
		if (!this.latest || snapshot.nextSequence > this.latest.nextSequence) this.latest = { ...snapshot };
		this.start();
	}

	private needsWork(): boolean {
		return this.latest !== undefined && this.indexedThrough < this.latest.nextSequence - 1;
	}

	private start(): void {
		if (this.pumping || !this.needsWork()) return;
		this.failure = undefined;
		const job = this.pump();
		this.pumping = job;
		void job.then(() => {
			this.pumping = undefined;
			if (!this.failure && this.needsWork()) this.start();
		});
	}

	private async pump(): Promise<void> {
		while (this.latest && this.needsWork()) {
			const snapshot = this.latest;
			try {
				this.index ??= await HistoryIndex.open(this.path);
				const frontier = await this.index.syncSource(this.sessionId, snapshot);
				this.indexedThrough = frontier.indexedThrough;
			} catch (error) {
				this.failure = error;
				return;
			}
		}
	}

	/** Callers must apply their captured sequence/branch scope to the following query. */
	async synchronize(snapshot: SessionJournalState): Promise<HistoryIndex> {
		if (this.closing) throw new Error("Session history index is closing");
		this.publish(snapshot);
		while (this.indexedThrough < snapshot.nextSequence - 1) {
			const job = this.pumping;
			if (!job) throw this.failure ?? new Error("Session history index has incomplete coverage");
			await job;
		}
		if (!this.index) throw new Error("Session history index is unavailable");
		return this.index;
	}

	/** Internal current-owner bootstrap; never substitutes current facts for an older captured prefix. */
	async currentSourceBootstrap(snapshot: SessionJournalState): Promise<SourceBootstrapState> {
		const captured = { ...snapshot };
		const index = await this.synchronize(captured);
		return index.currentSourceBootstrap(this.sessionId, captured);
	}

	/** Finish accepted indexing, then wait for the external worker to close. */
	close(): Promise<void> {
		this.closing ??= (async () => {
			while (this.pumping) await this.pumping;
			await this.index?.close();
		})();
		return this.closing;
	}
}
