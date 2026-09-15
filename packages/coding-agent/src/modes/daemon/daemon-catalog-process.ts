import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createCliSubprocessEnv, createCliSubprocessLaunchSpec } from "../../cli/subprocess-launch.js";
import { getPackageDir, isBunBinary } from "../../config.js";
import { stringifyBoundedJson } from "../../core/bounded-json.js";
import type { DeleteSessionFileResult } from "../../core/session-file-actions.js";
import { deleteSessionFile } from "../../core/session-file-actions.js";
import { readSessionInfo, type SessionInfo, SessionManager } from "../../core/session-manager.js";
import type { AgentConnectionSavedSessionScope } from "../agent-connection/types.js";
import {
	captureSavedSessionPageQuery,
	readSavedSessionPage,
	type SavedSessionPage,
	type SavedSessionPageQuery,
} from "./saved-session-page.js";

export const DAEMON_CATALOG_ROLE_ENV = "BASE_CONTEXT_INTERNAL_DAEMON_CATALOG";
const DAEMON_CATALOG_START_TIMEOUT_MS = 30_000;
const DAEMON_CATALOG_MAX_PENDING_REQUESTS = 32;
const DAEMON_CATALOG_MAX_PENDING_BYTES = 1024 * 1024;
const DAEMON_CATALOG_MAX_SHUTDOWN_BYTES = 128;

export function isDaemonCatalogSourcePath(modulePath: string, packageDir: string): boolean {
	return modulePath.startsWith(`${join(packageDir, "src")}${sep}`);
}

function resolveDaemonCatalogEntrypoint(): string {
	const packageDir = getPackageDir();
	const sourceEntrypoint = join(packageDir, "src", "modes", "daemon", "daemon-catalog-entry.ts");
	const compiledEntrypoint = join(packageDir, "dist", "modes", "daemon", "daemon-catalog-entry.js");
	const runningFromSource = isDaemonCatalogSourcePath(fileURLToPath(import.meta.url), packageDir);
	const candidates = runningFromSource
		? [sourceEntrypoint, compiledEntrypoint]
		: [compiledEntrypoint, sourceEntrypoint];
	const entrypoint = candidates.find((candidate) => existsSync(candidate));
	if (entrypoint) return entrypoint;
	throw new Error("Cannot locate the daemon catalog entrypoint");
}

interface SessionInfoWire extends Omit<SessionInfo, "created" | "modified"> {
	created: string;
	modified: string;
}

type CatalogRequest =
	| {
			type: "request";
			id: string;
			command: "list";
			cwd?: string;
			sessionDir?: string;
			page?: SavedSessionPageQuery;
			agentDir?: string;
			ledgerSessionDir?: string;
			scope?: AgentConnectionSavedSessionScope;
	  }
	| { type: "request"; id: string; command: "resolve"; selector: string; cwd: string; sessionDir?: string }
	| { type: "request"; id: string; command: "rename"; sessionPath: string; name: string }
	| { type: "request"; id: string; command: "delete"; sessionPath: string }
	| { type: "request"; id: string; command: "archive"; sessionPath: string; sessionId: string }
	| {
			type: "request";
			id: string;
			command: "mark_interrupted";
			sessionPath: string;
			activeSessionId: string;
			operations: string[];
	  }
	| { type: "request"; id: string; command: "shutdown" };

function captureCatalogRequest(request: CatalogRequest, maxBytes: number): { request: CatalogRequest; bytes: number } {
	const encoded = stringifyBoundedJson(request, maxBytes);
	return { request: JSON.parse(encoded) as CatalogRequest, bytes: Buffer.byteLength(encoded) };
}

type CatalogOutbound =
	| { type: "ready" }
	| { type: "progress"; id: string; loaded: number; total: number }
	| { type: "session"; id: string; session: SessionInfoWire }
	| { type: "response"; id: string; success: true; data?: unknown }
	| { type: "response"; id: string; success: false; error: string };

interface CatalogPageOptions {
	page: SavedSessionPageQuery;
	agentDir: string;
	ledgerSessionDir: string;
	scope: AgentConnectionSavedSessionScope;
}

interface CatalogListCallbacks {
	onProgress?: (loaded: number, total: number) => void;
	onSession?: (session: SessionInfo) => void;
}

