import { type ChildProcess, fork } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "../config.js";
import { assertProductStatePath } from "../runtime-paths.js";

/** Derived metadata only. Exact evidence remains at the canonical source locator. */
export interface IndexedSourceEvent {
	id: string;
	sequence: number;
	parentId: string | null;
	kind: string;
	authority: "user" | "runtime" | "assistant" | "imported";
	locator: { path: string; offset: number; length: number };
	revision: string;
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

export type HistoryIndexRequest =
	| { id: number; action: "apply"; sessionId: string; events: IndexedSourceEvent[]; committedThrough: number }
	| { id: number; action: "get"; sessionId: string; eventId: string }
	| { id: number; action: "page"; sessionId: string; after: number; limit: number; through: number }
	| { id: number; action: "search"; sessionId: string; query: string; limit: number; through: number }
	| { id: number; action: "clear"; sessionId: string }
	| { id: number; action: "close" };

type Response = { id: number; result?: unknown; error?: string } | { ready: true };
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
	private pending = new Map<
		number,
		{ bytes: number; resolve: (result: unknown) => void; reject: (error: Error) => void }
	>();
	private ready: Promise<void>;

	static async open(path: string, options: { nodeExecutable?: string } = {}): Promise<HistoryIndex> {
		const index = new HistoryIndex(path, options);
		await index.ready;
		return index;
	}

	private constructor(path: string, options: { nodeExecutable?: string }) {
		assertProductStatePath(path);
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const entrypoint = workerPath();
		const nodeExecutable = options.nodeExecutable ?? ("bun" in process.versions ? "node" : process.execPath);
		this.child = fork(entrypoint, [path], {
			execPath: nodeExecutable,
			execArgv: [
				"--experimental-sqlite",
				"--disable-warning=ExperimentalWarning",
				...(entrypoint.endsWith(".ts") ? ["--experimental-strip-types"] : []),
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
		this.child.on("error", fail);
		this.child.on("exit", (code) =>
			fail(new Error(`History-index worker exited (${code})${diagnostics ? `: ${diagnostics}` : ""}`)),
		);
		this.child.on("message", (message: Response) => {
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
		if (this.closed) throw new Error("History index is closed");
		if (
			("sessionId" in message && message.sessionId.length > 512) ||
			(message.action === "get" && message.eventId.length > 512) ||
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
	async get(sessionId: string, eventId: string): Promise<IndexedSourceEvent | undefined> {
		return (await this.request({ id: this.nextId++, action: "get", sessionId, eventId })) as
			| IndexedSourceEvent
			| undefined;
	}
	async page(sessionId: string, after: number, through: number, limit = 64): Promise<HistoryIndexPage> {
		return (await this.request({
			id: this.nextId++,
			action: "page",
			sessionId,
			after,
			through,
			limit,
		})) as HistoryIndexPage;
	}
	async search(sessionId: string, query: string, through: number, limit = 16): Promise<HistoryIndexPage> {
		return (await this.request({
			id: this.nextId++,
			action: "search",
			sessionId,
			query,
			through,
			limit,
		})) as HistoryIndexPage;
	}
	async clear(sessionId: string): Promise<void> {
		await this.request({ id: this.nextId++, action: "clear", sessionId });
	}
	async close(): Promise<void> {
		if (this.closed) return;
		try {
			await this.request({ id: this.nextId++, action: "close" });
		} finally {
			this.closed = true;
		}
	}
}
