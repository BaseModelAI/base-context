import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model, RequestTokenBudgetOptions } from "@ponythewhite/base-context-ai";
import { fauxAssistantMessage, RequestTokenBudgetError, registerFauxProvider } from "@ponythewhite/base-context-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../../src/core/agent-session.js";
import type { AgentSessionRuntimeConfig } from "../../src/core/agent-session-config.js";
import {
	AgentSessionRuntime,
	type AgentSessionServices,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.js";
import { AuthStorage } from "../../src/core/auth-storage.js";
import { GOAL_STATE_CUSTOM_TYPE } from "../../src/core/goals.js";
import type { RlmChildAdmission, SubagentRuntimeHost } from "../../src/core/rlm-runtime.js";
import {
	deriveSemanticEdges,
	readSemanticEdgeLedger,
	SEMANTIC_EDGES_LEDGER_FILENAME,
} from "../../src/core/semantic-edges.js";
import { readSessionJournal } from "../../src/core/session-journal-reader.js";
import { type RequestJournalEntry, type SessionEntry, SessionManager } from "../../src/core/session-manager.js";
import type {
	ExtensionAPI,
	ExtensionFactory,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../../src/index.js";
import { createDefaultRuntimeFactory } from "../../src/main.js";
import type { ActiveSessionState } from "../../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../../src/modes/daemon/daemon-mode.js";
import type { DaemonCommand } from "../../src/modes/daemon/daemon-protocol.js";
import { createDeferred } from "./scheduling.js";

const branchSummaryModel: Model<"openai-responses"> = {
	api: "openai-responses",
	provider: "branch-summary-fixture",
	id: "branch-summary-model",
	name: "Branch summary model",
	baseUrl: "https://branch-summary.invalid/v1",
	input: ["text"],
	reasoning: true,
	contextWindow: 128000,
	maxTokens: 32768,
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
};

type RecordedSessionEvent =
	| SessionBeforeSwitchEvent
	| SessionBeforeForkEvent
	| SessionShutdownEvent
	| SessionStartEvent;

type RuntimeSubagentMapAccess = {
	subagentRuntimes: Map<string, AgentSessionRuntime>;
};

describe("AgentSessionRuntime characterization", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeForTest(
		extensionFactory: ExtensionFactory,
		options?: {
			cwd?: string;
			bootstrapModel?: boolean;
			bootstrapThinkingLevel?: boolean;
			inMemory?: boolean;
			sessionConfig?: AgentSessionRuntimeConfig;
			sessionManager?: SessionManager;
			sessionOptions?: Parameters<CreateAgentSessionRuntimeFactory>[0]["sessionOptions"];
			onCreateRuntime?: (options: Parameters<CreateAgentSessionRuntimeFactory>[0]) => void;
		},
	) {
		const tempDir =
			options?.cwd ?? join(tmpdir(), `pi-runtime-suite-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider({
			models: [
				{ id: "faux-1", reasoning: true },
				{ id: "faux-2", reasoning: false },
			],
		});
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const serviceOptions = {
			agentDir: tempDir,
			authStorage,
			model: options?.bootstrapModel === false ? undefined : faux.getModel(),
			thinkingLevel: options?.bootstrapThinkingLevel === false ? undefined : undefined,
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
						extensionFactory(pi);
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async (runtimeOptions) => {
			options?.onCreateRuntime?.(runtimeOptions);
			const { cwd, sessionManager, sessionStartEvent } = runtimeOptions;
			const services = await createAgentSessionServices({
				...serviceOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: serviceOptions.model,
					thinkingLevel: serviceOptions.thinkingLevel,
					...runtimeOptions.sessionOptions,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager:
				options?.sessionManager ??
				(options?.inMemory
					? SessionManager.inMemory(tempDir)
					: await SessionManager.create(tempDir, join(tempDir, "sessions"))),
			sessionConfig: options?.sessionConfig,
			sessionOptions: options?.sessionOptions,
		});
		await runtime.session.bindExtensions({});

		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return { runtime, faux, tempDir };
	}

	function createRuntimeWithFakeSession(options?: { onShutdown?: () => void }) {
		const disposeSession = vi.fn();
		const session = {
			extensionRunner: {
				hasHandlers: (event: string) => event === "session_shutdown" && options?.onShutdown !== undefined,
				emit: async () => {
					options?.onShutdown?.();
				},
			},
			setSubagentRuntimeHost: vi.fn(),
			dispose: disposeSession,
			disposeAsync: disposeSession,
		} as unknown as AgentSession;
		const services = { cwd: "/tmp", agentDir: "/tmp" } as unknown as AgentSessionServices;
		const createRuntime: CreateAgentSessionRuntimeFactory = async () => {
			throw new Error("unexpected runtime creation");
		};
		const runtime = new AgentSessionRuntime(session, services, createRuntime);
		return { runtime, disposeSession };
	}

	it("passes session config to replacement runtimes", async () => {
		const calls: Array<Parameters<CreateAgentSessionRuntimeFactory>[0]> = [];
		const sessionConfig: AgentSessionRuntimeConfig = {
			cwd: "/tmp/session-config-cwd",
			model: "faux-2",
			tools: ["bash"],
		};
		const { runtime } = await createRuntimeForTest(() => {}, {
			sessionConfig,
			onCreateRuntime: (call) => calls.push(call),
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]?.sessionConfig).toBe(sessionConfig);

		await runtime.newSession();

		expect(calls).toHaveLength(2);
		expect(calls[1]?.sessionConfig).toBe(sessionConfig);
	});

	it("copies depth across new-session parent reference edges", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		const parentSession = runtime.session.sessionFile;
		if (!parentSession) throw new Error("Missing parent session file");

		await runtime.newSession({ parentSession });

		expect(runtime.session.sessionManager.getHeader()).toMatchObject({ parentSession, rlmDepth: 0 });
	});

	it("uses effective runtime depth for a parented new session from a legacy header", async () => {
		const tempDir = join(tmpdir(), `pi-runtime-legacy-new-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const sessionManager = await SessionManager.create(tempDir, join(tempDir, "sessions"));
		await sessionManager.newSession({ rlmDepth: undefined });
		const parentSession = sessionManager.getSessionFile();
		if (!parentSession) throw new Error("Missing parent session file");
		const { runtime } = await createRuntimeForTest(() => {}, {
			cwd: tempDir,
			sessionManager,
			sessionOptions: { rlmDepth: 2 },
		});

		await runtime.newSession({ parentSession });

		expect(runtime.session.sessionManager.getHeader()).toMatchObject({ parentSession, rlmDepth: 2 });
	});

	it.each([false, true])(
		"uses the effective runtime depth when forking a legacy session before its first entry (inMemory=%s)",
		async (inMemory) => {
			const tempDir = join(tmpdir(), `pi-runtime-legacy-fork-${Date.now()}-${Math.random().toString(36).slice(2)}`);
			const sessionManager = inMemory
				? SessionManager.inMemory(tempDir)
				: await SessionManager.create(tempDir, join(tempDir, "sessions"));
			await sessionManager.newSession({ rlmDepth: undefined });
			const firstEntry = await sessionManager.appendMessage({ role: "user", content: "fork here", timestamp: 1 });
			const { runtime } = await createRuntimeForTest(() => {}, {
				cwd: tempDir,
				sessionManager,
				sessionOptions: { rlmDepth: 2 },
			});

			await runtime.fork(firstEntry);

			expect(runtime.session.sessionManager.getHeader()?.rlmDepth).toBe(2);
			expect(runtime.session.rlmDepth).toBe(2);
		},
	);

	it("disposes a runtime only once across repeated teardown calls", async () => {
		const shutdownEvents: SessionShutdownEvent[] = [];
		const beforeInvalidate = vi.fn();
		const { runtime } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("session_shutdown", (event) => {
				shutdownEvents.push(event);
			});
		});
		runtime.setBeforeSessionInvalidate(beforeInvalidate);

		await Promise.all([runtime.dispose(), runtime.dispose()]);
		await runtime.dispose();

		expect(shutdownEvents).toEqual([{ type: "session_shutdown", reason: "quit" }]);
		expect(beforeInvalidate).toHaveBeenCalledTimes(1);
	});

	it("does not replay shutdown events when runtime disposal throws", async () => {
		let shutdownCount = 0;
		const { runtime, disposeSession } = createRuntimeWithFakeSession({
			onShutdown: () => {
				shutdownCount += 1;
			},
		});
		runtime.setBeforeSessionInvalidate(() => {
			throw new Error("invalidate failed");
		});

		await expect(runtime.dispose()).rejects.toThrow("invalidate failed");
		await expect(runtime.dispose()).rejects.toThrow("invalidate failed");

		expect(shutdownCount).toBe(1);
		expect(disposeSession).toHaveBeenCalledTimes(1);
	});

	it("continues disposing tracked subagents after one child dispose fails", async () => {
		const { runtime } = createRuntimeWithFakeSession();
		const firstDispose = vi.fn(async () => {
			throw new Error("first child failed");
		});
		const secondDispose = vi.fn(async () => {});
		const firstChild = { dispose: firstDispose } as unknown as AgentSessionRuntime;
		const secondChild = { dispose: secondDispose } as unknown as AgentSessionRuntime;
		const runtimeWithSubagents = runtime as unknown as RuntimeSubagentMapAccess;
		runtimeWithSubagents.subagentRuntimes.set("first", firstChild);
		runtimeWithSubagents.subagentRuntimes.set("second", secondChild);

		await expect(runtime.dispose()).rejects.toThrow("first child failed");

		expect(firstDispose).toHaveBeenCalledTimes(1);
		expect(secondDispose).toHaveBeenCalledTimes(1);
	});

	it("deletes exact and replaced in-process RLM child runtimes and retained sessions", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		const childSession = {} as AgentSession;
		const disposeRuntime = vi.fn(async () => {});
		const childRuntime = { session: childSession, dispose: disposeRuntime } as unknown as AgentSessionRuntime;
		const runtimeWithSubagents = runtime as unknown as RuntimeSubagentMapAccess;
		runtimeWithSubagents.subagentRuntimes.set("child-1", childRuntime);

		await runtime.deleteRlmSubagentRuntime("child-1", childSession);

		expect(disposeRuntime).toHaveBeenCalledOnce();
		expect(runtimeWithSubagents.subagentRuntimes.has("child-1")).toBe(false);

		const currentSession = {} as AgentSession;
		const disposeReplacedRuntime = vi.fn(async () => {});
		const replacedRuntime = {
			session: currentSession,
			dispose: disposeReplacedRuntime,
		} as unknown as AgentSessionRuntime;
		const disposeStaleSession = vi.fn(async () => {});
		const staleSession = { disposeAsync: disposeStaleSession } as unknown as AgentSession;
		runtimeWithSubagents.subagentRuntimes.set("replaced-child", replacedRuntime);

		await runtime.deleteRlmSubagentRuntime("replaced-child", staleSession);

		expect(disposeReplacedRuntime).toHaveBeenCalledOnce();
		expect(disposeStaleSession).toHaveBeenCalledOnce();
		expect(runtimeWithSubagents.subagentRuntimes.has("replaced-child")).toBe(false);

		const disposeRetained = vi.fn(async () => {});
		const retainedSession = { disposeAsync: disposeRetained } as unknown as AgentSession;
		await runtime.deleteRlmSubagentRuntime("retained-child", retainedSession);
		expect(disposeRetained).toHaveBeenCalledOnce();
	});

	it("publishes in-process RLM sessions before create resolves and rejects cancelled startup", async () => {
		const { runtime, faux, tempDir } = await createRuntimeForTest(() => {});
		const parentSession = runtime.session;
		const getRunStatus = vi.spyOn(parentSession, "getRlmChildRunStatus").mockReturnValue("running");
		let createResolved = false;
		const onSessionPublished = vi.fn((session: AgentSession) => {
			expect(createResolved).toBe(false);
			expect(session.sessionName).toBe("in-process-worker");
		});
		const baseOptions = {
			parentSession,
			prompt: "run in process",
			model: faux.getModel(),
			thinkingLevel: "off" as const,
			serviceTier: null,
			scopedModels: [],
			activeToolNames: [],
			customTools: [],
			includeGoals: false,
			includeCompactSkill: false,
			rlmDepth: 1,
			rlmMaxDepth: 2,
		};

		const childRuntime = await runtime.createRlmSubagentRuntime({
			...baseOptions,
			id: "in-process-child",
			sessionName: "in-process-worker",
			sessionDir: join(tempDir, "in-process-child"),
			rlmParentNodeId: "in-process-child",
			onSessionPublished,
		});
		createResolved = true;
		expect(onSessionPublished).toHaveBeenCalledOnce();
		await runtime.deleteRlmSubagentRuntime("in-process-child", childRuntime.session);

		getRunStatus.mockReturnValue("cancelled");
		await expect(
			runtime.createRlmSubagentRuntime({
				...baseOptions,
				id: "cancelled-child",
				sessionName: "cancelled-worker",
				sessionDir: join(tempDir, "cancelled-child"),
				rlmParentNodeId: "cancelled-child",
			}),
		).rejects.toThrow("startup was cancelled");
		expect((runtime as unknown as RuntimeSubagentMapAccess).subagentRuntimes.has("cancelled-child")).toBe(false);
	});

	it("releases a failed child run from the inline runtime host", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		const deleteRlmSubagentRuntime = vi.spyOn(runtime, "deleteRlmSubagentRuntime");
		let failedChild!: AgentSession;
		let restoreDisposal!: () => void;
		vi.spyOn(runtime, "createRlmSubagentRuntime").mockImplementationOnce(async (options) => {
			const childRuntime = await AgentSessionRuntime.prototype.createRlmSubagentRuntime.call(runtime, options);
			failedChild = childRuntime.session;
			vi.spyOn(failedChild, "promptAndWait").mockRejectedValue(new Error("child run failed"));
			const disposal = vi.spyOn(failedChild, "disposeAsync").mockRejectedValue(new Error("cleanup unconfirmed"));
			restoreDisposal = () => disposal.mockRestore();
			return childRuntime;
		});
		cleanups.push(() => restoreDisposal?.());

		const failed = await runtime.session.runRlmChild("fail after startup", { name: "failed-child" });
		await vi.waitFor(() => expect(deleteRlmSubagentRuntime).toHaveBeenCalledOnce());
		expect(runtime.listSubagentRuntimes()).toEqual([]);
		await expect(runtime.session.runRlmChild("must not reuse uncertain cleanup")).rejects.toThrow(
			"resident child limit",
		);
		restoreDisposal();
		await failedChild.disposeAsync();
		// The exited object is still historical, but no longer consumes resident capacity.
		expect(runtime.session.getRlmChildSession(failed.rlm_child_id)).toBe(failedChild);
		const next = await runtime.session.runRlmChild("admitted after confirmed cleanup", { name: "next-child" });
		await vi.waitFor(() => expect(runtime.session.hasRunningRlmChildren()).toBe(false));
		await runtime.session.getRlmChildSession(next.rlm_child_id)!.disposeAsync();

		let releaseInitialization!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseInitialization = resolve;
		});
		let initializationStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			initializationStarted = resolve;
		});
		let partialChild!: AgentSession;
		let childDisposalStarted = false;
		const initialize = AgentSession.prototype.initialize;
		const initialization = vi.spyOn(AgentSession.prototype, "initialize").mockImplementationOnce(async function (
			this: AgentSession,
		) {
			partialChild = this;
			const dispose = this.disposeAsync.bind(this);
			vi.spyOn(this, "disposeAsync").mockImplementation((options) => {
				childDisposalStarted = true;
				return dispose(options);
			});
			initializationStarted();
			await gate;
			await initialize.call(this);
		});
		cleanups.push(() => {
			releaseInitialization();
			initialization.mockRestore();
		});
		await runtime.session.runRlmChild("cancel before initialization", { name: "partial-child" });
		await started;
		const aborting = runtime.session.abort();
		let disposalFinished = false;
		const disposing = runtime.session.disposeAsync().then(() => {
			disposalFinished = true;
		});
		await vi.waitFor(() => expect(childDisposalStarted).toBe(true));
		expect(partialChild).toBeInstanceOf(AgentSession);
		expect(disposalFinished).toBe(false);
		await expect(runtime.session.runRlmChild("late start")).rejects.toThrow("disposed");
		releaseInitialization();
		await Promise.all([aborting, disposing]);
		initialization.mockRestore();

		const { runtime: unknownStart } = await createRuntimeForTest(() => {});
		vi.spyOn(unknownStart, "createRlmSubagentRuntime").mockRejectedValueOnce(new Error("start outcome unavailable"));
		await unknownStart.session.runRlmChild("unknown factory outcome", { name: "unknown-child" });
		await vi.waitFor(() => expect(unknownStart.session.hasRunningRlmChildren()).toBe(false));
		await expect(unknownStart.session.runRlmChild("unknown is not disposed")).rejects.toThrow("resident child limit");
	});

	it("plumbs the parent agent identity into runtime-created child prompts", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		await runtime.session.setSessionName("parent-worker");
		const childRuntime = await runtime.createRlmSubagentRuntime({
			parentSession: runtime.session,
			id: "parent-agent-child",
			prompt: "inspect parent identity",
			sessionName: "child-worker",
			sessionDir: join(runtime.cwd, "parent-agent-child"),
			model: runtime.session.model!,
			thinkingLevel: "off",
			serviceTier: null,
			scopedModels: [],
			activeToolNames: [],
			customTools: [],
			includeGoals: false,
			includeCompactSkill: false,
			rlmDepth: 1,
			rlmMaxDepth: 2,
			rlmParentNodeId: "parent-agent-child",
		});

		expect(childRuntime.session.systemPrompt).toContain("spawned by parent-worker");
		await runtime.deleteRlmSubagentRuntime("parent-agent-child", childRuntime.session);
	});

	it("plumbs semantic-edge ancestry into runtime-created child ledgers", async () => {
		const requestTokenBudget: RequestTokenBudgetOptions = { mode: "observe", profiles: [] };
		const { runtime, tempDir } = await createRuntimeForTest(() => {}, { sessionOptions: { requestTokenBudget } });
		const spawnedByRequestId = "a".repeat(32);
		const sessionDir = join(tempDir, "lineage-child");
		const childRuntime = await runtime.createRlmSubagentRuntime({
			parentSession: runtime.session,
			id: "lineage-child",
			prompt: "carry ancestry",
			sessionName: "lineage-worker",
			sessionDir,
			model: runtime.session.model!,
			thinkingLevel: "off",
			serviceTier: null,
			scopedModels: [],
			activeToolNames: [],
			customTools: [],
			includeGoals: false,
			includeCompactSkill: false,
			rlmDepth: 1,
			rlmMaxDepth: 2,
			rlmParentNodeId: "lineage-child",
			spawnedByRequestId,
		});

		expect(readSemanticEdgeLedger(join(sessionDir, SEMANTIC_EDGES_LEDGER_FILENAME))[0]).toMatchObject({
			type: "session_registered",
			parent_session_id: runtime.session.sessionId,
			spawned_by_request_id: spawnedByRequestId,
		});
		// Faux is simulated copy-path evidence; it does not meter physical requests.
		expect(childRuntime.session.requests.getRequestTokenBudgetOptions()).toEqual(requestTokenBudget);
		await childRuntime.session.prompt("execute the policy-inheriting child");
		expect(childRuntime.session.messages.some((message) => message.role === "assistant")).toBe(true);
		await runtime.deleteRlmSubagentRuntime("lineage-child", childRuntime.session);

		// The AgentSession-owned inline path must carry the same policy without a runtime host.
		runtime.session.setSubagentRuntimeHost(undefined);
		const inline = await runtime.session.runRlmChild("execute the inline child", { name: "policy-inline" });
		await vi.waitFor(() =>
			expect(runtime.session.getRlmChildSnapshots().find((child) => child.id === inline.rlm_child_id)?.status).toBe(
				"done",
			),
		);
		const inlineChild = runtime.session.getRlmChildSession(inline.rlm_child_id)!;
		expect(inlineChild.requests.getRequestTokenBudgetOptions()).toEqual(requestTokenBudget);
		expect(inlineChild.messages.some((message) => message.role === "assistant")).toBe(true);
	});

	it("keeps semantic spawn lineage through the production runtime factory", async () => {
		const tempDir = join(tmpdir(), `pi-runtime-factory-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		cleanups.push(() => rmSync(tempDir, { recursive: true, force: true }));
		const faux = registerFauxProvider({ models: [{ id: "faux-1", reasoning: false }] });
		cleanups.push(() => faux.unregister());
		const requestTokenBudget: RequestTokenBudgetOptions = { mode: "enforce", profiles: [] };
		const nativeModel: Model<"openai-responses"> = {
			id: "child-budget-fixture",
			name: "Child budget fixture",
			api: "openai-responses",
			provider: "child-budget-fixture",
			baseUrl: "https://child-budget.invalid/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 16384,
		};

		// The PRODUCTION factory (daemon workers and runtime hosts create every
		// session through it), not a test factory that forwards all options: the
		// original defect lived in its sessionOptions whitelist and stayed
		// invisible to factory-boundary assertions.
		const factory = createDefaultRuntimeFactory(
			{
				agentDir: tempDir,
				cwd: tempDir,
				sessionDir: join(tempDir, "sessions"),
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				telemetryDisabled: true,
				noTools: true,
			},
			[
				(pi: ExtensionAPI) => {
					pi.registerProvider(nativeModel.provider, {
						api: nativeModel.api,
						apiKey: "offline-fixture",
						baseUrl: nativeModel.baseUrl,
						models: [
							{
								id: nativeModel.id,
								name: nativeModel.name,
								api: nativeModel.api,
								reasoning: nativeModel.reasoning,
								input: nativeModel.input,
								cost: nativeModel.cost,
								contextWindow: nativeModel.contextWindow,
								maxTokens: nativeModel.maxTokens,
							},
						],
					});
					pi.registerProvider(faux.getModel().provider, {
						baseUrl: faux.getModel().baseUrl,
						apiKey: "faux-key",
						api: faux.api,
						models: faux.models.map((registeredModel) => ({
							id: registeredModel.id,
							name: registeredModel.name,
							api: registeredModel.api,
							reasoning: registeredModel.reasoning,
							input: registeredModel.input,
							cost: registeredModel.cost,
							contextWindow: registeredModel.contextWindow,
							maxTokens: registeredModel.maxTokens,
						})),
					});
				},
			],
		);

		const childSessionDir = join(tempDir, "lineage-child");
		const spawnedByRequestId = "a".repeat(32);
		const created = await factory({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: await SessionManager.create(tempDir, childSessionDir),
			sessionStartEvent: { type: "session_start", reason: "startup" },
			sessionOptions: {
				requestTokenBudget,
				model: faux.getModel(),
				thinkingLevel: "off",
				rlmDepth: 1,
				rlmMaxDepth: 2,
				rlmSessionDir: childSessionDir,
				rlmParentNodeId: "lineage-child",
				rlmParentAgent: "parent-worker",
				semanticParentSessionId: "parent-session-id",
				semanticSpawnedByRequestId: spawnedByRequestId,
			},
		});
		cleanups.push(() => created.session.disposeAsync());
		await created.session.bindExtensions({});

		const ledgerPath = join(childSessionDir, SEMANTIC_EDGES_LEDGER_FILENAME);
		expect(readSemanticEdgeLedger(ledgerPath)[0]).toMatchObject({
			type: "session_registered",
			parent_session_id: "parent-session-id",
			spawned_by_request_id: spawnedByRequestId,
		});

		faux.setResponses([fauxAssistantMessage("child work")]);
		await created.session.prompt("do the work");
		const edges = deriveSemanticEdges([readSemanticEdgeLedger(ledgerPath)]).edges;
		expect(edges.filter((edge) => edge.type === "subagent_call")).toMatchObject([
			{ source_request_id: spawnedByRequestId },
		]);

		expect(created.session.requests.getRequestTokenBudgetOptions()).toEqual(requestTokenBudget);

		// The same concrete parent owns ordinary daemon spawn and passive hydration.
		let nativeAdmission: RlmChildAdmission | undefined;
		const daemon = new AgentDaemon(join(tempDir, "resident-cap.sock"), {
			defaultSessionConfig: {
				cwd: tempDir,
				agentDir: tempDir,
				sessionDir: join(tempDir, "sessions"),
				noTools: true,
			},
			createRuntime: async (options) => {
				nativeAdmission = options.sessionOptions?.rlmChildAdmission;
				// Configure ONLY the actual root here. Native child/hydration options must carry their own inheritance.
				return factory(
					nativeAdmission
						? options
						: {
								...options,
								sessionOptions: { ...options.sessionOptions, model: faux.getModel(), requestTokenBudget },
							},
				);
			},
		});
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			openRlmJournalOwner(): Promise<void>;
			closeRlmJournal(): Promise<void>;
			createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
			closeSession(state: ActiveSessionState, reason: "shutdown"): Promise<void>;
			passivateSession(state: ActiveSessionState, minutes: 90, now: number): Promise<boolean>;
		};
		await internals.openRlmJournalOwner();
		cleanups.push(async () => {
			for (const state of [...internals.sessions.values()].reverse())
				await internals.closeSession(state, "shutdown");
			await internals.closeRlmJournal();
		});
		const manager = await SessionManager.create(tempDir, join(tempDir, "resident-parent"));
		await manager.appendModelChange(faux.getModel().provider, faux.getModel().id);
		const parentFile = manager.getSessionFile()!;
		await manager.close();
		const parent = await internals.createRuntime({ type: "create", sessionPath: parentFile });
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("done")]);
		const firstStart = parent.runtime.session.runRlmChild("first resident", { name: "resident-one" });
		// Neither name/model selection nor the factory has completed its first await.
		await expect(parent.runtime.session.runRlmChild("overlapping startup")).rejects.toThrow("resident child limit");
		const first = await firstStart;
		await vi.waitFor(() => expect(parent.runtime.session.hasRunningRlmChildren()).toBe(false));
		const firstState = [...internals.sessions.values()].find(
			(state) => state.runtime.metadata.rlmChildId === first.rlm_child_id,
		)!;
		const firstFile = firstState.runtime.session.sessionFile!;
		expect(firstState.runtime.session.requests.getRequestTokenBudgetOptions()).toEqual(requestTokenBudget);
		await expect(firstState.runtime.newSession()).rejects.toThrow("Owned child-runtime replacement is unavailable");
		await expect(firstState.runtime.switchSession(firstFile)).rejects.toThrow(
			"Owned child-runtime replacement is unavailable",
		);
		await expect(firstState.runtime.fork("not-a-real-entry")).rejects.toThrow(
			"Owned child-runtime replacement is unavailable",
		);
		await expect(firstState.runtime.importFromJsonl("not-a-real-file.jsonl")).rejects.toThrow(
			"Owned child-runtime replacement is unavailable",
		);
		await expect(parent.runtime.session.runRlmChild("completed but resident")).rejects.toThrow(
			"resident child limit",
		);
		await vi.waitFor(async () =>
			expect(await internals.passivateSession(firstState, 90, Date.now() + 86_400_000)).toBe(true),
		);
		const second = await parent.runtime.session.runRlmChild("historical first child is not resident", {
			name: "resident-two",
		});
		await vi.waitFor(() => expect(parent.runtime.session.hasRunningRlmChildren()).toBe(false));
		const secondState = [...internals.sessions.values()].find(
			(state) => state.runtime.metadata.rlmChildId === second.rlm_child_id,
		)!;
		await expect(internals.createRuntime({ type: "create", sessionPath: firstFile })).rejects.toThrow(
			"resident child limit",
		);
		await vi.waitFor(async () =>
			expect(await internals.passivateSession(secondState, 90, Date.now() + 86_400_000)).toBe(true),
		);

		let releaseHydration!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseHydration = resolve;
		});
		let hydrationStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			hydrationStarted = resolve;
		});
		const initialize = AgentSession.prototype.initialize;
		let initializingChild: AgentSession | undefined;
		const initialization = vi.spyOn(AgentSession.prototype, "initialize").mockImplementationOnce(async function (
			this: AgentSession,
		) {
			initializingChild = this;
			hydrationStarted();
			await gate;
			await initialize.call(this);
		});
		cleanups.push(() => {
			releaseHydration();
			initialization.mockRestore();
		});
		const hydration = internals.createRuntime({ type: "create", sessionPath: firstFile });
		await started;
		// Checks the real constructor through the production main whitelist, before initialize awaits.
		expect(nativeAdmission?.parent).toBe(parent.runtime.session);
		expect(nativeAdmission?.session).toBe(initializingChild);
		const joined = internals.createRuntime({ type: "create", sessionPath: firstFile });
		await expect(parent.runtime.session.runRlmChild("overlap passive hydration")).rejects.toThrow(
			"resident child limit",
		);
		releaseHydration();
		const [hydrated, same] = await Promise.all([hydration, joined]);
		initialization.mockRestore();
		expect(same).toBe(hydrated);
		expect(hydrated.runtime.session).not.toBe(firstState.runtime.session);
		expect(parent.runtime.session.getRlmChildSession(first.rlm_child_id)).toBe(hydrated.runtime.session);
		await expect(parent.runtime.session.runRlmChild("hydrated completion is resident")).rejects.toThrow(
			"resident child limit",
		);
		await vi.waitFor(async () =>
			expect(await internals.passivateSession(hydrated, 90, Date.now() + 86_400_000)).toBe(true),
		);

		const enforcingChild = await internals.createRuntime({ type: "create", sessionPath: firstFile });
		// Actual native preparation after genuine passive hydration must enforce the inherited unknown policy.
		// No inferred child profile and no transport: the offline endpoint is guarded even if propagation regresses.
		expect(enforcingChild.runtime.session.requests.getRequestTokenBudgetOptions()).toEqual(requestTokenBudget);
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected offline native fetch"));
		cleanups.push(() => fetch.mockRestore());
		enforcingChild.runtime.services.authStorage.setRuntimeApiKey(nativeModel.provider, "offline-fixture");
		await enforcingChild.runtime.session.setModel(nativeModel);
		const refused = enforcingChild.runtime.session.prompt("unprofiled native child must refuse before transport");
		await expect(refused).rejects.toBeInstanceOf(RequestTokenBudgetError);
		await expect(refused).rejects.toMatchObject({ assessment: { status: "unknown" } });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("disposes hosted RLM children during session replacement", async () => {
		const disposeRlmSubagentRuntimes = vi.fn(async () => {});
		const host: SubagentRuntimeHost = {
			createRlmSubagentRuntime: async () => {
				throw new Error("unexpected child creation");
			},
			deleteRlmSubagentRuntime: async () => {},
			disposeRlmSubagentRuntimes,
		};
		const { runtime } = await createRuntimeForTest(() => {});
		runtime.setSubagentRuntimeHost(host);

		await runtime.newSession();

		expect(disposeRlmSubagentRuntimes).toHaveBeenCalledTimes(1);
	});

	it("persists message_end assistant replacements to the session manager", async () => {
		const { runtime } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("message_end", (event) => {
				if (event.message.role !== "assistant") return;

				return {
					message: {
						...event.message,
						usage: {
							...event.message.usage,
							cost: {
								...event.message.usage.cost,
								total: 0.123,
							},
						},
					},
				};
			});
		});

		await runtime.session.prompt("hello");

		const sessionAssistant = runtime.session.messages.find((message) => message.role === "assistant");
		expect(sessionAssistant?.role).toBe("assistant");
		if (sessionAssistant?.role !== "assistant") {
			throw new Error("missing assistant message");
		}
		expect(sessionAssistant.usage.cost.total).toBe(0.123);

		const persistedAssistant = runtime.session.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "message")
			.map((entry) => entry.message)
			.find((message) => message.role === "assistant");
		expect(persistedAssistant?.role).toBe("assistant");
		if (persistedAssistant?.role !== "assistant") {
			throw new Error("missing persisted assistant message");
		}
		expect(persistedAssistant.usage.cost.total).toBe(0.123);
	});

	it("emits session_before_switch and session_start for new, resume, and import flows", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtime } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
			});
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtime.session.prompt("hello");
		const originalSessionFile = runtime.session.sessionFile;
		const originalSession = runtime.session;
		const persistedGoal = {
			active: true,
			status: "active",
			goalId: "retained-active-goal",
			objective: "This imported goal must remain evidence, not active control",
			tokensUsed: 5,
			timeUsedSeconds: 6,
			continuationsUsed: 1,
		};
		const goalEntryId = await runtime.session.sessionManager.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, persistedGoal);

		const newSessionResult = await runtime.newSession();
		expect(newSessionResult.cancelled).toBe(false);
		await runtime.session.bindExtensions({});
		expect(runtime.session).not.toBe(originalSession);
		expect(runtime.session.messages).toEqual([]);
		const secondSessionFile = runtime.session.sessionFile;
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "new", targetSessionFile: undefined },
			{ type: "session_shutdown", reason: "new", targetSessionFile: secondSessionFile },
			{ type: "session_start", reason: "new", previousSessionFile: originalSessionFile },
		]);

		events.length = 0;

		const switchResult = await runtime.switchSession(originalSessionFile!);
		expect(switchResult.cancelled).toBe(false);
		await runtime.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_shutdown", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_start", reason: "resume", previousSessionFile: secondSessionFile },
		]);
		expect(runtime.session.goalState).toMatchObject({ active: true, status: "active", goalId: persistedGoal.goalId });

		events.length = 0;
		const importResult = await runtime.importFromJsonl(originalSessionFile!);
		expect(importResult.cancelled).toBe(false);
		await runtime.session.bindExtensions({});
		const importedSessionFile = runtime.session.sessionFile!;
		expect(importedSessionFile).not.toBe(originalSessionFile);
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_shutdown", reason: "resume", targetSessionFile: importedSessionFile },
			{ type: "session_start", reason: "resume", previousSessionFile: originalSessionFile },
		]);
		expect(runtime.session.goalState).toMatchObject({ active: false, status: "idle" });
		expect(runtime.session.goalState.objective).toBeUndefined();
		expect(runtime.session.sessionManager.getEntryRetention(goalEntryId)).toBe("retained-import");
		const imported = await SessionManager.openReadOnly(importedSessionFile);
		try {
			expect(imported.getEntry(goalEntryId)).toMatchObject({
				type: "custom",
				customType: GOAL_STATE_CUSTOM_TYPE,
				data: persistedGoal,
			});
			expect(imported.getEntryRetention(goalEntryId)).toBe("retained-import");
		} finally {
			await imported.close();
		}
	});

	it("honors session_before_switch cancellation for new, resume, and import", async () => {
		const events: RecordedSessionEvent[] = [];
		let cancelReason: "new" | "resume" | undefined;
		const { runtime } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
				if (event.reason === cancelReason) {
					return { cancel: true };
				}
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		await runtime.session.prompt("hello");
		const originalSessionFile = runtime.session.sessionFile;

		cancelReason = "new";
		const newResult = await runtime.newSession();
		expect(newResult.cancelled).toBe(true);
		expect(runtime.session.sessionFile).toBe(originalSessionFile);

		events.length = 0;
		const otherDir = join(tmpdir(), `pi-runtime-other-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(otherDir, { recursive: true });
		cleanups.push(() => rmSync(otherDir, { recursive: true, force: true }));
		const otherSession = await SessionManager.create(otherDir, join(otherDir, "sessions"));
		cleanups.push(() => otherSession.close());
		await otherSession.appendMessage({
			role: "user",
			content: [{ type: "text", text: "other" }],
			timestamp: Date.now(),
		});
		const otherSessionFile = otherSession.getSessionFile();
		cancelReason = "resume";
		const resumeResult = await runtime.switchSession(otherSessionFile!);
		expect(resumeResult.cancelled).toBe(true);
		expect(runtime.session.sessionFile).toBe(originalSessionFile);

		events.length = 0;
		const originalSession = runtime.session;
		const importResult = await runtime.importFromJsonl(otherSessionFile!);
		expect(importResult.cancelled).toBe(true);
		expect(runtime.session).toBe(originalSession);
		expect(runtime.session.sessionFile).toBe(originalSessionFile);
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "resume", targetSessionFile: otherSessionFile },
		]);
	});

	it("emits session_before_fork and session_start and honors cancellation", async () => {
		const events: RecordedSessionEvent[] = [];
		let cancelNextFork = false;
		const { runtime } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("session_before_fork", (event) => {
				events.push(event);
				if (cancelNextFork) {
					cancelNextFork = false;
					return { cancel: true };
				}
			});
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		events.length = 0;
		await runtime.session.prompt("hello");
		const userMessage = (await runtime.session.getUserMessagesForForking())[0]!;
		const previousSessionFile = runtime.session.sessionFile;

		const successResult = await runtime.fork(userMessage.entryId);
		expect(successResult.cancelled).toBe(false);
		expect(successResult.selectedText).toBe("hello");
		await runtime.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" },
			{ type: "session_shutdown", reason: "fork", targetSessionFile: runtime.session.sessionFile },
			{ type: "session_start", reason: "fork", previousSessionFile },
		]);

		events.length = 0;
		cancelNextFork = true;
		const cancelResult = await runtime.fork(userMessage.entryId);
		expect(cancelResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" }]);

		events.length = 0;
		cancelNextFork = true;
		const cancelAtResult = await runtime.fork("missing-entry", { position: "at" });
		expect(cancelAtResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: "missing-entry", position: "at" }]);
	});

	it("forks before a selected middle prompt and preserves its selection metadata", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		await runtime.session.prompt("Say one");
		await runtime.session.prompt("Say two");
		await runtime.session.prompt("Say three");
		const userMessages = await runtime.session.getUserMessagesForForking();
		expect(userMessages.map((message) => message.text)).toEqual(["Say one", "Say two", "Say three"]);

		const result = await runtime.fork(userMessages[1]!.entryId);

		expect(result).toEqual({ cancelled: false, selectedText: "Say two" });
		expect(
			runtime.session.messages.map((message) =>
				message.role === "user"
					? typeof message.content === "string"
						? message.content
						: message.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("")
					: message.role,
			),
		).toEqual(["Say one", "assistant"]);
		expect(runtime.session.sessionFile).toBeDefined();
	});

	it("forks before the first prompt in-memory and preserves its selection metadata", async () => {
		const { runtime } = await createRuntimeForTest(() => {}, { inMemory: true });
		await runtime.session.prompt("Say one");
		const userMessages = await runtime.session.getUserMessagesForForking();

		const result = await runtime.fork(userMessages[0]!.entryId);

		expect(result).toEqual({ cancelled: false, selectedText: "Say one" });
		expect(runtime.session.messages).toEqual([]);
		expect(runtime.session.sessionFile).toBeUndefined();
	});

	it("should create branch summary when navigating with summarize=true", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		const { session } = runtime;
		const { sessionManager, settingsManager, modelRegistry } = session;
		settingsManager.applyOverrides({ autoRefine: { enabled: false } });
		await sessionManager.branchTo(null);
		await session.prompt("What is 2+2?");
		await session.prompt("What is 3+3?");
		await session.waitForIdle();
		const target = (await sessionManager.readEntries()).find(
			(entry) => entry.type === "message" && entry.message.role === "user",
		);
		if (!target) throw new Error("Missing original user navigation target");
		expect(target.parentId).toBeNull();
		const sourceSessionId = sessionManager.getSessionId();
		const sourceLeafId = sessionManager.getLeafId();
		const mainModel = structuredClone(session.model);
		const mainEffort = session.thinkingLevel;
		modelRegistry.registerProvider(branchSummaryModel.provider, {
			api: branchSummaryModel.api,
			baseUrl: branchSummaryModel.baseUrl,
			apiKey: "branch-summary-fixture-key",
			models: [branchSummaryModel],
		});
		const selection = {
			provider: branchSummaryModel.provider,
			modelId: branchSummaryModel.id,
			thinkingLevel: "high" as const,
		};
		settingsManager.applyOverrides({ branchSummary: { model: selection } });
		const detached = settingsManager.getBranchSummaryModel()!;
		detached.modelId = "mutated-getter-copy";
		expect(settingsManager.getBranchSummaryModel()).toEqual(selection);
		const readEntry = sessionManager.readEntry.bind(sessionManager);
		const targetRead = vi.spyOn(sessionManager, "readEntry").mockImplementationOnce((...args) => {
			settingsManager.applyOverrides({
				branchSummary: { model: { ...selection, modelId: "mutated-during-target-read", thinkingLevel: "low" } },
			});
			return readEntry(...args);
		});
		cleanups.push(() => targetRead.mockRestore());
		const auth = vi.spyOn(modelRegistry, "getApiKeyAndHeaders");
		cleanups.push(() => auth.mockRestore());
		const bodies: Array<{ model: string; reasoning: { effort: string } }> = [];
		// The real built-in adapter/coordinator runs; only HTTP is offline.
		const offlineFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			bodies.push(JSON.parse(String(init?.body)));
			const item = {
				type: "message",
				id: "msg_branch",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "Remember both sums", annotations: [] }],
			};
			const sse = [
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { ...item, status: "in_progress", content: [] },
				},
				{ type: "response.output_item.done", output_index: 0, item },
				{
					type: "response.completed",
					response: {
						id: "resp_branch",
						model: branchSummaryModel.id,
						status: "completed",
						usage: {
							input_tokens: 10,
							output_tokens: 1,
							total_tokens: 11,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				},
			]
				.map((event) => `data: ${JSON.stringify(event)}\n\n`)
				.join("");
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		});
		cleanups.push(() => offlineFetch.mockRestore());

		const result = await session.navigateTree(target.id, { summarize: true });

		expect(result.cancelled).toBe(false);
		expect(result.editorText).toBe("What is 2+2?");
		expect(result.summaryEntry).toMatchObject({
			type: "branch_summary",
			summary: expect.stringContaining("Remember both sums"),
			parentId: null,
		});
		expect(sessionManager.getLeafId()).toBe(result.summaryEntry?.id);
		expect(await sessionManager.readEntry(result.summaryEntry!.id)).toEqual(result.summaryEntry);
		const branchMessage = session.messages.find((message) => message.role === "branchSummary");
		expect(branchMessage).toBeDefined();
		expect(JSON.stringify(branchMessage)).not.toContain('"requestOutput"');
		expect(JSON.stringify(bodies)).not.toContain('"requestOutput"');
		expect(session.model).toEqual(mainModel);
		expect(session.thinkingLevel).toBe(mainEffort);
		expect(auth.mock.calls.map(([model]) => [model.provider, model.id])).toEqual([
			[branchSummaryModel.provider, branchSummaryModel.id],
		]);
		expect(bodies).toEqual([
			expect.objectContaining({
				model: branchSummaryModel.id,
				reasoning: expect.objectContaining({ effort: "high" }),
			}),
		]);
		const receipts: RequestJournalEntry[] = [];
		let recordedSummary: typeof result.summaryEntry;
		for await (const { entry: record, retention, qualification } of readSessionJournal(
			sessionManager.getSessionFile()!,
		)) {
			const entry = record as SessionEntry;
			if (entry.type === "request" && entry.request.type === "attempt_settled") receipts.push(entry);
			if (entry.type === "branch_summary" && entry.id === result.summaryEntry?.id) {
				recordedSummary = entry;
				expect(retention).toBeUndefined();
				expect(qualification).toBeUndefined();
			}
		}
		expect(receipts).toHaveLength(1);
		expect(receipts[0]?.request).toMatchObject({
			purpose: "summary",
			purposeDetail: "branch",
			owner: { sessionId: sourceSessionId },
			source: { sessionId: sourceSessionId, leafId: sourceLeafId },
			modelContract: { provider: branchSummaryModel.provider, model: branchSummaryModel.id },
			receipt: { model: branchSummaryModel.id, effort: "high", outcome: "completed" },
		});
		const request = receipts[0]?.request;
		if (request?.type !== "attempt_settled") throw new Error("Missing settled branch request");
		expect(recordedSummary).toEqual(result.summaryEntry);
		expect(recordedSummary?.requestOutput).toEqual({
			operationId: request.operationId,
			attemptIds: [request.attemptId],
			source: request.source,
		});
		expect(recordedSummary?.fromId).toBe("root");
		expect(recordedSummary?.requestOutput?.source.leafId).not.toBe(recordedSummary?.parentId);
	}, 120000);

	it("should handle abort during summarization", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		const { session } = runtime;
		const { sessionManager, settingsManager, modelRegistry } = session;
		settingsManager.applyOverrides({ autoRefine: { enabled: false } });
		await session.prompt("Tell me about something");
		await session.prompt("Continue");
		await session.waitForIdle();
		const branchBefore = await sessionManager.readBranch();
		const summariesBefore = (await sessionManager.readEntries()).filter((entry) => entry.type === "branch_summary");
		const leafBefore = sessionManager.getLeafId();
		const target = branchBefore.find((entry) => entry.type === "message" && entry.message.role === "user");
		if (!target) throw new Error("Missing original user navigation target");
		const mainModel = structuredClone(session.model);
		const mainEffort = session.thinkingLevel;
		modelRegistry.registerProvider(branchSummaryModel.provider, {
			api: branchSummaryModel.api,
			baseUrl: branchSummaryModel.baseUrl,
			apiKey: "branch-summary-fixture-key",
			models: [branchSummaryModel],
		});
		const selection = {
			provider: branchSummaryModel.provider,
			modelId: branchSummaryModel.id,
			thinkingLevel: "high" as const,
		};
		settingsManager.applyOverrides({
			branchSummary: { model: { ...selection, modelId: "missing-branch-summary-model" } },
		});
		const auth = vi.spyOn(modelRegistry, "getApiKeyAndHeaders");
		const targetRead = vi.spyOn(sessionManager, "readEntry");
		cleanups.push(
			() => auth.mockRestore(),
			() => targetRead.mockRestore(),
		);
		await expect(session.navigateTree(target.id, { summarize: true })).rejects.toThrow(
			`Unknown branchSummary.model ${branchSummaryModel.provider}/missing-branch-summary-model`,
		);
		expect(auth).not.toHaveBeenCalled();
		expect(targetRead).not.toHaveBeenCalled();
		expect(sessionManager.getLeafId()).toBe(leafBefore);
		expect(await sessionManager.readBranch()).toEqual(branchBefore);
		auth.mockRestore();
		targetRead.mockRestore();

		settingsManager.applyOverrides({ branchSummary: { model: selection } });
		const started = createDeferred();
		const offlineFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			started.resolve();
			return new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal;
				if (!signal) {
					reject(new Error("Missing summary request cancellation signal"));
					return;
				}
				const abort = () => reject(new DOMException("Summary request aborted", "AbortError"));
				if (signal.aborted) abort();
				else signal.addEventListener("abort", abort, { once: true });
			});
		});
		cleanups.push(() => offlineFetch.mockRestore());
		const navigation = session.navigateTree(target.id, { summarize: true });
		await started.promise;
		expect(session.isCompacting).toBe(true);
		session.abortBranchSummary();
		const result = await navigation;

		expect(result.cancelled).toBe(true);
		expect(result.aborted).toBe(true);
		expect(result.summaryEntry).toBeUndefined();
		// Native attempt rows may settle, but the selected transcript branch must not change.
		expect(await sessionManager.readBranch()).toEqual(branchBefore);
		expect((await sessionManager.readEntries()).filter((entry) => entry.type === "branch_summary")).toEqual(
			summariesBefore,
		);
		expect(sessionManager.getLeafId()).toBe(leafBefore);
		expect(session.model).toEqual(mainModel);
		expect(session.thinkingLevel).toBe(mainEffort);
		expect(offlineFetch).toHaveBeenCalledOnce();
		const receipts: RequestJournalEntry[] = [];
		for await (const { entry: record } of readSessionJournal(sessionManager.getSessionFile()!)) {
			const entry = record as RequestJournalEntry;
			if (entry.type === "request" && entry.request.type === "attempt_settled") receipts.push(entry);
		}
		expect(receipts).toHaveLength(1);
		expect(receipts[0]?.request).toMatchObject({
			purpose: "summary",
			purposeDetail: "branch",
			source: { sessionId: sessionManager.getSessionId(), leafId: leafBefore },
			receipt: { model: branchSummaryModel.id, effort: "high", outcome: "cancelled" },
		});
	}, 60000);

	it("duplicates the current active branch when forking at the current position", async () => {
		const { runtime } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("session_before_fork", async (event) => {
				await pi.setLabel(event.entryId, "after-capture");
			});
		});
		await runtime.session.prompt("hello");
		await runtime.session.prompt("again");

		const beforeMessages = runtime.session.messages.map((message) => ({
			role: message.role,
			text:
				message.role === "user"
					? typeof message.content === "string"
						? message.content
						: message.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("")
					: undefined,
		}));
		const previousSessionFile = runtime.session.sessionFile;
		const leafId = runtime.session.sessionManager.getLeafId();
		expect(leafId).toBeTruthy();

		const result = await runtime.fork(leafId!, { position: "at" });
		expect(result).toEqual({ cancelled: false, selectedText: undefined });
		expect(runtime.session.sessionFile).not.toBe(previousSessionFile);
		expect(await runtime.session.sessionManager.readLabel(leafId!)).toBeUndefined();
		expect(
			runtime.session.messages.map((message) => ({
				role: message.role,
				text:
					message.role === "user"
						? typeof message.content === "string"
							? message.content
							: message.content
									.filter((part): part is { type: "text"; text: string } => part.type === "text")
									.map((part) => part.text)
									.join("")
						: undefined,
			})),
		).toEqual(beforeMessages);
	});

	it("duplicates the current active branch in-memory when forking at the current position", async () => {
		const { runtime } = await createRuntimeForTest(() => {}, { inMemory: true });

		await runtime.session.prompt("hello");
		await runtime.session.prompt("again");

		const beforeMessages = runtime.session.messages.map((message) => ({
			role: message.role,
			text:
				message.role === "user"
					? typeof message.content === "string"
						? message.content
						: message.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("")
					: undefined,
		}));
		const leafId = runtime.session.sessionManager.getLeafId();
		expect(leafId).toBeTruthy();
		expect(runtime.session.sessionFile).toBeUndefined();

		const result = await runtime.fork(leafId!, { position: "at" });
		expect(result).toEqual({ cancelled: false, selectedText: undefined });
		expect(runtime.session.sessionFile).toBeUndefined();
		expect(
			runtime.session.messages.map((message) => ({
				role: message.role,
				text:
					message.role === "user"
						? typeof message.content === "string"
							? message.content
							: message.content
									.filter((part): part is { type: "text"; text: string } => part.type === "text")
									.map((part) => part.text)
									.join("")
						: undefined,
			})),
		).toEqual(beforeMessages);
	});

	it("throws when forking with an invalid entry id", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		await expect(runtime.fork("missing-entry")).rejects.toThrow("Invalid entry ID for forking");
	});

	it("updates the runtime session cwd on cross-cwd session replacement", async () => {
		const firstDir = join(tmpdir(), `pi-runtime-cwd-a-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const secondDir = join(tmpdir(), `pi-runtime-cwd-b-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(firstDir, { recursive: true });
		mkdirSync(secondDir, { recursive: true });
		cleanups.push(() => rmSync(secondDir, { recursive: true, force: true }));
		const { runtime, faux, tempDir } = await createRuntimeForTest(() => {}, { cwd: firstDir });
		const otherAuthStorage = AuthStorage.inMemory();
		otherAuthStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const otherRuntimeOptions = {
			agentDir: tempDir,
			authStorage: otherAuthStorage,
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createOtherRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			sessionManager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				...otherRuntimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const otherRuntime = await createAgentSessionRuntime(createOtherRuntime, {
			cwd: secondDir,
			agentDir: tempDir,
			sessionManager: await SessionManager.create(secondDir, join(secondDir, "sessions")),
		});
		cleanups.push(async () => {
			await otherRuntime.dispose();
		});
		await otherRuntime.session.prompt("other");
		const otherSessionFile = otherRuntime.session.sessionFile!;
		await otherRuntime.dispose();

		await runtime.switchSession(otherSessionFile);

		expect(realpathSync(runtime.session.sessionManager.getCwd())).toBe(realpathSync(secondDir));
		expect(realpathSync(runtime.cwd)).toBe(realpathSync(secondDir));
	});

	it("restores model and thinking state from the destination session", async () => {
		const { runtime, faux, tempDir } = await createRuntimeForTest(() => {}, {
			bootstrapModel: false,
			bootstrapThinkingLevel: false,
		});
		const otherDir = join(tempDir, "other");
		mkdirSync(otherDir, { recursive: true });
		const otherAuthStorage = AuthStorage.inMemory();
		otherAuthStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const otherRuntimeOptions = {
			agentDir: tempDir,
			authStorage: otherAuthStorage,
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createOtherRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			sessionManager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				...otherRuntimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const otherRuntime = await createAgentSessionRuntime(createOtherRuntime, {
			cwd: otherDir,
			agentDir: tempDir,
			sessionManager: await SessionManager.create(otherDir, join(otherDir, "sessions")),
		});
		cleanups.push(async () => {
			await otherRuntime.dispose();
		});
		await otherRuntime.session.setModel(faux.getModel("faux-2")!);
		await otherRuntime.session.setThinkingLevel("off");
		await otherRuntime.session.prompt("hello");
		const targetSessionFile = otherRuntime.session.sessionFile!;
		await otherRuntime.dispose();

		await runtime.switchSession(targetSessionFile);

		expect(runtime.session.model?.id).toBe("faux-2");
		expect(runtime.session.thinkingLevel).toBe("off");
	});
});