function serializeSessionInfo(session: SessionInfo): SessionInfoWire {
	return {
		...session,
		created: session.created.toISOString(),
		modified: session.modified.toISOString(),
	};
}

function deserializeSessionInfo(session: SessionInfoWire): SessionInfo {
	return {
		...session,
		created: new Date(session.created),
		modified: new Date(session.modified),
	};
}

export function resolveCatalogSessionMatch(
	sessions: readonly SessionInfo[],
	selector: string,
): SessionInfo | undefined {
	const matches = sessions.filter((session) => session.id.startsWith(selector) || session.name === selector);
	if (matches.length > 1) {
		throw new Error(`Ambiguous session selector "${selector}"`);
	}
	return matches[0];
}

function isCatalogOutbound(value: unknown): value is CatalogOutbound {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as { type?: unknown; id?: unknown };
	return (
		candidate.type === "ready" ||
		((candidate.type === "progress" || candidate.type === "session" || candidate.type === "response") &&
			typeof candidate.id === "string")
	);
}

function isCatalogRequest(value: unknown): value is CatalogRequest {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as { type?: unknown; id?: unknown; command?: unknown };
	return (
		candidate.type === "request" &&
		typeof candidate.id === "string" &&
		(candidate.command === "list" ||
			candidate.command === "resolve" ||
			candidate.command === "rename" ||
			candidate.command === "delete" ||
			candidate.command === "archive" ||
			candidate.command === "mark_interrupted" ||
			candidate.command === "shutdown")
	);
}

function sendCatalogMessage(message: CatalogOutbound): void {
	if (process.send) {
		process.send(message);
	}
}

export function isDaemonCatalogProcess(environment: NodeJS.ProcessEnv = process.env): boolean {
	return environment[DAEMON_CATALOG_ROLE_ENV] === "1";
}

