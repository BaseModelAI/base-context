import { appendFileSync } from "node:fs";
import {
	AgentContinueError,
	type AgentMessage,
	type ShouldStopAfterTurnContext,
} from "@ponythewhite/base-context-agent";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	getModel,
	isContextOverflow,
	type Model,
	type ToolResultMessage,
	type Usage,
} from "@ponythewhite/base-context-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompactionCommittedError } from "../../src/core/agent-session.js";
import {
	CanonicalContextCompiler,
	canonicalRecoveryBoundary,
	getCanonicalViewUnits,
} from "../../src/core/canonical-context.js";
import { appendContextEpoch, readContextEpoch } from "../../src/core/context-epoch.js";
import { InferenceCoordinator } from "../../src/core/inference-coordinator.js";
import { DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES } from "../../src/core/kernel/state-snapshot.js";
import type { RefinementProposal } from "../../src/core/refinement/index.js";
import { getRecoveryCompactionAuthorization, PublicContextBudgetError } from "../../src/core/request-view-selection.js";
import { SessionJournalOwner } from "../../src/core/session-journal-owner.js";
import { readSessionJournal } from "../../src/core/session-journal-reader.js";
import { type CompactionEntry, type RequestJournalEntry, SessionManager } from "../../src/core/session-manager.js";
import { TASK_FRAME_CUSTOM_TYPE } from "../../src/core/task-frame.js";
import type { IpythonKernelProvisioner } from "../../src/core/tools/ipython.js";
import { createHarness, getAssistantTexts, getMessageText, type Harness } from "./harness.js";
import { createDeferred } from "./scheduling.js";

// Read-only observations of records created by the native session, never fixture-owned admissions.
type CapturedCompactionOwner = {
	manager: Harness["sessionManager"];
	agent: Harness["session"]["agent"];
	sessionId: string;
	isSourceCurrent(): boolean;
};

type CapturedCheckpointAction = {
	action: { id: string; lifecycle: { state: string } };
	ticket: { id: string; delivered: Promise<unknown>; completed: Promise<unknown> };
};

type CapturedCheckpointResume = {
	owner: CapturedCompactionOwner;
	boundary?: { kind: "tool" | "overflow" | "request"; state: "pending" | "consumed" };
	actions: CapturedCheckpointAction[];
};

type ContinuationObservations = {
	_schedulePostCompactionContinue(resume: CapturedCheckpointResume): void;
	_postCompactionContinuationScheduled: boolean;
	_postCompactionContinuations: CapturedCheckpointAction[];
	_postCompactionContinuationSettlement?: { resume: CapturedCheckpointResume; promise: Promise<void> };
	_runScheduledPostCompactionContinue(settlement: unknown): Promise<void>;
	_waitForIdleOrSettlement(settlement?: unknown): Promise<void>;
	_sessionInputCheckpointWaiters: Set<() => void>;
};

type SessionWithCompactionInternals = {
	_checkCompaction: (
		assistantMessage: AssistantMessage,
		skipAbortedCheck?: boolean,
		queueAutonomousContinuation?: boolean,
	) => Promise<boolean>;
	_runAutoCompaction: (
		reason: "overflow" | "threshold" | "requested",
		willRetry: boolean,
		owner?: CapturedCompactionOwner,
		resumeInPlace?: boolean,
	) => Promise<boolean>;
	_shouldStopAfterTurn: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;
	_thresholdCompactionNeeded: (context: ShouldStopAfterTurnContext) => Promise<boolean>;
	_persistCompactionOutcome: (
		reason: "overflow" | "threshold" | "requested",
		outcome: "skipped" | "cancelled" | "failed",
		message: string,
	) => Promise<void>;
};

const compactionModel: Model<"openai-responses"> = {
	api: "openai-responses",
	provider: "compaction-model-fixture",
	id: "summary-model",
	name: "Summary model",
	baseUrl: "https://compaction.invalid/v1",
	input: ["text"],
	reasoning: true,
	contextWindow: 128000,
	maxTokens: 32768,
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
};

function createUsage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(
	harness: Harness,
	options: {
		stopReason?: AssistantMessage["stopReason"];
		errorMessage?: string;
		totalTokens?: number;
		timestamp?: number;
	},
): AssistantMessage {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage("", {
			stopReason: options.stopReason,
			errorMessage: options.errorMessage,
			timestamp: options.timestamp,
		}),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(options.totalTokens ?? 0),
	};
}

function failingGateCommand(): string {
	return `${process.execPath} -e "console.error('gate failed'); process.exit(1)"`;
}

