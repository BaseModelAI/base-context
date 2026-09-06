import { type ChildProcess, fork } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "../config.js";
import {
	RLM_LEDGER_MAX_MUTATION_BYTES,
	RLM_LEDGER_MAX_PENDING_BYTES,
	RLM_LEDGER_MAX_PENDING_OPERATIONS,
	type RlmLedgerMutation,
} from "../modes/daemon/rlm-ledger-mutations.js";
import { assertProductStatePath } from "../runtime-paths.js";
import { stringifyBoundedJson } from "./bounded-json.js";

export interface RlmJournalOwnerOptions {
	agentDir: string;
	sessionsDir: string;
	journalPath: string;
	nodeExecutable?: string;
}

export type RlmJournalOwnerRequest =
	| { id: number; action: "mutate"; mutation: RlmLedgerMutation }
	| { id: number; action: "recover" | "migrate_legacy" | "close" };

export type RlmJournalOwnerResponse =
	| { ready: true; journalPath: string }
	| { startupError: string }
	| { id: number; error?: string };

interface PendingRequest {
	bytes: number;
	promise: Promise<void>;
	resolve: () => void;
	reject: (error: Error) => void;
}

function workerPath(): string {
	const candidates = [
		fileURLToPath(new URL("./rlm-journal-owner-worker.js", import.meta.url)),
		fileURLToPath(new URL("./rlm-journal-owner-worker.ts", import.meta.url)),
		join(getPackageDir(), "dist", "core", "rlm-journal-owner-worker.js"),
		join(dirname(process.execPath), "core", "rlm-journal-owner-worker.js"),
		join(dirname(process.execPath), "rlm-journal-owner-worker.js"),
	];
	const path = candidates.find((candidate) => existsSync(candidate));
	if (!path) throw new Error("Base Context RLM journal-owner worker payload is missing");
	return path;
}

/** Bounded RPC to the process that holds the journal's SQLite lifetime ownership lock. */
export class RlmJournalOwner {
	private readonly child: ChildProcess;
	private readonly ready: Promise<void>;
	private readonly exited: Promise<void>;
	private readonly pending = new Map<number, PendingRequest>();
	private pendingBytes = 0;
	private nextId = 1;
	private accepting = true;
	private failure: Error | undefined;
	private closePromise: Promise<void> | undefined;
	private canonicalLedgerPath: string;

	static async open(options: RlmJournalOwnerOptions): Promise<RlmJournalOwner> {
		const owner = new RlmJournalOwner(options);
		await owner.ready;
		return owner;
	}

	private constructor(options: RlmJournalOwnerOptions) {
		const startup = {
			agentDir: assertProductStatePath(options.agentDir),
			sessionsDir: assertProductStatePath(options.sessionsDir),
			journalPath: assertProductStatePath(options.journalPath),
			parentPid: process.pid,
		};
		this.canonicalLedgerPath = resolve(startup.journalPath);
		const entrypoint = workerPath();
		this.child = fork(entrypoint, [stringifyBoundedJson(startup, RLM_LEDGER_MAX_MUTATION_BYTES)], {
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
		let diagnostics = "";
		this.child.stderr?.on("data", (data: Buffer) => {
			diagnostics = (diagnostics + data.toString()).slice(-8192);
		});
		let readyResolve = () => {};
		let readyReject: (error: Error) => void = () => {};
		this.ready = new Promise<void>((resolveReady, rejectReady) => {
			readyResolve = resolveReady;
			readyReject = rejectReady;
		});
		this.exited = new Promise<void>((resolveExit) => {
			this.child.once("exit", () => resolveExit());
			this.child.once("close", () => resolveExit());
		});
		const fail = (error: Error) => {
			this.accepting = false;
			this.failure ??= error;
			readyReject(this.failure);
			for (const request of this.pending.values()) request.reject(this.failure);
			this.pending.clear();
			this.pendingBytes = 0;
		};
		this.child.on("error", (error) => {
			fail(new Error(`RLM journal owner failed; mutation outcome may be unknown: ${error.message}`));
			this.child.kill();
		});
		this.child.on("exit", (code, signal) => {
			fail(
				new Error(
					`RLM journal owner exited (${signal ?? code}); mutation outcome may be unknown${diagnostics ? `: ${diagnostics}` : ""}`,
				),
			);
		});
		this.child.on("disconnect", () => {
			fail(new Error("RLM journal owner disconnected; mutation outcome may be unknown"));
		});
		this.child.on("message", (message: RlmJournalOwnerResponse) => {
			if ("startupError" in message) {
				fail(new Error(`RLM journal owner could not start: ${message.startupError}`));
				return;
			}
			if ("ready" in message) {
				this.canonicalLedgerPath = message.journalPath;
				readyResolve();
				return;
			}
			const request = this.pending.get(message.id);
			if (!request) return;
			this.pending.delete(message.id);
			this.pendingBytes -= request.bytes;
			if (message.error) request.reject(new Error(message.error));
			else request.resolve();
		});
	}

	get ledgerPath(): string {
		return this.canonicalLedgerPath;
	}

	private request(message: RlmJournalOwnerRequest, closing = false): Promise<void> {
		if ((!this.accepting && !closing) || this.failure) {
			return Promise.reject(this.failure ?? new Error("RLM journal owner is closing or closed"));
		}
		const serialized = stringifyBoundedJson(message, RLM_LEDGER_MAX_MUTATION_BYTES + 256);
		const bytes = Buffer.byteLength(serialized);
		if (
			this.pending.size >= RLM_LEDGER_MAX_PENDING_OPERATIONS ||
			this.pendingBytes + bytes > RLM_LEDGER_MAX_PENDING_BYTES
		) {
			return Promise.reject(
				new Error("RLM journal owner queue limit reached; await pending work before admitting more"),
			);
		}
		let resolveRequest = () => {};
		let rejectRequest: (error: Error) => void = () => {};
		const promise = new Promise<void>((resolveResult, rejectResult) => {
			resolveRequest = resolveResult;
			rejectRequest = rejectResult;
		});
		this.pending.set(message.id, { bytes, promise, resolve: resolveRequest, reject: rejectRequest });
		this.pendingBytes += bytes;
		// Snapshot checked JSON before IPC; callers cannot mutate an admitted operation.
		this.child.send(JSON.parse(serialized), (error) => {
			if (!error) return;
			this.child.emit("error", error);
		});
		return promise;
	}

	async mutate(mutation: RlmLedgerMutation): Promise<void> {
		const snapshot = JSON.parse(stringifyBoundedJson(mutation, RLM_LEDGER_MAX_MUTATION_BYTES)) as RlmLedgerMutation;
		await this.request({ id: this.nextId++, action: "mutate", mutation: snapshot });
	}

	async recover(): Promise<void> {
		await this.request({ id: this.nextId++, action: "recover" });
	}

	/** Explicit retained-source migration; startup and mutation never convert legacy journals. */
	async migrateLegacy(): Promise<void> {
		await this.request({ id: this.nextId++, action: "migrate_legacy" });
	}

	/** Stop admission now, settle prior requests, then release ownership and wait for the actor to exit. */
	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.accepting = false;
		this.closePromise = (async () => {
			try {
				await Promise.allSettled([...this.pending.values()].map((request) => request.promise));
				if (!this.failure) await this.request({ id: this.nextId++, action: "close" }, true);
			} finally {
				await this.exited;
			}
		})();
		return this.closePromise;
	}
}
