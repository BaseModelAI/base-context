import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentSession } from "./agent-session.js";
import type { AgentSessionRuntimeConfig } from "./agent-session-config.js";
import type {
	AgentSessionCreationOptions,
	AgentSessionRuntimeDiagnostic,
	AgentSessionServices,
} from "./agent-session-services.js";
import { isNoModelsAvailableMessage } from "./auth-guidance.js";
import type { ReplacedSessionContext, SessionShutdownEvent, SessionStartEvent } from "./extensions/index.js";
import { emitSessionShutdownEvent } from "./extensions/runner.js";
import type {
	CreateRlmSubagentRuntimeOptions,
	RlmChildAdmission,
	RlmSubagentRuntime,
	SubagentRuntimeHost,
} from "./rlm-runtime.js";
import type { CreateAgentSessionResult } from "./sdk.js";
import { assertSessionCwdExists } from "./session-cwd.js";
import { SessionImportFileNotFoundError } from "./session-import-errors.js";
import { acquireSessionLease, canonicalSessionPath, type SessionLease } from "./session-lease.js";
import { SessionManager } from "./session-manager.js";

export { SessionImportFileNotFoundError } from "./session-import-errors.js";

export interface CreateAgentSessionRuntimeResult extends CreateAgentSessionResult {
	services: AgentSessionServices;
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

export type CreateAgentSessionRuntimeFactory = (options: {
	cwd: string;
	agentDir: string;
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
	sessionConfig?: AgentSessionRuntimeConfig;
	sessionOptions?: AgentSessionCreationOptions;
}) => Promise<CreateAgentSessionRuntimeResult>;

export type AgentSessionRuntimeKind = "top-level" | "subagent";

export interface AgentSessionRuntimeMetadata {
	kind: AgentSessionRuntimeKind;
	createdAt: number;
	parentActiveSessionId?: string;
	parentSessionId?: string;
	parentSessionFile?: string;
	rlmChildId?: string;
	rlmParentNodeId?: string;
	rehydratedCompleted?: boolean;
	prompt?: string;
	spawnCode?: string;
	sessionDir?: string;
}

function extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") {
		return content;
	}

	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

export interface AgentSessionRuntimeDisposeOptions {
	/** Set false when the session's artifact dir is deleted right after disposal (default true). */
	kernelSnapshot?: boolean;
}

export class AgentSessionRuntime implements SubagentRuntimeHost {
	private rebindSession?: (session: AgentSession) => Promise<void>;
	private readonly sessionReplacedListeners = new Set<(session: AgentSession) => void | Promise<void>>();
	private runtimeEnvScope?: <T>(fn: () => Promise<T>) => Promise<T>;
	private beforeSessionInvalidate?: () => void;
	private subagentRuntimeHost?: SubagentRuntimeHost;
	private subagentRuntimes = new Map<string, AgentSessionRuntime>();
	private disposePromise?: Promise<void>;
	private autoRefineAdmissionClosed = false;

	constructor(
		private _session: AgentSession,
		private _services: AgentSessionServices,
		private readonly createRuntime: CreateAgentSessionRuntimeFactory,
		private _diagnostics: AgentSessionRuntimeDiagnostic[] = [],
		private _modelFallbackMessage?: string,
		private readonly sessionConfig?: AgentSessionRuntimeConfig,
		private readonly _metadata: AgentSessionRuntimeMetadata = {
			kind: "top-level",
			createdAt: Date.now(),
		},
		private _sessionLease?: SessionLease,
	) {
		this.bindRuntimeHost();
	}

	get services(): AgentSessionServices {
		return this._services;
	}

	get session(): AgentSession {
		return this._session;
	}

	get requests() {
		return this._session.requests;
	}

	get cwd(): string {
		return this._services.cwd;
	}

	get diagnostics(): readonly AgentSessionRuntimeDiagnostic[] {
		return this._diagnostics;
	}

	get modelFallbackMessage(): string | undefined {
		// The "no models available" warning describes session state, not a
		// startup event: once the session gains a model (set_model, /login,
		// onboarding), the stored snapshot is stale and must not reach clients.
		if (isNoModelsAvailableMessage(this._modelFallbackMessage) && this._session.model) {
			return undefined;
		}
		return this._modelFallbackMessage;
	}