export async function runDaemonCatalogProcess(): Promise<never> {
	// Shutdown shares this queue, so admitted writes close their owner before process exit.
	let requests = Promise.resolve();
	let shuttingDown = false;
	let pendingRequests = 0;
	let pendingBytes = 0;
	process.on("disconnect", () => process.exit(0));
	process.on("message", (value: unknown) => {
		if (!isCatalogRequest(value)) {
			return;
		}
		if (shuttingDown) {
			sendCatalogMessage({
				type: "response",
				id: value.id,
				success: false,
				error: "Daemon catalog is shutting down",
			});
			return;
		}
		try {
			const shutdown = value.command === "shutdown";
			if (!shutdown && pendingRequests >= DAEMON_CATALOG_MAX_PENDING_REQUESTS)
				throw new Error("Daemon catalog pending request limit exceeded (32)");
			const captured = captureCatalogRequest(
				value,
				shutdown ? DAEMON_CATALOG_MAX_SHUTDOWN_BYTES : DAEMON_CATALOG_MAX_PENDING_BYTES - pendingBytes,
			);
			if (shutdown) shuttingDown = true;
			else {
				pendingRequests++;
				pendingBytes += captured.bytes;
			}
			requests = requests
				.then(() => handleCatalogRequest(captured.request))
				.finally(() => {
					if (!shutdown) {
						pendingRequests--;
						pendingBytes -= captured.bytes;
					}
				});
		} catch (error) {
			sendCatalogMessage({
				type: "response",
				id: value.id,
				success: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});
	sendCatalogMessage({ type: "ready" });
	return new Promise(() => {});
}

async function handleCatalogRequest(request: CatalogRequest): Promise<void> {
	try {
		switch (request.command) {
			case "list": {
				if (request.page !== undefined) {
					const page = await readSavedSessionPage(
						{
							cwd: request.cwd,
							sessionDir: request.sessionDir,
							agentDir: request.agentDir,
							ledgerSessionDir: request.ledgerSessionDir,
							scope: request.scope ?? "all",
						},
						request.page,
					);
					sendCatalogMessage({ type: "response", id: request.id, success: true, data: page });
					return;
				}
				// Existing explicit array-returning SDK/resolve callers keep their full-list semantics.
				const callbacks = {
					onProgress: (loaded: number, total: number) =>
						sendCatalogMessage({ type: "progress", id: request.id, loaded, total }),
					onSession: (session: SessionInfo) =>
						sendCatalogMessage({ type: "session", id: request.id, session: serializeSessionInfo(session) }),
				};
				const sessions = request.cwd
					? await SessionManager.list(request.cwd, request.sessionDir, callbacks)
					: await SessionManager.listAll(callbacks, request.sessionDir);
				sendCatalogMessage({
					type: "response",
					id: request.id,
					success: true,
					data: { sessions: sessions.map(serializeSessionInfo) },
				});
				return;
			}
			case "resolve": {
				const localMatch = resolveCatalogSessionMatch(
					await SessionManager.list(request.cwd, request.sessionDir),
					request.selector,
				);
				if (localMatch) {
					sendCatalogMessage({
						type: "response",
						id: request.id,
						success: true,
						data: { sessionPath: localMatch.path },
					});
					return;
				}
				const globalMatch = resolveCatalogSessionMatch(
					await SessionManager.listAll(undefined, request.sessionDir),
					request.selector,
				);
				if (globalMatch) {
					sendCatalogMessage({
						type: "response",
						id: request.id,
						success: true,
						data: { sessionPath: globalMatch.path },
					});
					return;
				}
				throw new Error(`No session found matching '${request.selector}'`);
			}
			case "rename": {
				const manager = await SessionManager.open(request.sessionPath);
				try {
					await manager.appendSessionInfo(request.name.trim());
				} finally {
					await manager.close();
				}
				sendCatalogMessage({ type: "response", id: request.id, success: true });
				return;
			}
			case "delete":
				sendCatalogMessage({
					type: "response",
					id: request.id,
					success: true,
					data: await deleteSessionFile(request.sessionPath),
				});
				return;
			case "archive": {
				const session = await readSessionInfo(request.sessionPath);
				if (!session || session.id !== request.sessionId) {
					sendCatalogMessage({
						type: "response",
						id: request.id,
						success: true,
						data: { archived: false },
					});
					return;
				}
				let archived = true;
				if (session.state?.status !== "archived") {
					const manager = await SessionManager.open(request.sessionPath);
					try {
						archived = manager.getSessionId() === request.sessionId;
						if (archived) await manager.appendSessionState({ status: "archived" });
					} finally {
						await manager.close();
					}
				}
				sendCatalogMessage({
					type: "response",
					id: request.id,
					success: true,
					data: { archived },
				});
				return;
			}
			case "mark_interrupted": {
				const manager = await SessionManager.open(request.sessionPath);
				try {
					await manager.appendCustomMessageEntry(
						"prime-agent.worker_recovery",
						"<prime_agent_worker_interrupted>\nThe isolated session worker stopped during in-flight work. The saved transcript was recovered, but uncertain model, tool, bash, or child-agent work was not replayed. Inspect external side effects before continuing.\n</prime_agent_worker_interrupted>",
						false,
						{
							activeSessionId: request.activeSessionId,
							operations: request.operations,
						},
					);
				} finally {
					await manager.close();
				}
				sendCatalogMessage({ type: "response", id: request.id, success: true });
				return;
			}
			case "shutdown":
				sendCatalogMessage({ type: "response", id: request.id, success: true });
				setImmediate(() => process.exit(0));
				return;
		}
	} catch (error) {
		sendCatalogMessage({
			type: "response",
			id: request.id,
			success: false,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export class DaemonCatalogClient {
	private child?: ChildProcess;
	private starting?: Promise<void>;
	private stopping?: Promise<void>;
	private readonly pending = new Map<
		string,
		{
			resolve: (data: unknown) => void;
			reject: (error: Error) => void;
			callbacks?: CatalogListCallbacks;
			request: CatalogRequest;
			bytes: number;
			sent: boolean;
			timeout?: ReturnType<typeof setTimeout>;
		}
	>();

	constructor(private readonly onDiagnostic: (message: string) => void) {}

	async start(): Promise<void> {
		if (this.starting) {
			return this.starting;
		}
		if (this.child?.connected) {
			return;
		}
		if (this.stopping) throw new Error("Daemon catalog is shutting down");
		this.starting = this.spawnCatalog().finally(() => {
			this.starting = undefined;
		});
		return this.starting;
	}

	list(
		cwd: string | undefined,
		sessionDir: string | undefined,
		options: CatalogPageOptions,
	): Promise<SavedSessionPage>;
	list(cwd?: string, sessionDir?: string, callbacks?: CatalogListCallbacks): Promise<SessionInfo[]>;
	async list(
		cwd?: string,
		sessionDir?: string,
		options?: CatalogListCallbacks | CatalogPageOptions,
	): Promise<SessionInfo[] | SavedSessionPage> {
		if (options && "page" in options)
			return this.request<SavedSessionPage>({
				type: "request",
				id: randomUUID(),
				command: "list",
				cwd,
				sessionDir,
				page: captureSavedSessionPageQuery(options.page),
				agentDir: options.agentDir,
				ledgerSessionDir: options.ledgerSessionDir,
				scope: options.scope,
			});
		const data = await this.request<{ sessions: SessionInfoWire[] }>(
			{ type: "request", id: randomUUID(), command: "list", cwd, sessionDir },
			options,
		);
		return data.sessions.map(deserializeSessionInfo);
	}

	async rename(sessionPath: string, name: string): Promise<void> {
		await this.request({ type: "request", id: randomUUID(), command: "rename", sessionPath, name });
	}

	async resolve(selector: string, cwd: string, sessionDir?: string): Promise<string> {
		const data = await this.request<{ sessionPath: string }>({
			type: "request",
			id: randomUUID(),
			command: "resolve",
			selector,
			cwd,
			sessionDir,
		});
		return data.sessionPath;
	}

	delete(sessionPath: string): Promise<DeleteSessionFileResult> {
		return this.request({ type: "request", id: randomUUID(), command: "delete", sessionPath });
	}

	async archive(sessionPath: string, sessionId: string): Promise<boolean> {
		const data = await this.request<{ archived: boolean }>({
			type: "request",
			id: randomUUID(),
			command: "archive",
			sessionPath,
			sessionId,
		});
		return data.archived;
	}

	async markInterrupted(sessionPath: string, activeSessionId: string, operations: string[]): Promise<void> {
		await this.request({
			type: "request",
			id: randomUUID(),
			command: "mark_interrupted",
			sessionPath,
			activeSessionId,
			operations,
		});
	}

	stop(): Promise<void> {
		if (this.stopping) return this.stopping;
		// Close ordinary admission now; one reserved control follows all admitted entries.
		this.stopping = Promise.resolve()
			.then(async () => {
				const child = this.child;
				if (!child && !this.starting) return;
				await this.request({ type: "request", id: randomUUID(), command: "shutdown" }).catch(() => undefined);
				if (child?.connected) child.disconnect();
				if (this.child === child) this.child = undefined;
			})
			.finally(() => {
				this.stopping = undefined;
			});
		return this.stopping;
	}

	private async spawnCatalog(): Promise<void> {
		let command: string;
		let args: string[];
		let environment = createCliSubprocessEnv({ ...process.env, [DAEMON_CATALOG_ROLE_ENV]: "1" });
		if (isBunBinary) {
			const launch = createCliSubprocessLaunchSpec(["--version"]);
			command = launch.command;
			args = launch.args;
		} else {
			const catalogEntry = resolveDaemonCatalogEntrypoint();
			const execArgs = catalogEntry.endsWith(".ts")
				? [...process.execArgv, "--import", createRequire(import.meta.url).resolve("tsx")]
				: process.execArgv;
			const launch = createCliSubprocessLaunchSpec([], undefined, execArgs, catalogEntry);
			command = launch.command;
			args = launch.args;
			environment = createCliSubprocessEnv(environment, catalogEntry, execArgs);
		}
		const child = spawn(command, args, {
			cwd: process.cwd(),
			env: environment,
			stdio: ["ignore", "ignore", "ignore", "ipc"],
		});
		this.child = child;
		child.on("message", (value: unknown) => this.handleMessage(value));
		child.on("error", (error) => this.handleClose(child, error));
		child.on("exit", (code, signal) =>
			this.handleClose(child, new Error(`Daemon catalog exited (${signal ?? code ?? "unknown"})`)),
		);
		await new Promise<void>((resolveReady, rejectReady) => {
			const timeout = setTimeout(() => {
				cleanup();
				const error = new Error("Timed out starting daemon catalog");
				this.handleClose(child, error);
				if (child.connected) {
					child.disconnect();
				}
				child.kill("SIGKILL");
				rejectReady(error);
			}, DAEMON_CATALOG_START_TIMEOUT_MS);
			const cleanup = () => {
				clearTimeout(timeout);
				child.off("message", onMessage);
				child.off("error", onError);
				child.off("exit", onExit);
			};
			const onMessage = (value: unknown) => {
				if (isCatalogOutbound(value) && value.type === "ready") {
					cleanup();
					resolveReady();
				}
			};
			const onError = (error: Error) => {
				cleanup();
				rejectReady(error);
			};
			const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
				onError(new Error(`Daemon catalog exited during startup (${signal ?? code ?? "unknown"})`));
			};
			child.on("message", onMessage);
			child.once("error", onError);
			child.once("exit", onExit);
		});
	}

	private async request<T = void>(request: CatalogRequest, callbacks?: CatalogListCallbacks): Promise<T> {
		const shutdown = request.command === "shutdown";
		if (!shutdown && this.stopping) throw new Error("Daemon catalog is shutting down");
		let count = 0;
		let bytes = 0;
		for (const pending of this.pending.values()) {
			if (pending.request.command === "shutdown") continue;
			count++;
			bytes += pending.bytes;
		}
		if (!shutdown && count >= DAEMON_CATALOG_MAX_PENDING_REQUESTS)
			throw new Error("Daemon catalog pending request limit exceeded (32)");
		const captured = captureCatalogRequest(
			request,
			shutdown ? DAEMON_CATALOG_MAX_SHUTDOWN_BYTES : DAEMON_CATALOG_MAX_PENDING_BYTES - bytes,
		);
		return new Promise<T>((resolveRequest, rejectRequest) => {
			this.pending.set(captured.request.id, {
				resolve: (data) => resolveRequest(data as T),
				reject: rejectRequest,
				callbacks,
				request: captured.request,
				bytes: captured.bytes,
				sent: false,
			});
			const starting = this.start();
			const child = this.child;
			void starting.then(
				() => {
					if (!child || this.child !== child) {
						this.removePending(captured.request.id)?.reject(new Error("Daemon catalog is not connected"));
						return;
					}
					this.sendPending(child);
				},
				(error: Error) => this.removePending(captured.request.id)?.reject(error),
			);
		});
	}

	private sendPending(child: ChildProcess): void {
		if (!child.connected) {
			for (const id of this.pending.keys())
				this.removePending(id)?.reject(new Error("Daemon catalog is not connected"));
			return;
		}
		// The existing map is the FIFO, including entries admitted during startup.
		for (const pending of this.pending.values()) {
			if (this.child !== child) return;
			if (pending.sent) continue;
			pending.sent = true;
			const request = pending.request;
			pending.timeout = setTimeout(
				() => {
					const expired = this.removePending(request.id);
					if (!expired) return;
					child.kill("SIGKILL");
					expired.reject(new Error(`Timed out waiting for daemon catalog ${request.command}`));
				},
				5 * 60 * 1000,
			);
			try {
				child.send(request, (error) => {
					if (error) this.removePending(request.id)?.reject(error);
				});
			} catch (error) {
				this.removePending(request.id)?.reject(error instanceof Error ? error : new Error(String(error)));
			}
		}
	}

	private removePending(id: string) {
		const pending = this.pending.get(id);
		if (pending) {
			this.pending.delete(id);
			clearTimeout(pending.timeout);
		}
		return pending;
	}

	private handleMessage(value: unknown): void {
		if (!isCatalogOutbound(value) || value.type === "ready") {
			return;
		}
		const pending = this.pending.get(value.id);
		if (!pending) {
			return;
		}
		if (value.type === "progress") {
			pending.callbacks?.onProgress?.(value.loaded, value.total);
			return;
		}
		if (value.type === "session") {
			pending.callbacks?.onSession?.(deserializeSessionInfo(value.session));
			return;
		}
		this.removePending(value.id);
		if (value.success) {
			pending.resolve(value.data);
		} else {
			pending.reject(new Error(value.error));
		}
	}

	private handleClose(child: ChildProcess, error: Error): void {
		if (this.child !== child) {
			return;
		}
		this.child = undefined;
		for (const id of this.pending.keys()) this.removePending(id)?.reject(error);
		this.onDiagnostic(error.message);
	}
}
