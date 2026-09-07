import type { CanonicalPayloadFragment } from "./canonical-payload-parts.js";
import {
	type ContextManifestOptions,
	type ContextManifestPage,
	type ContextUpdates,
	type ContextUpdateTarget,
	HistoryIndex,
	type HistoryIndexPage,
	type HistoryPayloadReadOptions,
	type IndexedSourceEvent,
	type TaskEvidenceOptions,
	type TaskEvidencePage,
} from "./history-index.js";
import type { BoundRequestSink, SourceSnapshotRef } from "./request-events.js";
import type { SessionJournalState } from "./session-journal-owner.js";

/** One source/branch frontier shared by every operation in a captured request. */
export interface SessionHistoryReadView {
	readonly source: SourceSnapshotRef;
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

export interface BoundSessionRequestSink extends BoundRequestSink {
	readHistory<T>(read: (view: SessionHistoryReadView) => Promise<T>): Promise<T>;
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

	/** Finish accepted indexing, then wait for the external worker to close. */
	close(): Promise<void> {
		this.closing ??= (async () => {
			while (this.pumping) await this.pumping;
			await this.index?.close();
		})();
		return this.closing;
	}
}
