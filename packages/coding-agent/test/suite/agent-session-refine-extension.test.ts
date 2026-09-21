import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	type Model,
	type SimpleStreamOptions,
} from "@ponythewhite/base-context-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.js";
import { RefineSkippedError } from "../../src/core/agent-session.js";
import { appendContextEpoch, readContextEpoch } from "../../src/core/context-epoch.js";
import type { SessionBeforeRefineEvent } from "../../src/core/extensions/index.js";
import { HistoryIndex } from "../../src/core/history-index.js";
import { InferenceCoordinator } from "../../src/core/inference-coordinator.js";
import { convertToLlm, HARNESS_SNAPSHOT_CUSTOM_TYPE } from "../../src/core/messages.js";
import {
	type AutoRefineReview,
	applyRefinementProposal,
	getLocalHarnessStateDir,
	loadHarnessState,
	REFINEMENT_CUSTOM_TYPE,
	type RefinementProposal,
	saveHarnessState,
} from "../../src/core/refinement/index.js";
import type { SessionHistoryReadView } from "../../src/core/session-history-index.js";
import { readSessionJournal } from "../../src/core/session-journal-reader.js";
import {
	type CustomEntry,
	type RequestJournalEntry,
	type SessionEntry,
	SessionManager,
} from "../../src/core/session-manager.js";
import { createHarness, type Harness } from "./harness.js";
import { createDeferred } from "./scheduling.js";

const learningModel: Model<"openai-responses"> = {
	api: "openai-responses",
	provider: "refinement-planner-fixture",
	id: "learning",
	name: "Learning fixture",
	baseUrl: "https://refinement-planner.invalid/v1",
	input: ["text"],
	reasoning: true,
	contextWindow: 128000,
	maxTokens: 32768,
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
};