	get metadata(): AgentSessionRuntimeMetadata {
		return { ...this._metadata };
	}

	get runtimeConfig(): AgentSessionRuntimeConfig | undefined {
		return this.sessionConfig ? { ...this.sessionConfig } : undefined;
	}

	setRebindSession(rebindSession?: (session: AgentSession) => Promise<void>): void {
		this.rebindSession = rebindSession;
	}

	onSessionReplaced(listener: (session: AgentSession) => void | Promise<void>): () => void {
		this.sessionReplacedListeners.add(listener);
		return () => this.sessionReplacedListeners.delete(listener);
	}

	/**
	 * Host-installed scope wrapping every runtime rebuild (new/switch/fork/
	 * import and subagent creation), during which extensions re-load. The
	 * daemon uses it to apply the session's client env for load-time captures.
	 */
	setRuntimeEnvScope(scope?: <T>(fn: () => Promise<T>) => Promise<T>): void {
		this.runtimeEnvScope = scope;
	}

	private scopedBuild<T>(fn: () => Promise<T>): Promise<T> {
		return this.runtimeEnvScope ? this.runtimeEnvScope(fn) : fn();
	}

	setSubagentRuntimeHost(host?: SubagentRuntimeHost): void {
		this.subagentRuntimeHost = host;
		this.bindRuntimeHost();
	}

	/**
	 * Set a synchronous callback that runs after `session_shutdown` handlers finish
	 * but before the current session is invalidated.
	 *
	 * This is for host-owned UI teardown that must not yield to the event loop,
	 * such as detaching extension-provided TUI components before the old extension
	 * context becomes stale.
	 */
	setBeforeSessionInvalidate(beforeSessionInvalidate?: () => void): void {
		this.beforeSessionInvalidate = beforeSessionInvalidate;
	}

