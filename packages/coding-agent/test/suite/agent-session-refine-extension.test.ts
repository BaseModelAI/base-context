import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	type Model,
	type SimpleStreamOptions,
} from "@ponythewhite/base-context-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RefineSkippedError } from "../../src/core/agent-session.js";
import type { SessionBeforeRefineEvent } from "../../src/core/extensions/index.js";
import { InferenceCoordinator } from "../../src/core/inference-coordinator.js";
import { loadHarnessState, REFINEMENT_CUSTOM_TYPE, type RefinementProposal } from "../../src/core/refinement/index.js";
import { readSessionJournal } from "../../src/core/session-journal-reader.js";
import type { CustomEntry, RequestJournalEntry, SessionEntry } from "../../src/core/session-manager.js";
import { createHarness, type Harness } from "./harness.js";

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

	afterEach(async () => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			await harnesses.pop()?.cleanup();
		}
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
			}): Promise<{ shouldRefine: boolean }>;
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
		const values: unknown[] = [
			{ shouldRefine: true, rationale: "fixture lesson", instructions: "capture it", global: false },
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
		expect(
			(await internals._reviewAutoRefine({ reason: "turn_interval", turnsSinceLastReview: 25 })).shouldRefine,
		).toBe(true);
		const sourceLeafId = sessionManager.getLeafId();
		const nativeResult = await harness.session.refine();
		expect(nativeResult.summary).toBe("built-in fixture plan");
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
