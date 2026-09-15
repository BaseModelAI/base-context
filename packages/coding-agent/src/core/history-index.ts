import { type ChildProcess, fork } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "../config.js";
import { assertProductStatePath } from "../runtime-paths.js";
import type { CanonicalPayloadCursor, CanonicalPayloadFragment } from "./canonical-payload-parts.js";
import type { CatalogSourceIdentity } from "./history-source.js";
import type { JournalFrameRetention, NativeEntryQualification } from "./journal-frame.js";
import type { SessionCatalogProjection } from "./session-info-projection.js";
import type { SessionJournalState } from "./session-journal-owner.js";
import type { TaskStateProjection, TaskStateSourceRef } from "./task-state.js";

/** Derived metadata only. Exact evidence remains at the canonical source locator. */
export interface IndexedSourceEvent {
	id: string;
	sequence: number;
	parentId: string | null;
	kind: string;
	authority: "user" | "runtime" | "assistant" | "imported" | "unrecorded";
	locator: { path: string; offset: number; length: number };
	revision: string;
	/** Decoded frame qualifier, never a claim inside the payload. */
	retention?: JournalFrameRetention;
	/** Positive qualification comes only from synchronized canonical frame control. */
	qualification?: NativeEntryQualification;
	text: string;
	textComplete: boolean;
}

export interface HistoryIndexPage {
	events: IndexedSourceEvent[];
	indexedThrough: number;
	coverage: "complete" | "partial";
	truncated: boolean;
	nextAfter: number | null;
}

export interface HistoryIndexFrontier extends SessionJournalState {
	format: "framed";
	indexedThrough: number;
}

export interface HistoryIndexScope {
	leafId: string | null;
}

/** Whole-source facts for exactly the current indexed owner snapshot, not an older prefix. */
export interface SourceBootstrapState {
	leaf: IndexedSourceEvent | null;
	sessionInfo: IndexedSourceEvent | null;
	sessionState: IndexedSourceEvent | null;
	compactionCount: number;
	/** Position in the optional initial model/thinking/tier content prefix. */
	contentPrefix: number;
	hasUserContent: boolean;
}

export type SessionCatalogIndexResult =
	| { selection: "unavailable" | "stale" | "unsupported"; reason: string }
	| {
			selection: "covered";
			frontier: HistoryIndexFrontier;
			projection: SessionCatalogProjection;
			refs: {
				firstMessage: IndexedSourceEvent | null;
				name: IndexedSourceEvent | null;
				agentStatus: IndexedSourceEvent | null;
			};
	  };

/** Captured parent-chain state. Values remain in the referenced canonical payloads. */
export interface BranchBootstrapState {
	model: IndexedSourceEvent | null;
	thinkingLevel: IndexedSourceEvent | null;
	serviceTier: IndexedSourceEvent | null;
	goalState: IndexedSourceEvent | null;
	rlmMaxDepth: IndexedSourceEvent | null;
	latestCompaction: IndexedSourceEvent | null;
	contextUsageAssistant: IndexedSourceEvent | null;
	gitState: IndexedSourceEvent | null;
	agentStatus: IndexedSourceEvent | null;
	hasContextMessages: boolean;
	/** Exact message-entry presence, independent of payload truthiness. */
	hasBranchMessage: boolean;
	goalSeedable: boolean;
}

export interface TaskEvidenceCursor {
	sequence: number;
	ordinal: number;
}
export interface TaskEvidenceOptions {
	taskKey?: string;
	after?: TaskEvidenceCursor | null;
	limit?: number;
	itemId?: string;
}
export type IndexedTaskEvidence =
	| (TaskEvidenceCursor & { projection: TaskStateProjection; truncated: false })
	| (TaskEvidenceCursor & { source: TaskStateSourceRef; itemId?: string; itemIdOmitted?: true; truncated: true });
export interface TaskEvidencePage {
	entries: IndexedTaskEvidence[];
	indexedThrough: number;
	coverage: "complete" | "partial";
	/** A structured-evidence slice, never exhaustive semantic requirement extraction. */
	structuredOnly: true;
	selective: true;
	truncated: boolean;
	nextAfter: TaskEvidenceCursor | null;
}