describe("AgentSession session_before_refine extension hook", () => {
	const harnesses: Harness[] = [];
	const profiles: string[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			await harnesses.pop()?.cleanup();
		}
		vi.unstubAllEnvs();
		for (const profile of profiles.splice(0)) rmSync(profile, { recursive: true, force: true });
	});

	it("keeps native prefixes stable while fresh canonical advice survives changes, deletion, cold reopen and summaries", async () => {
		const profile = mkdtempSync(join(tmpdir(), "refinement-cache-profile-"));
		profiles.push(profile);
		vi.stubEnv(ENV_AGENT_DIR, profile);
		const nativeModel = { ...learningModel, provider: "openai", id: "native-main", maxTokens: 256 };
		const requestTokenBudget = {
			mode: "enforce" as const,
			profiles: [
				{
					id: "refinement-cache",
					revision: "1",
					api: nativeModel.api,
					provider: nativeModel.provider,
					url: `${nativeModel.baseUrl}/responses`,
					model: nativeModel.id,
					authMode: "fixture-api-key",
					templateRevision: "responses-text-v1",
					replayFamily: "responses-text-v1",
					contextTokens: 128000,
					outputCeilingTokens: 256,
					estimate: { tokensPerUtf8Byte: 1, templateTokens: 8, marginTokens: 16 },
				},
			],
		};
		const create = async (manager?: SessionManager) => {
			const harness = await createHarness({
				cwd: profile,
				persistSession: true,
				sessionManager: manager,
				tools: [],
				requestTokenBudget,
				settings: {
					compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 1 },
					autoRefine: { enabled: false },
					retry: { enabled: false },
				},
				extensionFactories: [
					(pi) => {
						pi.on("session_before_refine", () => ({
							proposal: {
								summary: "Keep the lesson",
								rationale: "fixture",
								expectedOutcome: "fresh advice",
								edits: [
									{
										action: "create",
										kind: "memory",
										id: "cache-lesson",
										title: "Cache lesson",
										content: "Fresh cache lesson alpha.",
									},
								],
							},
						}));
						pi.on("session_before_compact", (event) => ({
							compaction: {
								summary: "A completed earlier phase; old harness advice may be obsolete.",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						}));
					},
				],
			});
			harnesses.push(harness);
			harness.session.modelRegistry.registerProvider(nativeModel.provider, {
				api: nativeModel.api,
				baseUrl: nativeModel.baseUrl,
				apiKey: "offline-refinement-cache",
				models: [nativeModel],
			});
			await harness.session.setModel(nativeModel);
			return harness;
		};
		let harness = await create();
		const bodies: Array<{ input: unknown[]; [key: string]: unknown }> = [];
		const latestSnapshots: string[] = [];
		const transportErrors: unknown[] = [];
		const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			const body = JSON.parse(String(init?.body));
			bodies.push(body);
			await harness.sessionManager
				.readBranchHistory(async (history) => {
					const manifest = await history.branchContext.contextManifest({ limit: 1 });
					if (manifest.selection !== "known" || !manifest.summaryRef)
						throw new Error("Missing accepted epoch before send");
					const control = await history.hydrateEntry(manifest.summaryRef.entryId, 2 * 1024 * 1024);
					if (control?.entry.type !== "compaction") throw new Error("Missing epoch control");
					expect(control.source.qualification).toBe("native-context-epoch");
					const checkpoint = readContextEpoch(control.entry.details, 2 * 1024 * 1024)!;
					const snapshots = (await harness.sessionManager.readEntries()).filter(
						(entry) => entry.type === "custom_message" && entry.customType === HARNESS_SNAPSHOT_CUSTOM_TYPE,
					);
					const snapshot = snapshots.at(-1)!;
					if (snapshot.type !== "custom_message") throw new Error("Missing canonical advice");
					latestSnapshots.push(String(snapshot.content));
					expect(checkpoint.source.sourceSequence).toBeGreaterThanOrEqual(
						(await history.get(snapshot.id))!.sequence,
					);
					expect(
						checkpoint.literalTailId === snapshot.id ||
							checkpoint.views.some((view) => view.ref.entryId === snapshot.id),
					).toBe(true);
				})
				.catch((error) => {
					transportErrors.push(error);
					throw error;
				});
			const item = {
				type: "message",
				id: `msg_cache_${bodies.length}`,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "Done with this phase.", annotations: [] }],
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
						id: `resp_cache_${bodies.length}`,
						model: nativeModel.id,
						status: "completed",
						usage: {
							input_tokens: 20,
							output_tokens: 5,
							total_tokens: 25,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				},
			]
				.map((event) => `data: ${JSON.stringify(event)}\n\n`)
				.join("");
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		});
		const snapshots = async () =>
			(await harness.sessionManager.readEntries()).filter(
				(entry) => entry.type === "custom_message" && entry.customType === HARNESS_SNAPSHOT_CUSTOM_TYPE,
			);
		const bind = harness.sessionManager.bindCompactionSink.bind(harness.sessionManager);
		let rejectAck = true;
		const ackFailure = vi.spyOn(harness.sessionManager, "bindCompactionSink").mockImplementation((limits) => {
			const sink = bind(limits);
			const append = sink[appendContextEpoch];
			vi.spyOn(sink, appendContextEpoch).mockImplementation(async (...args) => {
				if (rejectAck) {
					rejectAck = false;
					throw new Error("fixture epoch ACK failed");
				}
				return append(...args);
			});
			return sink;
		});
		await harness.session.prompt("This preparation cannot pass its epoch ACK.").catch(() => {});
		expect(fetch).not.toHaveBeenCalled();
		expect(harness.session.agent.state.errorMessage).toContain("fixture epoch ACK failed");
		expect(await snapshots()).toHaveLength(1);
		ackFailure.mockRestore();
		await harness.session.prompt("Start the phase.");
		expect(await snapshots()).toHaveLength(1);
		expect(transportErrors).toEqual([]);
		expect(fetch).toHaveBeenCalledTimes(1);
		const prefix = structuredClone(bodies[0].input);
		const system = harness.session.systemPrompt;
		const refined = await harness.session.refine();
		expect(harness.session.systemPrompt).toBe(system);
		await harness.session.prompt("Use the lesson.");
		expect(bodies[1].input.slice(0, prefix.length)).toEqual(prefix);
		expect(JSON.stringify(bodies[1])).toContain("Fresh cache lesson alpha.");
		expect(harness.session.systemPrompt).not.toContain("Fresh cache lesson alpha.");
		expect(await snapshots()).toHaveLength(2);
		// Native/public conversion can erase customType; dedup must still use canonical source recipes.
		harness.session.agent.state.messages = convertToLlm([...harness.session.messages]);
		expect(harness.session.messages.some((message) => message.role === "custom")).toBe(false);
		// An unrelated receipt append during the fixed read does not change the conversation owner.
		const internals = harness.session as unknown as {
			_readHarnessSnapshot(view: SessionHistoryReadView): Promise<string | undefined>;
		};
		const originalRead = internals._readHarnessSnapshot.bind(internals);
		const priorRequest = (await harness.sessionManager.readEntries()).find(
			(entry) => entry.type === "request" && entry.request.type === "attempt_settled",
		);
		if (priorRequest?.type !== "request") throw new Error("Missing native receipt");
		const unrelated = vi.spyOn(internals, "_readHarnessSnapshot").mockImplementationOnce(async (view) => {
			const result = await originalRead(view);
			const sink = harness.sessionManager.bindRequestSink();
			try {
				await sink.persist({ ...priorRequest.request, attemptId: "unrelated-receipt", source: await sink.source });
			} finally {
				await sink.release();
			}
			return result;
		});
		await harness.session.prompt("Keep working without a harness change.");
		unrelated.mockRestore();
		expect(await snapshots()).toHaveLength(2);
		await harness.session.refine({ rollbackId: refined.id });
		await harness.session.prompt("The lesson was rolled back.");
		expect(latestSnapshots.at(-1)).toContain("No saved harness entries yet.");
		expect(latestSnapshots.at(-1)).not.toContain("Fresh cache lesson alpha.");
		expect(await snapshots()).toHaveLength(3);
		const local = getLocalHarnessStateDir(harness.sessionManager.getSessionArtifactDir())!;
		const state = loadHarnessState(local, "local");
		applyRefinementProposal(
			state,
			{
				summary: "Direct edit",
				rationale: "fixture",
				expectedOutcome: "fresh direct edit",
				edits: [
					{
						action: "create",
						kind: "memory",
						id: "direct",
						title: "Direct edit",
						content: "Fresh direct kernel-style lesson.",
					},
				],
			},
			{ id: "direct", scope: "local" },
		);
		saveHarnessState(local, state);
		await harness.session.prompt("Read a direct harness edit.");
		expect(latestSnapshots.at(-1)).toContain("Fresh direct kernel-style lesson.");
		const file = harness.sessionManager.getSessionFile()!;
		await harness.session.disposeAsync({ kernelSnapshot: false });
		const reopened = await SessionManager.open(file);
		harness = await create(reopened);
		await harness.session.prompt("Resume unchanged after cold reopen.");
		expect(await snapshots()).toHaveLength(4);
		await harness.session.compact();
		await harness.session.prompt("Continue after the real summary.");
		expect(latestSnapshots.at(-1)).toContain("Fresh direct kernel-style lesson.");
		expect(await snapshots()).toHaveLength(5);
		delete state.entries.memory.direct;
		saveHarnessState(local, state);
		await harness.session.prompt("The last entry was deleted.");
		expect(latestSnapshots.at(-1)).toContain("No saved harness entries yet.");
		expect(latestSnapshots.at(-1)).not.toContain("Fresh direct kernel-style lesson.");
		expect(await snapshots()).toHaveLength(6);
		expect(fetch).toHaveBeenCalledTimes(8);
		expect(harness.session.agent.state.errorMessage).toBeUndefined();
		// Going away and back to the same leaf still invalidates the captured source owner.
		const reopenedInternals = harness.session as unknown as typeof internals;
		const readSnapshot = reopenedInternals._readHarnessSnapshot.bind(reopenedInternals);
		const switched = vi.spyOn(reopenedInternals, "_readHarnessSnapshot").mockImplementationOnce(async (view) => {
			const result = await readSnapshot(view);
			await harness.sessionManager.branchTo(null);
			await harness.sessionManager.branchTo(view.source.leafId);
			return result;
		});
		await harness.session.prompt("A branch switch races snapshot preparation.").catch(() => {});
		expect(fetch).toHaveBeenCalledTimes(8);
		expect(harness.session.agent.state.errorMessage).toContain("Harness snapshot source changed");
		switched.mockRestore();
		await harness.session.prompt("Retry the unchanged snapshot after the source settles.");
		expect(await snapshots()).toHaveLength(6);
		await harness.sessionManager.branchTo(null);
		await harness.session.prompt("An empty branch needs its own current snapshot.");
		expect(await snapshots()).toHaveLength(7);
		expect(JSON.stringify(bodies.at(-1))).not.toContain("Fresh direct kernel-style lesson.");
		await harness.sessionManager.newSession();
		await harness.session.prompt("A new source must not reuse the old source's snapshot.");
		expect(await snapshots()).toHaveLength(1);
		expect(fetch).toHaveBeenCalledTimes(11);
		const newLocal = getLocalHarnessStateDir(harness.sessionManager.getSessionArtifactDir())!;
		saveHarnessState(newLocal, {
			...state,
			entries: {
				...state.entries,
				memory: {
					abort: {
						id: "abort",
						kind: "memory",
						title: "Abort lesson",
						content: "Accepted snapshot survives cancellation.",
						path: "test",
						scope: "local",
						reference: {},
						arguments: {},
						metadata: {},
						source: "test",
						version: 1,
						created_at: "",
						updated_at: "",
					},
				},
			},
		});
		const entered = createDeferred();
		const release = createDeferred();
		const appendSnapshot = harness.sessionManager.appendCustomMessageEntryWithRollback.bind(harness.sessionManager);
		const gated = vi
			.spyOn(harness.sessionManager, "appendCustomMessageEntryWithRollback")
			.mockImplementationOnce(async (...args) => {
				const id = await appendSnapshot(...args);
				entered.resolve();
				await release.promise;
				return id;
			});
		const cancelled = harness.session.prompt("Cancel after snapshot acceptance.");
		await entered.promise;
		const abort = harness.session.abort();
		release.resolve();
		await Promise.allSettled([cancelled, abort]);
		gated.mockRestore();
		expect(fetch).toHaveBeenCalledTimes(11);
		expect(await snapshots()).toHaveLength(2);
		await harness.session.prompt("Retry after cancellation.");
		expect(fetch).toHaveBeenCalledTimes(12);
		expect(await snapshots()).toHaveLength(2);
		expect(latestSnapshots.at(-1)).toContain("Accepted snapshot survives cancellation.");
		expect(transportErrors).toEqual([]);
	});

	it("applies an extension-provided proposal without calling the built-in planner", async () => {
		const events: SessionBeforeRefineEvent[] = [];
		const harness = await createHarness({
			persistSession: true,
			extensionFactories: [
				(pi) => {
					pi.on("session_before_refine", async (event) => {
						events.push(event);
						return {
							proposal: {
								summary: "extension summary",
								rationale: "extension rationale",
								expectedOutcome: "extension outcome",
								edits: [
									{
										action: "create" as const,
										kind: "memory" as const,
										title: "Extension memory",
										content: "Captured by the extension planner",
									},
								],
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([]);
		await harness.session.prompt("hello").catch(() => {});

		const result = await harness.session.refine({ instructions: "capture lessons" });

		expect(result.summary).toBe("extension summary");
		expect(result.appliedEdits).toHaveLength(1);
		expect(result.appliedEdits[0]?.applied).toBe(true);
		expect(events).toHaveLength(1);
		expect(events[0]?.preparation.trigger).toBe("manual");
		expect(events[0]?.preparation.scope).toBe("local");
		expect(events[0]?.preparation.instructions).toBe("capture lessons");
		expect(harness.getPendingResponseCount()).toBe(0);

		const state = loadHarnessState(result.harnessStatePath.replace(/\/[^/]+$/, ""), "local");
		const memories = Object.values(state.entries.memory);
		expect(memories.some((entry) => entry.title === "Extension memory")).toBe(true);
		const records = (await harness.session.sessionManager.readEntries()).filter(
			(entry) => entry.type === "custom" && entry.customType === REFINEMENT_CUSTOM_TYPE,
		);
		expect(records).toHaveLength(1);
		expect(records[0]).not.toHaveProperty("plannerRequest");
		expect(result).not.toHaveProperty("plannerRequest");
	});

	it("reads refinement records without hydrating an oversized ordinary-message archive", async () => {
		const events: SessionBeforeRefineEvent[] = [];
		const harness = await createHarness({
			persistSession: true,
			extensionFactories: [
				(pi) => {
					pi.on("session_before_refine", async (event) => {
						events.push(event);
						return {
							proposal: {
								summary: "Source-backed refinement",
								rationale: "Keep recorded lessons",
								expectedOutcome: "Read only refinement history",
								edits: [],
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		const first = await harness.session.refine();
		const padding = "x".repeat(8 * 1024 * 1024);
		const ordinaryIds = new Set<string>();
		for (let index = 0; index < 9; index++) {
			ordinaryIds.add(
				await harness.sessionManager.appendCustomMessageEntry("ordinary-large-output", padding, false),
			);
		}
		expect(statSync(harness.sessionManager.getSessionFile()!).size).toBeGreaterThan(64 * 1024 * 1024);
		const payloads = vi.spyOn(HistoryIndex.prototype, "readSourcePayload");
		const second = await harness.session.refine();
		expect(second.summary).toBe("Source-backed refinement");
		expect(events.at(-1)?.preparation.history).toContainEqual(expect.objectContaining({ id: first.id }));
		expect(payloads.mock.calls.some(([, id]) => ordinaryIds.has(id))).toBe(false);
		// A selective read still propagates source failures instead of treating them as empty history.
		const failure = new Error("injected captured history failure");
		vi.spyOn(harness.sessionManager, "readSourceHistory").mockRejectedValueOnce(failure);
		await expect(harness.session.refine()).rejects.toBe(failure);
	}, 30000);

	it("rejects invalid extension edits at apply time", async () => {
		const harness = await createHarness({
			persistSession: true,
			extensionFactories: [
				(pi) => {
					pi.on("session_before_refine", async () => ({
						proposal: {
							summary: "bad plan",
							rationale: "bad",
							expectedOutcome: "bad",
							edits: [
								// update without id is invalid
								{ action: "update" as const, kind: "memory" as const, title: "x", content: "y" },
							],
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([]);
		await harness.session.prompt("hello").catch(() => {});

		const result = await harness.session.refine();

		expect(result.appliedEdits[0]?.applied).toBe(false);
		expect(result.appliedEdits[0]?.error).toContain("requires id");
	});

	it("normalizes malformed runtime extension proposals before applying them", async () => {
		const proposals: Array<{ proposal: unknown; expectedEdits: number }> = [
			{ proposal: { summary: "missing edits" }, expectedEdits: 0 },
			{ proposal: { edits: "not an array" }, expectedEdits: 0 },
			{
				proposal: {
					edits: [null, "not an edit", { action: "update", kind: "memory", title: "x", content: "y" }],
				},
				expectedEdits: 1,
			},
		];

		for (const { proposal, expectedEdits } of proposals) {
			const harness = await createHarness({
				persistSession: true,
				extensionFactories: [
					(pi) => {
						pi.on("session_before_refine", async () => ({
							proposal: proposal as RefinementProposal,
						}));
					},
				],
			});
			harnesses.push(harness);
			harness.setResponses([]);
			await harness.session.prompt("hello").catch(() => {});

			const result = await harness.session.refine();

			expect(result.appliedEdits).toHaveLength(expectedEdits);
			if (expectedEdits > 0) {
				expect(result.appliedEdits[0]?.applied).toBe(false);
				expect(result.appliedEdits[0]?.error).toContain("requires id");
			}
			expect(harness.eventsOfType("refine_failed")).toHaveLength(0);
		}
	});

	it("skips the refinement round when an extension returns skip", async () => {
		const harness = await createHarness({
			persistSession: true,
			extensionFactories: [
				(pi) => {
					pi.on("session_before_refine", async () => ({ skip: true }));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([]);
		await harness.session.prompt("hello").catch(() => {});

		await expect(harness.session.refine()).rejects.toThrow(RefineSkippedError);
	});

	it("falls back to the built-in planner when the handler returns nothing", async () => {
		let handlerCalls = 0;
		const harness = await createHarness({
			persistSession: true,
			models: [
				{ id: "main", reasoning: true },
				{ id: "learning", reasoning: true },
			],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_refine", async () => {
						handlerCalls += 1;
						return undefined;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([]);
		await harness.session.prompt("hello").catch(() => {});

		const internals = harness.session as unknown as {
			_planRefine(options: unknown, signal: AbortSignal): Promise<unknown>;
			_reviewAutoRefine(context: {
				reason: "turn_interval";
				turnsSinceLastReview: number;
			}): Promise<AutoRefineReview>;
		};
		// The handler runs but does not short-circuit: planning proceeds to the
		// built-in planner LLM call, which fails here (no faux response queued)
		// rather than being skipped.
		const refineAbort = new AbortController();
		await expect(internals._planRefine({ instructions: "x" }, refineAbort.signal)).rejects.not.toThrow(
			RefineSkippedError,
		);
		expect(handlerCalls).toBe(1);

		// Actual built-in requests, not an injected reviewer or planner implementation.
		const observed: Array<{ modelId: string; reasoning: SimpleStreamOptions["reasoning"] }> = [];
		const response =
			(value: unknown): FauxResponseFactory =>
			(_context, options, _state, model) => {
				observed.push({ modelId: model.id, reasoning: (options as SimpleStreamOptions | undefined)?.reasoning });
				return fauxAssistantMessage(JSON.stringify(value));
			};
		const queueReviewAndPlan = () =>
			harness.appendResponses([
				response({ shouldRefine: true, rationale: "fixture lesson", instructions: "capture it", global: false }),
				response({
					summary: "built-in fixture plan",
					rationale: "fixture",
					expectedOutcome: "no edit needed",
					edits: [],
				}),
			]);
		await harness.session.setThinkingLevel("high");
		queueReviewAndPlan();
		expect(
			(await internals._reviewAutoRefine({ reason: "turn_interval", turnsSinceLastReview: 25 })).shouldRefine,
		).toBe(true);
		expect((await harness.session.refine()).summary).toBe("built-in fixture plan");
		// Legacy main MODEL inheritance does not imply main effort on either request.
		expect(observed).toEqual([
			{ modelId: "main", reasoning: undefined },
			{ modelId: "main", reasoning: undefined },
		]);

		const { sessionManager, modelRegistry } = harness.session;
		modelRegistry.registerProvider(learningModel.provider, {
			api: learningModel.api,
			baseUrl: learningModel.baseUrl,
			apiKey: "refinement-planner-fixture-key",
			models: [learningModel],
		});
		harness.settingsManager.applyOverrides({
			autoRefine: {
				model: {
					provider: learningModel.provider,
					modelId: "learning",
					thinkingLevel: "off",
				},
			},
		});
		// Replace the two existing learning responses, not the native planner/reviewer or their completion promises.
		const completions = vi.spyOn(InferenceCoordinator.prototype, "complete");
		const reviewerInstructions = "--global capture the user's reusable lesson";
		const values: unknown[] = [
			{ shouldRefine: true, rationale: "fixture lesson", instructions: reviewerInstructions },
			{
				summary: "built-in fixture plan",
				rationale: "fixture",
				expectedOutcome: "One proposed lesson may be useful",
				edits: [
					{ action: "create", kind: "memory", title: "Native planner memory", content: "A proposed lesson" },
					{ action: "update", kind: "memory", title: "Missing target", content: "Skipped without an id" },
				],
			},
		];
		const bodies: Record<string, unknown>[] = [];
		const offlineFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			const value = values.shift();
			if (value === undefined) throw new Error("Unexpected extra learning request");
			const item = {
				type: "message",
				id: `msg_learning_${bodies.length}`,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: JSON.stringify(value), annotations: [] }],
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
						id: `resp_learning_${bodies.length}`,
						model: learningModel.id,
						status: "completed",
						usage: {
							input_tokens: 20,
							output_tokens: 10,
							total_tokens: 30,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				},
			];
			const sse = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		});
		const nativeReview = await internals._reviewAutoRefine({ reason: "turn_interval", turnsSinceLastReview: 25 });
		expect(nativeReview.shouldRefine).toBe(true);
		expect(nativeReview.instructions?.startsWith(`${reviewerInstructions}\n\n`)).toBe(true);
		const automaticPolicy = nativeReview.instructions!.slice(reviewerInstructions.length + 2);
		expect(automaticPolicy).toContain("concrete reusable improvement");
		expect(automaticPolicy).toContain("local reusable lessons are eligible");
		expect(automaticPolicy).toContain("not already supplied in the task or current harness context");
		expect(automaticPolicy).toContain("Do not refine solely to copy current progress");
		expect(completions.mock.calls[0]?.[1].systemPrompt).toContain(automaticPolicy);
		const sourceLeafId = sessionManager.getLeafId();
		const nativeResult = await harness.session.refine({ instructions: nativeReview.instructions });
		expect(nativeResult.summary).toBe("built-in fixture plan");
		expect(completions.mock.calls[1]?.[1].messages[0]?.content).toEqual([
			{ type: "text", text: expect.stringContaining(nativeReview.instructions!) },
		]);
		expect([
			...observed,
			...completions.mock.calls.map(([model, , options]) => ({
				modelId: model.id,
				reasoning: options?.reasoning,
			})),
		]).toEqual([
			{ modelId: "main", reasoning: undefined },
			{ modelId: "main", reasoning: undefined },
			{ modelId: "learning", reasoning: "off" },
			{ modelId: "learning", reasoning: "off" },
		]);
		expect(harness.session.model?.id).toBe("main");
		expect(harness.session.thinkingLevel).toBe("high");
		expect(handlerCalls).toBe(3);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(offlineFetch).toHaveBeenCalledTimes(2);
		expect(nativeResult.appliedEdits.map((edit) => edit.applied)).toEqual([true, false]);
		const state = loadHarnessState(nativeResult.harnessStatePath.replace(/\/[^/]+$/, ""), "local");
		expect(Object.values(state.entries.memory).some((entry) => entry.title === "Native planner memory")).toBe(true);
		const receipts: RequestJournalEntry[] = [];
		let recorded: CustomEntry | undefined;
		for await (const { entry: raw, retention, qualification } of readSessionJournal(
			sessionManager.getSessionFile()!,
		)) {
			const entry = raw as SessionEntry;
			if (entry.type === "request" && entry.request.type === "attempt_settled") receipts.push(entry);
			if (
				entry.type === "custom" &&
				entry.customType === REFINEMENT_CUSTOM_TYPE &&
				entry.data &&
				typeof entry.data === "object" &&
				"id" in entry.data &&
				entry.data.id === nativeResult.id
			) {
				recorded = entry;
				expect(retention).toBeUndefined();
				expect(qualification).toBeUndefined();
			}
		}
		expect(receipts).toHaveLength(2);
		const planner = receipts.map((entry) => entry.request).find((request) => request.purposeDetail === "plan");
		if (planner?.type !== "attempt_settled") throw new Error("Missing settled planner request");
		expect(planner).toMatchObject({
			purpose: "refine",
			purposeDetail: "plan",
			source: { sessionId: sessionManager.getSessionId(), leafId: sourceLeafId },
			receipt: { outcome: "completed" },
		});
		expect(receipts.some((entry) => entry.request.purposeDetail === "auto-refine-review")).toBe(true);
		expect(recorded?.data).toEqual(nativeResult);
		expect(recorded?.plannerRequest).toEqual({
			operationId: planner.operationId,
			attemptIds: [planner.attemptId],
			source: planner.source,
		});
		expect(recorded?.plannerRequest?.operationId).not.toBe(nativeResult.id);
		expect(JSON.stringify(nativeResult)).not.toContain('"plannerRequest"');
		expect(JSON.stringify(state)).not.toContain('"plannerRequest"');
		expect(JSON.stringify(bodies)).not.toContain('"plannerRequest"');
		expect(JSON.stringify(harness.session.messages)).not.toContain('"plannerRequest"');
	});

	it("declines automatic task snapshots without adding planner instructions", async () => {
		const harness = await createHarness({
			persistSession: true,
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(JSON.stringify({ shouldRefine: false, rationale: "Only mutable task progress" })),
		]);
		const internals = harness.session as unknown as {
			_maybeAutoRefine(reason: "turn_interval"): Promise<void>;
			_reviewAutoRefine(context: {
				reason: "turn_interval";
				turnsSinceLastReview: number;
			}): Promise<AutoRefineReview>;
			_assistantTurnsSinceAutoRefine: number;
		};
		const review = vi.spyOn(internals, "_reviewAutoRefine");
		const planner = vi.spyOn(harness.session, "refine");
		internals._assistantTurnsSinceAutoRefine = 1;

		await internals._maybeAutoRefine("turn_interval");

		expect(review).toHaveBeenCalledTimes(1);
		await expect(review.mock.results[0]?.value).resolves.toEqual({
			shouldRefine: false,
			rationale: "Only mutable task progress",
			instructions: undefined,
		});
		expect(planner).not.toHaveBeenCalled();
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("consumes a non-serialized auto-refine round when an extension skips it", async () => {
		let handlerCalls = 0;
		const harness = await createHarness({
			persistSession: true,
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
			autoRefineReviewer: async () => ({ shouldRefine: true, rationale: "durable lesson" }),
			extensionFactories: [
				(pi) => {
					pi.on("session_before_refine", async () => {
						handlerCalls += 1;
						return { skip: true };
					});
				},
			],
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as {
			_maybeAutoRefine(reason: "turn_interval"): Promise<void>;
			_assistantTurnsSinceAutoRefine: number;
			_turnIntervalAutoRefinePending: boolean;
			_pendingAutoRefineReview?: unknown;
		};
		internals._assistantTurnsSinceAutoRefine = 1;

		await internals._maybeAutoRefine("turn_interval");

		expect(handlerCalls).toBe(1);
		expect(internals._assistantTurnsSinceAutoRefine).toBe(0);
		expect(internals._turnIntervalAutoRefinePending).toBe(false);
		expect(internals._pendingAutoRefineReview).toBeUndefined();
		expect(harness.eventsOfType("refine_failed")).toHaveLength(0);

		await internals._maybeAutoRefine("turn_interval");
		expect(handlerCalls).toBe(1);
	});

	it("marks serialized auto-refine as trigger auto and treats extension skip as a non-failure", async () => {
		const events: SessionBeforeRefineEvent[] = [];
		const harness = await createHarness({
			persistSession: true,
			serializedRefine: true,
			autoRefineReviewer: async () => ({
				shouldRefine: true,
				rationale: "durable lesson",
				instructions: "capture the lesson",
			}),
			extensionFactories: [
				(pi) => {
					pi.on("session_before_refine", async (event) => {
						events.push(event);
						return { skip: true };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([]);
		await harness.session.prompt("hello").catch(() => {});

		const internals = harness.session as unknown as {
			_runSerializedAutoRefineReview(reason: "compact" | "turn_interval", branchVersion: number): Promise<void>;
			_autoRefineBranchVersion: number;
		};
		await internals._runSerializedAutoRefineReview("turn_interval", internals._autoRefineBranchVersion);

		expect(events).toHaveLength(1);
		expect(events[0]?.preparation.trigger).toBe("auto");
		expect(harness.eventsOfType("refine_failed")).toHaveLength(0);
	});

	it("emits refine_failed when disposal drains an extension-skipped explicit serialized refine.run", async () => {
		const harness = await createHarness({
			persistSession: true,
			serializedRefine: true,
			extensionFactories: [
				(pi) => {
					pi.on("session_before_refine", async () => ({ skip: true }));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([]);
		await harness.session.prompt("hello").catch(() => {});

		(harness.session.agent.state as { isStreaming: boolean }).isStreaming = true;
		harness.session.handleRefineHostRequest("refine.run", { instructions: "x" });
		(harness.session.agent.state as { isStreaming: boolean }).isStreaming = false;

		await harness.session.disposeAsync();

		const failures = harness.eventsOfType("refine_failed");
		expect(failures).toHaveLength(1);
		expect(failures[0]?.error).toBe("Refinement skipped by extension");
	});
});
