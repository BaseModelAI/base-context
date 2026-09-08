import { type ChildProcess, fork } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "../config.js";
import { assertProductStatePath } from "../runtime-paths.js";
import { stringifyBoundedJson } from "./bounded-json.js";
import type { JournalFrameRetention } from "./journal-frame.js";
import type { DeleteSessionFileResult } from "./session-file-removal.js";

export const SESSION_JOURNAL_MAX_RECORD_BYTES = 64 * 1024 * 1024;
export const SESSION_JOURNAL_MAX_FRAME_BYTES = SESSION_JOURNAL_MAX_RECORD_BYTES + 320;
export const SESSION_JOURNAL_CHUNK_BYTES = 64 * 1024;
export const SESSION_JOURNAL_MAX_IPC_BYTES = 128 * 1024;
const MAX_PENDING_IPC_BYTES = 1024 * 1024;
const MAX_PENDING_OPERATIONS = 32;
/** @internal Native admission and qualified canonical-copy paths only. */
export const APPEND_NATIVE_ADMISSION = Symbol("session-journal.native-admission");

export interface SessionJournalOwnerOptions {
	journalPath: string;
	create?: true;
	nodeExecutable?: string;
}

export interface SessionJournalState {
	journalPath: string;
	nextSequence: number;
	format: "legacy" | "framed";
	byteLength: number;
	checksum: string | null;
	dev: number;
	ino: number;
}

export type SessionJournalRequest =
	| { id: number; action: "begin" | "begin-admitted"; bytes: number; retention?: JournalFrameRetention }
	| { id: number; action: "chunk"; data: string }
	| { id: number; action: "commit" | "abort" | "flush" | "migrate" | "recover" | "close" };

export type SessionJournalResponse =
	| { ready: SessionJournalState }
	| { startupError: string }
	| { id: number; state?: SessionJournalState; sequence?: number; error?: string };

type ResponseResult = Extract<SessionJournalResponse, { id: number }>;

function workerPath(): string {
	const candidates = [
		fileURLToPath(new URL("./session-journal-owner-worker.js", import.meta.url)),
		fileURLToPath(new URL("./session-journal-owner-worker.ts", import.meta.url)),
		join(getPackageDir(), "dist", "core", "session-journal-owner-worker.js"),
		join(dirname(process.execPath), "core", "session-journal-owner-worker.js"),
		join(dirname(process.execPath), "session-journal-owner-worker.js"),
	];
	const path = candidates.find((candidate) => existsSync(candidate));
	if (!path) throw new Error("Base Context session journal-owner worker payload is missing");
	return path;
}