	private async emitBeforeSwitch(
		reason: "new" | "resume",
		targetSessionFile?: string,
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_switch")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_switch",
			reason,
			targetSessionFile,
		});
		return { cancelled: result?.cancel === true };
	}

	private async emitBeforeFork(
		runner: AgentSession["extensionRunner"],
		entryId: string,
		options: { position: "before" | "at" },
	): Promise<{ cancelled: boolean }> {
		if (!runner.hasHandlers("session_before_fork")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_fork",
			entryId,
			...options,
		});
		return { cancelled: result?.cancel === true };
	}

	private async teardownCurrent(reason: SessionShutdownEvent["reason"], targetSessionFile?: string): Promise<void> {
		await emitSessionShutdownEvent(this.session.extensionRunner, {
			type: "session_shutdown",
			reason,
			targetSessionFile,
		});
		this.beforeSessionInvalidate?.();
		// Await the kernel's final snapshot flush before invalidating the session.
		await this.session.disposeAsync();
		await this.disposeHostedSubagentRuntimes();
	}

	/** Native EOF closes new opportunistic work, including a session replaced by an already accepted command. */
	closeAutoRefineAdmission(): void {
		this.autoRefineAdmissionClosed = true;
		this._session.closeAutoRefineAdmission();
	}

	private bindRuntimeHost(): void {
		if (this.autoRefineAdmissionClosed) this._session.closeAutoRefineAdmission();
		this._session.setSubagentRuntimeHost(this.subagentRuntimeHost ?? this);
	}

	private apply(result: CreateAgentSessionRuntimeResult): void {
		this._session = result.session;
		this._services = result.services;
		this._diagnostics = result.diagnostics;
		this._modelFallbackMessage = result.modelFallbackMessage;
		this.bindRuntimeHost();
	}

	private acquireReplacementLease(sessionPath: string | undefined): SessionLease | undefined {
		if (sessionPath && this._sessionLease?.sessionPath === canonicalSessionPath(sessionPath)) {
			return this._sessionLease;
		}
		return acquireSessionLease(sessionPath, this.services.agentDir);
	}

	private releaseUncommittedLease(lease: SessionLease | undefined): void {
		if (lease !== this._sessionLease) {
			lease?.release();
		}
	}

	private releaseSessionLease(): void {
		this._sessionLease?.release();
		this._sessionLease = undefined;
	}

	private commitReplacementLease(lease: SessionLease | undefined): void {
		if (lease === this._sessionLease) {
			return;
		}
		const previous = this._sessionLease;
		this._sessionLease = lease;
		previous?.release();
	}

	private async replaceWithManager(
		sessionManager: SessionManager,
		source: { session: AgentSession; sessionFile: string | undefined; agentDir: string },
		reason: "new" | "resume" | "fork",
		teardown = true,
		setup?: (manager: SessionManager) => Promise<void>,
	): Promise<void> {
		let lease: SessionLease | undefined;
		let result: CreateAgentSessionRuntimeResult | undefined;
		try {
			if (this.session !== source.session) throw new Error("Session changed before replacement");
			lease = this.acquireReplacementLease(sessionManager.getSessionFile());
			if (teardown) await this.teardownCurrent(reason, sessionManager.getSessionFile());
			result = await this.scopedBuild(() =>
				this.createRuntime({
					cwd: sessionManager.getCwd(),
					agentDir: source.agentDir,
					sessionManager,
					sessionStartEvent: { type: "session_start", reason, previousSessionFile: source.sessionFile },
					sessionConfig: this.sessionConfig,
				}),
			);
			await result.session.initialize();
			if (setup) {
				await setup(sessionManager);
				await sessionManager.flushNow();
				result.session.agent.state.messages = (await result.session.buildSessionContext()).messages;
			}
			if (this.session !== source.session) throw new Error("Session changed during replacement");
			this.apply(result);
			this.commitReplacementLease(lease);
		} catch (error) {
			try {
				if (result) await result.session.disposeAsync();
				else await sessionManager.close();
			} finally {
				this.releaseUncommittedLease(lease);
			}
			throw error;
		}
	}

	private async disposeSubagentRuntimes(): Promise<void> {
		const runtimes = [...this.subagentRuntimes.values()];
		this.subagentRuntimes.clear();
		let disposeError: unknown;
		for (const runtime of runtimes) {
			try {
				await runtime.dispose();
			} catch (error) {
				disposeError ??= error;
			}
		}
		if (disposeError) {
			throw disposeError;
		}
	}

	private async disposeHostedSubagentRuntimes(): Promise<void> {
		let disposeError: unknown;
		try {
			await this.subagentRuntimeHost?.disposeRlmSubagentRuntimes?.();
		} catch (error) {
			disposeError ??= error;
		}
		try {
			await this.disposeSubagentRuntimes();
		} catch (error) {
			disposeError ??= error;
		}
		if (disposeError) {
			throw disposeError;
		}
	}

	listSubagentRuntimes(): readonly AgentSessionRuntime[] {
		return [...this.subagentRuntimes.values()];
	}

	async createRlmSubagentRuntime(options: CreateRlmSubagentRuntimeOptions): Promise<RlmSubagentRuntime> {
		const requestTokenBudget =
			options.requestTokenBudget === undefined
				? options.parentSession.requests.getRequestTokenBudgetOptions()
				: structuredClone(options.requestTokenBudget);
		if (requestTokenBudget !== undefined) options = { ...options, requestTokenBudget };
		const admission = options.admission ?? options.parentSession.reserveRlmChildAdmission();
		try {
			if (admission.parent !== options.parentSession)
				throw new Error("RLM child admission belongs to another parent");
			admission.assertCurrent();
			admission.claimFactory();
			return await this.createAdmittedRlmSubagentRuntime({ ...options, admission });
		} finally {
			if (!options.admission) admission.settle();
		}
	}

	private async createAdmittedRlmSubagentRuntime(
		options: CreateRlmSubagentRuntimeOptions & { admission: RlmChildAdmission },
	): Promise<RlmSubagentRuntime> {
		options.admission.assertCurrent();
		const parent = options.parentSession;
		const parentSessionFile = parent.sessionFile;
		const parentSessionId = parent.sessionId;
		const parentAgent = parent.sessionName ?? parentSessionId;
		const agentDir = this.services.agentDir;
		const sessionManager = await SessionManager.create(parent.sessionManager.getCwd(), options.sessionDir, {
			parentSession: parentSessionFile,
			rlmDepth: options.rlmDepth,
		});
		let runtime: AgentSessionRuntime;
		let factoryStarted = false;
		try {
			options.admission.assertCurrent();
			factoryStarted = true;
			runtime = await this.scopedBuild(() =>
				createAgentSessionRuntime(this.createRuntime, {
					cwd: sessionManager.getCwd(),
					agentDir,
					sessionManager,
					sessionStartEvent: { type: "session_start", reason: "startup" },
					sessionConfig: this.sessionConfig,
					sessionOptions: {
						...(options.requestTokenBudget === undefined
							? {}
							: { requestTokenBudget: options.requestTokenBudget }),
						model: options.model,
						thinkingLevel: options.thinkingLevel,
						serviceTier: options.serviceTier,
						scopedModels: options.scopedModels,
						initialActiveToolNames: options.activeToolNames,
						allowedToolNames: options.allowedToolNames,
						customTools: options.customTools,
						includeGoals: options.includeGoals,
						includeCompactSkill: options.includeCompactSkill,
						rlmDepth: options.rlmDepth,
						rlmMaxDepth: options.rlmMaxDepth,
						rlmSessionDir: options.sessionDir,
						rlmParentNodeId: options.rlmParentNodeId,
						rlmParentAgent: parentAgent,
						rlmChildAdmission: options.admission,
						semanticParentSessionId: parentSessionId,
						semanticSpawnedByRequestId: options.spawnedByRequestId,
					},
					runtimeMetadata: {
						kind: "subagent",
						createdAt: Date.now(),
						parentSessionId: parentSessionId,
						parentSessionFile: parentSessionFile,
						rlmChildId: options.id,
						rlmParentNodeId: options.rlmParentNodeId,
						prompt: options.prompt,
						spawnCode: options.spawnCode,
						sessionDir: options.sessionDir,
					},
				}),
			);
		} catch (error) {
			try {
				await sessionManager.close();
				if (!factoryStarted) options.admission.confirmUnboundCleanup();
			} catch (cleanupError) {
				if (cleanupError === error || (error instanceof AggregateError && error.errors.includes(cleanupError)))
					throw error;
				throw new AggregateError([error, cleanupError], "RLM startup and cleanup failed");
			}
			throw error;
		}
		this.subagentRuntimes.set(options.id, runtime);
		try {
			await runtime.session.bindExtensions({});
			if (options.parentSession.getRlmChildRunStatus(options.id) === "cancelled") {
				throw new Error("RLM subagent startup was cancelled");
			}
			if (runtime.session.sessionName !== options.sessionName) {
				await runtime.session.setSessionName(options.sessionName);
			}
			if (parent.getRlmChildRunStatus(options.id) === "cancelled") {
				throw new Error("RLM subagent startup was cancelled");
			}
			options.admission.bind(runtime.session);
			options.admission.assertCurrent();
			options.onSessionPublished?.(runtime.session);
		} catch (error) {
			this.subagentRuntimes.delete(options.id);
			try {
				await runtime.dispose();
			} catch (cleanupError) {
				if (cleanupError === error || (error instanceof AggregateError && error.errors.includes(cleanupError)))
					throw error;
				throw new AggregateError([error, cleanupError], "RLM startup and cleanup failed");
			}
			throw error;
		}
		return runtime;
	}

	async deleteRlmSubagentRuntime(childId: string, session: AgentSession): Promise<void> {
		const runtime = this.subagentRuntimes.get(childId);
		if (!runtime) {
			await session.disposeAsync();
			return;
		}
		this.subagentRuntimes.delete(childId);
		const shouldDisposeStaleSession = runtime.session !== session;
		try {
			await runtime.dispose();
		} finally {
			if (shouldDisposeStaleSession) {
				await session.disposeAsync();
			}
		}
	}

	private async finishSessionReplacement(withSession?: (ctx: ReplacedSessionContext) => Promise<void>): Promise<void> {
		if (this.rebindSession) {
			await this.rebindSession(this.session);
		}
		for (const listener of this.sessionReplacedListeners) {
			await listener(this.session);
		}
		if (withSession) {
			await withSession(this.session.createReplacedSessionContext());
		}
	}

	private assertCanReplaceSession(): void {
		if (this.metadata.kind === "subagent" || this.session.hasRlmParentAdmission) {
			throw new Error("Owned child-runtime replacement is unavailable; dispose or passivate the child instead");
		}
	}

	async switchSession(
		sessionPath: string,
		options?: { cwdOverride?: string; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean }> {
		this.assertCanReplaceSession();
		const source = { session: this.session, sessionFile: this.session.sessionFile, agentDir: this.services.agentDir };
		const fallbackCwd = this.cwd;
		const cwdOverride = options?.cwdOverride;
		const withSession = options?.withSession;
		const samePath =
			source.sessionFile !== undefined &&
			canonicalSessionPath(source.sessionFile) === canonicalSessionPath(sessionPath);
		const beforeResult = await this.emitBeforeSwitch("resume", sessionPath);
		if (beforeResult.cancelled) return beforeResult;
		if (this.session !== source.session) throw new Error("Session changed before replacement");

		if (samePath) {
			const view = await SessionManager.openReadOnly(sessionPath, undefined, cwdOverride);
			try {
				assertSessionCwdExists(view, fallbackCwd);
			} finally {
				await view.close();
			}
			await this.teardownCurrent("resume", sessionPath);
		}
		const sessionManager = await SessionManager.open(sessionPath, undefined, cwdOverride);
		try {
			assertSessionCwdExists(sessionManager, fallbackCwd);
		} catch (error) {
			await sessionManager.close();
			throw error;
		}
		await this.replaceWithManager(sessionManager, source, "resume", !samePath);
		await this.finishSessionReplacement(withSession);
		return { cancelled: false };
	}

	async newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }> {
		this.assertCanReplaceSession();
		const source = { session: this.session, sessionFile: this.session.sessionFile, agentDir: this.services.agentDir };
		const cwd = this.cwd;
		const sessionDir = source.session.sessionManager.getSessionDir();
		const headerOptions = options?.parentSession
			? {
					parentSession: options.parentSession,
					rlmDepth: source.session.sessionManager.getHeader()?.rlmDepth ?? source.session.rlmDepth,
				}
			: undefined;
		const setup = options?.setup;
		const withSession = options?.withSession;
		const beforeResult = await this.emitBeforeSwitch("new");
		if (beforeResult.cancelled) return beforeResult;
		const sessionManager = await SessionManager.create(cwd, sessionDir, headerOptions);
		await this.replaceWithManager(sessionManager, source, "new", true, setup);
		await this.finishSessionReplacement(withSession);
		return { cancelled: false };
	}

	async fork(
		entryId: string,
		options?: {
			position?: "before" | "at";
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
		},
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		this.assertCanReplaceSession();
		const source = { session: this.session, sessionFile: this.session.sessionFile, agentDir: this.services.agentDir };
		const rlmDepth = source.session.rlmDepth;
		const withSession = options?.withSession;
		const position = options?.position ?? "before";
		const runner = source.session.extensionRunner;
		const preparation = Promise.allSettled([
			source.session.sessionManager.prepareFork(entryId, { position, rlmDepth }),
		]);
		const [beforeResult] = await Promise.allSettled([
			this.emitBeforeFork(runner, entryId, { position }),
			preparation,
		]);
		// Join the independent source read before handling hook failure or cancellation.
		if (beforeResult.status === "rejected") throw beforeResult.reason;
		if (beforeResult.value.cancelled) {
			return { cancelled: true };
		}
		const [preparedResult] = await preparation;
		if (preparedResult.status === "rejected") throw preparedResult.reason;
		const prepared = preparedResult.value;
		if (this.session !== source.session) throw new Error("Session changed before replacement");

		let selectedText: string | undefined;
		if (position === "before") {
			const selectedEntry = prepared.selectedEntry;
			if (selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
				throw new Error("Invalid entry ID for forking");
			}
			selectedText = extractUserMessageText(selectedEntry.message.content);
		}

		const sessionManager = await prepared.create();
		await this.replaceWithManager(sessionManager, source, "fork");
		await this.finishSessionReplacement(withSession);
		return { cancelled: false, selectedText };
	}

	/**
	 * Import a session JSONL file and switch runtime state to the imported session.
	 *
	 * @returns `{ cancelled: true }` when cancelled by `session_before_switch`, otherwise `{ cancelled: false }`.
	 * @throws {SessionImportFileNotFoundError} When the input path does not exist.
	 * @throws {MissingSessionCwdError} When the imported session cwd cannot be resolved and no override is provided.
	 */
	async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		this.assertCanReplaceSession();
		const resolvedPath = resolve(inputPath);
		if (!existsSync(resolvedPath)) throw new SessionImportFileNotFoundError(resolvedPath);
		const source = { session: this.session, sessionFile: this.session.sessionFile, agentDir: this.services.agentDir };
		const sessionDir = source.session.sessionManager.getSessionDir();
		const fallbackCwd = this.cwd;
		const beforeResult = await this.emitBeforeSwitch("resume", resolvedPath);
		if (beforeResult.cancelled) return beforeResult;

		const view = await SessionManager.openReadOnly(resolvedPath, undefined, cwdOverride);
		let targetCwd: string;
		try {
			assertSessionCwdExists(view, fallbackCwd);
			targetCwd = view.getCwd();
		} finally {
			await view.close();
		}
		const sessionManager = await SessionManager.importRetainedFrom(resolvedPath, targetCwd, sessionDir);
		await this.replaceWithManager(sessionManager, source, "resume");
		await this.finishSessionReplacement();
		return { cancelled: false };
	}

	private async disposeOnce(options: AgentSessionRuntimeDisposeOptions): Promise<void> {
		let disposeError: unknown;
		try {
			await emitSessionShutdownEvent(this.session.extensionRunner, {
				type: "session_shutdown",
				reason: "quit",
			});
		} catch (error) {
			disposeError ??= error;
		}
		try {
			this.beforeSessionInvalidate?.();
		} catch (error) {
			disposeError ??= error;
		}
		try {
			// Await the kernel's final snapshot flush before tearing the session down.
			await this.session.disposeAsync({ kernelSnapshot: options.kernelSnapshot ?? true });
		} catch (error) {
			disposeError ??= error;
		}
		try {
			await this.disposeHostedSubagentRuntimes();
		} catch (error) {
			disposeError ??= error;
		}
		try {
			if (disposeError) {
				throw disposeError;
			}
		} finally {
			this.releaseSessionLease();
		}
	}

	async dispose(options?: AgentSessionRuntimeDisposeOptions): Promise<void> {
		if (!this.disposePromise) {
			this.disposePromise = this.disposeOnce(options ?? {});
		}
		await this.disposePromise;
	}
}