export interface ContextManifestCursor {
	version: 1;
	sessionId: string;
	journalPath: string;
	dev: number;
	ino: number;
	leafId: string | null;
	through: number;
	throughRevision: string;
	nextOrdinal: number;
}

/** Exact canonical source ref, not a decoded message or provider-ordered item. */
export interface ContextRef {
	entryId: string;
	sequence: number;
	/** Source classification, not authority inferred from rendered message text. */
	authority?: IndexedSourceEvent["authority"];
	/** Canonical frame control, never projected from message/details payloads. */
	qualification?: NativeEntryQualification;
	retention?: JournalFrameRetention;
	kind: "message" | "custom_message" | "branch_summary" | "compaction";
	locator: IndexedSourceEvent["locator"];
	revision: string;
}
export interface ContextManifestOptions {
	cursor?: ContextManifestCursor;
	limit?: number;
}

export interface ParentPathCursor {
	version: 1;
	sessionId: string;
	journalPath: string;
	dev: number;
	ino: number;
	leafId: string | null;
	through: number;
	throughRevision: string;
	/** Zero-based depth of the next entry on the captured parent path. */
	nextDepth: number;
}
export interface ParentPathOptions {
	cursor?: ParentPathCursor;
	limit?: number;
}
export interface ParentPathPage {
	events: IndexedSourceEvent[];
	nextCursor: ParentPathCursor | null;
	totalEntries: number;
}
export type ContextManifestPage =
	| {
			selection: "known";
			summaryRef: ContextRef | null;
			activeBase: number;
			retainedMessageCount: number;
			activeMessageCount: number;
			refs: (ContextRef & { ordinal: number })[];
			order: "source";
			nextCursor: ContextManifestCursor | null;
	  }
	| {
			selection: "unresolved-lineage" | "invalid-first-kept";
			summaryRef: ContextRef | null;
			refs: [];
			order: "source";
			nextCursor: null;
	  };

export type ContextUpdateTarget =
	| { kind: "assistant-usage"; targetId: string }
	| { kind: "ipython-sent-message"; toolCallId: string };

/** A related canonical record, not a copied usage value or sent message. */
export interface ContextUpdateRef extends Omit<ContextRef, "kind"> {
	kind: "child_usage_attributed" | "custom";
}
export interface ContextUpdates {
	refs: ContextUpdateRef[];
	order: "source";
}

export interface IpythonSentMessagesCursor {
	version: 1;
	sessionId: string;
	journalPath: string;
	dev: number;
	ino: number;
	leafId: string | null;
	through: number;
	throughRevision: string;
	toolCallId: string;
	messageId: string | null;
	/** Last examined source sequence; empty pages can still make bounded progress. */
	after: number;
}
export interface IpythonSentMessagesOptions {
	messageId?: string;
	cursor?: IpythonSentMessagesCursor;
	limit?: number;
}
export interface IpythonSentMessagesPage {
	refs: ContextUpdateRef[];
	nextCursor: IpythonSentMessagesCursor | null;
}

export interface HistoryPayloadReadOptions {
	cursor?: CanonicalPayloadCursor;
	maxBytes?: number;
}