function forkWorker(options: SessionJournalOwnerOptions, remove = false): ChildProcess {
	const journalPath = assertProductStatePath(options.journalPath);
	const entrypoint = workerPath();
	const startup = stringifyBoundedJson(
		{ journalPath, create: options.create === true, parentPid: process.pid, ...(remove ? { remove: true } : {}) },
		SESSION_JOURNAL_CHUNK_BYTES,
	);
	return fork(entrypoint, [startup], {
		execPath: options.nodeExecutable ?? ("bun" in process.versions ? "node" : process.execPath),
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
}

/** Chunk transport never splits a UTF16 surrogate pair or silently replaces an invalid one. */
export function* sessionJournalUtf8Chunks(text: string): Generator<Buffer> {
	for (let start = 0; start < text.length; ) {
		let end = Math.min(start + SESSION_JOURNAL_CHUNK_BYTES / 4, text.length);
		const last = text.charCodeAt(end - 1);
		if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
		const part = text.slice(start, end);
		const bytes = Buffer.from(part, "utf8");
		if (bytes.toString("utf8") !== part) throw new Error("Session JSON contains invalid UTF16");
		yield bytes;
		start = end;
	}
}

/** Only the external Node actor writes canonical bytes; method completion is its durable acknowledgement. */
export class SessionJournalOwner {
	private readonly child: ChildProcess;
	private readonly ready: Promise<void>;
	private readonly exited: Promise<void>;
	private snapshot!: SessionJournalState;
	private accepting = true;
	private failure: Error | undefined;
	private closePromise: Promise<void> | undefined;
	private queue: Promise<void> = Promise.resolve();
	private queuedOperations = 0;
	private queuedRecordBytes = 0;
	private nextId = 1;
	private pendingBytes = 0;
	private readonly pending = new Map<
		number,
		{
			bytes: number;
			resolve: (response: ResponseResult) => void;
			reject: (error: Error) => void;
		}
	>();

	static async open(options: SessionJournalOwnerOptions): Promise<SessionJournalOwner> {
		const owner = new SessionJournalOwner(options);
		try {
			await owner.ready;
			return owner;
		} catch (error) {
			await owner.close().catch(() => undefined);
			throw error;
		}
	}

	/** Remove once under the canonical owner fence; an unknown outcome is never replayed. */
	static async remove(
		options: Pick<SessionJournalOwnerOptions, "journalPath" | "nodeExecutable">,
	): Promise<DeleteSessionFileResult> {
		const child = forkWorker(options, true);
		const exited = new Promise<void>((resolveExit) => {
			child.once("exit", () => resolveExit());
			child.once("close", () => resolveExit());
		});
		let diagnostics = "";
		child.stderr?.on("data", (data: Buffer) => {
			diagnostics = (diagnostics + data.toString()).slice(-8192);
		});
		try {
			return await new Promise<DeleteSessionFileResult>((resolveResult, rejectResult) => {
				const fail = (detail: string) =>
					rejectResult(new Error(`Session journal removal failed; outcome may be unknown: ${detail}`));
				child.once("error", (error) => {
					fail(error.message);
					child.kill();
				});
				child.on("message", (message: { removed: DeleteSessionFileResult } | { startupError: string }) => {
					if ("removed" in message) resolveResult(message.removed);
					else if ("startupError" in message) fail(message.startupError);
					else {
						fail("Unexpected worker response");
						child.kill();
					}
				});
				child.once("exit", (code, signal) =>
					fail(`worker exited (${signal ?? code})${diagnostics ? `: ${diagnostics}` : ""}`),
				);
				child.once("disconnect", () => fail("worker disconnected"));
			});
		} finally {
			await exited;
		}
	}

	private constructor(options: SessionJournalOwnerOptions) {
		this.child = forkWorker(options);
		let diagnostics = "";
		this.child.stderr?.on("data", (data: Buffer) => {
			diagnostics = (diagnostics + data.toString()).slice(-8192);
		});
		let resolveReady = () => {};
		let rejectReady: (error: Error) => void = () => {};
		this.ready = new Promise<void>((resolveResult, rejectResult) => {
			resolveReady = resolveResult;
			rejectReady = rejectResult;
		});
		this.exited = new Promise<void>((resolveExit) => {
			this.child.once("exit", () => resolveExit());
			this.child.once("close", () => resolveExit());
		});
		const fail = (error: Error) => {
			this.accepting = false;
			this.failure ??= error;
			rejectReady(this.failure);
			for (const request of this.pending.values()) request.reject(this.failure);
			this.pending.clear();
			this.pendingBytes = 0;
		};
		this.child.on("error", (error) => {
			fail(new Error(`Session journal owner failed; append outcome may be unknown: ${error.message}`));
			this.child.kill();
		});
		this.child.on("exit", (code, signal) =>
			fail(
				new Error(
					`Session journal owner exited (${signal ?? code}); append outcome may be unknown${diagnostics ? `: ${diagnostics}` : ""}`,
				),
			),
		);
		this.child.on("disconnect", () =>
			fail(new Error("Session journal owner disconnected; append outcome may be unknown")),
		);
		this.child.on("message", (message: SessionJournalResponse) => {
			if ("startupError" in message) {
				fail(new Error(`Session journal owner could not start: ${message.startupError}`));
				return;
			}
			if ("ready" in message) {
				this.snapshot = message.ready;
				resolveReady();
				return;
			}
			const request = this.pending.get(message.id);
			if (!request) return;
			this.pending.delete(message.id);
			this.pendingBytes -= request.bytes;
			if (message.state) this.snapshot = message.state;
			if (message.error !== undefined) request.reject(new Error(message.error));
			else request.resolve(message);
		});
	}

	get journalPath(): string {
		return this.snapshot.journalPath;
	}
	get nextSequence(): number {
		return this.snapshot.nextSequence;
	}
	get format(): "legacy" | "framed" {
		return this.snapshot.format;
	}

	/** A copy of the latest actor ready state or completed acknowledgement. */
	getSnapshot(): SessionJournalState {
		return { ...this.snapshot };
	}

	private request(message: SessionJournalRequest): Promise<ResponseResult> {
		if (this.failure) return Promise.reject(this.failure);
		const serialized = stringifyBoundedJson(message, SESSION_JOURNAL_MAX_IPC_BYTES);
		const bytes = Buffer.byteLength(serialized);
		if (this.pending.size >= MAX_PENDING_OPERATIONS || this.pendingBytes + bytes > MAX_PENDING_IPC_BYTES) {
			return Promise.reject(new Error("Session journal IPC queue limit reached"));
		}
		const promise = new Promise<ResponseResult>((resolveResponse, rejectResponse) => {
			this.pending.set(message.id, { bytes, resolve: resolveResponse, reject: rejectResponse });
		});
		this.pendingBytes += bytes;
		try {
			this.child.send(JSON.parse(serialized), (error) => {
				if (error) this.child.emit("error", error);
			});
		} catch (error) {
			this.child.emit("error", error instanceof Error ? error : new Error(String(error)));
		}
		return promise;
	}

	private enqueue<T>(bytes: number, action: () => Promise<T>): Promise<T> {
		if (!this.accepting || this.failure)
			return Promise.reject(this.failure ?? new Error("Session journal owner is closing or closed"));
		if (
			this.queuedOperations >= MAX_PENDING_OPERATIONS ||
			this.queuedRecordBytes + bytes > SESSION_JOURNAL_MAX_RECORD_BYTES
		) {
			return Promise.reject(new Error("Session journal queue limit reached; await admitted work"));
		}
		this.queuedOperations++;
		this.queuedRecordBytes += bytes;
		const task = this.queue.then(action).finally(() => {
			this.queuedOperations--;
			this.queuedRecordBytes -= bytes;
		});
		this.queue = task.then(
			() => {},
			() => {},
		);
		return task;
	}

	appendJson(json: string, retention?: JournalFrameRetention): Promise<{ sequence: number }> {
		return this.uploadJson(json, retention, "begin");
	}

	/** @internal The caller must bind native admission or a decoded copy to this owner. */
	[APPEND_NATIVE_ADMISSION](json: string, retention?: JournalFrameRetention): Promise<{ sequence: number }> {
		return this.uploadJson(json, retention, "begin-admitted");
	}

	private async uploadJson(
		json: string,
		retention: JournalFrameRetention | undefined,
		action: "begin" | "begin-admitted",
	): Promise<{ sequence: number }> {
		const bytes = Buffer.byteLength(json);
		if (bytes === 0 || bytes > SESSION_JOURNAL_MAX_RECORD_BYTES)
			throw new Error("Session journal record byte limit exceeded");
		return this.enqueue(bytes, async () => {
			await this.request({ id: this.nextId++, action, bytes, retention });
			try {
				for (const chunk of sessionJournalUtf8Chunks(json)) {
					await this.request({ id: this.nextId++, action: "chunk", data: chunk.toString("base64") });
				}
				const response = await this.request({ id: this.nextId++, action: "commit" });
				if (response.sequence === undefined)
					throw new Error("Session journal append acknowledgement lacks a sequence");
				return { sequence: response.sequence };
			} catch (error) {
				if (!this.failure) {
					try {
						await this.request({ id: this.nextId++, action: "abort" });
					} catch {
						/* Keep the original failed append visible. */
					}
				}
				throw error;
			}
		});
	}

	async flush(): Promise<void> {
		await this.enqueue(0, () => this.request({ id: this.nextId++, action: "flush" }));
	}

	async migrateLegacy(): Promise<void> {
		await this.enqueue(0, () => this.request({ id: this.nextId++, action: "migrate" }));
	}

	async recover(): Promise<void> {
		await this.enqueue(0, () => this.request({ id: this.nextId++, action: "recover" }));
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.accepting = false;
		this.closePromise = (async () => {
			try {
				await this.queue;
				if (!this.failure) await this.request({ id: this.nextId++, action: "close" });
			} finally {
				await this.exited;
			}
		})();
		return this.closePromise;
	}
}