export async function createAgentSessionRuntime(
	createRuntime: CreateAgentSessionRuntimeFactory,
	options: {
		cwd: string;
		agentDir: string;
		sessionManager: SessionManager;
		sessionStartEvent?: SessionStartEvent;
		sessionConfig?: AgentSessionRuntimeConfig;
		sessionOptions?: AgentSessionCreationOptions;
		runtimeMetadata?: AgentSessionRuntimeMetadata;
		sessionLease?: SessionLease;
	},
): Promise<AgentSessionRuntime> {
	const { sessionLease, ...runtimeOptions } = options;
	let lease: SessionLease | undefined;
	let result: CreateAgentSessionRuntimeResult | undefined;
	try {
		lease =
			sessionLease ?? acquireSessionLease(runtimeOptions.sessionManager.getSessionFile(), runtimeOptions.agentDir);
		assertSessionCwdExists(runtimeOptions.sessionManager, runtimeOptions.cwd);
		result = await createRuntime(runtimeOptions);
		await result.session.initialize();
		return new AgentSessionRuntime(
			result.session,
			result.services,
			createRuntime,
			result.diagnostics,
			result.modelFallbackMessage,
			runtimeOptions.sessionConfig,
			runtimeOptions.runtimeMetadata,
			lease,
		);
	} catch (error) {
		const errors: unknown[] = error instanceof AggregateError ? [...error.errors] : [error];
		const initialErrorCount = errors.length;
		try {
			const admitted = runtimeOptions.sessionOptions?.rlmChildAdmission?.session;
			const failedSession =
				result?.session ?? (admitted?.sessionManager === runtimeOptions.sessionManager ? admitted : undefined);
			if (failedSession) await failedSession.disposeAsync();
			else await runtimeOptions.sessionManager.close();
		} catch (cleanupError) {
			if (!errors.includes(cleanupError)) errors.push(cleanupError);
		}
		try {
			lease?.release();
		} catch (cleanupError) {
			if (!errors.includes(cleanupError)) errors.push(cleanupError);
		}
		if (errors.length === initialErrorCount) throw error;
		throw new AggregateError(errors, "Runtime creation and cleanup failed");
	}
}

export {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./agent-session-services.js";