export type HistoryIndexRequest =
	| {
			id: number;
			action: "ipython_sent_messages";
			sessionId: string;
			scope: HistoryIndexScope & { through: number };
			toolCallId: string;
			options: IpythonSentMessagesOptions;
	  }
	| { id: number; action: "current_source_bootstrap"; sessionId: string; snapshot: SessionJournalState }
	| { id: number; action: "catalog"; sessionId: string; source: CatalogSourceIdentity }
	| {
			id: number;
			action: "source_label" | "source_assistant_usage";
			sessionId: string;
			targetId: string;
			through: number;
	  }
	| {
			id: number;
			action: "parent_path";
			sessionId: string;
			scope: HistoryIndexScope & { through: number };
			options: ParentPathOptions;
	  }
	| {
			id: number;
			action: "branch_bootstrap";
			sessionId: string;
			scope: HistoryIndexScope & { through: number };
	  }
	| {
			id: number;
			action: "context_updates";
			sessionId: string;
			scope: HistoryIndexScope & { through: number };
			target: ContextUpdateTarget;
	  }
	| {
			id: number;
			action: "read_context_update_payload";
			sessionId: string;
			eventId: string;
			scope: HistoryIndexScope & { through: number };
			target: ContextUpdateTarget;
			options: HistoryPayloadReadOptions;
	  }
	| {
			id: number;
			action: "context_manifest";
			sessionId: string;
			scope: HistoryIndexScope & { through: number };
			options: ContextManifestOptions;
	  }
	| {
			id: number;
			action: "read_payload";
			sessionId: string;
			eventId: string;
			scope: HistoryIndexScope & { through: number };
			options: HistoryPayloadReadOptions;
	  }
	| {
			id: number;
			action: "task_evidence";
			sessionId: string;
			scope: HistoryIndexScope & { through: number };
			options: TaskEvidenceOptions;
	  }
	| { id: number; action: "sync_source"; sessionId: string; snapshot: SessionJournalState }
	| { id: number; action: "apply"; sessionId: string; events: IndexedSourceEvent[]; committedThrough: number }
	| { id: number; action: "get"; sessionId: string; eventId: string; scope?: HistoryIndexScope & { through: number } }
	| { id: number; action: "get_source"; sessionId: string; eventId: string; through: number }
	| {
			id: number;
			action: "read_source_payload";
			sessionId: string;
			eventId: string;
			through: number;
			options: HistoryPayloadReadOptions;
	  }
	| {
			id: number;
			action: "page";
			sessionId: string;
			after: number;
			limit: number;
			through: number;
			scope?: HistoryIndexScope;
	  }
	| {
			id: number;
			action: "search";
			sessionId: string;
			query: string;
			limit: number;
			through: number;
			scope?: HistoryIndexScope;
	  }
	| { id: number; action: "clear"; sessionId: string }
	| { id: number; action: "close" };

export class HistoryIndexUnsupportedError extends Error {}

type Response =
	| { id: number; result?: unknown; error?: string }
	| { ready: true }
	| { startupError: string; unsupported: boolean };
const MAX_PENDING_BYTES = 4 * 1024 * 1024;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

function workerPath(): string {
	const candidates = [
		fileURLToPath(new URL("./history-index-worker.js", import.meta.url)),
		fileURLToPath(new URL("./history-index-worker.ts", import.meta.url)),
		join(getPackageDir(), "dist", "core", "history-index-worker.js"),
		join(dirname(process.execPath), "core", "history-index-worker.js"),
		join(dirname(process.execPath), "history-index-worker.js"),
	];
	const path = candidates.find((candidate) => existsSync(candidate));
	if (!path) throw new Error("Base Context history-index worker payload is missing");
	return path;
}

/** One bounded IPC queue; all SQLite work runs outside the agent/UI event loop. */
export class HistoryIndex {
	private child: ChildProcess;
	private nextId = 1;
	private pendingBytes = 0;
	private closed = false;
	private closing = false;
	private closePromise: Promise<void> | undefined;
	private exited: Promise<void>;
	private settled: Promise<void> = Promise.resolve();
	private pending = new Map<
		number,
		{ bytes: number; resolve: (result: unknown) => void; reject: (error: Error) => void }
	>();
	private ready: Promise<void>;

	static async open(
		path: string,
		options: { nodeExecutable?: string; readOnly?: boolean } = {},
	): Promise<HistoryIndex> {
		const index = new HistoryIndex(path, options);
		try {
			await index.ready;
			return index;
		} catch (error) {
			await index.close().catch(() => undefined);
			throw error;
		}
	}

