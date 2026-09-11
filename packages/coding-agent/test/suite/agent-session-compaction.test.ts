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
	type Model,
	type ToolResultMessage,
	type Usage,
} from "@ponythewhite/base-context-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompactionCommittedError } from "../../src/core/agent-session.js";
import { readContextEpoch } from "../../src/core/context-epoch.js";
import { InferenceCoordinator } from "../../src/core/inference-coordinator.js";
import { SessionJournalOwner } from "../../src/core/session-journal-owner.js";
import { readSessionJournal } from "../../src/core/session-journal-reader.js";
import { type CompactionEntry, type RequestJournalEntry, SessionManager } from "../../src/core/session-manager.js";
import { TASK_FRAME_CUSTOM_TYPE } from "../../src/core/task-frame.js";
import { createHarness, getMessageText, type Harness } from "./harness.js";
import { createDeferred } from "./scheduling.js";

type SessionWithCompactionInternals = {
	_checkCompaction: (
		assistantMessage: AssistantMessage,
		skipAbortedCheck?: boolean,
		queueAutonomousContinuation?: boolean,
	) => Promise<void>;
	_runAutoCompaction: (reason: "overflow" | "threshold" | "requested", willRetry: boolean) => Promise<void>;
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

	it("manually compacts using an extension-provided summary", async () => {
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

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const pruneOversizedVariables = vi.fn(async () => ["large_text"]);
		const listNamespaceNames = vi.fn(async () => ["small_value"]);
		const internals = harness.session as unknown as { _ipythonKernelProvisioner?: unknown };
		const previousProvisioner = internals._ipythonKernelProvisioner;
		internals._ipythonKernelProvisioner = {
			hasRunningKernel: true,
			pruneOversizedVariables,
			listNamespaceNames,
		};
		let result!: Awaited<ReturnType<typeof harness.session.compact>>;
		try {
			result = await harness.session.compact();
		} finally {
			internals._ipythonKernelProvisioner = previousProvisioner;
		}
		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");

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
		expect(harness.session.messages[0]?.role).toBe("compactionSummary");
	});

	it("continues DeepSeek tools through its native public checkpoint and rejects an altered replay payload", async () => {
		const model = getModel("deepseek", "deepseek-flash");
		const privateThinking = `PRIVATE_DEEPSEEK_REASONING ${"thinking ".repeat(14000)}`;
		let executions = 0;
		const harness = await createHarness({
			persistSession: true,
			settings: { compaction: { enabled: false, keepRecentTokens: 1 }, autoRefine: { enabled: false } },
			tools: [
				{
					name: "deepseek_probe",
					label: "DeepSeek probe",
					description: "Return the fixture result.",
					parameters: Type.Object({}),
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
				choices: [{ index: 0, delta, finish_reason: toolCall ? "tool_calls" : "stop" }],
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
		expect(executions).toBe(1);
		expect(mainBodies).toHaveLength(2);
		expect(rawBodies).toHaveLength(2); // The public candidate does not convert or call onPayload again.
		expect(rawBodies[1]).toContain(privateThinking);
		expect(rawBodies[1]).toContain('"reasoning_content"');
		expect(rawBodies[1]).toContain('"tool_calls"');
		expect(JSON.stringify(mainBodies[1])).not.toContain("PRIVATE_DEEPSEEK_REASONING");
		expect(JSON.stringify(mainBodies[1])).not.toContain('"tool_calls"');
		expect(mainBodies[1].messages.some((message) => message.role === "tool")).toBe(false);
		expect(JSON.stringify(mainBodies[1])).toContain("TOOL_RESULT_PRESERVED");
		expect(mainBodies[1].tools).toEqual(mainBodies[0].tools);
		expect(mainBodies.map((body) => body.reasoning_effort)).toEqual(["low", "low"]);
		expect(epochsAtSend[1]).not.toBe(epochsAtSend[0]);
		const qualifiedTool = await harness.sessionManager.readBranchHistory(async (history) => {
			for await (const item of history.iterateEntries({ maxEntries: 128, maxSourceBytes: 2 * 1024 * 1024 }))
				if (item.source.qualification === "native-tool-execution") return true;
			return false;
		});
		expect(qualifiedTool).toBe(true);
		const beforeCompaction = await harness.sessionManager.readEntries();
		const toolAssistant = beforeCompaction.find(
			(entry) =>
				entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "toolUse",
		);
		expect(toolAssistant).toMatchObject({
			requestOutput: {
				attemptIds: [expect.any(String)],
				source: { sessionId: harness.sessionManager.getSessionId() },
			},
		});

		const compacted = await harness.session.compact();
		expect(compacted.summary).toContain("DeepSeek compacted summary.");
		expect(summaryBodies.length).toBeGreaterThan(0);
		const saved = (await harness.sessionManager.readEntries()).filter((entry) => entry.type === "compaction").at(-1)!;
		expect(saved.requestOutputs?.length).toBe(summaryBodies.length);
		expect(readContextEpoch(saved.details, 2 * 1024 * 1024)).toBeDefined();
		await harness.session.setThinkingLevel("medium");
		await harness.session.prompt("Continue after the committed summary.");
		expect(mainBodies).toHaveLength(3);
		expect(mainBodies[2].reasoning_effort).toBe("high");
		expect(JSON.stringify(mainBodies[2])).toContain("DeepSeek compacted summary.");
		expect(rawBodies).toHaveLength(3);
		expect(executions).toBe(1);

		const sent = offlineFetch.mock.calls.length;
		const accepted = epochsAtSend.at(-1)!;
		altered = true;
		await expect(harness.session.prompt("Do not accept a changed projection.")).rejects.toThrow(
			"compatible final provider projection",
		);
		expect(rawBodies).toHaveLength(4);
		expect(offlineFetch).toHaveBeenCalledTimes(sent);
		expect((await harness.sessionManager.readEntries()).some((entry) => entry.id === accepted)).toBe(true);
	});

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
		const originalSourceRead = harness.sessionManager.readSourceHistory.bind(harness.sessionManager);
		const sourceRead = vi.spyOn(harness.sessionManager, "readSourceHistory").mockImplementationOnce(() =>
			originalSourceRead(async () => {
				throw sourceError;
			}),
		);
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
		vi.useFakeTimers();
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
			_schedulePostCompactionContinue(): void;
			_cancelPostCompactionContinue(): void;
			_postCompactionContinuationScheduled: boolean;
		};
		try {
			await harness.session.prompt("one");
			await harness.session.prompt("two");
			internals._schedulePostCompactionContinue();

			await harness.session.compact();

			expect(internals._postCompactionContinuationScheduled).toBe(true);
		} finally {
			internals._cancelPostCompactionContinue();
		}
	});

	it("waits for active manual compaction before continuing", async () => {
		const compactionStarted = createDeferred();
		const compactionRelease = createDeferred();
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						compactionStarted.resolve();
						await compactionRelease.promise;
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
		const internals = harness.session as unknown as {
			_schedulePostCompactionContinue(): void;
		};
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");
		const pause = harness.session.acquireQueuedWorkPause();
		const continueAgent = vi.spyOn(harness.session.agent, "continue").mockResolvedValue();
		internals._schedulePostCompactionContinue();

		const compaction = harness.session.compact(undefined, { skipAbort: true });
		await compactionStarted.promise;
		pause.release();
		await new Promise<void>(setImmediate);
		expect(continueAgent).not.toHaveBeenCalled();

		compactionRelease.resolve();
		await compaction;
		await harness.session.waitForHeadlessIdle();
		expect(continueAgent).toHaveBeenCalledTimes(1);
	});

	it("waits for active auto-compaction before continuing", async () => {
		const compactionStarted = createDeferred();
		const compactionRelease = createDeferred();
		let staleCompactionStarted: (() => void) | undefined;
		let staleCompactionRelease: Promise<void> | undefined;
		let staleBranchIds: string[] = [];
		const harness = await createHarness({
			persistSession: true,
			settings: { compaction: { keepRecentTokens: 1 }, autoRefine: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						compactionStarted.resolve();
						await compactionRelease.promise;
						if (staleCompactionStarted) {
							staleBranchIds = event.branchEntries.map((entry) => entry.id);
							staleCompactionStarted();
							await staleCompactionRelease;
						}
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
		const internals = harness.session as unknown as SessionWithCompactionInternals & {
			_schedulePostCompactionContinue(): void;
		};
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");
		const pause = harness.session.acquireQueuedWorkPause();
		const continueAgent = vi.spyOn(harness.session.agent, "continue").mockResolvedValue();
		internals._schedulePostCompactionContinue();

		const compaction = internals._runAutoCompaction("threshold", false);
		await compactionStarted.promise;
		pause.release();
		await new Promise<void>(setImmediate);
		expect(continueAgent).not.toHaveBeenCalled();

		compactionRelease.resolve();
		await compaction;
		await harness.session.waitForHeadlessIdle();
		expect(continueAgent).toHaveBeenCalledTimes(1);

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
		const harness = await createHarness();
		harnesses.push(harness);
		const session = harness.session;
		const internals = session as unknown as {
			_schedulePostCompactionContinue(): void;
			_cancelPostCompactionContinue(): void;
			_sessionInputCheckpointWaiters: Set<() => void>;
			_sessionInputPumpSuspended: boolean;
		};
		// A queued follow-up held back by a pause, then a pump suspension (the
		// requestAbort teardown state): the queue stays populated but undispatchable.
		const pause = session.acquireQueuedWorkPause();
		await session.followUp("queued across abort");
		expect(session.queuedActionCount).toBe(1);
		session.requestAbort();
		pause.release();
		expect(internals._sessionInputPumpSuspended).toBe(true);
		expect(session.queuedActionCount).toBe(1);

		// The runner passes its pre-dispatch guards (no pauses, agent idle) and
		// parks in the session idle wait on a checkpoint waiter.
		internals._schedulePostCompactionContinue();
		await vi.waitFor(() => {
			expect(internals._sessionInputCheckpointWaiters.size).toBeGreaterThan(0);
		});
		expect(session.hasPendingAdmissionWaiters).toBe(true);

		// Cancelling the continuation must release that waiter: a stuck waiter
		// keeps hasPendingAdmissionWaiters true and blocks daemon passivation.
		// The settle's own notify empties the set for a moment; a leaked runner
		// re-parks within a microtask, so settle real time before asserting.
		internals._cancelPostCompactionContinue();
		await new Promise((resolve) => setTimeout(resolve, 100));
		try {
			expect(internals._sessionInputCheckpointWaiters.size).toBe(0);
			expect(session.hasPendingAdmissionWaiters).toBe(false);
		} finally {
			session.clearQueue();
			session.resumeQueuedWork();
		}
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
			): Promise<AgentMessage | undefined>;
			_clearQueuedAutonomousContinuationsAfterSkippedThresholdCompaction(
				shouldContinueAfterThreshold: boolean,
				queuedMessages: AgentMessage[],
			): void;
			_postCompactionContinuationMessages: AgentMessage[];
		};
		const firstAssistant = createAssistant(harness, { stopReason: "toolUse", totalTokens: 10_000 });
		const secondAssistant = createAssistant(harness, { stopReason: "toolUse", totalTokens: 10_000 });

		const firstQueued = await sessionInternals._queueAutonomousContinuationForThresholdCompaction(firstAssistant);
		const secondQueued = await sessionInternals._queueAutonomousContinuationForThresholdCompaction(secondAssistant);

		expect(firstQueued).toBeDefined();
		expect(secondQueued).toBeDefined();
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(2);
		sessionInternals._clearQueuedAutonomousContinuationsAfterSkippedThresholdCompaction(true, [secondQueued!]);

		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(1);
		expect(sessionInternals._postCompactionContinuationMessages).toEqual([firstQueued]);
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

	it("does not retry overflow recovery more than once", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const overflowMessage = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "prompt is too long",
			timestamp: Date.now(),
		});
		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue();
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

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue();

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

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue();

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).toHaveBeenCalledWith("threshold", false);
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

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue();

		await sessionInternals._checkCompaction(successfulAssistant, false);

		expect(runAutoCompactionSpy).toHaveBeenCalledWith("threshold", false);
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
		const sessionInternals = harness.session as unknown as {
			_schedulePostCompactionContinue(): void;
			_postCompactionContinuationMessages: AgentMessage[];
		};
		const steeringMessage = {
			role: "user",
			content: [{ type: "text", text: "steer first" }],
			timestamp: Date.now(),
		} satisfies AgentMessage;
		const autonomousMessage = {
			role: "user",
			content: [{ type: "text", text: "autonomous follow-up" }],
			timestamp: Date.now(),
		} satisfies AgentMessage;
		sessionInternals._postCompactionContinuationMessages = [autonomousMessage];
		harness.session.agent.state.messages = [{ ...fauxAssistantMessage("done"), timestamp: Date.now() - 1000 }];
		harness.session.agent.steer(steeringMessage);
		harness.session.agent.followUp(autonomousMessage);
		const continueSpy = vi.spyOn(harness.session.agent, "continue").mockResolvedValue();
		const followUpSpy = vi.spyOn(harness.session.agent, "followUp");

		sessionInternals._schedulePostCompactionContinue();
		await vi.advanceTimersByTimeAsync(100);

		expect(continueSpy).toHaveBeenCalledTimes(1);
		expect(sessionInternals._postCompactionContinuationMessages).toEqual([autonomousMessage]);
		expect(followUpSpy).toHaveBeenCalledWith(autonomousMessage);
	});

	it.each([
		{
			name: "untracked queued input",
			text: "queued input",
			response: "queued input handled",
			tracked: false,
		},
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
		vi.useFakeTimers();
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as {
			_schedulePostCompactionContinue(continueAfterSessionInput?: boolean): void;
			_postCompactionContinuationMessages: AgentMessage[];
			_postCompactionContinuationScheduled: boolean;
			_createPreparedTurnAction(
				schedule: "followUp",
				text: string,
				images: undefined,
				options: { message?: AgentMessage; resumeIfIdle: boolean },
			): unknown;
			_admitSessionInput(action: unknown, options?: { wake?: boolean }): { accepted: boolean };
		};
		const continuation = {
			role: "user",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		} satisfies AgentMessage;
		if (tracked) sessionInternals._postCompactionContinuationMessages = [continuation];
		harness.setResponses([fauxAssistantMessage(response)]);
		sessionInternals._admitSessionInput(
			sessionInternals._createPreparedTurnAction("followUp", text, undefined, {
				...(tracked && { message: continuation }),
				resumeIfIdle: tracked,
			}),
		);
		const continueSpy = vi.spyOn(harness.session.agent, "continue");

		sessionInternals._schedulePostCompactionContinue(continueAfterSessionInput);
		await vi.advanceTimersByTimeAsync(200);

		expect(continueSpy).toHaveBeenCalledTimes(continueAfterSessionInput ? 1 : 0);
		expect(sessionInternals._postCompactionContinuationScheduled).toBe(false);
		expect(sessionInternals._postCompactionContinuationMessages).toEqual([]);
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: response }],
		});
	});

	it("keeps autonomous threshold continuations when post-compaction continue must retry", async () => {
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
		const sessionInternals = harness.session as unknown as {
			_schedulePostCompactionContinue(): void;
			_cancelPostCompactionContinue(): void;
			_postCompactionContinuationMessages: AgentMessage[];
			_postCompactionContinuationScheduled: boolean;
		};
		const queuedMessage = {
			role: "user",
			content: [{ type: "text", text: "autonomous follow-up" }],
			timestamp: Date.now(),
		} satisfies AgentMessage;
		sessionInternals._postCompactionContinuationMessages = [queuedMessage];
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
		];
		const activeRunSettled = createDeferred();
		const continueSpy = vi
			.spyOn(harness.session.agent, "continue")
			.mockRejectedValueOnce(new AgentContinueError("busy", "already processing"));
		vi.spyOn(harness.session.agent, "waitForIdle").mockImplementation(() =>
			continueSpy.mock.calls.length === 0 ? Promise.resolve() : activeRunSettled.promise,
		);

		sessionInternals._schedulePostCompactionContinue();
		await vi.waitFor(() => expect(continueSpy).toHaveBeenCalledTimes(1));

		expect(sessionInternals._postCompactionContinuationMessages).toEqual([queuedMessage]);
		expect(sessionInternals._postCompactionContinuationScheduled).toBe(true);
		sessionInternals._cancelPostCompactionContinue();
		activeRunSettled.resolve();
	});

	it("keeps replacement continuation messages when a cancelled continue settles late", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as {
			_schedulePostCompactionContinue(): void;
			_cancelPostCompactionContinue(): void;
			_postCompactionContinuationMessages: AgentMessage[];
		};
		const queuedMessage = {
			role: "user",
			content: [{ type: "text", text: "autonomous follow-up" }],
			timestamp: Date.now(),
		} satisfies AgentMessage;
		sessionInternals._postCompactionContinuationMessages = [queuedMessage];
		const staleRun = createDeferred();
		const replacementRun = createDeferred();
		const continueSpy = vi
			.spyOn(harness.session.agent, "continue")
			.mockReturnValueOnce(staleRun.promise)
			.mockReturnValueOnce(replacementRun.promise);

		sessionInternals._schedulePostCompactionContinue();
		await vi.waitFor(() => expect(continueSpy).toHaveBeenCalledTimes(1));
		sessionInternals._cancelPostCompactionContinue();
		sessionInternals._schedulePostCompactionContinue();
		await vi.waitFor(() => expect(continueSpy).toHaveBeenCalledTimes(2));

		staleRun.resolve();
		await new Promise<void>(setImmediate);
		expect(sessionInternals._postCompactionContinuationMessages).toEqual([queuedMessage]);

		replacementRun.resolve();
		await harness.session.waitForHeadlessIdle();
		expect(sessionInternals._postCompactionContinuationMessages).toEqual([]);
	});

	it("waits for an in-flight refine application before continuing", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as {
			_schedulePostCompactionContinue(): void;
			_refineInFlight: Promise<void> | undefined;
		};
		const continueSpy = vi.spyOn(harness.session.agent, "continue").mockResolvedValue();
		const pause = harness.session.acquireQueuedWorkPause();
		sessionInternals._schedulePostCompactionContinue();
		await new Promise<void>(setImmediate);

		// Refine enters its apply phase while the runner waits out the pause.
		const refineApply = createDeferred();
		sessionInternals._refineInFlight = refineApply.promise;
		pause.release();
		await new Promise<void>(setImmediate);
		expect(continueSpy).not.toHaveBeenCalled();

		sessionInternals._refineInFlight = undefined;
		refineApply.resolve();
		await harness.session.waitForHeadlessIdle();
		expect(continueSpy).toHaveBeenCalledTimes(1);
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

		const runCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue();
		const followUpSpy = vi.spyOn(harness.session.agent, "followUp");

		await sessionInternals._checkCompaction(successfulAssistant, false);

		expect(runCompactionSpy).toHaveBeenCalledWith("threshold", false);
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

		const runCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue();
		const followUpSpy = vi.spyOn(harness.session.agent, "followUp");

		await sessionInternals._checkCompaction(successfulAssistant, false, false);

		expect(runCompactionSpy).toHaveBeenCalledWith("threshold", false);
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

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue();

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

		const compactionTimestamp = new Date(harness.sessionManager.getEntry(compactionId)!.timestamp).getTime();
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

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue();

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
		const belowThresholdSpy = vi.spyOn(belowThresholdInternals, "_runAutoCompaction").mockResolvedValue();
		const disabledSpy = vi.spyOn(disabledInternals, "_runAutoCompaction").mockResolvedValue();

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
		const persistedEntries = harness.sessionManager.getEntries();
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
		// No unacknowledged outcome is published: same leaf and entries.
		expect(harness.sessionManager.getLeafId()).toBe(persistedLeafId);
		expect(harness.sessionManager.getEntries()).toEqual(persistedEntries);

		await expect(harness.sessionManager.appendCustomEntry("blocked_before_recovery")).rejects.toThrow(
			"outcome may be unknown",
		);
		await harness.sessionManager.recover();
		const nextId = await harness.sessionManager.appendCustomEntry("after_failed_outcome");
		const reloaded = await SessionManager.openReadOnly(sessionFile);
		expect(reloaded.getEntry(nextId)?.parentId).toBe(persistedLeafId);
		expect(reloaded.getBranch().map((entry) => entry.id)).toEqual(
			harness.sessionManager.getBranch().map((entry) => entry.id),
		);
		expect(reloaded.getEntries()).not.toContainEqual(
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