describe("AgentSession compaction characterization", () => {
	const harnesses: Harness[] = [];

	beforeEach(() => {
		vi.useRealTimers();
	});

	afterEach(async () => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			await harnesses.pop()?.cleanup();
		}
	});

	// A real tool turn requests its checkpoint. Only its result is gated; native admission,
	// compaction, owner capture, action tickets and agent settlement are never replaced.
	async function prepareNativeCheckpoint(
		options: {
			persistSession?: boolean;
			autonomous?: NonNullable<Parameters<typeof createHarness>[0]>["autonomous"];
			beforeCompact?: (entries: readonly { id: string }[]) => Promise<void>;
			beforePrompt?: (prompt: string) => Promise<void>;
			refineProposal?: RefinementProposal;
			failFirstCompaction?: boolean;
		} = {},
	) {
		const toolStarted = createDeferred();
		const releaseTool = createDeferred();
		const compacted = createDeferred();
		let compactionHooks = 0;
		const initialSummaryFailure = "Native fixture initial summary failure";
		const harness: Harness = await createHarness({
			persistSession: options.persistSession,
			autonomous: options.autonomous ? { ...options.autonomous, enabled: false } : undefined,
			settings: {
				compaction: { enabled: false, keepRecentTokens: 1 },
				autoRefine: { enabled: false },
			},
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event) => {
						await options.beforePrompt?.(event.prompt);
					});
					pi.on("session_before_refine", () =>
						options.refineProposal ? { proposal: options.refineProposal } : undefined,
					);
					pi.registerTool({
						name: "compaction_checkpoint",
						label: "Compaction checkpoint",
						description: "Hold a native tool turn at its compaction checkpoint.",
						parameters: Type.Object({}),
						execute: async (_id, _params, signal) => {
							toolStarted.resolve();
							const abort = () => releaseTool.resolve();
							signal?.addEventListener("abort", abort, { once: true });
							try {
								await releaseTool.promise;
								signal?.throwIfAborted();
								return { content: [{ type: "text", text: "Native checkpoint result" }], details: {} };
							} finally {
								signal?.removeEventListener("abort", abort);
							}
						},
					});
					pi.on("session_before_compact", async (event) => {
						if (options.failFirstCompaction && compactionHooks++ === 0) {
							// Hook exceptions are caught by ExtensionRunner. Fail the real summary instead.
							const failed = fauxAssistantMessage("", {
								stopReason: "error",
								errorMessage: initialSummaryFailure,
							});
							harness.setResponses([failed, failed]); // History and optional turn-prefix summary.
							return;
						}
						await options.beforeCompact?.(event.branchEntries);
						return {
							compaction: {
								summary: "summary from extension",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: { source: "extension" },
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		const originalCompactionSettings = harness.settingsManager.getCompactionSettings();
		harness.session.setActiveToolsByName(["compaction_checkpoint"]);
		harness.setResponses([fauxAssistantMessage("seed one"), fauxAssistantMessage("seed two")]);
		await harness.session.prompt("first seed");
		await harness.session.prompt("second seed");
		if (options.autonomous) await harness.session.prompt("/autonomous on");
		const internals = harness.session as unknown as ContinuationObservations;
		const scheduled = vi.spyOn(internals, "_schedulePostCompactionContinue");
		const continued = vi.spyOn(harness.session.agent, "continue");
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type !== "compaction_end") return;
			unsubscribe();
			if (options.autonomous) {
				harness.settingsManager.applyOverrides({ compaction: originalCompactionSettings });
				if (event.reason !== "threshold") {
					compacted.reject(new Error(`Expected native threshold compaction, received ${event.reason}`));
					return;
				}
			}
			if (options.failFirstCompaction) {
				const expected = [
					`Requested compaction failed: Summarization failed: ${initialSummaryFailure}`,
					`Requested compaction failed: Turn prefix summarization failed: ${initialSummaryFailure}`,
				];
				if (
					event.reason !== "requested" ||
					event.aborted !== false ||
					event.result !== undefined ||
					!expected.includes(event.errorMessage ?? "")
				) {
					compacted.reject(new Error(`Unexpected initial compaction outcome: ${JSON.stringify(event)}`));
					return;
				}
				harness.setResponses([fauxAssistantMessage("checkpoint continued")]);
				compacted.resolve();
			} else if (event.result) compacted.resolve();
			else compacted.reject(new Error(event.errorMessage ?? "Native checkpoint did not compact"));
		});
		void compacted.promise.catch(() => undefined);
		if (!options.autonomous) {
			const unsubscribeRequest = harness.session.agent.subscribe(async (event) => {
				if (event.type === "agent_end") {
					unsubscribeRequest();
					return;
				}
				if (event.type !== "turn_end") return;
				const result = event.toolResults.find(
					(value) => value.toolCallId === "native-checkpoint" && value.toolName === "compaction_checkpoint",
				);
				if (!result) return;
				try {
					expect(result.isError).toBe(false);
					// Public Agent listeners backpressure this finalized boundary before getTurnOutcome.
					expect(await harness.session.handleCompactHostRequest("compact.run")).toMatchObject({
						scheduled: true,
					});
				} catch (error) {
					compacted.reject(error instanceof Error ? error : new Error(String(error)));
					throw error;
				} finally {
					unsubscribeRequest();
				}
			});
		}
		const call = fauxAssistantMessage(
			{ type: "toolCall", id: "native-checkpoint", name: "compaction_checkpoint", arguments: {} },
			{ stopReason: "toolUse" },
		);
		harness.setResponses([call, fauxAssistantMessage("checkpoint continued")]);
		const running = harness.session.prompt("Reach the native checkpoint.");
		void running.catch(() => undefined);
		await toolStarted.promise;
		const pause = harness.session.acquireQueuedWorkPause();
		if (options.autonomous) {
			const usage = await harness.session.getContextUsage();
			if (
				!usage ||
				usage.tokens === null ||
				!Number.isFinite(usage.tokens) ||
				usage.tokens <= 0 ||
				usage.tokens >= usage.contextWindow
			) {
				throw new Error("Expected finite positive native context usage below the model window");
			}
			// Use the real provider/trailing estimate, not synthetic usage or an exact-tokenizer claim.
			harness.settingsManager.applyOverrides({
				compaction: { enabled: true, reserveTokens: usage.contextWindow - usage.tokens + 1 },
			});
		}
		return { harness, internals, scheduled, continued, running, pause, releaseTool, compacted };
	}

	it.each(["manual", "requested", "threshold"] as const)(
		"commits %s compaction despite concurrent child accounting and continues",
		async (mode) => {
			const summarize = createDeferred();
			const releaseSummary = createDeferred();
			let harness: Harness;
			let running: Promise<unknown>;
			let releasePause: (() => void) | undefined;
			if (mode === "manual") {
				harness = await createHarness({
					persistSession: true,
					settings: { compaction: { enabled: false, keepRecentTokens: 1 }, autoRefine: { enabled: false } },
				});
				harnesses.push(harness);
				harness.setResponses([fauxAssistantMessage("first response"), fauxAssistantMessage("second response")]);
				await harness.session.prompt("first request");
				await harness.session.prompt("second request");
				const summary = async () => {
					summarize.resolve();
					await releaseSummary.promise;
					return fauxAssistantMessage("model summary with concurrent accounting");
				};
				harness.setResponses([summary, summary]);
				running = harness.session.compact();
			} else {
				const fixture = await prepareNativeCheckpoint({
					persistSession: true,
					...(mode === "threshold" ? { autonomous: { enabled: true } } : {}),
					beforeCompact: async () => {
						summarize.resolve();
						await releaseSummary.promise;
					},
				});
				harness = fixture.harness;
				running = fixture.running;
				releasePause = () => fixture.pause.release();
				fixture.releaseTool.resolve();
			}
			void running.catch(() => undefined);
			try {
				await summarize.promise;
				const entries = await harness.sessionManager.readBranch();
				const target = entries.find((entry) => entry.type === "message" && entry.message.role === "assistant");
				if (!target) throw new Error("Expected an assistant for late child accounting");
				const sourceLeaf = harness.sessionManager.getLeafId();
				await harness.sessionManager.appendChildUsageAttributionWithAggregate(target.id, createUsage(10));
				await harness.sessionManager.appendChildUsageAttributionWithAggregate(target.id, createUsage(20));
				expect(harness.sessionManager.getLeafId()).not.toBe(sourceLeaf);
			} finally {
				releaseSummary.resolve();
				releasePause?.();
			}
			await running;
			await harness.session.waitForHeadlessIdle();
			expect(harness.eventsOfType("compaction_end")).toContainEqual(
				expect.objectContaining({ reason: mode, result: expect.any(Object), aborted: false }),
			);
			expect(harness.eventsOfType("compaction_end").filter((event) => event.errorMessage)).toEqual([]);
			expect(harness.session.isCompacting).toBe(false);
			harness.setResponses([fauxAssistantMessage("continued after accounting race")]);
			await harness.session.prompt("continue after the checkpoint");
			expect(getAssistantTexts(harness)).toContain("continued after accounting race");
		},
		30_000,
	);

	it("starts accepted next prompts after short manual compaction at the real agent-end boundary", async () => {
		const harness = await createHarness({
			persistSession: true,
			tools: [],
			settings: { autoRefine: { enabled: false } },
		});
		harnesses.push(harness);
		harness.session.modelRegistry.registerProvider(compactionModel.provider, {
			api: compactionModel.api,
			baseUrl: compactionModel.baseUrl,
			apiKey: "owner-reproduction-key",
			models: [compactionModel],
		});
		harness.authStorage.setRuntimeApiKey(compactionModel.provider, "owner-reproduction-key");
		await harness.session.setModel(compactionModel);
		await harness.session.setThinkingLevel("low");
		const bodies: unknown[] = [];
		// Only transport is fake. MAIN and summary use the real adapter and persistent owners.
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			bodies.push(JSON.parse(String(init?.body)));
			const text = `Owner scheduling fixture reply ${bodies.length}.`;
			const item = {
				type: "message",
				id: `msg_owner_${bodies.length}`,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text, annotations: [] }],
			};
			const events = [
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { ...item, status: "in_progress", content: [] },
				},
				{ type: "response.output_item.done", output_index: 0, item },
				{
					type: "response.completed",
					response: {
						id: `resp_owner_${bodies.length}`,
						model: compactionModel.id,
						status: "completed",
						usage: {
							input_tokens: 100,
							output_tokens: 16,
							total_tokens: 116,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				},
			];
			return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});
		const control = harness.session as unknown as {
			_sessionInputPumpEpoch: number;
			_sessionInputPumpRequested: boolean;
			_sessionInputPumpSuspended: boolean;
			_queuedWorkPauses: Set<unknown>;
			_sessionInputAdmissionPauses: Set<unknown>;
			_refineInFlight?: Promise<void>;
			_pendingCheckpoint?: unknown;
		};
		const bounded = <T>(work: Promise<T>, phase: string): Promise<T> =>
			new Promise((resolve, reject) => {
				const timer = setTimeout(
					() =>
						reject(
							new Error(
								`Owner reproduction stalled at ${phase}: ${JSON.stringify({
									epoch: control._sessionInputPumpEpoch,
									pumpRequested: control._sessionInputPumpRequested,
									pumpSuspended: control._sessionInputPumpSuspended,
									queuedWorkPauses: control._queuedWorkPauses.size,
									admissionPauses: control._sessionInputAdmissionPauses.size,
									refineInFlight: control._refineInFlight !== undefined,
									pendingCheckpoint: control._pendingCheckpoint !== undefined,
									streaming: harness.session.isStreaming,
									compacting: harness.session.isCompacting,
									unfinishedActions: harness.session.unfinishedActionCount,
									starts: harness.eventsOfType("agent_start").length,
									ends: harness.eventsOfType("agent_end").length,
									providerRequests: bodies.length,
								})}`,
							),
						),
					10_000,
				);
				work.then(
					(value) => {
						clearTimeout(timer);
						resolve(value);
					},
					(error) => {
						clearTimeout(timer);
						reject(error);
					},
				);
			});
		const completedRuns: Array<Promise<{ error?: unknown }>> = [];
		const runToTerminalBoundary = async (text: string) => {
			const accepted = createDeferred<void>();
			const terminal = createDeferred<void>();
			const observed = Promise.all([accepted.promise, terminal.promise]);
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "agent_end") terminal.resolve();
			});
			const run = harness.session.prompt(text, {
				source: "rpc",
				preflightResult: (success) => {
					if (success) accepted.resolve();
					else accepted.reject(new Error(`Prompt was not accepted: ${text}`));
				},
			});
			completedRuns.push(
				run.then(
					() => ({}),
					(error) => {
						accepted.reject(error);
						terminal.reject(error);
						return { error };
					},
				),
			);
			try {
				// Match the observed event boundary; do NOT drain the previous prompt/pump here.
				await bounded(observed, text);
			} finally {
				unsubscribe();
			}
		};
		await bounded(harness.session.prompt("seed enough history for a real manual summary"), "seed");
		await runToTerminalBoundary("owner-stage-initial");
		expect(harness.settingsManager.getCompactionKeepRecentTokens()).toBe(20000);
		const firstTailId = harness.sessionManager.getLeafId();
		const first = await bounded(harness.session.compact(), "first manual compact");
		expect(first.firstKeptEntryId).toBe(firstTailId);
		expect(first.summary).not.toBe("");
		await runToTerminalBoundary("owner-stage-recovered");
		// Ordinary prompt-to-prompt delivery waits for the lower agent, not the session pump.
		// Both manual compactions still start at agent_end without draining their prompt.
		await harness.session.agent.waitForIdle();
		await runToTerminalBoundary("owner-stage-clock-offsets");
		const second = await bounded(harness.session.compact(), "second manual compact");
		expect(second.summary).not.toBe("");
		const afterCompactionRequests = bodies.length;
		await runToTerminalBoundary("owner-stage-stream-monitor");
		const outcomes = await bounded(Promise.all(completedRuns), "prior prompt settlements");
		for (const outcome of outcomes) if ("error" in outcome) throw outcome.error;
		expect(harness.eventsOfType("agent_start")).toHaveLength(5);
		expect(harness.eventsOfType("agent_end")).toHaveLength(5);
		expect(harness.eventsOfType("compaction_end").filter((event) => event.result && !event.aborted)).toHaveLength(2);
		expect(bodies.length).toBeGreaterThan(afterCompactionRequests);
		expect(JSON.stringify(bodies.slice(afterCompactionRequests))).toContain("owner-stage-stream-monitor");
		expect(
			harness
				.eventsOfType("message_end")
				.some(
					(event) =>
						event.message.role === "user" && getMessageText(event.message) === "owner-stage-stream-monitor",
				),
		).toBe(true);
	}, 60_000);

	it("refuses short manual compaction without a removable source prefix", async () => {
		const harness = await createHarness({
			persistSession: true,
			tools: [],
			settings: { autoRefine: { enabled: false } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("This summary must not be requested.")]);
		await harness.sessionManager.appendMessage({ role: "user", content: "Only input", timestamp: 1 });

		await expect(harness.session.compact()).rejects.toThrow("Session is too short to compact");

		expect(harness.getPendingResponseCount()).toBe(1);
		expect((await harness.sessionManager.readEntries()).filter((entry) => entry.type === "compaction")).toEqual([]);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "manual",
			result: undefined,
			errorSeverity: "warning",
		});
	});

	it("manually compacts using an extension-provided summary", async () => {
		const harness = await createHarness({
			persistSession: true,
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: { source: "extension" },
						},
					}));
				},
			],
		});
		harnesses.push(harness);

		harness.session.setActiveToolsByName(["ipython"]);
		harness.setResponses([
			fauxAssistantMessage("one response"),
			fauxAssistantMessage(
				{
					type: "toolCall",
					id: "native-kernel-variables",
					name: "ipython",
					arguments: {
						code: `import sys
assert sys.version_info[:2] == (3, 13)
small_value = 42
large_text = "x" * ${DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES + 1024}`,
					},
				},
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("native variables ready"),
		]);
		await harness.session.prompt("one");
		await harness.session.prompt("Create the compaction variables with ipython.");
		const toolResult = harness.session.messages.find(
			(message) => message.role === "toolResult" && message.toolCallId === "native-kernel-variables",
		);
		expect(toolResult, JSON.stringify(toolResult)).toMatchObject({ isError: false });
		const provisioner = (harness.session as unknown as { _ipythonKernelProvisioner: IpythonKernelProvisioner })
			._ipythonKernelProvisioner;
		expect(provisioner.hasRunningKernel).toBe(true);
		const pruneOversizedVariables = vi.spyOn(provisioner, "pruneOversizedVariables");
		const listNamespaceNames = vi.spyOn(provisioner, "listNamespaceNames");
		const result = await harness.session.compact();
		expect(await pruneOversizedVariables.mock.results[0].value).toContain("large_text");
		const names = await listNamespaceNames.mock.results[0].value;
		expect(names).toContain("small_value");
		expect(names).not.toContain("large_text");
		const compactionEntries = (await harness.sessionManager.readEntries()).filter(
			(entry) => entry.type === "compaction",
		);

		expect(pruneOversizedVariables).toHaveBeenCalledOnce();
		expect(listNamespaceNames).toHaveBeenCalledOnce();
		expect(pruneOversizedVariables.mock.invocationCallOrder[0] as number).toBeLessThan(
			listNamespaceNames.mock.invocationCallOrder[0] as number,
		);
		expect(harness.session.messages).toContainEqual(
			expect.objectContaining({
				role: "custom",
				customType: "ipython_state",
				content: expect.stringContaining("were removed: large_text"),
			}),
		);
		expect(result.summary).toBe("summary from extension");
		expect(compactionEntries).toHaveLength(1);
		expect(harness.session.messages[0]).toMatchObject({ role: "custom", customType: TASK_FRAME_CUSTOM_TYPE });
		const literalMessages = harness.session.messages.filter(
			(message) => message.role !== "custom" || message.customType !== TASK_FRAME_CUSTOM_TYPE,
		);
		expect(literalMessages[0]).toMatchObject({ role: "compactionSummary", summary: "summary from extension" });
	});

	async function createRecoveryCompactionFixture(
		options: { unbudgeted?: boolean; sessionManager?: SessionManager; firstMainUsage?: number } = {},
	) {
		const model = getModel("deepseek", "deepseek-flash");
		const harness = await createHarness({
			persistSession: true,
			sessionManager: options.sessionManager,
			cwd: options.sessionManager?.getCwd(),
			settings: { compaction: { enabled: false, keepRecentTokens: 1 }, autoRefine: { enabled: false } },
			// Keep the built-in prime_context identity; an override would not produce native recovery.
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "ordinary_tail",
						label: "Ordinary tail",
						description: "Return an ordinary tool result after recovery.",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ORDINARY_TAIL_RESULT" }], details: {} }),
					});
				},
			],
			requestTokenBudget: options.unbudgeted
				? undefined
				: {
						mode: "enforce",
						profiles: [
							{
								id: "offline-recovery-compaction",
								revision: "1",
								api: model.api,
								provider: model.provider,
								url: "https://api.deepseek.com/chat/completions",
								model: model.id,
								authMode: "fixture-api-key",
								templateRevision: "deepseek-text-tools-fixture-v1",
								replayFamily: "deepseek-completions",
								contextTokens: 120000,
								outputCeilingTokens: 393216,
								estimate: { tokensPerUtf8Byte: 1, templateTokens: 0, marginTokens: 32 },
							},
						],
					},
		});
		harnesses.push(harness);
		harness.session.modelRegistry.registerProvider(model.provider, {
			api: model.api,
			baseUrl: model.baseUrl,
			apiKey: "offline-deepseek-key",
			models: [model],
		});
		harness.authStorage.setRuntimeApiKey(model.provider, "offline-deepseek-key");
		await harness.session.setModel(model);
		await harness.session.setThinkingLevel("low");
		harness.session.setActiveToolsByName(["prime_context", "ordinary_tail"]);
		harness.settingsManager.applyOverrides({
			compaction: { model: { provider: model.provider, modelId: model.id, thinkingLevel: "low" } },
		});
		const main: Array<{ epoch: CompactionEntry; request: RequestJournalEntry["request"] }> = [];
		const admissions: RequestJournalEntry["request"][] = [];
		const summaries: unknown[] = [];
		// Only HTTP is local. Recovery, request selection, append ACK and compaction use their native owners.
		vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
			expect(String(url)).toBe("https://api.deepseek.com/chat/completions");
			const body = JSON.parse(String(init?.body));
			const entries = await harness.sessionManager.readEntries();
			const admitted = entries
				.flatMap((entry) =>
					entry.type === "request" && entry.request.type === "attempt_admitted" ? [entry.request] : [],
				)
				.at(-1)!;
			const summarizing = admitted.purpose === "summary";
			if (summarizing) summaries.push(body);
			else {
				admissions.push(admitted);
				const epoch = entries.filter((entry) => entry.type === "compaction").at(-1);
				if (epoch) {
					expect(readContextEpoch(epoch.details, 2 * 1024 * 1024)?.replayContract).toBe("message-groups");
					expect(admitted.contextEpoch).toEqual({
						sessionId: harness.sessionManager.getSessionId(),
						entryId: epoch.id,
					});
					main.push({ epoch, request: admitted });
				} else {
					expect(options.unbudgeted && !options.sessionManager).toBe(true);
					expect(admitted.contextEpoch).toBeUndefined();
				}
			}
			const call =
				summarizing || options.sessionManager
					? undefined
					: admissions.length === 1
						? {
								id: "recovery_call",
								name: "prime_context",
								arguments: '{"action":"search","query":"RECOVERY_EVIDENCE"}',
							}
						: admissions.length === 2
							? { id: "ordinary_call", name: "ordinary_tail", arguments: "{}" }
							: undefined;
			const delta = call
				? {
						role: "assistant",
						reasoning_content: "Use the requested tool.",
						tool_calls: [
							{
								index: 0,
								id: call.id,
								type: "function",
								function: { name: call.name, arguments: call.arguments },
							},
						],
					}
				: {
						role: "assistant",
						reasoning_content: "Keep the recovered result.",
						content: summarizing ? "Recovery compacted summary." : "Recovery and ordinary tail complete.",
					};
			const inputTokens = !summarizing && admissions.length === 1 ? (options.firstMainUsage ?? 10) : 10;
			const chunk = {
				id: `recovery_reply_${admissions.length}_${summaries.length}`,
				object: "chat.completion.chunk",
				model: model.id,
				choices: [{ index: 0, delta, finish_reason: call ? "tool_calls" : "stop" }],
				usage: { prompt_tokens: inputTokens, completion_tokens: 10, total_tokens: inputTokens + 10 },
			};
			return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});
		const readRecovery = async () => {
			const entries = await harness.sessionManager.readEntries();
			const result = entries.find(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolCallId === "recovery_call",
			)!;
			expect(result).toMatchObject({ message: { toolName: "prime_context", isError: false } });
			const source = await harness.sessionManager.readBranchHistory((history) => history.get(result.id));
			expect(source).toMatchObject({ qualification: "native-recovery" });
			return { result, source: source! };
		};
		return { harness, main, admissions, summaries, readRecovery };
	}

	it("compacts fresh unbudgeted native recovery after a containing MAIN request", async () => {
		const model = getModel("deepseek", "deepseek-flash");
		const harness = await createHarness({
			persistSession: true,
			settings: { compaction: { enabled: false, keepRecentTokens: 1 }, autoRefine: { enabled: false } },
		});
		harnesses.push(harness);
		harness.session.modelRegistry.registerProvider(model.provider, {
			api: model.api,
			baseUrl: model.baseUrl,
			apiKey: "offline-recovery-key",
			models: [model],
		});
		harness.authStorage.setRuntimeApiKey(model.provider, "offline-recovery-key");
		await harness.session.setModel(model);
		await harness.session.setThinkingLevel("low");
		harness.session.setActiveToolsByName(["prime_context"]);
		const main: RequestJournalEntry["request"][] = [];
		const summaries: unknown[] = [];
		// Only HTTP is offline. Tool qualification, serialization, selection and ACK stay native.
		vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
			expect(String(url)).toBe("https://api.deepseek.com/chat/completions");
			const entries = await harness.sessionManager.readEntries();
			const admitted = entries
				.flatMap((entry) =>
					entry.type === "request" && entry.request.type === "attempt_admitted" ? [entry.request] : [],
				)
				.at(-1)!;
			const summarizing = admitted.purpose === "summary";
			if (summarizing) summaries.push(JSON.parse(String(init?.body)));
			else main.push(admitted);
			const call = !summarizing && main.length === 1;
			const delta = call
				? {
						role: "assistant",
						reasoning_content: "Recover the recorded evidence.",
						tool_calls: [
							{
								index: 0,
								id: "unbudgeted_recovery",
								type: "function",
								function: {
									name: "prime_context",
									arguments: '{"action":"search","query":"RECOVERY_EVIDENCE"}',
								},
							},
						],
					}
				: { role: "assistant", content: summarizing ? "Unbudgeted recovery summary." : "Recovery complete." };
			const chunk = {
				id: `unbudgeted_${main.length}_${summaries.length}`,
				object: "chat.completion.chunk",
				model: model.id,
				choices: [{ index: 0, delta, finish_reason: call ? "tool_calls" : "stop" }],
				usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
			};
			return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});
		await harness.session.prompt(`RECOVERY_EVIDENCE: preserve the warehouse rule. ${"Earlier context. ".repeat(32)}`);
		expect(main).toHaveLength(2);
		const entries = await harness.sessionManager.readEntries();
		const recovery = entries.find((entry) => entry.type === "message" && entry.message.role === "toolResult")!;
		expect(recovery).toMatchObject({ message: { toolName: "prime_context", isError: false } });
		expect(await harness.sessionManager.readBranchHistory((history) => history.get(recovery.id))).toMatchObject({
			qualification: "native-recovery",
		});
		await expect(harness.session.compact()).resolves.toMatchObject({
			summary: expect.stringContaining("Unbudgeted recovery summary."),
		});
		expect(summaries.length).toBeGreaterThan(0);
		const containing = main[1];
		if (containing.type !== "attempt_admitted") throw new Error("Expected actual MAIN admission");
		expect(containing.descriptor.requestBudget).toBeUndefined();
		expect(containing.contextEpoch).toBeDefined();
	});

	it("keeps unbudgeted recovery native when the adapter offers no replay projection", async () => {
		const harness = await createHarness({
			persistSession: true,
			settings: { compaction: { enabled: false, keepRecentTokens: 1 }, autoRefine: { enabled: false } },
		});
		harnesses.push(harness);
		harness.session.setActiveToolsByName(["prime_context"]);
		harness.setResponses([
			fauxAssistantMessage(
				{
					type: "toolCall",
					id: "unprojected_recovery",
					name: "prime_context",
					arguments: { action: "search", query: "RECOVERY_EVIDENCE" },
				},
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Full native recovery complete."),
		]);
		await harness.session.prompt("RECOVERY_EVIDENCE: preserve the warehouse rule.");
		expect(getAssistantTexts(harness)).toContain("Full native recovery complete.");
		expect((await harness.sessionManager.readEntries()).filter((entry) => entry.type === "compaction")).toEqual([]);
		await expect(harness.session.compact()).rejects.toThrow(
			"Recovery compaction requires an accepted replay contract for its selected results",
		);
	});

	it("keeps optional unbudgeted Responses recovery native with request metadata", async () => {
		const model: Model<"openai-responses"> = {
			id: "offline-recovery-metadata",
			name: "Offline recovery metadata",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: false,
			input: ["text"],
			contextWindow: 300000,
			maxTokens: 16,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const harness = await createHarness({
			persistSession: true,
			settings: {
				compaction: { enabled: false, keepRecentTokens: 1 },
				autoRefine: { enabled: false },
				retry: { enabled: false },
			},
		});
		harnesses.push(harness);
		harness.session.modelRegistry.registerProvider(model.provider, {
			api: model.api,
			baseUrl: model.baseUrl,
			apiKey: "offline-metadata-key",
			models: [model],
		});
		harness.authStorage.setRuntimeApiKey(model.provider, "offline-metadata-key");
		await harness.session.setModel(model);
		harness.session.setActiveToolsByName(["prime_context"]);
		const metadataPayload = (payload: unknown) => ({
			...(payload as Record<string, unknown>),
			metadata: { test: "native" },
		});
		harness.session.agent.onPayload = metadataPayload;
		const bodies: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
			expect(String(url)).toBe("https://api.openai.com/v1/responses");
			const body = String(init?.body);
			bodies.push(body);
			expect(JSON.parse(body).metadata).toEqual(harness.session.agent.onPayload ? { test: "native" } : undefined);
			const item =
				bodies.length === 1
					? {
							type: "function_call",
							id: "fc_metadata_recovery",
							call_id: "metadata_recovery",
							name: "prime_context",
							arguments: '{"action":"search","query":"RECOVERY_EVIDENCE"}',
							status: "completed",
						}
					: {
							type: "message",
							id: `msg_metadata_done_${bodies.length}`,
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: "Metadata recovery complete.", annotations: [] }],
						};
			const events = [
				{ type: "response.output_item.added", output_index: 0, item },
				{ type: "response.output_item.done", output_index: 0, item },
				{
					type: "response.completed",
					response: {
						id: `resp_metadata_${bodies.length}`,
						model: model.id,
						status: "completed",
						usage: {
							input_tokens: 10,
							output_tokens: 1,
							total_tokens: 11,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				},
			];
			return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});
		await harness.session.prompt("RECOVERY_EVIDENCE: retain this ordinary recovery result.");
		const entries = await harness.sessionManager.readEntries();
		const result = entries.find((entry) => entry.type === "message" && entry.message.role === "toolResult")!;
		expect(await harness.sessionManager.readBranchHistory((history) => history.get(result.id))).toMatchObject({
			qualification: "native-recovery",
		});
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
		expect(bodies).toHaveLength(2);
		expect(getAssistantTexts(harness)).toContain("Metadata recovery complete.");
		// Unsupported epoch configuration is not permission to prune this native history.
		expect(entries.filter((entry) => entry.type === "compaction")).toEqual([]);
		await expect(harness.session.compact()).rejects.toThrow(
			"Recovery compaction requires an accepted replay contract for its selected results",
		);
		expect(JSON.parse(bodies[1]).input).toContainEqual(
			expect.objectContaining({
				type: "function_call_output",
				call_id: "metadata_recovery",
				output: expect.any(String),
			}),
		);
		// Once a real native epoch exists, unsupported configuration remains a strict refusal.
		harness.session.agent.onPayload = undefined;
		await harness.session.prompt("Acquire native replay coverage without the metadata hook.");
		expect(bodies).toHaveLength(3);
		const checkpoint = (await harness.sessionManager.readEntries())
			.filter((entry) => entry.type === "compaction")
			.at(-1)!;
		expect(readContextEpoch(checkpoint.details, 2 * 1024 * 1024)?.representation).toBeTypeOf("string");
		harness.session.agent.onPayload = metadataPayload;
		await expect(harness.session.prompt("Keep the mandatory epoch strict.")).rejects.toThrow(
			"Unsupported context epoch request configuration",
		);
		expect(bodies).toHaveLength(3);
	});

	it("defers automatic cold recovery until the first native ACK without a failed outcome", async () => {
		const first = await createRecoveryCompactionFixture({ unbudgeted: true, firstMainUsage: 1048576 });
		const priorOutcome = first.harness.session.agent.getTurnOutcome;
		first.harness.session.agent.getTurnOutcome = (context, signal) =>
			context.toolResults.some((result) => result.toolCallId === "recovery_call")
				? { kind: "finish" }
				: (priorOutcome?.(context, signal) ?? { kind: "proceed" });
		await first.harness.session.prompt(
			`RECOVERY_EVIDENCE: keep the warehouse rule. ${"Earlier context. ".repeat(2000)}`,
		);
		expect(first.admissions).toHaveLength(1);
		const { result } = await first.readRecovery();
		const before = await first.harness.sessionManager.readEntries();
		expect(before.filter((entry) => entry.type === "compaction")).toEqual([]);
		const file = first.harness.sessionManager.getSessionFile()!;
		await first.harness.session.disposeAsync();
		const reopened = await SessionManager.open(file);
		const next = await createRecoveryCompactionFixture({
			unbudgeted: true,
			sessionManager: reopened,
			firstMainUsage: 1048576,
		});
		next.harness.session.agent.state.messages = (await next.harness.session.buildSessionContext()).messages;
		next.harness.settingsManager.applyOverrides({ compaction: { enabled: true } });
		await next.harness.session.prompt("Continue from the old unbudgeted recovery history.");
		expect(next.main).toHaveLength(1);
		expect(next.summaries.length).toBeGreaterThan(0);
		const after = await reopened.readEntries();
		const outcomes = after.filter(
			(entry) => entry.type === "custom_message" && entry.customType === "compaction_outcome",
		);
		expect(outcomes).not.toContainEqual(
			expect.objectContaining({ details: expect.objectContaining({ outcome: "failed" }) }),
		);
		expect(outcomes).toContainEqual(
			expect.objectContaining({ details: expect.objectContaining({ outcome: "skipped" }) }),
		);
		const rebuilt = await reopened.readBranchHistory((history) =>
			new CanonicalContextCompiler().compile(
				history.branchContext,
				next.harness.settingsManager.getCanonicalContextLimits(),
			),
		);
		expect(getCanonicalViewUnits(rebuilt)!.flatMap((unit) => unit.exactSources)).toContain(result.id);
	});

	it("cold-resumes an uncompacted overflowed native-tool session without a budget profile", async () => {
		// Seed a genuine admitted native-tool history; the reopened CLI-style owner
		// deliberately has no request-budget profile.
		const first = await createRecoveryCompactionFixture();
		await first.harness.session.prompt(
			`RECOVERY_EVIDENCE: keep the warehouse rule. ${"Earlier context. ".repeat(2000)}`,
		);
		expect(first.main).toHaveLength(3);
		const page = await first.harness.session.recoverNativeHistory({
			action: "search",
			query: "RECOVERY_EVIDENCE",
			maxBytes: 2048,
		});
		const cursor = page.results[0].cursor;
		expect(cursor).toBeTypeOf("string");
		vi.mocked(globalThis.fetch).mockImplementationOnce(
			async () =>
				new Response(
					JSON.stringify({
						error: {
							message:
								"This model's maximum context length is 1048576 tokens. The requested input exceeds this limit.",
							type: "invalid_request_error",
							code: "context_length_exceeded",
						},
					}),
					{ status: 400, headers: { "content-type": "application/json" } },
				),
		);
		await first.harness.session.prompt("RECOVERY_EVIDENCE appended after cursor: continue the current task.");
		const overflow = first.harness.session.messages.at(-1);
		expect(overflow).toMatchObject({ role: "assistant", stopReason: "error" });
		if (overflow?.role !== "assistant") throw new Error("Expected persisted provider overflow");
		expect(isContextOverflow(overflow)).toBe(true);
		expect(first.summaries).toHaveLength(0);
		const continued = await first.harness.session.recoverNativeHistory({
			action: "search",
			cursor: cursor!,
			maxBytes: 2048,
		});
		expect(continued.scope).toEqual(page.scope);
		expect(continued.results[0].reason).not.toBe("expired_cursor");
		expect(
			continued.results
				.flatMap((result) => result.records)
				.map((record) => record.text)
				.join("\n"),
		).not.toContain("appended after cursor");
		const file = first.harness.sessionManager.getSessionFile()!;
		const before = await first.harness.sessionManager.readEntries();
		const toolIds = before
			.filter((entry) => entry.type === "message" && entry.message.role === "toolResult")
			.map((entry) => entry.id);
		await first.harness.session.disposeAsync();
		const reopened = await SessionManager.open(file);
		const next = await createRecoveryCompactionFixture({ unbudgeted: true, sessionManager: reopened });
		// The SDK restores the read-only session context before accepting new input;
		// this low-level AgentSession harness must perform that same public read.
		next.harness.session.agent.state.messages = (await next.harness.session.buildSessionContext()).messages;
		const expired = await next.harness.session.recoverNativeHistory({
			action: "search",
			cursor: cursor!,
			maxBytes: 2048,
		});
		expect(expired.results[0]).toMatchObject({ status: "unavailable", reason: "expired_cursor" });
		next.harness.settingsManager.applyOverrides({ compaction: { enabled: true } });
		await next.harness.session.prompt("Continue after reopening the overflowed session.");

		expect(next.summaries.length).toBeGreaterThan(0);
		expect(next.main).toHaveLength(1);
		expect(next.harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
		const admitted = next.main[0].request;
		if (admitted.type !== "attempt_admitted") throw new Error("Expected actual MAIN admission");
		expect(admitted.descriptor.requestBudget).toBeUndefined();
		const after = await reopened.readEntries();
		expect(
			after
				.filter((entry) => entry.type === "message" && entry.message.role === "toolResult")
				.map((entry) => entry.id),
		).toEqual(toolIds);
		expect(next.harness.session.messages.some((message) => message.role === "compactionSummary")).toBe(true);
	});

	it("accepts refinement_outcome after an existing DeepSeek epoch without sending the UI message", async () => {
		const { harness, main } = await createRecoveryCompactionFixture();
		await harness.session.prompt("RECOVERY_EVIDENCE: keep the warehouse rule.");
		expect(main).toHaveLength(3);
		const existingEpoch = main.at(-1)!.epoch.id;
		const outcomeId = await harness.sessionManager.appendCustomMessageEntry(
			"refinement_outcome",
			"UI_ONLY_REFINEMENT_OUTCOME",
			true,
			{},
		);

		await harness.session.prompt("Apply the SLA update.");
		expect(main).toHaveLength(4);
		expect(main.at(-1)!.request.contextEpoch?.entryId).toBe(main.at(-1)!.epoch.id);
		expect((await harness.sessionManager.readEntries()).some((entry) => entry.id === existingEpoch)).toBe(true);
		expect((await harness.sessionManager.readEntries()).find((entry) => entry.id === outcomeId)).toMatchObject({
			type: "custom_message",
			customType: "refinement_outcome",
			display: true,
		});
		expect(harness.session.messages).toEqual(
			expect.arrayContaining([expect.objectContaining({ role: "custom", customType: "refinement_outcome" })]),
		);
		const body = String(vi.mocked(globalThis.fetch).mock.calls.at(-1)![1]?.body);
		expect(body).not.toContain("UI_ONLY_REFINEMENT_OUTCOME");
		expect(body).toContain("Apply the SLA update.");
	});

	it("adopts native epochs and mode changes when bookkeeping arrives after their ACK", async () => {
		const original = SessionManager.prototype.bindCompactionSink;
		let acknowledgements = 0;
		vi.spyOn(SessionManager.prototype, "bindCompactionSink").mockImplementation(function (
			this: SessionManager,
			...args
		) {
			const sink = original.apply(this, args);
			const append = sink[appendContextEpoch];
			sink[appendContextEpoch] = async (...params) => {
				const entryId = await append(...params);
				await this.appendAgentStatus({ summary: "late status", basedOnMessageCount: 0 });
				expect(this.getLeafId()).not.toBe(entryId);
				expect(sink.isCurrent()).toBe(true);
				acknowledgements++;
				return entryId;
			};
			return sink;
		});
		const { harness, main } = await createRecoveryCompactionFixture();
		await harness.session.prompt("RECOVERY_EVIDENCE: keep the warehouse rule.");
		expect(main).toHaveLength(3);
		await harness.session.setContextMode("off");
		await harness.session.prompt("Continue with fixed context.");
		await harness.session.setContextMode("on");
		await harness.session.prompt("Continue after status bookkeeping.");
		expect(main).toHaveLength(5);
		expect(acknowledgements).toBeGreaterThanOrEqual(4);
		expect(harness.session.isCompacting).toBe(false);
		expect(harness.eventsOfType("compaction_end").filter((event) => event.errorMessage)).toEqual([]);
	});

	it("compacts an overfull public history into a fitting request", async () => {
		const { harness, main, summaries } = await createRecoveryCompactionFixture();
		await harness.session.prompt(`RECOVERY_EVIDENCE: keep the warehouse rule. ${"Older context. ".repeat(2000)}`);
		expect(main).toHaveLength(3);
		const previous = main.at(-1)!.request;
		if (previous.type !== "attempt_admitted") throw new Error("Expected native main admission");
		const budget = previous.descriptor.requestBudget!;
		expect(budget.status).toBe("within-estimate");
		// This fixture explicitly meters one token per byte. Exceed its observed remaining
		// space while leaving enough room after the removable 30 KiB source prefix.
		const addedBytes = budget.availableInputTokens! - budget.estimatedInputTokens! + 20000;
		const recoveryOwner = harness.session.agent as unknown as {
			requestPreparationRecoveryOwner(error: unknown, signal?: AbortSignal): Promise<boolean | "reprepare">;
		};
		const recoverOriginal = recoveryOwner.requestPreparationRecoveryOwner.bind(recoveryOwner);
		const target = (await harness.sessionManager.readBranch()).find(
			(entry) => entry.type === "message" && entry.message.role === "assistant",
		)!;
		const recover = vi
			.spyOn(recoveryOwner, "requestPreparationRecoveryOwner")
			.mockImplementation(async (error, signal) => {
				if (error instanceof PublicContextBudgetError) {
					await harness.sessionManager.appendChildUsageAttributionWithAggregate(target.id, createUsage(10));
					expect(harness.sessionManager.getLeafId()).not.toBe(error.source.leafId);
					expect(error.isSourceCurrent?.()).toBe(true);
				}
				return recoverOriginal(error, signal);
			});
		harness.settingsManager.applyOverrides({ compaction: { enabled: true } });
		await harness.session.prompt(`Current required facts. ${"New ".repeat(Math.ceil(addedBytes / 4))}`);
		expect(recover).toHaveBeenCalledTimes(2);
		expect(await recover.mock.results[0].value).toBe("reprepare");
		expect(await recover.mock.results[1].value).toBe(true);
		const refused = recover.mock.calls[1][0];
		if (!(refused instanceof PublicContextBudgetError)) throw new Error("Expected captured public capacity");
		const remaining =
			refused.mandatoryAssessment!.availableInputTokens! - refused.mandatoryAssessment!.estimatedInputTokens!;
		const requested = summaries.reduce<number>(
			(total, body) => total + (body as { max_tokens: number }).max_tokens,
			0,
		);
		expect(summaries.length).toBeGreaterThan(0);
		expect(requested).toBeLessThanOrEqual(remaining);
		expect(main).toHaveLength(4);
		const admitted = main.at(-1)!.request;
		if (admitted.type !== "attempt_admitted") throw new Error("Expected native main admission");
		expect(admitted.descriptor.requestBudget?.status).toBe("within-estimate");
		expect(harness.session.messages.some((message) => message.role === "compactionSummary")).toBe(true);
	});

	it("compacts recovery over budget before any containing MAIN acknowledgement", async () => {
		const { harness, main, summaries, readRecovery } = await createRecoveryCompactionFixture();
		const priorOutcome = harness.session.agent.getTurnOutcome;
		harness.session.agent.getTurnOutcome = (context, signal) =>
			context.toolResults.some((result) => result.toolCallId === "recovery_call")
				? { kind: "finish" }
				: (priorOutcome?.(context, signal) ?? { kind: "proceed" });
		await harness.session.prompt(`RECOVERY_EVIDENCE: keep the warehouse rule. ${"Older context. ".repeat(2000)}`);
		harness.session.agent.getTurnOutcome = priorOutcome;
		expect(main).toHaveLength(1);
		const { result, source } = await readRecovery();
		const previous = main[0].request;
		if (previous.type !== "attempt_admitted") throw new Error("Expected native main admission");
		expect(readContextEpoch(main[0].epoch.details, 2 * 1024 * 1024)!.source.sourceSequence).toBeLessThan(
			source.sequence,
		);
		const budget = previous.descriptor.requestBudget!;
		const addedBytes = budget.availableInputTokens! - budget.estimatedInputTokens! + 20000;
		const recoveryOwner = harness.session.agent as unknown as {
			requestPreparationRecoveryOwner(error: unknown, signal?: AbortSignal): Promise<boolean | "reprepare">;
		};
		const recover = vi.spyOn(recoveryOwner, "requestPreparationRecoveryOwner");
		harness.settingsManager.applyOverrides({ compaction: { enabled: true } });
		await harness.session.prompt(`Current required facts. ${"New ".repeat(Math.ceil(addedBytes / 4))}`);
		expect(summaries.length).toBeGreaterThan(0);
		const entries = await harness.sessionManager.readEntries();
		const summaryIndex = entries.findIndex(
			(entry) => entry.type === "request" && entry.request.purpose === "summary",
		);
		// The rejected body neither sent nor minted an intermediate epoch before the summary.
		expect(entries.slice(0, summaryIndex).filter((entry) => entry.type === "compaction")).toEqual([main[0].epoch]);
		expect(
			entries
				.slice(0, summaryIndex)
				.filter(
					(entry) =>
						entry.type === "request" &&
						entry.request.type === "attempt_admitted" &&
						entry.request.purpose === "main",
				),
		).toHaveLength(1);
		const rebuilt = await harness.sessionManager.readBranchHistory((history) =>
			new CanonicalContextCompiler().compile(
				history.branchContext,
				harness.settingsManager.getCanonicalContextLimits(),
			),
		);
		expect(getCanonicalViewUnits(rebuilt)!.flatMap((unit) => unit.exactSources)).toContain(result.id);
		const refused = recover.mock.calls.at(-1)![0];
		if (!(refused instanceof PublicContextBudgetError)) throw new Error("Expected actual public budget failure");
		const authorization = getRecoveryCompactionAuthorization(refused);
		expect(authorization).toBeDefined();
		expect(() => canonicalRecoveryBoundary(rebuilt, authorization)).toThrow("no longer matches its captured source");
		const copied = new PublicContextBudgetError(
			refused.source,
			refused.assessment,
			refused.originalAssessment,
			refused.mandatoryAssessment,
			refused.taskFrameRebaseAvailable,
			refused.getCompactionKey(),
			undefined,
			() => true,
		);
		expect(getRecoveryCompactionAuthorization(copied)).toBeUndefined();
		const admitted = main.at(-1)!.request;
		if (admitted.type !== "attempt_admitted") throw new Error("Expected native main admission");
		expect(admitted.descriptor.requestBudget?.status).toBe("within-estimate");
	});

	it("compacts exact inherited recovery again without an intervening MAIN request", async () => {
		const { harness, main, summaries, readRecovery } = await createRecoveryCompactionFixture();
		await harness.session.prompt(`RECOVERY_EVIDENCE: keep the warehouse rule. ${"Earlier context. ".repeat(32)}`);
		const { result } = await readRecovery();
		await harness.session.compact();
		const first = (await harness.sessionManager.readEntries()).filter((entry) => entry.type === "compaction").at(-1)!;
		const checkpoint = readContextEpoch(first.details, 2 * 1024 * 1024)!;
		expect(checkpoint.representation).toBeNull();
		expect(checkpoint.includeSummary).toBe(true);
		expect(checkpoint.replayContract).toBe("message-groups");
		const requestsBefore = main.length;
		const summariesBefore = summaries.length;
		await harness.sessionManager.appendMessage({
			role: "user",
			content: "Retain that evidence in the next summary.",
			timestamp: Date.now(),
		});
		// Threshold compaction may refresh the previous summary while retaining the same unmeasured tail.
		const internals = harness.session as unknown as SessionWithCompactionInternals;
		await internals._runAutoCompaction("threshold", false);
		expect(harness.eventsOfType("compaction_end").at(-1)?.errorMessage).toBeUndefined();
		expect(main).toHaveLength(requestsBefore);
		expect(summaries.length).toBeGreaterThan(summariesBefore);
		const rebuilt = await harness.sessionManager.readBranchHistory((history) =>
			new CanonicalContextCompiler().compile(
				history.branchContext,
				harness.settingsManager.getCanonicalContextLimits(),
			),
		);
		expect(getCanonicalViewUnits(rebuilt)!.flatMap((unit) => unit.exactSources)).toContain(result.id);
	});

	it("refuses an oversized mandatory public request without paying for a summary", async () => {
		const { harness, main, summaries } = await createRecoveryCompactionFixture();
		await harness.session.prompt("RECOVERY_EVIDENCE: keep the warehouse rule.");
		expect(main).toHaveLength(3);
		harness.settingsManager.applyOverrides({ compaction: { enabled: true } });
		const requiredPrompt = vi
			.spyOn(harness.session.resourceLoader, "getSystemPrompt")
			.mockReturnValue("Required instruction. ".repeat(8000));
		harness.session.setActiveToolsByName(harness.session.getActiveToolNames());
		await expect(harness.session.prompt("Continue with the same required evidence.")).rejects.toThrow(
			"Context capacity exceeded",
		);
		expect(requiredPrompt).toHaveBeenCalled();
		expect(main).toHaveLength(3);
		expect(summaries).toHaveLength(0);
	});

	it("renews recovery coverage at accepted ACK, reuses an ordinary tail, and manually compacts", async () => {
		const { harness, main, summaries, readRecovery } = await createRecoveryCompactionFixture();
		await harness.session.prompt(`RECOVERY_EVIDENCE: keep the warehouse rule. ${"Earlier context. ".repeat(32)}`);
		expect(main).toHaveLength(3);
		const { result, source } = await readRecovery();
		const initial = readContextEpoch(main[0].epoch.details, 2 * 1024 * 1024)!;
		const accepted = readContextEpoch(main[1].epoch.details, 2 * 1024 * 1024)!;
		expect(source.sequence).toBeGreaterThan(initial.source.sourceSequence);
		expect(main[1].epoch.id).not.toBe(main[0].epoch.id);
		expect(accepted.source).toEqual(main[1].request.source);
		expect(accepted.source.leafId).toBe(result.id);
		expect(accepted.source.sourceSequence).toBe(source.sequence);
		expect(accepted.literalTailId).toBe(result.id);
		// No unrelated policy/resource/task change can explain the new ACK.
		expect(accepted.representation).toBe(initial.representation);
		expect(accepted.resourceRevision).toBe(initial.resourceRevision);
		expect(accepted.taskFrame?.material).toBe(initial.taskFrame?.material);
		expect(main[2].request.source.sourceSequence).toBeGreaterThan(source.sequence);
		expect(main[2].epoch.id).toBe(main[1].epoch.id);
		expect((await harness.sessionManager.readEntries()).filter((entry) => entry.type === "compaction")).toHaveLength(
			2,
		);

		const before = await harness.sessionManager.readBranchHistory((history) =>
			new CanonicalContextCompiler().compile(
				history.branchContext,
				harness.settingsManager.getCanonicalContextLimits(),
			),
		);
		const beforeUnits = getCanonicalViewUnits(before)!;
		const recoveryUnit = beforeUnits.find((unit) => unit.exactSources.includes(result.id))!;
		const callerIndex = before.findIndex(
			(message) =>
				message.role === "assistant" &&
				message.content.some((part) => part.type === "toolCall" && part.id === "recovery_call"),
		);
		expect(callerIndex).toBeGreaterThanOrEqual(0);
		expect(recoveryUnit.requiredVisibleDependencies).toContain(beforeUnits[callerIndex].id);
		const callerSource = beforeUnits[callerIndex].exactSources[0];
		const compacted = await harness.session.compact();
		expect(compacted.summary).toContain("Recovery compacted summary.");
		expect(summaries.length).toBeGreaterThan(0);
		const rebuilt = await harness.sessionManager.readBranchHistory((history) =>
			new CanonicalContextCompiler().compile(
				history.branchContext,
				harness.settingsManager.getCanonicalContextLimits(),
			),
		);
		const retained = getCanonicalViewUnits(rebuilt)!.flatMap((unit) => unit.exactSources);
		expect(retained).toEqual(expect.arrayContaining([result.id, callerSource]));
	});

	it("refuses manual compaction of native recovery before any containing candidate is accepted", async () => {
		const { harness, main, summaries, readRecovery } = await createRecoveryCompactionFixture();
		const priorOutcome = harness.session.agent.getTurnOutcome;
		harness.session.agent.getTurnOutcome = (context, signal) =>
			context.toolResults.some((result) => result.toolCallId === "recovery_call")
				? { kind: "finish" }
				: (priorOutcome?.(context, signal) ?? { kind: "proceed" });
		await harness.session.prompt(`RECOVERY_EVIDENCE: keep the warehouse rule. ${"Earlier context. ".repeat(32)}`);
		expect(main).toHaveLength(1); // The result exists, but no request containing it has reached acceptance.
		const { source } = await readRecovery();
		const checkpoint = readContextEpoch(main[0].epoch.details, 2 * 1024 * 1024)!;
		expect(source.sequence).toBeGreaterThan(checkpoint.source.sourceSequence);
		await expect(harness.session.compact()).rejects.toThrow(
			"Recovery compaction requires an accepted replay contract for its selected results",
		);
		expect(summaries).toHaveLength(0);
		expect((await harness.sessionManager.readEntries()).filter((entry) => entry.type === "compaction")).toEqual([
			main[0].epoch,
		]);
	});

	it.each(["tool_calls", "length"] as const)(
		"continues DeepSeek tools through its native public checkpoint and rejects an altered replay payload (%s)",
		async (finishReason) => {
			const model = getModel("deepseek", "deepseek-flash");
			const privateThinking = `PRIVATE_DEEPSEEK_REASONING ${"thinking ".repeat(14000)}`;
			const lengthLimited = finishReason === "length";
			const expectedExecutions = lengthLimited ? 0 : 1;
			const expectedResult = lengthLimited ? "Validation failed for tool" : "TOOL_RESULT_PRESERVED";
			let executions = 0;
			const harness = await createHarness({
				persistSession: true,
				settings: { compaction: { enabled: false, keepRecentTokens: 1 }, autoRefine: { enabled: false } },
				tools: [
					{
						name: "deepseek_probe",
						label: "DeepSeek probe",
						description: "Return the fixture result.",
						parameters: lengthLimited ? Type.Object({ command: Type.String() }) : Type.Object({}),
						execute: async () => {
							executions++;
							return { content: [{ type: "text", text: "TOOL_RESULT_PRESERVED" }], details: {} };
						},
					},
				],
				requestTokenBudget: {
					mode: "enforce",
					profiles: [
						{
							id: "offline-deepseek-native",
							revision: "1",
							api: model.api,
							provider: model.provider,
							url: "https://api.deepseek.com/chat/completions",
							model: model.id,
							authMode: "fixture-api-key",
							templateRevision: "deepseek-text-tools-fixture-v1",
							replayFamily: "deepseek-completions",
							contextTokens: 120000,
							outputCeilingTokens: 393216,
							estimate: { tokensPerUtf8Byte: 1, templateTokens: 0, marginTokens: 32 },
						},
					],
				},
			});
			harnesses.push(harness);
			harness.session.modelRegistry.registerProvider(model.provider, {
				api: model.api,
				baseUrl: model.baseUrl,
				apiKey: "offline-deepseek-key",
				models: [model],
			});
			harness.authStorage.setRuntimeApiKey(model.provider, "offline-deepseek-key");
			await harness.session.setModel(model);
			await harness.session.setThinkingLevel("low");
			harness.session.setActiveToolsByName(["deepseek_probe"]);
			harness.settingsManager.applyOverrides({
				compaction: { model: { provider: model.provider, modelId: model.id, thinkingLevel: "low" } },
			});
			type Body = {
				model: string;
				messages: Array<Record<string, unknown>>;
				max_tokens: number;
				reasoning_effort?: string;
				tools?: unknown[];
			};
			const mainBodies: Body[] = [];
			const summaryBodies: Body[] = [];
			const epochsAtSend: string[] = [];
			const rawBodies: string[] = [];
			let altered = false;
			harness.session.agent.onPayload = (payload) => {
				rawBodies.push(JSON.stringify(payload));
				if (altered) {
					const body = payload as Body;
					return { ...body, messages: [...body.messages, { role: "user", content: "UNOWNED_PAYLOAD_CHANGE" }] };
				}
			};
			// Only HTTP is offline. The real adapter, selected tool, journal and epoch owner run normally.
			const offlineFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
				expect(String(url)).toBe("https://api.deepseek.com/chat/completions");
				const body = JSON.parse(String(init?.body)) as Body;
				expect(body.model).toBe(model.id);
				expect(body.max_tokens).toBeGreaterThan(0);
				expect(body).not.toHaveProperty("max_completion_tokens");
				expect(body).not.toHaveProperty("input");
				const entries = await harness.sessionManager.readEntries();
				const admitted = entries
					.flatMap((entry) =>
						entry.type === "request" && entry.request.type === "attempt_admitted" ? [entry.request] : [],
					)
					.at(-1)!;
				const summarizing = admitted.purpose === "summary";
				if (summarizing) summaryBodies.push(body);
				else {
					const epoch = entries.filter((entry) => entry.type === "compaction").at(-1)!;
					const checkpoint = readContextEpoch(epoch.details, 2 * 1024 * 1024)!;
					expect(checkpoint.replayContract).toBe("message-groups");
					expect(admitted.contextEpoch).toEqual({
						sessionId: harness.sessionManager.getSessionId(),
						entryId: epoch.id,
					});
					// Admission and HTTP follow the existing canonical append ACK, not a predicted epoch ID.
					epochsAtSend.push(epoch.id);
					mainBodies.push(body);
				}
				const toolCall = !summarizing && mainBodies.length === 1;
				const delta = toolCall
					? {
							role: "assistant",
							reasoning_content: privateThinking,
							tool_calls: [
								{
									index: 0,
									id: "deepseek_call",
									type: "function",
									function: { name: "deepseek_probe", arguments: "{}" },
								},
							],
						}
					: {
							role: "assistant",
							reasoning_content: "Retain the result.",
							content: summarizing ? "DeepSeek compacted summary." : "DeepSeek continuation complete.",
						};
				const chunk = {
					id: `deepseek_reply_${mainBodies.length}_${summaryBodies.length}`,
					object: "chat.completion.chunk",
					model: model.id,
					choices: [{ index: 0, delta, finish_reason: toolCall ? finishReason : "stop" }],
					usage: {
						prompt_tokens: 10,
						completion_tokens: 10,
						total_tokens: 20,
						prompt_cache_hit_tokens: 2,
						prompt_cache_miss_tokens: 8,
					},
				};
				return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			});

			await harness.session.prompt("Run deepseek_probe and retain its result.");
			expect(executions).toBe(expectedExecutions);
			expect(mainBodies).toHaveLength(2);
			expect(rawBodies).toHaveLength(2); // The public candidate does not convert or call onPayload again.
			expect(rawBodies[1]).toContain(privateThinking);
			expect(rawBodies[1]).toContain('"reasoning_content"');
			expect(rawBodies[1]).toContain('"tool_calls"');
			expect(JSON.stringify(mainBodies[1])).not.toContain("PRIVATE_DEEPSEEK_REASONING");
			expect(JSON.stringify(mainBodies[1])).not.toContain('"tool_calls"');
			expect(mainBodies[1].messages.some((message) => message.role === "tool")).toBe(false);
			expect(JSON.stringify(mainBodies[1])).toContain(expectedResult);
			expect(mainBodies[1].tools).toEqual(mainBodies[0].tools);
			expect(mainBodies.map((body) => body.reasoning_effort)).toEqual(["low", "low"]);
			expect(epochsAtSend[1]).not.toBe(epochsAtSend[0]);
			const qualifiedTool = await harness.sessionManager.readBranchHistory(async (history) => {
				for await (const item of history.iterateEntries({ maxEntries: 128, maxSourceBytes: 2 * 1024 * 1024 }))
					if (item.source.qualification === "native-tool-execution") return true;
				return false;
			});
			expect(qualifiedTool).toBe(!lengthLimited);
			const beforeCompaction = await harness.sessionManager.readEntries();
			const toolAssistant = beforeCompaction.find(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					entry.message.stopReason === (lengthLimited ? "length" : "toolUse"),
			);
			expect(toolAssistant).toMatchObject({
				requestOutput: {
					attemptIds: [expect.any(String)],
					source: { sessionId: harness.sessionManager.getSessionId() },
				},
			});

			if (lengthLimited) {
				expect(
					beforeCompaction.find(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "toolResult" &&
							entry.message.toolCallId === "deepseek_call",
					),
				).toMatchObject({
					message: { isError: true },
					execution: { executionOutcome: "not_started", originalInput: {} },
				});
			}

			const compacted = await harness.session.compact();
			expect(compacted.summary).toContain("DeepSeek compacted summary.");
			expect(summaryBodies.length).toBeGreaterThan(0);
			const saved = (await harness.sessionManager.readEntries())
				.filter((entry) => entry.type === "compaction")
				.at(-1)!;
			expect(saved.requestOutputs?.length).toBe(summaryBodies.length);
			expect(readContextEpoch(saved.details, 2 * 1024 * 1024)).toBeDefined();
			await harness.session.setThinkingLevel("medium");
			await harness.session.prompt("Continue after the committed summary.");
			expect(mainBodies).toHaveLength(3);
			expect(mainBodies[2].reasoning_effort).toBe("high");
			expect(JSON.stringify(mainBodies[2])).toContain("DeepSeek compacted summary.");
			expect(rawBodies).toHaveLength(3);
			expect(executions).toBe(expectedExecutions);

			const sent = offlineFetch.mock.calls.length;
			const accepted = epochsAtSend.at(-1)!;
			altered = true;
			await expect(harness.session.prompt("Do not accept a changed projection.")).rejects.toThrow(
				"compatible final provider projection",
			);
			expect(rawBodies).toHaveLength(4);
			expect(offlineFetch).toHaveBeenCalledTimes(sent);
			expect((await harness.sessionManager.readEntries()).some((entry) => entry.id === accepted)).toBe(true);
		},
	);

	it("compacts through the model summarizer, persists metadata, emits events, and remains usable", async () => {
		let postAckSummary = false;
		let extensionRequestOutputs: CompactionEntry["requestOutputs"];
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 }, autoRefine: { enabled: false } },
			persistSession: true,
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => {
						if (!postAckSummary) return;
						return {
							compaction: {
								summary: "acknowledged refresh probe",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								requestOutputs: extensionRequestOutputs,
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("one response"),
			fauxAssistantMessage("two response"),
			fauxAssistantMessage("still usable"),
		]);
		harness.session.modelRegistry.registerProvider(compactionModel.provider, {
			api: compactionModel.api,
			baseUrl: compactionModel.baseUrl,
			apiKey: "summary-fixture-key",
			models: [compactionModel],
		});
		harness.authStorage.setRuntimeApiKey(compactionModel.provider, "summary-fixture-key");
		const selection = {
			provider: compactionModel.provider,
			modelId: compactionModel.id,
			thinkingLevel: "high" as const,
		};
		harness.settingsManager.applyOverrides({ compaction: { model: selection } });
		const detached = harness.settingsManager.getCompactionModel()!;
		detached.modelId = "changed-getter-copy";
		expect(harness.settingsManager.getCompactionModel()).toEqual(selection);
		const mainModel = structuredClone(harness.session.model);
		const mainEffort = harness.session.thinkingLevel;
		const bodies: Array<{ model: string; reasoning: { effort: string } }> = [];
		// Only HTTP is offline; the real adapter owns serialization, admission and receipts.
		const offlineFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			bodies.push(JSON.parse(String(init?.body)));
			const text = bodies.length === 1 ? "model-generated summary" : "model-generated turn summary";
			const item = {
				type: "message",
				id: `msg_summary_${bodies.length}`,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text, annotations: [] }],
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
						id: `resp_summary_${bodies.length}`,
						model: compactionModel.id,
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
		await harness.session.prompt("one");
		await harness.session.prompt("two");
		const readOwnUsage = async () => {
			const eager = vi.spyOn(harness.sessionManager, "getEntries").mockImplementation(() => {
				throw new Error("Own usage must read captured source history");
			});
			try {
				return await harness.session.getOwnUsageSummary();
			} finally {
				eager.mockRestore();
			}
		};
		const usageBeforeCompaction = await readOwnUsage();
		const repeatedUsage = await readOwnUsage();
		expect(repeatedUsage).toEqual(usageBeforeCompaction);
		if (repeatedUsage) repeatedUsage.cost = -1;
		expect(await readOwnUsage()).toEqual(usageBeforeCompaction);
		const sourceError = new Error("Own usage source callback failed");
		const sourceRead = vi.spyOn(harness.sessionManager, "readOwnUsageSummary").mockRejectedValueOnce(sourceError);
		try {
			await expect(readOwnUsage()).rejects.toBe(sourceError);
		} finally {
			sourceRead.mockRestore();
		}

		const sourceSessionId = harness.sessionManager.getSessionId();
		const sourceLeafId = harness.sessionManager.getLeafId();
		const originalBind = harness.sessionManager.bindCompactionSink.bind(harness.sessionManager);
		let branchReads = 0;
		const bound = vi.spyOn(harness.sessionManager, "bindCompactionSink").mockImplementation((limits) => {
			const sink = originalBind(limits);
			const read = sink.readBranch.bind(sink);
			vi.spyOn(sink, "readBranch").mockImplementation(() => {
				branchReads++;
				if (branchReads === 1) {
					harness.settingsManager.applyOverrides({
						compaction: { model: { ...selection, modelId: "changed-after-capture", thinkingLevel: "low" } },
					});
				}
				return read();
			});
			return sink;
		});
		const captures = vi.spyOn(InferenceCoordinator.prototype, "capture");
		const result = await harness.session.compact();
		harness.settingsManager.applyOverrides({ compaction: { model: selection } });
		expect(harness.session.model).toEqual(mainModel);
		expect(harness.session.thinkingLevel).toBe(mainEffort);
		expect(offlineFetch).toHaveBeenCalledTimes(2);
		expect(bodies).toEqual([
			expect.objectContaining({ model: compactionModel.id, reasoning: expect.objectContaining({ effort: "high" }) }),
			expect.objectContaining({ model: compactionModel.id, reasoning: expect.objectContaining({ effort: "high" }) }),
		]);
		const receipts: RequestJournalEntry[] = [];
		for await (const { entry: record } of readSessionJournal(harness.sessionManager.getSessionFile()!)) {
			const entry = record as RequestJournalEntry;
			if (entry.type === "request" && entry.request.type === "attempt_settled") receipts.push(entry);
		}
		expect(receipts).toHaveLength(2);
		for (const { request } of receipts) {
			expect(request).toMatchObject({
				purpose: "summary",
				owner: { sessionId: sourceSessionId },
				source: { sessionId: sourceSessionId, leafId: sourceLeafId },
				modelContract: { provider: compactionModel.provider, model: compactionModel.id },
				receipt: { api: compactionModel.api, model: compactionModel.id, effort: "high", outcome: "completed" },
			});
		}
		expect(bound).toHaveBeenCalledOnce();
		expect(branchReads).toBe(1);
		expect(captures).toHaveBeenCalledWith(bound.mock.results[0].value);
		const entry = (await harness.sessionManager.readEntries()).find((candidate) => candidate.type === "compaction");
		if (!entry || entry.type !== "compaction" || !entry.requestOutputs)
			throw new Error("Expected native compaction request links");
		expect(entry.requestOutputs.map((output) => output.part).sort()).toEqual(["history", "turn-prefix"]);
		for (const output of entry.requestOutputs) {
			const purposeDetail = output.part === "history" ? "compaction" : "compaction-turn-prefix";
			const request = receipts.find(({ request }) => request.purposeDetail === purposeDetail)?.request;
			if (!request) throw new Error("Expected the recorded summary request");
			// This fixture admits one attempt per actual history/prefix request, without retries.
			expect(output).toEqual({
				part: output.part,
				operationId: request.operationId,
				attemptIds: [request.attemptId],
				source: request.source,
			});
		}
		const originalRequestOutputs = structuredClone(entry.requestOutputs);
		extensionRequestOutputs = structuredClone(originalRequestOutputs);
		expect(JSON.stringify(bodies)).not.toContain("requestOutputs");

		expect(result.summary).toContain("model-generated summary");
		expect(result.tokensBefore).toBeGreaterThan(0);
		expect(result.firstKeptEntryId).toBeTruthy();
		expect(entry).toMatchObject({
			type: "compaction",
			summary: expect.stringContaining("model-generated summary"),
			firstKeptEntryId: result.firstKeptEntryId,
			tokensBefore: result.tokensBefore,
			fromHook: false,
		});
		const compactionUsage = (entry as { usage: Usage }).usage;
		expect(compactionUsage.input).toBeGreaterThan(0);
		expect(compactionUsage.output).toBeGreaterThan(0);
		// Own spend grows by exactly what the compaction entry recorded.
		const ownUsage = await readOwnUsage();
		expect((ownUsage?.inputTokens ?? 0) - (usageBeforeCompaction?.inputTokens ?? 0)).toBe(
			compactionUsage.input + compactionUsage.cacheRead + compactionUsage.cacheWrite,
		);
		expect((ownUsage?.outputTokens ?? 0) - (usageBeforeCompaction?.outputTokens ?? 0)).toBe(compactionUsage.output);
		expect((ownUsage?.cost ?? 0) - (usageBeforeCompaction?.cost ?? 0)).toBeCloseTo(compactionUsage.cost.total);
		expect(harness.session.messages[0]).toMatchObject({ role: "custom", customType: TASK_FRAME_CUSTOM_TYPE });
		const literalMessages = harness.session.messages.filter(
			(message) => message.role !== "custom" || message.customType !== TASK_FRAME_CUSTOM_TYPE,
		);
		expect(literalMessages[0]).toMatchObject({
			role: "compactionSummary",
			summary: expect.stringContaining("model-generated summary"),
		});
		expect(literalMessages[0]).not.toHaveProperty("requestOutputs");
		expect(harness.eventsOfType("compaction_start")).toEqual([expect.objectContaining({ reason: "manual" })]);
		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({
				reason: "manual",
				result: expect.objectContaining({ tokensBefore: result.tokensBefore }),
				aborted: false,
				willRetry: false,
			}),
		]);

		await harness.session.prompt("after compaction");
		expect(harness.session.model).toEqual(mainModel);
		expect(harness.session.thinkingLevel).toBe(mainEffort);
		expect(offlineFetch).toHaveBeenCalledTimes(2);
		expect(harness.session.agent.state.errorMessage).toBeUndefined();
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "still usable" }],
		});

		// A real canonical append ACK followed by a failed bootstrap is not a failed append or usable projection.
		const countBeforeSetupFailure = (await harness.sessionManager.readEntries()).filter(
			(entry) => entry.type === "compaction",
		).length;
		const startsBeforeSetupFailure = harness.eventsOfType("compaction_start").length;
		const refreshError = new Error("post-ACK compaction refresh failed");
		const append = harness.sessionManager.appendCompaction.bind(harness.sessionManager);
		let committedEntryId: string | undefined;
		let restoreRefresh: (() => void) | undefined;
		const appendProbe = vi
			.spyOn(harness.sessionManager, "appendCompaction")
			.mockImplementationOnce(async (...args) => {
				const id = await append(...args);
				committedEntryId = id;
				const refresh = vi.spyOn(harness.sessionManager, "readBranchHistory").mockRejectedValueOnce(refreshError);
				restoreRefresh = () => refresh.mockRestore();
				return id;
			});
		const finish = vi.spyOn(harness.session.semanticEdges, "finishCompaction");
		const continueAgent = vi.spyOn(harness.session.agent, "continue");
		postAckSummary = true;
		try {
			const error = await harness.session.compact().then(
				() => undefined,
				(failure: unknown) => failure,
			);
			expect(error).toBeInstanceOf(CompactionCommittedError);
			const committed = error as CompactionCommittedError;
			expect(committed.entryId).toBe(committedEntryId);
			expect(committed.result.summary).toBe("acknowledged refresh probe");
			expect(committed.cause).toBe(refreshError);
			await expect(harness.session.compact()).rejects.toBe(committed);
			expect(appendProbe).toHaveBeenCalledOnce();
			const extensionEntry = await harness.sessionManager.readEntry(committed.entryId);
			expect(extensionEntry).toMatchObject({
				id: committed.entryId,
				type: "compaction",
				summary: committed.result.summary,
			});
			expect(extensionEntry).not.toHaveProperty("requestOutputs");
			expect(await harness.sessionManager.readEntry(entry.id)).toMatchObject({
				requestOutputs: originalRequestOutputs,
			});
			expect(
				(await harness.sessionManager.readEntries()).filter((entry) => entry.type === "compaction"),
			).toHaveLength(countBeforeSetupFailure + 1);
			expect(finish.mock.calls.map(([, status]) => status)).toEqual(["completed"]);
			expect(harness.eventsOfType("compaction_start")).toHaveLength(startsBeforeSetupFailure + 1);
			expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
				result: committed.result,
				errorMessage: committed.message,
				errorSeverity: "error",
				willRetry: false,
			});
			expect(continueAgent).not.toHaveBeenCalled();
		} finally {
			postAckSummary = false;
			restoreRefresh?.();
			appendProbe.mockRestore();
			finish.mockRestore();
			continueAgent.mockRestore();
		}

		// These are storage arguments, not a physical provider usage receipt.
		const branchBeforeAdmission = await harness.sessionManager.readBranch();
		const firstKept = branchBeforeAdmission.find((candidate) => candidate.type === "message");
		if (!firstKept) throw new Error("Expected a real message for bound append admission");
		const details = { readFiles: ["Before.ts"], nested: { text: "before source wait" } };
		const usage: Usage = {
			input: 7,
			output: 3,
			cacheRead: 2,
			cacheWrite: 0,
			totalTokens: 12,
			cost: { input: 0.7, output: 0.3, cacheRead: 0.2, cacheWrite: 0, total: 1.2 },
		};
		const originalDetails = structuredClone(details);
		const originalUsage = structuredClone(usage);
		const admitted = harness.sessionManager.bindCompactionSink();
		admitted.retain();
		try {
			const reading = admitted.readBranch();
			const appending = admitted.appendCompaction(
				"bound argument snapshot",
				firstKept.id,
				64,
				details,
				false,
				undefined,
				usage,
			);
			details.readFiles[0] = "After.ts";
			details.nested.text = "mutated before the first await";
			usage.input = 700;
			usage.cost.input = 70;
			const releasing = admitted.release();
			const [entryId, readBranch] = await Promise.all([appending, reading, releasing]);
			expect(readBranch).toEqual(branchBeforeAdmission);
			const genericEntry = await harness.sessionManager.readEntry(entryId);
			expect(genericEntry).toMatchObject({
				type: "compaction",
				summary: "bound argument snapshot",
				firstKeptEntryId: firstKept.id,
				details: originalDetails,
				usage: originalUsage,
			});
			expect(genericEntry).not.toHaveProperty("requestOutputs");
		} finally {
			await admitted.release();
		}
	});

	it("renders an executing /compact as activity instead of queued work", async () => {
		let releaseCompaction: () => void = () => {};
		const compactionGate = new Promise<void>((resolve) => {
			releaseCompaction = resolve;
		});
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			persistSession: true,
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => {
						await compactionGate;
					});
				},
			],
		});
		harnesses.push(harness);
		let releaseTurn: () => void = () => {};
		const turnGate = new Promise<void>((resolve) => {
			releaseTurn = resolve;
		});
		harness.setResponses([
			async () => {
				await turnGate;
				return fauxAssistantMessage("slow response");
			},
			fauxAssistantMessage("model-generated summary"),
			fauxAssistantMessage("model-generated turn summary"),
		]);
		const running = harness.session.prompt("one");
		// Queue the command while the turn streams, then let the turn finish.
		const queued = harness.session.prompt("/compact", { streamingBehavior: "steer" });
		releaseTurn();
		await vi.waitFor(() =>
			expect(harness.session.getSessionActionSnapshot()).toMatchObject({
				queuedCount: 0,
				steering: [],
				followUps: [],
				active: { kind: "session_command", phase: "running", label: "/compact" },
			}),
		);
		expect(harness.session.isSessionActive).toBe(true);
		releaseCompaction();
		await Promise.all([running, queued]);

		const order = harness.events.map((event) => event.type);
		expect(order.indexOf("compaction_start")).toBeGreaterThan(order.indexOf("agent_end"));
		expect(harness.eventsOfType("compaction_start")).toEqual([expect.objectContaining({ reason: "manual" })]);
		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({ reason: "manual", aborted: false }),
		]);
	});

	it("reschedules a pending post-compaction continuation after successful manual compaction", async () => {
		const fixture = await prepareNativeCheckpoint({ failFirstCompaction: true });
		const { harness, internals, scheduled, pause, running } = fixture;
		try {
			fixture.releaseTool.resolve();
			await fixture.compacted.promise;
			await harness.session.agent.waitForIdle();
			await vi.waitFor(() => expect(scheduled).toHaveBeenCalledOnce());
			const original = scheduled.mock.calls[0][0];
			expect(original.boundary?.state).toBe("pending");

			await harness.session.compact();

			expect(internals._postCompactionContinuationScheduled).toBe(true);
			expect(scheduled).toHaveBeenCalledTimes(2);
			const replacement = scheduled.mock.calls[1][0];
			expect(replacement.owner.manager === harness.sessionManager).toBe(true);
			expect(replacement.owner.agent === harness.session.agent).toBe(true);
			expect(replacement.owner.isSourceCurrent()).toBe(true);
			expect(replacement.boundary === original.boundary).toBe(true);
		} finally {
			pause.release();
		}
		await running;
		await harness.session.waitForHeadlessIdle();
	});

	it("waits for active manual compaction before continuing", async () => {
		const compactionStarted = createDeferred();
		const compactionRelease = createDeferred();
		let hold = false;
		const fixture = await prepareNativeCheckpoint({
			failFirstCompaction: true,
			beforeCompact: async () => {
				if (!hold) return;
				compactionStarted.resolve();
				await compactionRelease.promise;
			},
		});
		const { harness, pause, continued, running } = fixture;
		fixture.releaseTool.resolve();
		await fixture.compacted.promise;
		await harness.session.agent.waitForIdle();
		await vi.waitFor(() => expect(fixture.scheduled).toHaveBeenCalledOnce());
		hold = true;
		const compaction = harness.session.compact(undefined, { skipAbort: true });
		try {
			await compactionStarted.promise;
			pause.release();
			await new Promise<void>(setImmediate);
			expect(continued).not.toHaveBeenCalled();
		} finally {
			compactionRelease.resolve();
			pause.release();
		}
		await compaction;
		await running;
		await harness.session.waitForHeadlessIdle();
		expect(continued).toHaveBeenCalledTimes(1);
	});

	it("waits for active auto-compaction before continuing", async () => {
		const compactionStarted = createDeferred();
		const compactionRelease = createDeferred();
		let hold = false;
		let staleCompactionStarted: (() => void) | undefined;
		let staleCompactionRelease: Promise<void> | undefined;
		let staleBranchIds: string[] = [];
		const fixture = await prepareNativeCheckpoint({
			failFirstCompaction: true,
			persistSession: true,
			beforeCompact: async (entries) => {
				if (!hold) return;
				compactionStarted.resolve();
				await compactionRelease.promise;
				if (staleCompactionStarted) {
					staleBranchIds = entries.map((entry) => entry.id);
					staleCompactionStarted();
					await staleCompactionRelease;
				}
			},
		});
		const { harness, pause, continued, running } = fixture;
		const internals = harness.session as unknown as SessionWithCompactionInternals;
		fixture.releaseTool.resolve();
		await fixture.compacted.promise;
		await harness.session.agent.waitForIdle();
		await vi.waitFor(() => expect(fixture.scheduled).toHaveBeenCalledOnce());
		hold = true;
		// The existing native auto-compaction entry captures the already-owned checkpoint.
		harness.settingsManager.applyOverrides({ compaction: { enabled: true } });
		const compaction = internals._runAutoCompaction("threshold", false);
		try {
			await compactionStarted.promise;
			pause.release();
			await new Promise<void>(setImmediate);
			expect(continued).not.toHaveBeenCalled();
		} finally {
			compactionRelease.resolve();
			pause.release();
		}
		await compaction;
		await running;
		await harness.session.waitForHeadlessIdle();
		expect(continued).toHaveBeenCalledTimes(1);

		// Extend the existing held-hook case without another provider/summary response.
		const before = (await harness.sessionManager.readEntries()).filter((entry) => entry.type === "compaction");
		await harness.sessionManager.appendMessage({ role: "user", content: "Prepare stale summary", timestamp: 3 });
		const keptId = await harness.sessionManager.appendMessage({
			role: "user",
			content: "Keep exact input",
			timestamp: 4,
		});
		const staleStarted = createDeferred();
		const staleRelease = createDeferred();
		staleCompactionStarted = () => staleStarted.resolve();
		staleCompactionRelease = staleRelease.promise;
		const stale = internals._runAutoCompaction("threshold", false);
		let lateId: string;
		try {
			await staleStarted.promise;
			lateId = await harness.sessionManager.appendMessage({
				role: "user",
				content: "Later source input",
				timestamp: 5,
			});
			expect(staleBranchIds).toContain(keptId);
			expect(staleBranchIds).not.toContain(lateId);
		} finally {
			staleRelease.resolve();
			await stale;
			staleCompactionStarted = undefined;
			staleCompactionRelease = undefined;
		}
		expect((await harness.sessionManager.readEntries()).filter((entry) => entry.type === "compaction")).toEqual(
			before,
		);
		expect(await harness.sessionManager.readEntry(lateId!)).toMatchObject({
			type: "message",
			message: { role: "user", content: "Later source input" },
		});
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			result: undefined,
			errorMessage: expect.stringContaining("Compaction source or branch changed"),
		});
		// Established auto-failure outcome records may still follow that input; do not claim a frozen leaf.

		// Public selection away/back invalidates this in-memory candidate even when the leaf is restored.
		const aba = harness.sessionManager.bindCompactionSink();
		aba.retain();
		try {
			const source = await aba.source;
			const branch = await aba.readBranch();
			const away = branch.find((entry) => entry.id !== source.leafId);
			const firstKept = branch.find((entry) => entry.type === "message");
			if (!source.leafId || !away || !firstKept) throw new Error("Expected real source selections for ABA");
			await harness.sessionManager.branchTo(away.id);
			await harness.sessionManager.branchTo(source.leafId);
			expect(harness.sessionManager.getLeafId()).toBe(source.leafId);
			await expect(aba.appendCompaction("stale ABA summary", firstKept.id, 1)).rejects.toThrow(
				"Compaction source or branch changed",
			);
			expect((await harness.sessionManager.readEntries()).filter((entry) => entry.type === "compaction")).toEqual(
				before,
			);
		} finally {
			await aba.release();
		}

		const captured = harness.sessionManager.bindCompactionSink();
		captured.retain();
		try {
			const source = await captured.source;
			const branch = await captured.readBranch();
			const firstKept = branch.find((entry) => entry.type === "message");
			if (!firstKept) throw new Error("Expected a real captured source message");
			await harness.sessionManager.newSession();
			expect(harness.sessionManager.getSessionId()).not.toBe(source.sessionId);
			expect(await captured.readBranch()).toEqual(branch);
			await expect(captured.appendCompaction("stale source summary", firstKept.id, 1)).rejects.toThrow(
				"Compaction source or branch changed",
			);
			expect((await harness.sessionManager.readEntries()).filter((entry) => entry.type === "compaction")).toEqual(
				[],
			);
		} finally {
			await captured.release();
		}
		await expect(captured.readBranch()).rejects.toThrow("Captured request sink is not retained");
		await expect(captured.appendCompaction("released source summary", keptId, 1)).rejects.toThrow(
			"Captured request sink is not retained",
		);
		expect((await harness.sessionManager.readEntries()).filter((entry) => entry.type === "compaction")).toEqual([]);
	});

	it("treats session-owned queued inputs as queued work after compaction", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: { source: "extension" },
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as {
			_cancelPostCompactionContinue(): void;
			_scheduleAutoRefineAfterCompaction(willContinueAfterCompaction: boolean): void;
		};
		const scheduleAutoRefineSpy = vi.spyOn(internals, "_scheduleAutoRefineAfterCompaction");
		try {
			await harness.session.prompt("one");
			await harness.session.prompt("two");
			// Hold the input in the session-owned follow-up queue across compaction.
			const pause = harness.session.acquireQueuedWorkPause();
			await harness.session.followUp("queued across compaction", undefined, { resumeIfIdle: true });
			expect(harness.session.queuedActionCount).toBe(1);

			await harness.session.compact();

			// Session-owned queued work counts as queued: refine defers to the next
			// turn boundary instead of running before the queued input's turn.
			expect(scheduleAutoRefineSpy).toHaveBeenCalledWith(true);

			pause.release();
		} finally {
			harness.session.clearQueue();
			internals._cancelPostCompactionContinue();
		}
	});

	it("releases the runner's suspended idle wait when the continuation is cancelled", async () => {
		const preparing = createDeferred();
		const releasePreparation = createDeferred();
		const fixture = await prepareNativeCheckpoint({
			beforePrompt: async (prompt) => {
				if (prompt !== "queued across abort") return;
				preparing.resolve();
				await releasePreparation.promise;
			},
		});
		const { harness, internals, pause, running } = fixture;
		const session = harness.session;
		const idle = vi.spyOn(internals, "_waitForIdleOrSettlement");
		let rollbackPause: ReturnType<typeof session.acquireQueuedWorkPause> | undefined;
		let cleared: ReturnType<typeof session.clearQueue> | undefined;
		try {
			await session.followUp("queued across abort", undefined, { resumeIfIdle: true });
			fixture.releaseTool.resolve();
			await fixture.compacted.promise;
			await session.agent.waitForIdle();
			const settlement = internals._postCompactionContinuationSettlement!;
			expect(settlement).toBeDefined();
			expect(settlement.resume.actions).toHaveLength(1);
			const ownedAction = settlement.resume.actions[0];
			pause.release();
			await preparing.promise;
			await vi.waitFor(() => expect(idle.mock.calls.some(([value]) => value === settlement)).toBe(true));
			const idleCall = idle.mock.calls.findIndex(([value]) => value === settlement);
			expect(idle.mock.results[idleCall].type).toBe("return");
			const runnerIdle = idle.mock.results[idleCall].value as Promise<void>;

			// Let the actual pump roll this undelivered preparation back behind a new public pause.
			rollbackPause = session.acquireQueuedWorkPause();
			releasePreparation.resolve();
			await vi.waitFor(() => expect(internals._sessionInputCheckpointWaiters.size).toBeGreaterThan(0));
			expect(internals._postCompactionContinuationScheduled).toBe(true);
			expect(internals._postCompactionContinuationSettlement === settlement).toBe(true);
			expect(settlement.resume.actions[0] === ownedAction).toBe(true);
			expect(ownedAction.action.lifecycle.state).toBe("queued");
			expect(session.getFollowUpMessages()).toContain("queued across abort");
			expect(session.hasPendingAdmissionWaiters).toBe(true);
			const parked = [...internals._sessionInputCheckpointWaiters];

			// Cancel while the pump is still blocked; the real idle helper must release its waiter.
			session.requestAbort();
			await runnerIdle;
			expect(internals._postCompactionContinuationScheduled).toBe(false);
			expect(internals._postCompactionContinuationSettlement).toBeUndefined();
			expect(parked.every((waiter) => !internals._sessionInputCheckpointWaiters.has(waiter))).toBe(true);
			expect(ownedAction.action.lifecycle.state).toBe("queued");
			expect(session.getFollowUpMessages()).toContain("queued across abort");
		} finally {
			releasePreparation.resolve();
			cleared = session.clearQueue();
			rollbackPause?.release();
			pause.release();
			session.resumeQueuedWork();
		}
		expect(cleared?.followUp).toEqual(["queued across abort"]);
		await running;
		await session.waitForHeadlessIdle();
		expect(internals._sessionInputCheckpointWaiters.size).toBe(0);
		expect(session.hasPendingAdmissionWaiters).toBe(false);
	});

	it("defers post-compaction refine behind a preparing session action", async () => {
		const preparationReached = vi.fn();
		let releasePreparation = () => {};
		const preparationGate = new Promise<void>((resolve) => {
			releasePreparation = resolve;
		});
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event) => {
						if (event.prompt !== "preparing across compaction") return;
						preparationReached();
						await preparationGate;
					});
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: { source: "extension" },
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("one response"),
			fauxAssistantMessage("two response"),
			fauxAssistantMessage("prepared response"),
		]);
		await harness.session.prompt("one");
		await harness.session.prompt("two");
		await harness.session.followUp("preparing across compaction", undefined, { resumeIfIdle: true });
		await vi.waitFor(() => expect(preparationReached).toHaveBeenCalledOnce());
		const internals = harness.session as unknown as SessionWithCompactionInternals & {
			_cancelPostCompactionContinue(): void;
			_scheduleAutoRefineAfterCompaction(willContinueAfterCompaction: boolean): void;
		};
		const scheduleAutoRefineSpy = vi.spyOn(internals, "_scheduleAutoRefineAfterCompaction");
		try {
			await internals._runAutoCompaction("requested", false);
			expect(scheduleAutoRefineSpy).toHaveBeenCalledWith(true);
		} finally {
			releasePreparation();
			internals._cancelPostCompactionContinue();
		}
		await harness.session.waitForIdle();
	});

	it("throws when compacting without a model", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.agent.state.model = undefined as unknown as Model<string>;

		await expect(harness.session.compact()).rejects.toThrow("No model selected");
	});

	it("throws when compacting without configured auth", async () => {
		const harness = await createHarness({
			withConfiguredAuth: false,
			settings: { compaction: { keepRecentTokens: 1 }, autoRefine: { enabled: false } },
			requestTokenBudget: { mode: "enforce", profiles: [] },
		});
		harnesses.push(harness);

		await expect(harness.session.compact()).rejects.toThrow(`No API key found for ${harness.getModel().provider}.`);

		const mainModel = structuredClone(harness.session.model);
		const mainEffort = harness.session.thinkingLevel;
		harness.session.modelRegistry.registerProvider(compactionModel.provider, {
			api: compactionModel.api,
			baseUrl: compactionModel.baseUrl,
			apiKey: "summary-fixture-key",
			models: [compactionModel],
		});
		harness.authStorage.setRuntimeApiKey(compactionModel.provider, "summary-fixture-key");
		const selection = {
			provider: compactionModel.provider,
			modelId: compactionModel.id,
			thinkingLevel: "high" as const,
		};
		harness.settingsManager.applyOverrides({
			compaction: { model: { ...selection, modelId: "missing-summary-model" } },
		});
		const auth = vi.spyOn(harness.session.modelRegistry, "getApiKeyAndHeaders");
		const bind = vi.spyOn(harness.sessionManager, "bindCompactionSink");
		await expect(harness.session.compact()).rejects.toThrow(
			`Unknown compaction.model ${compactionModel.provider}/missing-summary-model`,
		);
		expect(auth).not.toHaveBeenCalled();
		expect(bind).not.toHaveBeenCalled();
		auth.mockRestore();
		bind.mockRestore();

		// A known explicit model still requires its own covered route profile.
		harness.settingsManager.applyOverrides({ compaction: { model: selection } });
		await harness.sessionManager.appendMessage({ role: "user", content: "Summarize this input", timestamp: 1 });
		await harness.sessionManager.appendMessage({ role: "user", content: "Keep this input", timestamp: 2 });
		const offlineFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unprofiled request sent"));
		await (harness.session as unknown as SessionWithCompactionInternals)._runAutoCompaction("requested", false);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "requested",
			result: undefined,
			errorMessage: expect.stringContaining(
				"Request token budget unknown: exact explicit route/model profile unavailable or ambiguous",
			),
		});
		expect(offlineFetch).not.toHaveBeenCalled();
		expect((await harness.sessionManager.readEntries()).filter((entry) => entry.type === "compaction")).toEqual([]);
		expect(harness.session.model).toEqual(mainModel);
		expect(harness.session.thinkingLevel).toBe(mainEffort);
	});

	it("cancels in-progress manual compaction when abortCompaction is called", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						return await new Promise<{ cancel: true }>((resolve) => {
							event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
						});
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const compactPromise = harness.session.compact();
		await new Promise((resolve) => setTimeout(resolve, 0));
		harness.session.abortCompaction();

		await expect(compactPromise).rejects.toThrow("Compaction cancelled");
	});

	it("resumes after threshold compaction when only agent-level queued messages exist", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "auto compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		harness.session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "queued custom" }],
			display: false,
			timestamp: Date.now(),
		});

		const continueSpy = vi.spyOn(harness.session.agent, "continue").mockResolvedValue();
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await sessionInternals._runAutoCompaction("threshold", false);
		await vi.advanceTimersByTimeAsync(100);

		expect(continueSpy).toHaveBeenCalledTimes(1);
	});

	it("keeps prior autonomous continuations when later threshold compaction is skipped", async () => {
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 4,
				maxTurns: 100,
				gates: { commands: [failingGateCommand()], maxRetries: 5 },
			},
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as {
			_queueAutonomousContinuationForThresholdCompaction(
				message: AssistantMessage,
			): Promise<CapturedCheckpointAction | undefined>;
			_clearQueuedAutonomousContinuationsAfterSkippedThresholdCompaction(
				shouldContinueAfterThreshold: boolean,
				continuations: CapturedCheckpointAction[],
			): void;
			_postCompactionContinuations: CapturedCheckpointAction[];
		};
		const firstAssistant = createAssistant(harness, { stopReason: "toolUse", totalTokens: 10_000 });
		const secondAssistant = createAssistant(harness, { stopReason: "toolUse", totalTokens: 10_000 });

		const firstQueued = await sessionInternals._queueAutonomousContinuationForThresholdCompaction(firstAssistant);
		const secondQueued = await sessionInternals._queueAutonomousContinuationForThresholdCompaction(secondAssistant);

		expect(firstQueued).toBeDefined();
		expect(secondQueued).toBeDefined();
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(2);
		const firstText = harness.session.getFollowUpMessages()[0];
		sessionInternals._clearQueuedAutonomousContinuationsAfterSkippedThresholdCompaction(true, [secondQueued!]);

		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(1);
		expect(sessionInternals._postCompactionContinuations).toHaveLength(1);
		expect(sessionInternals._postCompactionContinuations[0] === firstQueued).toBe(true);
		expect(firstQueued!.action.lifecycle.state).toBe("queued");
		expect(secondQueued!.action.lifecycle.state).toBe("cancelled");
		expect(harness.session.getFollowUpMessages()[0]).toBe(firstText);
		expect(harness.session.getFollowUpMessages()).toHaveLength(1);
	});

	it("clears queued autonomous continuations when threshold compaction is skipped", async () => {
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 2,
				maxTurns: 100,
				gates: { commands: [failingGateCommand()], maxRetries: 5 },
			},
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "toolUse",
			totalTokens: 10_000,
			timestamp: Date.now(),
		});
		const toolResult: ToolResultMessage<unknown> = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "large-context",
			content: [{ type: "text", text: "x".repeat(800_000) }],
			isError: false,
			timestamp: Date.now() + 500,
		};
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			successfulAssistant,
			toolResult,
		];

		const shouldStop = await sessionInternals._shouldStopAfterTurn({
			message: successfulAssistant,
			toolResults: [toolResult],
			context: {
				systemPrompt: harness.session.systemPrompt,
				messages: [successfulAssistant, toolResult],
				tools: [],
			},
			newMessages: [successfulAssistant, toolResult],
		});
		expect(shouldStop).toBe(true);
		expect(harness.session.getFollowUpMessages()).toHaveLength(1);
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(1);

		await sessionInternals._runAutoCompaction("threshold", false);

		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(0);
	});

	it("emits a warning and persists the outcome outside model context when auto-compaction has nothing to summarize", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.prompt("one");

		const endEvents: Array<{ errorMessage?: string; errorSeverity?: string }> = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end") {
				expect(harness.session.messages.at(-1)).toMatchObject({ customType: "compaction_outcome" });
				endEvents.push({ errorMessage: event.errorMessage, errorSeverity: event.errorSeverity });
			}
		});

		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		await sessionInternals._runAutoCompaction("threshold", false);

		expect(endEvents).toHaveLength(1);
		expect(endEvents[0].errorSeverity).toBe("warning");
		expect(endEvents[0].errorMessage).toContain("Auto-compaction skipped");

		// The unsuccessful outcome is disclosed as a durable custom message that stays out of model context.
		const outcome = harness.session.messages.at(-1);
		expect(outcome).toMatchObject({
			role: "custom",
			customType: "compaction_outcome",
			content: endEvents[0].errorMessage,
			display: true,
			details: { reason: "threshold", outcome: "skipped" },
		});
		expect(harness.session.agent.convertToLlm([outcome!])).toEqual([]);
	});

	it("does not repeat failed threshold summaries for bookkeeping, but accepts manual retries and new input", async () => {
		const harness = await createHarness({
			persistSession: true,
			models: [{ id: "faux-1", contextWindow: 200_000 }],
			settings: {
				compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 199_999 },
				autoRefine: { enabled: false },
			},
		});
		harnesses.push(harness);
		const largeReply = () => fauxAssistantMessage("large context reply");
		harness.setResponses([fauxAssistantMessage("earlier reply"), largeReply()]);
		await harness.session.prompt("earlier request");
		await harness.session.prompt("current request");
		const lastAssistant = [...harness.session.messages]
			.reverse()
			.find((message) => message.role === "assistant") as AssistantMessage;
		const target = (await harness.sessionManager.readBranch())
			.reverse()
			.find((entry) => entry.type === "message" && entry.message.role === "assistant")!;
		let summaryCalls = 0;
		const failSummary = () => {
			summaryCalls++;
			throw new Error("summary service unavailable");
		};
		harness.setResponses([failSummary, failSummary]);
		harness.settingsManager.applyOverrides({ compaction: { enabled: true } });
		const internals = harness.session as unknown as SessionWithCompactionInternals;
		await internals._checkCompaction(lastAssistant, false, false);
		const firstSummaryCalls = summaryCalls;
		expect(firstSummaryCalls).toBeGreaterThan(0);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
		await harness.sessionManager.appendChildUsageAttributionWithAggregate(target.id, createUsage(10));
		await harness.sessionManager.appendAgentStatus({ summary: "child accounting arrived", basedOnMessageCount: 4 });
		await internals._checkCompaction(lastAssistant, false, false);
		expect(
			await internals._thresholdCompactionNeeded({
				message: lastAssistant,
				toolResults: [],
				context: { systemPrompt: harness.session.systemPrompt, messages: harness.session.messages, tools: [] },
				newMessages: [lastAssistant],
			}),
		).toBe(false);
		expect(summaryCalls).toBe(firstSummaryCalls);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
		harness.setResponses([failSummary, failSummary]);
		await expect(harness.session.compact()).rejects.toThrow("summary service unavailable");
		expect(summaryCalls).toBeGreaterThan(firstSummaryCalls);
		const beforeNewInput = summaryCalls;
		harness.setResponses([largeReply(), failSummary, failSummary]);
		await harness.session.prompt("new public input permits a fresh automatic attempt");
		await harness.session.waitForHeadlessIdle();
		expect(summaryCalls).toBeGreaterThan(beforeNewInput);
		expect(harness.eventsOfType("compaction_end").filter((event) => event.reason === "threshold")).toHaveLength(2);
		expect(harness.session.isCompacting).toBe(false);
		expect(getAssistantTexts(harness)).toContain("large context reply");
	});

	it("does not retry overflow recovery more than once", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const overflowMessage = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "prompt is too long",
			timestamp: Date.now(),
		});
		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);
		const compactionErrors: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.errorMessage) {
				compactionErrors.push(event.errorMessage);
			}
		});

		await sessionInternals._checkCompaction(overflowMessage);
		await sessionInternals._checkCompaction({ ...overflowMessage, timestamp: Date.now() + 1 });
		await sessionInternals._checkCompaction({ ...overflowMessage, timestamp: Date.now() + 2 });

		expect(runAutoCompactionSpy).toHaveBeenCalledTimes(1);
		const message =
			"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.";
		expect(compactionErrors).toContain(message);
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "custom",
			customType: "compaction_outcome",
			content: message,
			details: { reason: "overflow", outcome: "failed" },
		});
		expect(
			harness.session.messages.filter(
				(entry) =>
					entry.role === "custom" && entry.customType === "compaction_outcome" && entry.content === message,
			),
		).toHaveLength(1);
	});

	it("ignores stale pre-compaction assistant usage on pre-prompt checks", async () => {
		const harness = await createHarness({ persistSession: true, settings: { compaction: { enabled: true } } });
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const staleTimestamp = Date.now() - 10_000;
		const staleAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 610_000,
			timestamp: staleTimestamp,
		});

		const firstKeptEntryId = await harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: staleTimestamp - 1000,
		});
		await harness.sessionManager.appendMessage(staleAssistant);
		await harness.sessionManager.appendCompaction(
			"summary",
			firstKeptEntryId,
			staleAssistant.usage.totalTokens,
			undefined,
			false,
		);
		await harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "after compaction" }],
			timestamp: Date.now(),
		});

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(staleAssistant, false);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
		const originalLimits = harness.settingsManager.getCanonicalContextLimits();
		harness.settingsManager.applyOverrides({ canonicalContext: { ...originalLimits, maxSourceBytes: 1 } });
		try {
			await expect(sessionInternals._checkCompaction(staleAssistant, false)).rejects.toThrow(
				"Compaction bootstrap source byte budget exceeded",
			);
		} finally {
			harness.settingsManager.applyOverrides({ canonicalContext: originalLimits });
		}
		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("triggers threshold compaction for error messages using the last successful usage", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: Date.now(),
		});
		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now() + 1000,
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			successfulAssistant,
			{ role: "user", content: [{ type: "text", text: "retry" }], timestamp: Date.now() + 500 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy.mock.calls).toHaveLength(1);
		const [reason, retry, owner] = runAutoCompactionSpy.mock.calls[0];
		expect([reason, retry]).toEqual(["threshold", false]);
		expect(owner?.manager === harness.sessionManager).toBe(true);
		expect(owner?.agent === harness.session.agent).toBe(true);
		expect(owner?.sessionId).toBe(harness.sessionManager.getSessionId());
		expect(owner?.isSourceCurrent()).toBe(true);
	});

	it("triggers threshold compaction when trailing context exceeds the model window", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 10_000,
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			successfulAssistant,
			{
				role: "custom",
				customType: "large-context",
				content: [{ type: "text", text: "x".repeat(800_000) }],
				display: false,
				timestamp: Date.now() + 500,
			},
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(successfulAssistant, false);

		expect(runAutoCompactionSpy.mock.calls).toHaveLength(1);
		const [reason, retry, owner] = runAutoCompactionSpy.mock.calls[0];
		expect([reason, retry]).toEqual(["threshold", false]);
		expect(owner?.manager === harness.sessionManager).toBe(true);
		expect(owner?.agent === harness.session.agent).toBe(true);
		expect(owner?.sessionId).toBe(harness.sessionManager.getSessionId());
		expect(owner?.isSourceCurrent()).toBe(true);
	});

	it("stops a tool loop for threshold compaction before the next model call", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "toolUse",
			totalTokens: 10_000,
			timestamp: Date.now(),
		});
		const toolResult: ToolResultMessage<unknown> = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "large-context",
			content: [{ type: "text", text: "x".repeat(800_000) }],
			isError: false,
			timestamp: Date.now() + 500,
		};
		const messages: AgentMessage[] = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			successfulAssistant,
			toolResult,
		];
		harness.session.agent.state.messages = messages;

		const shouldStop = await sessionInternals._shouldStopAfterTurn({
			message: successfulAssistant,
			toolResults: [toolResult],
			context: { systemPrompt: harness.session.systemPrompt, messages, tools: [] },
			newMessages: [successfulAssistant, toolResult],
		});

		expect(shouldStop).toBe(true);
	});

	it("queues a failing autonomous gate continuation before threshold compaction stops a tool loop", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 2,
				maxTurns: 100,
				gates: { commands: [failingGateCommand()], maxRetries: 5 },
			},
			settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "auto compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "toolUse",
			totalTokens: 10_000,
			timestamp: Date.now(),
		});
		const toolResult: ToolResultMessage<unknown> = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "large-context",
			content: [{ type: "text", text: "x".repeat(800_000) }],
			isError: false,
			timestamp: Date.now() + 500,
		};
		const currentUser = {
			role: "user",
			content: [{ type: "text", text: "hello" }],
			timestamp: Date.now() - 1000,
		} satisfies Parameters<typeof harness.sessionManager.appendMessage>[0];
		const oldUser = {
			role: "user",
			content: [{ type: "text", text: "old" }],
			timestamp: Date.now() - 3000,
		} satisfies Parameters<typeof harness.sessionManager.appendMessage>[0];
		const oldAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 100,
			timestamp: Date.now() - 2000,
		});
		const oldMessages: AgentMessage[] = [oldUser, oldAssistant];
		const messages: AgentMessage[] = [currentUser, successfulAssistant, toolResult];
		for (const message of [oldUser, oldAssistant, currentUser, successfulAssistant]) {
			await harness.sessionManager.appendMessage(message);
		}
		harness.session.agent.state.messages = [...oldMessages, ...messages];

		const continueSpy = vi.spyOn(harness.session.agent, "continue").mockResolvedValue();
		const followUpSpy = vi.spyOn(harness.session.agent, "followUp");

		const shouldStop = await sessionInternals._shouldStopAfterTurn({
			message: successfulAssistant,
			toolResults: [toolResult],
			context: { systemPrompt: harness.session.systemPrompt, messages, tools: [] },
			newMessages: [successfulAssistant, toolResult],
		});

		expect(shouldStop).toBe(true);
		expect(harness.session.getAutonomousStatus()).toMatchObject({
			continuationsUsed: 1,
			gates: expect.objectContaining({ maxRetries: 5 }),
		});
		expect(followUpSpy).not.toHaveBeenCalled();
		const queuedText = harness.session.getFollowUpMessages()[0] ?? "";
		expect(queuedText).toContain("Autonomous quality gate failed (attempt 1/5)");
		expect(queuedText).toContain("gate failed");

		await sessionInternals._runAutoCompaction("threshold", false);
		await vi.advanceTimersByTimeAsync(100);

		expect(continueSpy).not.toHaveBeenCalled();
		expect(harness.session.getFollowUpMessages()).toEqual([]);
	});

	it("keeps autonomous continuation bookkeeping when only steering queue is drained", async () => {
		const fixture = await prepareNativeCheckpoint({
			autonomous: {
				enabled: true,
				maxContinuations: 1,
				maxTurns: 100,
				gates: { commands: [failingGateCommand()], maxRetries: 5 },
			},
		});
		const { harness, internals, pause, running } = fixture;
		const steeringStarted = createDeferred();
		const releaseSteering = createDeferred();
		try {
			fixture.releaseTool.resolve();
			await fixture.compacted.promise;
			await harness.session.agent.waitForIdle();
			expect(internals._postCompactionContinuations).toHaveLength(1);
			const continuation = internals._postCompactionContinuations[0];
			const queuedText = harness.session.getFollowUpMessages()[0];
			await harness.session.steer("steer first", undefined, { resumeIfIdle: true });
			harness.setResponses([
				async () => {
					steeringStarted.resolve();
					await releaseSteering.promise;
					return fauxAssistantMessage("steering handled");
				},
				fauxAssistantMessage("autonomous follow-up handled"),
			]);
			pause.release();
			await steeringStarted.promise;
			expect(internals._postCompactionContinuations.includes(continuation)).toBe(true);
			expect(continuation.action.lifecycle.state).toBe("queued");
			expect(harness.session.getFollowUpMessages()).toContain(queuedText);
		} finally {
			releaseSteering.resolve();
			pause.release();
		}
		await running;
		await harness.session.waitForHeadlessIdle();
		expect(internals._postCompactionContinuations).toHaveLength(0);
		expect(
			harness.session.messages.some((message) => getMessageText(message) === "autonomous follow-up handled"),
		).toBe(true);
	});

	it.each([
		{ name: "untracked queued input", text: "queued input", response: "queued input handled", tracked: false },
		{
			name: "post-compaction continuation",
			text: "session-owned continuation",
			response: "continuation handled",
			tracked: true,
		},
		{
			name: "an empty resume request",
			text: "concurrent input",
			response: "concurrent input handled",
			tracked: false,
			continueAfterSessionInput: true,
		},
	])("settles $name after the session pump runs", async ({ text, response, tracked, continueAfterSessionInput }) => {
		const fixture = await prepareNativeCheckpoint({
			autonomous: tracked
				? {
						enabled: true,
						maxContinuations: 1,
						maxTurns: 100,
						gates: { commands: [failingGateCommand()], maxRetries: 5 },
					}
				: undefined,
		});
		const { harness, internals, pause, continued, running } = fixture;
		const responseStarted = createDeferred();
		const releaseResponse = createDeferred();
		let finished = false;
		let completion!: Promise<void>;
		try {
			if (!tracked && !continueAfterSessionInput) await harness.session.followUp(text);
			fixture.releaseTool.resolve();
			await fixture.compacted.promise;
			await harness.session.agent.waitForIdle();
			await vi.waitFor(() => expect(fixture.scheduled).toHaveBeenCalledOnce());
			const resume = fixture.scheduled.mock.calls[0][0];
			const settlement = internals._postCompactionContinuationSettlement!;
			expect(settlement?.resume === resume).toBe(true);
			completion = settlement.promise.then(() => {
				finished = true;
			});
			void completion.catch(() => undefined);
			expect(resume.owner.manager === harness.sessionManager).toBe(true);
			expect(resume.owner.isSourceCurrent()).toBe(true);
			expect(resume.actions).toHaveLength(continueAfterSessionInput ? 0 : 1);
			expect(resume.boundary?.state).toBe("pending");
			harness.setResponses([
				async () => {
					responseStarted.resolve();
					await releaseResponse.promise;
					return fauxAssistantMessage(continueAfterSessionInput ? "empty boundary resumed" : response);
				},
				...(continueAfterSessionInput ? [fauxAssistantMessage(response)] : []),
			]);
			pause.release();
			await responseStarted.promise;
			expect(finished).toBe(false); // Delivery/dequeue is not completion.
			if (continueAfterSessionInput) {
				// This later input is separate work, not part of the earlier captured empty resume.
				await harness.session.followUp(text, undefined, { resumeIfIdle: true });
				expect(resume.actions).toHaveLength(0);
				expect(resume.boundary?.state).toBe("consumed");
			} else {
				expect(resume.actions[0].action.lifecycle.state).not.toBe("completed");
			}
		} finally {
			releaseResponse.resolve();
			pause.release();
		}
		await completion;
		await running;
		await harness.session.waitForHeadlessIdle();
		expect(continued).toHaveBeenCalledTimes(continueAfterSessionInput ? 1 : 0);
		expect(internals._postCompactionContinuationScheduled).toBe(false);
		expect(internals._postCompactionContinuations).toHaveLength(0);
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: response }],
		});
	});

	it("keeps the owned autonomous action after a native busy refusal and completes it once", async () => {
		const fixture = await prepareNativeCheckpoint({
			autonomous: {
				enabled: true,
				maxContinuations: 1,
				maxTurns: 100,
				gates: { commands: [failingGateCommand()], maxRetries: 5 },
			},
		});
		const { harness, internals, pause, continued, running } = fixture;
		fixture.releaseTool.resolve();
		await fixture.compacted.promise;
		await harness.session.agent.waitForIdle();
		await vi.waitFor(() => expect(fixture.scheduled).toHaveBeenCalledOnce());
		expect(internals._postCompactionContinuations).toHaveLength(1);
		const continuation = internals._postCompactionContinuations[0];
		const queuedText = harness.session.getFollowUpMessages()[0];
		const competingStarted = createDeferred();
		const releaseCompeting = createDeferred();
		harness.setResponses([
			async () => {
				competingStarted.resolve();
				await releaseCompeting.promise;
				return fauxAssistantMessage("competing native turn finished");
			},
			fauxAssistantMessage("owned autonomous action completed"),
		]);
		const competing = harness.session.agent.prompt("Real competing native turn");
		void competing.catch(() => undefined);
		try {
			await competingStarted.promise;
			expect(continued).not.toHaveBeenCalled();
			const refused = harness.session.agent.continue();
			await expect(refused).rejects.toBeInstanceOf(AgentContinueError);
			await expect(refused).rejects.toMatchObject({ code: "busy" });
			expect(internals._postCompactionContinuations.includes(continuation)).toBe(true);
			expect(continuation.action.lifecycle.state).toBe("queued");
			expect(harness.session.getFollowUpMessages()).toContain(queuedText);
			pause.release();
			await new Promise<void>(setImmediate);
			expect(continuation.action.lifecycle.state).not.toBe("completed");
		} finally {
			releaseCompeting.resolve();
			pause.release();
		}
		await competing;
		await running;
		await harness.session.waitForHeadlessIdle();
		await continuation.ticket.completed;
		expect(await continuation.ticket.delivered).toMatchObject({ status: "delivered" });
		expect(continuation.action.lifecycle.state).toBe("completed");
		expect(
			harness.session.messages.filter(
				(message) => message.role === "user" && getMessageText(message) === queuedText,
			),
		).toHaveLength(1);
		expect(internals._postCompactionContinuations).toHaveLength(0);
		// The only continue call is the real refused call above; owned input uses the session pump.
		expect(continued).toHaveBeenCalledTimes(1);
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "owned autonomous action completed" }],
		});
	});

	it("keeps replacement continuation messages when a cancelled continue settles late", async () => {
		const fixture = await prepareNativeCheckpoint({ failFirstCompaction: true });
		const { harness, internals, pause, running } = fixture;
		const runners = vi.spyOn(internals, "_runScheduledPostCompactionContinue");
		const responseStarted = createDeferred();
		const releaseResponse = createDeferred();
		try {
			await harness.session.followUp("replacement continuation", undefined, { resumeIfIdle: true });
			fixture.releaseTool.resolve();
			await fixture.compacted.promise;
			await harness.session.agent.waitForIdle();
			await vi.waitFor(() => expect(runners).toHaveBeenCalledOnce());
			const original = internals._postCompactionContinuationSettlement!;
			const originalRunner = runners.mock.results[0].value;
			const action = original.resume.actions[0];
			expect(action.action.lifecycle.state).toBe("queued");

			// Manual success cancels the real old settlement without suspending the input pump.
			await harness.session.compact(undefined, { skipAbort: true });
			expect(runners).toHaveBeenCalledTimes(2);
			const replacement = internals._postCompactionContinuationSettlement!;
			expect(replacement === original).toBe(false);
			expect(replacement.resume.actions[0] === action).toBe(true);
			await originalRunner;
			await new Promise<void>(setImmediate);
			expect(internals._postCompactionContinuationSettlement === replacement).toBe(true);
			expect(internals._postCompactionContinuationScheduled).toBe(true);
			expect(harness.session.getFollowUpMessages()).toContain("replacement continuation");

			harness.setResponses([
				async () => {
					responseStarted.resolve();
					await releaseResponse.promise;
					return fauxAssistantMessage("replacement completed");
				},
			]);
			pause.release();
			await responseStarted.promise;
			expect(action.action.lifecycle.state).not.toBe("completed");
		} finally {
			releaseResponse.resolve();
			pause.release();
			runners.mockRestore();
		}
		await running;
		await harness.session.waitForHeadlessIdle();
		expect(internals._postCompactionContinuationScheduled).toBe(false);
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "replacement completed" }],
		});
	});

	it("waits for an in-flight refine application before continuing", async () => {
		const fixture = await prepareNativeCheckpoint({
			persistSession: true,
			refineProposal: {
				summary: "Native refine ordering",
				rationale: "Exercise the real application boundary.",
				edits: [],
				expectedOutcome: "Continuation waits until application completes.",
			},
		});
		const { harness, pause, continued, running } = fixture;
		fixture.releaseTool.resolve();
		await fixture.compacted.promise;
		await harness.session.agent.waitForIdle();
		await vi.waitFor(() => expect(fixture.scheduled).toHaveBeenCalledOnce());
		const applicationStarted = createDeferred();
		const releaseApplication = createDeferred();
		const append = harness.sessionManager.appendCustomEntry.bind(harness.sessionManager);
		// Hold only the return of an actual acknowledged application write, not the lifecycle flag.
		const applicationWrite = vi
			.spyOn(harness.sessionManager, "appendCustomEntry")
			.mockImplementation(async (...args) => {
				const entryId = await append(...args);
				if (args[0] === "prime-agent.refinement") {
					applicationStarted.resolve();
					await releaseApplication.promise;
				}
				return entryId;
			});
		const refinement = harness.session.refine({ instructions: "Exercise native application ordering." });
		void refinement.catch(() => undefined);
		try {
			await applicationStarted.promise;
			pause.release();
			await new Promise<void>(setImmediate);
			expect(continued).not.toHaveBeenCalled();
		} finally {
			releaseApplication.resolve();
			pause.release();
			applicationWrite.mockRestore();
		}
		await refinement;
		await running;
		await harness.session.waitForHeadlessIdle();
		expect(continued).toHaveBeenCalledTimes(1);
		expect(harness.eventsOfType("refine_complete")).toHaveLength(1);
	});

	it("clears queued autonomous threshold continuations when autonomous mode is disabled", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 2,
				maxTurns: 100,
				gates: { commands: [failingGateCommand()], maxRetries: 5 },
			},
			settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "auto compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "toolUse",
			totalTokens: 10_000,
			timestamp: Date.now(),
		});
		const toolResult: ToolResultMessage<unknown> = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "large-context",
			content: [{ type: "text", text: "x".repeat(800_000) }],
			isError: false,
			timestamp: Date.now() + 500,
		};
		const oldUser = {
			role: "user",
			content: [{ type: "text", text: "old" }],
			timestamp: Date.now() - 3000,
		} satisfies Parameters<typeof harness.sessionManager.appendMessage>[0];
		const oldAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 100,
			timestamp: Date.now() - 2000,
		});
		const currentUser = {
			role: "user",
			content: [{ type: "text", text: "hello" }],
			timestamp: Date.now() - 1000,
		} satisfies Parameters<typeof harness.sessionManager.appendMessage>[0];
		for (const message of [oldUser, oldAssistant, currentUser, successfulAssistant]) {
			await harness.sessionManager.appendMessage(message);
		}
		harness.session.agent.state.messages = [oldUser, oldAssistant, currentUser, successfulAssistant, toolResult];

		await sessionInternals._shouldStopAfterTurn({
			message: successfulAssistant,
			toolResults: [toolResult],
			context: {
				systemPrompt: harness.session.systemPrompt,
				messages: [currentUser, successfulAssistant, toolResult],
				tools: [],
			},
			newMessages: [successfulAssistant, toolResult],
		});
		expect(harness.session.getFollowUpMessages()).toHaveLength(1);

		await harness.session.prompt("/autonomous off");
		await harness.session.waitForIdle();
		expect(harness.session.getAutonomousStatus().enabled).toBe(false);
		expect(harness.session.getFollowUpMessages()).toEqual([]);

		await sessionInternals._runAutoCompaction("threshold", false);
		await vi.advanceTimersByTimeAsync(100);

		expect(harness.session.getFollowUpMessages()).toEqual([]);
	});

	it("queues a failing autonomous gate continuation before post-turn threshold compaction", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 2,
				maxTurns: 100,
				gates: { commands: [failingGateCommand()], maxRetries: 5 },
			},
			settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 10_000,
			timestamp: Date.now(),
		});
		const largeToolResult: ToolResultMessage<unknown> = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "large-context",
			content: [{ type: "text", text: "x".repeat(800_000) }],
			isError: false,
			timestamp: Date.now() + 500,
		};
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			successfulAssistant,
			largeToolResult,
		];

		const runCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);
		const followUpSpy = vi.spyOn(harness.session.agent, "followUp");

		await sessionInternals._checkCompaction(successfulAssistant, false);

		expect(runCompactionSpy.mock.calls).toHaveLength(1);
		const [reason, retry, owner] = runCompactionSpy.mock.calls[0];
		expect([reason, retry]).toEqual(["threshold", false]);
		expect(owner?.manager === harness.sessionManager).toBe(true);
		expect(owner?.agent === harness.session.agent).toBe(true);
		expect(owner?.sessionId).toBe(harness.sessionManager.getSessionId());
		expect(owner?.isSourceCurrent()).toBe(true);
		expect(followUpSpy).not.toHaveBeenCalled();
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(1);
		const queuedText = harness.session.getFollowUpMessages()[0] ?? "";
		expect(queuedText).toContain("Autonomous quality gate failed (attempt 1/5)");
		expect(queuedText).toContain("gate failed");
	});

	it("does not queue autonomous gate continuations for pre-prompt threshold compaction", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 2,
				maxTurns: 100,
				gates: { commands: [failingGateCommand()], maxRetries: 5 },
			},
			settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 10_000,
			timestamp: Date.now(),
		});
		const largeToolResult: ToolResultMessage<unknown> = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "large-context",
			content: [{ type: "text", text: "x".repeat(800_000) }],
			isError: false,
			timestamp: Date.now() + 500,
		};
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			successfulAssistant,
			largeToolResult,
		];

		const runCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);
		const followUpSpy = vi.spyOn(harness.session.agent, "followUp");

		await sessionInternals._checkCompaction(successfulAssistant, false, false);

		expect(runCompactionSpy.mock.calls).toHaveLength(1);
		const [reason, retry, owner] = runCompactionSpy.mock.calls[0];
		expect([reason, retry]).toEqual(["threshold", false]);
		expect(owner?.manager === harness.sessionManager).toBe(true);
		expect(owner?.agent === harness.session.agent).toBe(true);
		expect(owner?.sessionId).toBe(harness.sessionManager.getSessionId());
		expect(owner?.isSourceCurrent()).toBe(true);
		expect(followUpSpy).not.toHaveBeenCalled();
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(0);
	});

	it("waits for threshold-compaction autonomous continuations before finishing prompt", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 1,
				maxTurns: 100,
				gates: { commands: [failingGateCommand()], maxRetries: 5 },
			},
			settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(harness);
		const highUsageDone = {
			...fauxAssistantMessage("done"),
			usage: createUsage(10_000),
		};
		harness.setResponses([highUsageDone, fauxAssistantMessage("retry")]);
		const promptPromise = harness.session.prompt("make the change");

		await vi.waitFor(() => expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(1));
		await vi.advanceTimersByTimeAsync(100);
		await promptPromise;

		expect(harness.session.getAutonomousStatus()).toMatchObject({
			continuationsUsed: 1,
			turnsUsed: 2,
		});
	});

	it("does not trigger threshold compaction for error messages when no prior usage exists", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("does not trigger threshold compaction when only kept pre-compaction usage exists", async () => {
		const harness = await createHarness({ persistSession: true, settings: { compaction: { enabled: true } } });
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const preCompactionTimestamp = Date.now() - 10_000;
		const keptAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: preCompactionTimestamp,
		});

		const firstKeptEntryId = await harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: preCompactionTimestamp - 1000,
		});
		await harness.sessionManager.appendMessage(keptAssistant);
		const compactionId = await harness.sessionManager.appendCompaction(
			"summary",
			firstKeptEntryId,
			keptAssistant.usage.totalTokens,
			undefined,
			false,
		);

		const compactionTimestamp = new Date((await harness.sessionManager.readEntry(compactionId))!.timestamp).getTime();
		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: compactionTimestamp + 2,
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "kept user" }], timestamp: preCompactionTimestamp - 1000 },
			keptAssistant,
			{ role: "user", content: [{ type: "text", text: "new prompt" }], timestamp: compactionTimestamp + 1 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);
		expect(
			await sessionInternals._thresholdCompactionNeeded({
				message: errorAssistant,
				toolResults: [],
				context: {
					systemPrompt: harness.session.systemPrompt,
					messages: harness.session.agent.state.messages,
					tools: [],
				},
				newMessages: [errorAssistant],
			}),
		).toBe(false);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("does not trigger threshold compaction below the threshold or when disabled", async () => {
		const belowThresholdHarness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(belowThresholdHarness);
		const disabledHarness = await createHarness({ settings: { compaction: { enabled: false } } });
		harnesses.push(disabledHarness);

		const belowThresholdInternals = belowThresholdHarness.session as unknown as SessionWithCompactionInternals;
		const disabledInternals = disabledHarness.session as unknown as SessionWithCompactionInternals;
		const belowThresholdSpy = vi.spyOn(belowThresholdInternals, "_runAutoCompaction").mockResolvedValue(false);
		const disabledSpy = vi.spyOn(disabledInternals, "_runAutoCompaction").mockResolvedValue(false);

		await belowThresholdInternals._checkCompaction(
			createAssistant(belowThresholdHarness, { stopReason: "stop", totalTokens: 1_000, timestamp: Date.now() }),
		);
		await disabledInternals._checkCompaction(
			createAssistant(disabledHarness, { stopReason: "stop", totalTokens: 1_000_000, timestamp: Date.now() }),
		);

		expect(belowThresholdSpy).not.toHaveBeenCalled();
		expect(disabledSpy).not.toHaveBeenCalled();
	});

	it("keeps failed outcome persistence out of the branch until explicit recovery", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("persisted response")]);
		await harness.session.prompt("persist this turn");

		const internals = harness.session as unknown as SessionWithCompactionInternals;
		const sessionFile = harness.sessionManager.getSessionFile()!;
		const persistedLeafId = harness.sessionManager.getLeafId();
		const persistedEntries = await harness.sessionManager.readEntries();
		vi.spyOn(SessionJournalOwner.prototype, "appendJson").mockImplementationOnce(async () => {
			appendFileSync(sessionFile, '{"type":"custom_message"');
			throw new Error("injected append acknowledgement failure");
		});

		await expect(
			internals._persistCompactionOutcome("requested", "failed", "Requested compaction failed"),
		).resolves.toBeUndefined();
		// The live outcome message discloses that it was not saved.
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "custom",
			customType: "compaction_outcome",
			content: expect.stringContaining("could not be saved to session history"),
			details: { reason: "requested", outcome: "failed" },
		});
		// The leaf is unchanged; fresh reads refuse the uncertain source until explicit recovery.
		expect(harness.sessionManager.getLeafId()).toBe(persistedLeafId);
		await expect(harness.sessionManager.readEntries()).rejects.toThrow("outcome may be unknown");

		await expect(harness.sessionManager.appendCustomEntry("blocked_before_recovery")).rejects.toThrow(
			"outcome may be unknown",
		);
		await harness.sessionManager.recover();
		expect(harness.sessionManager.getLeafId()).toBe(persistedLeafId);
		expect(await harness.sessionManager.readEntries()).toEqual(persistedEntries);
		const nextId = await harness.sessionManager.appendCustomEntry("after_failed_outcome");
		const reloaded = await SessionManager.openReadOnly(sessionFile);
		expect((await reloaded.readEntry(nextId))?.parentId).toBe(persistedLeafId);
		expect((await reloaded.readBranch()).map((entry) => entry.id)).toEqual(
			(await harness.sessionManager.readBranch()).map((entry) => entry.id),
		);
		expect(await reloaded.readEntries()).not.toContainEqual(
			expect.objectContaining({ type: "custom_message", customType: "compaction_outcome" }),
		);
		// The unpersisted disclosure survives context rebuilds (e.g. thinking toggle).
		const rebuilt = await harness.session.buildSessionContext();
		expect(rebuilt.messages.at(-1)).toMatchObject({
			role: "custom",
			customType: "compaction_outcome",
			content: expect.stringContaining("could not be saved to session history"),
		});

		// Cross a millisecond boundary so the later turn's timestamp is strictly newer.
		await new Promise((resolve) => setTimeout(resolve, 5));
		harness.setResponses([fauxAssistantMessage("later response")]);
		await harness.session.prompt("later turn");
		const reordered = (await harness.session.buildSessionContext()).messages;
		const outcomeIndex = reordered.findIndex(
			(message) => message.role === "custom" && message.customType === "compaction_outcome",
		);
		const laterTurnIndex = reordered.findIndex(
			(message) => message.role === "user" && getMessageText(message).includes("later turn"),
		);
		expect(outcomeIndex).toBeGreaterThanOrEqual(0);
		expect(laterTurnIndex).toBeGreaterThan(outcomeIndex);
	});

	it("keeps an unpersisted outcome in agent state after a successful compaction", async () => {
		const harness = await createHarness({
			persistSession: true,
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "post-failure summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: { source: "extension" },
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one response"), fauxAssistantMessage("two response")]);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const internals = harness.session as unknown as SessionWithCompactionInternals;
		vi.spyOn(SessionJournalOwner.prototype, "appendJson").mockRejectedValueOnce(
			new Error("injected append acknowledgement failure"),
		);
		await internals._persistCompactionOutcome("requested", "failed", "Requested compaction failed");
		await harness.sessionManager.recover();

		// Compaction reloads agent.state.messages from the session file; the
		// memory-only disclosure must survive.
		await harness.session.compact();

		expect(harness.session.messages).toContainEqual(
			expect.objectContaining({
				role: "custom",
				customType: "compaction_outcome",
				content: expect.stringContaining("could not be saved to session history"),
			}),
		);
	});
});