	private constructor(path: string, options: { nodeExecutable?: string; readOnly?: boolean }) {
		assertProductStatePath(path);
		const entrypoint = workerPath();
		const nodeExecutable = options.nodeExecutable ?? ("bun" in process.versions ? "node" : process.execPath);
		this.child = fork(entrypoint, options.readOnly ? [path, "--read-only"] : [path], {
			execPath: nodeExecutable,
			execArgv: [
				"--experimental-sqlite",
				"--disable-warning=ExperimentalWarning",
				...(entrypoint.endsWith(".ts") ? ["--import", import.meta.resolve("tsx")] : []),
			],
			stdio: ["ignore", "ignore", "pipe", "ipc"],
			env: {
				PATH: process.env.PATH,
				HOME: homedir(),
				TMPDIR: tmpdir(),
				SYSTEMROOT: process.env.SYSTEMROOT,
				WINDIR: process.env.WINDIR,
			},
		});
		this.exited = new Promise<void>((resolveExit) => {
			this.child.once("exit", () => resolveExit());
			this.child.once("close", () => resolveExit());
		});
		let diagnostics = "";
		this.child.stderr?.on("data", (data: Buffer) => {
			diagnostics = (diagnostics + data.toString()).slice(-8192);
		});
		let readyResolve = () => {};
		let readyReject: (error: Error) => void = () => {};
		this.ready = new Promise<void>((resolve, reject) => {
			readyResolve = resolve;
			readyReject = reject;
		});
		const fail = (error: Error) => {
			this.closed = true;
			readyReject(error);
			for (const request of this.pending.values()) request.reject(error);
			this.pending.clear();
			this.pendingBytes = 0;
		};
		this.child.on("error", (error) => {
			fail(error);
			this.child.kill();
		});
		this.child.on("disconnect", () => {
			fail(new Error("History-index worker disconnected"));
			if (!this.closing) this.child.kill();
		});
		this.child.on("exit", (code) =>
			fail(new Error(`History-index worker exited (${code})${diagnostics ? `: ${diagnostics}` : ""}`)),
		);
		this.child.on("message", (message: Response) => {
			if ("startupError" in message) {
				fail(
					message.unsupported
						? new HistoryIndexUnsupportedError(message.startupError)
						: new Error(message.startupError),
				);
				return;
			}
			if ("ready" in message) {
				readyResolve();
				return;
			}
			const request = this.pending.get(message.id);
			if (!request) return;
			this.pending.delete(message.id);
			this.pendingBytes -= request.bytes;
			if (message.error) request.reject(new Error(message.error));
			else request.resolve(message.result);
		});
	}

	private async request(message: HistoryIndexRequest): Promise<unknown> {
		if (this.closed || (this.closing && message.action !== "close")) throw new Error("History index is closed");
		if (
			("sessionId" in message && message.sessionId.length > 512) ||
			((message.action === "get" ||
				message.action === "get_source" ||
				message.action === "read_source_payload" ||
				message.action === "read_payload" ||
				message.action === "read_context_update_payload") &&
				message.eventId.length > 512) ||
			((message.action === "source_label" || message.action === "source_assistant_usage") &&
				message.targetId.length > 512) ||
			(message.action === "ipython_sent_messages" &&
				(message.toolCallId.length > 8192 ||
					(message.options.messageId !== undefined && message.options.messageId.length > 8192))) ||
			(message.action === "search" && message.query.length > 8192)
		) {
			throw new Error("History-index request field limit exceeded");
		}
		const bytes = Buffer.byteLength(JSON.stringify(message));
		if (bytes > MAX_REQUEST_BYTES || this.pendingBytes + bytes > MAX_PENDING_BYTES || this.pending.size >= 32) {
			throw new Error("History-index queue limit reached; await pending work before admitting more");
		}
		this.pendingBytes += bytes;
		const result = new Promise<unknown>((resolve, reject) => {
			this.pending.set(message.id, { bytes, resolve, reject });
		});
		this.settled = Promise.allSettled([this.settled, result]).then(() => undefined);
		try {
			await this.ready;
			this.child.send(message, (error) => {
				if (!error) return;
				const request = this.pending.get(message.id);
				if (!request) return;
				this.pending.delete(message.id);
				this.pendingBytes -= request.bytes;
				request.reject(error);
			});
		} catch (error) {
			const request = this.pending.get(message.id);
			if (request) {
				this.pending.delete(message.id);
				this.pendingBytes -= request.bytes;
				request.reject(error instanceof Error ? error : new Error(String(error)));
			}
		}
		return result;
	}

	async apply(sessionId: string, events: IndexedSourceEvent[], committedThrough: number): Promise<void> {
		if (events.length > 128) throw new Error("Index batch limit exceeded");
		let bytes = 1024;
		const snapshots = events.map((event) => {
			if (
				!event.id ||
				event.id.length > 512 ||
				(event.parentId?.length ?? 0) > 512 ||
				event.kind.length > 128 ||
				event.revision.length > 512 ||
				event.text.length > 8192 ||
				event.locator.path.length > 4096
			) {
				throw new Error("Index record limit exceeded; use bounded source parts");
			}
			// Copy the allowlisted metadata, not extra fields or a mutable source object.
			const snapshot: IndexedSourceEvent = {
				id: event.id,
				sequence: event.sequence,
				parentId: event.parentId,
				kind: event.kind,
				authority: event.authority,
				revision: event.revision,
				...(event.retention === undefined ? {} : { retention: event.retention }),
				text: event.text,
				textComplete: event.textComplete,
				locator: { path: event.locator.path, offset: event.locator.offset, length: event.locator.length },
			};
			bytes += Buffer.byteLength(JSON.stringify(snapshot)) + 1;
			if (bytes > MAX_REQUEST_BYTES) throw new Error("Index batch byte limit exceeded");
			return snapshot;
		});
		await this.request({ id: this.nextId++, action: "apply", sessionId, events: snapshots, committedThrough });
	}
	async syncSource(sessionId: string, snapshot: SessionJournalState): Promise<HistoryIndexFrontier> {
		const target: SessionJournalState = {
			journalPath: snapshot.journalPath,
			nextSequence: snapshot.nextSequence,
			format: snapshot.format,
			byteLength: snapshot.byteLength,
			checksum: snapshot.checksum,
			dev: snapshot.dev,
			ino: snapshot.ino,
		};
		return (await this.request({
			id: this.nextId++,
			action: "sync_source",
			sessionId,
			snapshot: target,
		})) as HistoryIndexFrontier;
	}
	/** One read-only SQLite snapshot, checked against current source descriptor/frontier identity. */
	async readSessionCatalog(sessionId: string, source: CatalogSourceIdentity): Promise<SessionCatalogIndexResult> {
		return (await this.request({
			id: this.nextId++,
			action: "catalog",
			sessionId,
			source: { ...source },
		})) as SessionCatalogIndexResult;
	}
	/** Current whole-source bootstrap; equality with this exact owner snapshot is required. */
	async currentSourceBootstrap(sessionId: string, snapshot: SessionJournalState): Promise<SourceBootstrapState> {
		const target: SessionJournalState = {
			journalPath: snapshot.journalPath,
			nextSequence: snapshot.nextSequence,
			format: snapshot.format,
			byteLength: snapshot.byteLength,
			checksum: snapshot.checksum,
			dev: snapshot.dev,
			ino: snapshot.ino,
		};
		return (await this.request({
			id: this.nextId++,
			action: "current_source_bootstrap",
			sessionId,
			snapshot: target,
		})) as SourceBootstrapState;
	}
	/** Latest label control for this source target, including a clear. */
	async sourceLabel(sessionId: string, targetId: string, through: number): Promise<IndexedSourceEvent | undefined> {
		return (await this.request({ id: this.nextId++, action: "source_label", sessionId, targetId, through })) as
			| IndexedSourceEvent
			| undefined;
	}
	/** Latest stored source aggregate, without validating or replacing its payload. */
	async sourceAssistantUsage(
		sessionId: string,
		targetId: string,
		through: number,
	): Promise<IndexedSourceEvent | undefined> {
		return (await this.request({
			id: this.nextId++,
			action: "source_assistant_usage",
			sessionId,
			targetId,
			through,
		})) as IndexedSourceEvent | undefined;
	}
	async get(
		sessionId: string,
		eventId: string,
		scope?: HistoryIndexScope & { through: number },
	): Promise<IndexedSourceEvent | undefined> {
		return (await this.request({
			id: this.nextId++,
			action: "get",
			sessionId,
			eventId,
			...(scope ? { scope: { leafId: scope.leafId, through: scope.through } } : {}),
		})) as IndexedSourceEvent | undefined;
	}
	/** Whole-source metadata within a synchronized captured prefix, independent of branch selection. */
	async getSource(sessionId: string, eventId: string, through: number): Promise<IndexedSourceEvent | undefined> {
		return (await this.request({
			id: this.nextId++,
			action: "get_source",
			sessionId,
			eventId,
			through,
		})) as IndexedSourceEvent | undefined;
	}
	/** Exact ordered page; rejects if 256 candidates cannot establish the page and lookahead. */
	async page(
		sessionId: string,
		after: number,
		through: number,
		limit = 64,
		scope?: HistoryIndexScope,
	): Promise<HistoryIndexPage> {
		return (await this.request({
			id: this.nextId++,
			action: "page",
			sessionId,
			after,
			through,
			limit,
			...(scope ? { scope: { leafId: scope.leafId } } : {}),
		})) as HistoryIndexPage;
	}
	/** Selection and text-coverage scans each reject after 256 unresolved candidates. */
	async search(
		sessionId: string,
		query: string,
		through: number,
		limit = 16,
		scope?: HistoryIndexScope,
	): Promise<HistoryIndexPage> {
		return (await this.request({
			id: this.nextId++,
			action: "search",
			sessionId,
			query,
			through,
			limit,
			...(scope ? { scope: { leafId: scope.leafId } } : {}),
		})) as HistoryIndexPage;
	}
	/** Selection and import-loss scans each have a 256-candidate exact-or-refuse budget. */
	async taskEvidence(
		sessionId: string,
		scope: HistoryIndexScope & { through: number },
		options: TaskEvidenceOptions = {},
	): Promise<TaskEvidencePage> {
		const selection: TaskEvidenceOptions = {
			...(options.after ? { after: { sequence: options.after.sequence, ordinal: options.after.ordinal } } : {}),
			limit: options.limit ?? 64,
			...(options.itemId !== undefined ? { itemId: options.itemId } : {}),
			...(options.taskKey !== undefined ? { taskKey: options.taskKey } : {}),
		};
		return (await this.request({
			id: this.nextId++,
			action: "task_evidence",
			sessionId,
			scope: { leafId: scope.leafId, through: scope.through },
			options: selection,
		})) as TaskEvidencePage;
	}
	/** Chronological pages of the exact parent chain, never attached request evidence. */
	async parentPath(
		sessionId: string,
		scope: HistoryIndexScope & { through: number },
		options: ParentPathOptions = {},
	): Promise<ParentPathPage> {
		const cursor = options.cursor;
		return (await this.request({
			id: this.nextId++,
			action: "parent_path",
			sessionId,
			scope: { leafId: scope.leafId, through: scope.through },
			options: {
				...(cursor
					? {
							cursor: {
								version: cursor.version,
								sessionId: cursor.sessionId,
								journalPath: cursor.journalPath,
								dev: cursor.dev,
								ino: cursor.ino,
								leafId: cursor.leafId,
								through: cursor.through,
								throughRevision: cursor.throughRevision,
								nextDepth: cursor.nextDepth,
							},
						}
					: {}),
				...(options.limit !== undefined ? { limit: options.limit } : {}),
			},
		})) as ParentPathPage;
	}
	/** Actual parent-path sent-message refs; a tool result need not exist yet. */
	async ipythonSentMessages(
		sessionId: string,
		scope: HistoryIndexScope & { through: number },
		toolCallId: string,
		options: IpythonSentMessagesOptions = {},
	): Promise<IpythonSentMessagesPage> {
		const cursor = options.cursor;
		return (await this.request({
			id: this.nextId++,
			action: "ipython_sent_messages",
			sessionId,
			toolCallId,
			scope: { leafId: scope.leafId, through: scope.through },
			options: {
				...(options.messageId !== undefined ? { messageId: options.messageId } : {}),
				...(options.limit !== undefined ? { limit: options.limit } : {}),
				...(cursor
					? {
							cursor: {
								version: cursor.version,
								sessionId: cursor.sessionId,
								journalPath: cursor.journalPath,
								dev: cursor.dev,
								ino: cursor.ino,
								leafId: cursor.leafId,
								through: cursor.through,
								throughRevision: cursor.throughRevision,
								toolCallId: cursor.toolCallId,
								messageId: cursor.messageId,
								after: cursor.after,
							},
						}
					: {}),
			},
		})) as IpythonSentMessagesPage;
	}
	/** At most nine source refs and exact message/goal-seeding facts for the captured branch. */
	async branchBootstrap(
		sessionId: string,
		scope: HistoryIndexScope & { through: number },
	): Promise<BranchBootstrapState> {
		return (await this.request({
			id: this.nextId++,
			action: "branch_bootstrap",
			sessionId,
			scope: { leafId: scope.leafId, through: scope.through },
		})) as BranchBootstrapState;
	}
	/** Context-visible source refs; compiler ordering and LLM filtering happen after selection. */
	async contextUpdates(
		sessionId: string,
		scope: HistoryIndexScope & { through: number },
		target: ContextUpdateTarget,
	): Promise<ContextUpdates> {
		return (await this.request({
			id: this.nextId++,
			action: "context_updates",
			sessionId,
			scope: { leafId: scope.leafId, through: scope.through },
			target:
				target.kind === "assistant-usage"
					? { kind: target.kind, targetId: target.targetId }
					: { kind: target.kind, toolCallId: target.toolCallId },
		})) as ContextUpdates;
	}
	async readContextUpdatePayload(
		sessionId: string,
		eventId: string,
		scope: HistoryIndexScope & { through: number },
		target: ContextUpdateTarget,
		options: HistoryPayloadReadOptions = {},
	): Promise<CanonicalPayloadFragment | undefined> {
		return (await this.request({
			id: this.nextId++,
			action: "read_context_update_payload",
			sessionId,
			eventId,
			scope: { leafId: scope.leafId, through: scope.through },
			target:
				target.kind === "assistant-usage"
					? { kind: target.kind, targetId: target.targetId }
					: { kind: target.kind, toolCallId: target.toolCallId },
			options: { ...options, cursor: options.cursor ? { ...options.cursor } : undefined },
		})) as CanonicalPayloadFragment | undefined;
	}
	async contextManifest(
		sessionId: string,
		scope: HistoryIndexScope & { through: number },
		options: ContextManifestOptions = {},
	): Promise<ContextManifestPage> {
		return (await this.request({
			id: this.nextId++,
			action: "context_manifest",
			sessionId,
			scope: { leafId: scope.leafId, through: scope.through },
			options: {
				...(options.cursor ? { cursor: { ...options.cursor } } : {}),
				...(options.limit !== undefined ? { limit: options.limit } : {}),
			},
		})) as ContextManifestPage;
	}
	async readPayload(
		sessionId: string,
		eventId: string,
		scope: HistoryIndexScope & { through: number },
		options: HistoryPayloadReadOptions = {},
	): Promise<CanonicalPayloadFragment | undefined> {
		const selection: HistoryPayloadReadOptions = {
			...(options.cursor
				? {
						cursor: {
							frameChecksum: options.cursor.frameChecksum,
							payloadOffset: options.cursor.payloadOffset,
							byteOffset: options.cursor.byteOffset,
						},
					}
				: {}),
			...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
		};
		return (await this.request({
			id: this.nextId++,
			action: "read_payload",
			sessionId,
			eventId,
			scope: { leafId: scope.leafId, through: scope.through },
			options: selection,
		})) as CanonicalPayloadFragment | undefined;
	}
	/** Exact whole-source payload bytes, bounded by the captured prefix and fragment limit. */
	async readSourcePayload(
		sessionId: string,
		eventId: string,
		through: number,
		options: HistoryPayloadReadOptions = {},
	): Promise<CanonicalPayloadFragment | undefined> {
		const selection: HistoryPayloadReadOptions = {
			...(options.cursor
				? {
						cursor: {
							frameChecksum: options.cursor.frameChecksum,
							payloadOffset: options.cursor.payloadOffset,
							byteOffset: options.cursor.byteOffset,
						},
					}
				: {}),
			...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
		};
		return (await this.request({
			id: this.nextId++,
			action: "read_source_payload",
			sessionId,
			eventId,
			through,
			options: selection,
		})) as CanonicalPayloadFragment | undefined;
	}
	async clear(sessionId: string): Promise<void> {
		await this.request({ id: this.nextId++, action: "clear", sessionId });
	}
	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closing = true;
		this.closePromise = (async () => {
			try {
				await this.settled;
				if (!this.closed) await this.request({ id: this.nextId++, action: "close" });
			} finally {
				await this.exited;
				this.closed = true;
			}
		})();
		return this.closePromise;
	}
}
