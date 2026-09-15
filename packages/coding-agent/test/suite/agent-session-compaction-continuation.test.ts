/**
 * Regression tests: the agent must keep working after an auto-compaction that interrupted
 * unfinished work. BUG A: a skipped/failed threshold compaction that stopped a tool loop must
 * resume it. BUG B: an assistant-text-turn threshold stop reads as "task finished", so an
 * active goal queues its continuation as a session input before compaction.
 */
import {
	Agent,
	type AgentMessage,
	type AgentTurnOutcome,
	type ShouldStopAfterTurnContext,
} from "@ponythewhite/base-context-agent";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxToolCall,
	getModel,
	type Model,
	RequestTokenBudgetError,
	type ToolResultMessage,
	type Usage,
} from "@ponythewhite/base-context-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.js";
import { AuthStorage, InMemoryAuthStorageBackend } from "../../src/core/auth-storage.js";
import { CanonicalContextCompiler, getCanonicalEpochContext } from "../../src/core/canonical-context.js";
import { appendContextEpoch, readContextEpoch } from "../../src/core/context-epoch.js";
import { InferenceCoordinator } from "../../src/core/inference-coordinator.js";
import { renderPublicHistory } from "../../src/core/public-context.js";
import type { NativeRequestEvent } from "../../src/core/request-events.js";
import { PublicContextBudgetError } from "../../src/core/request-view-selection.js";
import { createHarness, getMessageText, type Harness } from "./harness.js";
import { createDeferred } from "./scheduling.js";

type CheckpointDirective = {
	owner: object;
	boundary?: { kind: "tool" | "overflow"; state: "pending" | "consumed" };
	actions: unknown[];
};

type SessionInternals = {
	_shouldStopAfterTurn: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;
	_runAutoCompaction: (reason: "overflow" | "threshold" | "requested", willRetry: boolean) => Promise<boolean>;
	_performCompaction: (options: {
		model: unknown;
		apiKey: string;
		headers?: Record<string, string>;
		customInstructions?: string;
		signal: AbortSignal;
	}) => Promise<unknown>;
	_pendingCheckpoint: CheckpointDirective | undefined;
	_captureCompactionOwner: () => object;
	_captureCheckpointResume: (owner: object, boundary?: CheckpointDirective["boundary"]) => CheckpointDirective;
	_schedulePostCompactionContinue: (directive: CheckpointDirective) => void;
};

function createUsage(totalTokens: number): Usage {
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
	options: { stopReason?: AssistantMessage["stopReason"]; totalTokens?: number; timestamp?: number },
): AssistantMessage {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage("", { stopReason: options.stopReason, timestamp: options.timestamp }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(options.totalTokens ?? 0),
	};
}

/** Faux ipython tool that services goal.* host requests like the real kernel bridge. */
function createFauxIpythonTool(sessionRef: { current?: AgentSession }) {
	return {
		name: "ipython",
		label: "ipython",
		description: "Execute Python code in the agent kernel.",
		parameters: Type.Object({ code: Type.String() }),
		execute: async (_toolCallId: string, params: unknown) => {
			const session = sessionRef.current;
			if (!session) throw new Error("test session is not initialized");
			const code = (params as { code: string }).code.trim();
			let text = "";
			if (code.startsWith("goal.")) {
				const spaceIndex = code.indexOf(" ");
				const type = spaceIndex < 0 ? code : code.slice(0, spaceIndex);
				const payload = spaceIndex < 0 ? {} : JSON.parse(code.slice(spaceIndex + 1));
				text = JSON.stringify(await session.handleGoalHostRequest(type, payload));
			}
			return { content: [{ type: "text" as const, text }], details: {} };
		},
	};
}

describe("compaction continuation", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	function midToolLoopContext(harness: Harness): ShouldStopAfterTurnContext {
		const assistant = createAssistant(harness, {
			stopReason: "toolUse",
			totalTokens: 250_000,
			timestamp: Date.now(),
		});
		const toolResult: ToolResultMessage<unknown> = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "big",
			content: [{ type: "text", text: "result" }],
			isError: false,
			timestamp: Date.now() + 500,
		};
		const messages: AgentMessage[] = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			assistant,
			toolResult,
		];
		harness.session.agent.state.messages = messages;
		return {
			message: assistant,
			toolResults: [toolResult],
			context: { systemPrompt: harness.session.systemPrompt, messages, tools: [] },
			newMessages: [assistant, toolResult],
		};
	}

	async function createPublicPressureFixture(
		removablePrefix: boolean,
		toolCharacters = 70_000,
		olderToolCharacters = 0,
		reasoning: { fromCall?: number; afterCall?: boolean } = {},
	) {
		const model = getModel("openai-codex", "gpt-5.6-sol");
		const summaryModel: Model<"openai-responses"> = {
			...getModel("openai", "gpt-4.1"),
			baseUrl: "https://summary.invalid/v1",
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
		};
		const key = `fixture.${Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "pressure-fixture" } }),
		).toString("base64")}.fixture`;
		const authBackend = new InMemoryAuthStorageBackend();
		authBackend.withLock(() => ({
			result: undefined,
			next: JSON.stringify({
				"openai-codex": {
					type: "oauth",
					access: key,
					refresh: "unused-fixture-refresh",
					expires: Date.now() + 3_600_000,
				},
			}),
		}));
		// The stock subscription contract requires a read-only existing login, not a runtime API key.
		vi.spyOn(AuthStorage, "inMemory").mockReturnValueOnce(
			AuthStorage.fromStorage(authBackend, {
				existingOpenAICodexSubscription: true,
				usePrimeCliConfig: false,
			}),
		);
		const failures: unknown[] = [];
		const transitions: string[] = [];
		const bindRecovery = Agent.prototype.bindRequestPreparationRecoveryOwner;
		vi.spyOn(Agent.prototype, "bindRequestPreparationRecoveryOwner").mockImplementation(function (
			this: Agent,
			owner,
		) {
			bindRecovery.call(this, async (error, signal) => {
				failures.push(error);
				transitions.push("public_pressure");
				return owner(error, signal);
			});
		});
		const toolText = `RETAINED_TOOL_RESULT:${"t".repeat(toolCharacters)}`;
		const olderToolText = olderToolCharacters ? `OLDER_TOOL_RESULT:${"o".repeat(olderToolCharacters)}` : undefined;
		const toolResults = olderToolText ? [olderToolText, toolText] : [toolText];
		let nextToolResult = 0;
		const execute = vi.fn(async () => ({
			content: [{ type: "text" as const, text: toolResults[nextToolResult++] }],
			details: {},
		}));
		const harness = await createHarness({
			persistSession: true,
			tools: [
				{
					name: "pressure_fixture",
					label: "Pressure fixture",
					description: "Return local fixture text.",
					parameters: Type.Object({}),
					execute,
				},
			],
			settings: { compaction: { enabled: true }, autoRefine: { enabled: false } },
			requestTokenBudget: {
				mode: "enforce",
				profiles: [model, summaryModel].map((requestModel) => ({
					id: `offline-public-pressure-${requestModel.api}`,
					revision: "1",
					api: requestModel.api,
					provider: requestModel.provider,
					url: `${requestModel.baseUrl}${requestModel.api === "openai-codex-responses" ? "/codex" : ""}/responses`,
					model: requestModel.id,
					authMode: "offline-fixture",
					templateRevision: "responses-text-fixture-v1",
					replayFamily: "responses",
					contextTokens: 272_000,
					outputCeilingTokens: 128_000,
					estimate: { tokensPerUtf8Byte: 1, templateTokens: 0, marginTokens: 1_024 },
				})),
			},
		});
		harnesses.push(harness);
		for (const requestModel of [model, summaryModel]) {
			harness.session.modelRegistry.registerProvider(requestModel.provider, {
				api: requestModel.api,
				baseUrl: requestModel.baseUrl,
				apiKey: key,
				models: [requestModel],
			});
			harness.authStorage.setRuntimeApiKey(requestModel.provider, key);
		}
		await harness.session.setModel(model);
		await harness.session.setThinkingLevel("low");
		harness.session.agent.getApiKey = () => key;
		harness.session.agent.transport = "sse";
		harness.session.setActiveToolsByName(["pressure_fixture"]);
		// Summary uses the ordinary HTTP adapter; only main needs Codex's opaque replay path.
		harness.settingsManager.applyOverrides({
			compaction: { model: { provider: summaryModel.provider, modelId: summaryModel.id, thinkingLevel: "off" } },
		});
		expect(harness.settingsManager.getCompactionSettings()).toMatchObject({
			reserveTokens: 16_384,
			keepRecentTokens: 20_000,
		});
		if (removablePrefix) {
			await harness.sessionManager.appendMessage({
				role: "user",
				content: `OLD_PREFIX:${"p".repeat(olderToolText ? 1_000 : 70_000)}`,
				timestamp: 1,
			});
			await harness.sessionManager.appendMessage({
				role: "assistant",
				content: [
					{
						type: "text",
						text: "The old task is complete.",
						textSignature: JSON.stringify({ v: 1, id: "msg_pressure_old" }),
					},
				],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: createUsage(0),
				stopReason: "stop",
				timestamp: 2,
			});
		}
		// Tool results grow the request past 143k available input bytes. The pressure case
		// has an older exchange to summarize; the short case has only its current instruction.
		const prompt = `Run the local fixture ${toolResults.length} time(s), then finish. ${"u".repeat(removablePrefix ? 20_000 : 90_000)}`;
		const sends: Array<{ body: string; request: Extract<NativeRequestEvent, { type: "attempt_admitted" }> }> = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
			const entries = await harness.sessionManager.readEntries();
			const request = entries
				.flatMap((entry) =>
					entry.type === "request" && entry.request.type === "attempt_admitted" ? [entry.request] : [],
				)
				.at(-1);
			if (!request) throw new Error("Expected persisted native admission before fetch");
			const summary = request.purpose === "summary";
			expect(String(url)).toBe(
				summary ? "https://summary.invalid/v1/responses" : "https://chatgpt.com/backend-api/codex/responses",
			);
			expect(request.descriptor.requestBudget?.status).toBe("within-estimate");
			sends.push({ body: String(init?.body), request });
			transitions.push(summary ? "summary_send" : "main_send");
			if (!summary) {
				const epoch = entries.filter((entry) => entry.type === "compaction").at(-1)!;
				expect(request.contextEpoch).toEqual({
					sessionId: harness.sessionManager.getSessionId(),
					entryId: epoch.id,
				});
			}
			const mainCount = sends.filter((send) => send.request.purpose === "main").length;
			const toolCall = !summary && mainCount <= toolResults.length;
			const items = toolCall
				? [
						...(mainCount >= (reasoning.fromCall ?? 1)
							? [
									{
										type: "reasoning",
										id: `rs_pressure_${mainCount}`,
										encrypted_content: "fixture-opaque-reasoning",
										summary: [],
									},
								]
							: []),
						{
							type: "function_call",
							id: `fc_pressure_${mainCount}`,
							call_id: `call_pressure_${mainCount}`,
							name: "pressure_fixture",
							arguments: "{}",
							status: "completed",
						},
					]
				: [
						{
							type: "message",
							id: `msg_pressure_${sends.length}`,
							role: "assistant",
							status: "completed",
							content: [
								{
									type: "output_text",
									text: summary
										? "The old task is complete; retain the current tool result."
										: "Finished after the acknowledged summary.",
									annotations: [],
								},
							],
						},
					];
			if (toolCall && reasoning.afterCall) items.reverse();
			const events = [
				...items.flatMap((item, output_index) => [
					{ type: "response.output_item.added", output_index, item },
					{ type: "response.output_item.done", output_index, item },
				]),
				{
					type: "response.completed",
					response: {
						id: `resp_pressure_${sends.length}`,
						model: summary ? summaryModel.id : model.id,
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
		return { harness, prompt, execute, failures, sends, transitions, toolText, olderToolText };
	}

	it("preserves meterable native tool groups before an unknown reasoning public suffix", async () => {
		const { harness, prompt, execute, failures, sends } = await createPublicPressureFixture(true, 100, 100, {
			fromCall: 2,
		});
		await harness.session.promptAndWait(prompt);
		expect(failures).toEqual([]);
		expect(execute).toHaveBeenCalledTimes(2);
		expect(sends.map((send) => send.request.purpose)).toEqual(["main", "main", "main"]);
		const nativeInput = JSON.parse(sends[1].body).input as Array<{ type?: string; call_id?: string }>;
		const publicInput = JSON.parse(sends[2].body).input as Array<{ type?: string; call_id?: string }>;
		const olderItems = nativeInput.filter((item) => item.call_id === "call_pressure_1");
		expect(olderItems.map((item) => item.type)).toEqual(["function_call", "function_call_output"]);
		expect(JSON.stringify(publicInput.filter((item) => item.call_id === "call_pressure_1"))).toBe(
			JSON.stringify(olderItems),
		);
		expect(publicInput.some((item) => item.type === "reasoning" || item.call_id === "call_pressure_2")).toBe(false);

		const entries = await harness.sessionManager.readEntries();
		const toolEntries = entries
			.filter((entry) => entry.type === "message")
			.filter(
				(entry) =>
					entry.message.role === "toolResult" ||
					(entry.message.role === "assistant" && entry.message.content.some((part) => part.type === "toolCall")),
			);
		expect(toolEntries).toHaveLength(4);
		const [olderAssistant, olderResult, reasoningAssistant, reasoningResult] = toolEntries;
		// The fixture checks the actual persisted admission/epoch ACK at fetch, not a mock commit.
		const epochEntry = entries.find((entry) => entry.id === sends[2].request.contextEpoch?.entryId);
		if (epochEntry?.type !== "compaction") throw new Error("Expected the accepted public suffix epoch");
		const epoch = readContextEpoch(epochEntry.details, 2 * 1024 * 1024)!;
		expect(epoch).toMatchObject({
			replayContract: "message-groups",
			publicWindow: true,
			literalTailId: reasoningResult.id,
			continuation: { kind: "portable-checkpoint" },
		});
		for (const original of [olderAssistant, olderResult]) {
			const reference = epoch.views.find((view) => view.ref.entryId === original.id);
			expect(reference).toBeDefined();
			expect(reference!.rendering).toBeUndefined();
		}
		expect(epoch.views.find((view) => view.ref.entryId === reasoningAssistant.id)?.rendering).toBe(
			"public-history/1",
		);
		expect(epoch.views.some((view) => view.ref.entryId === reasoningResult.id)).toBe(false);

		// Rebuild from the persisted recipe with a new compiler, including the public literal tail.
		const requests = new InferenceCoordinator(() => harness.sessionManager.bindRequestSink());
		const captured = requests.capture();
		let rebuilt: AgentMessage[];
		try {
			rebuilt = await captured.readHistory((history) =>
				new CanonicalContextCompiler().compile(history, { maxMessages: 256, maxSourceBytes: 2 * 1024 * 1024 }),
			);
		} finally {
			await captured.dispose();
			await requests.dispose();
		}
		const rebuiltReferences = getCanonicalEpochContext(rebuilt)!.references;
		const reconstructed = (entryId: string) =>
			rebuilt[rebuiltReferences.findIndex((reference) => reference?.ref.entryId === entryId)];
		for (const original of [olderAssistant, olderResult]) {
			expect(JSON.stringify(reconstructed(original.id))).toBe(JSON.stringify(original.message));
		}
		const publicItems = [reasoningAssistant, reasoningResult].map((original) => {
			const rendered = renderPublicHistory(original.message, original.id, 2 * 1024 * 1024);
			expect(reconstructed(original.id)).toEqual(rendered);
			if (rendered.role !== "custom" || typeof rendered.content !== "string")
				throw new Error("Expected existing public history rendering");
			return { role: "user", content: [{ type: "input_text", text: rendered.content }] };
		});
		expect(publicInput.slice(-2)).toEqual(publicItems);
		expect(sends[2].body).not.toContain("fixture-opaque-reasoning");
		// Messages appended after the acknowledged public tail still use their native representation.
		expect(rebuilt.at(-1)?.role).toBe("assistant");
		expect(getMessageText(rebuilt.at(-1)!)).toBe("Finished after the acknowledged summary.");
	});

	it("keeps the committed epoch refusal when trailing reasoning requires complete-context replay", async () => {
		const { harness, prompt, execute, sends } = await createPublicPressureFixture(true, 100, 100, {
			fromCall: 2,
			afterCall: true,
		});
		// A reasoning item without a following text/call in its message has no message-group contract.
		const error: unknown = await harness.session.promptAndWait(prompt).then(
			() => undefined,
			(failure: unknown) => failure,
		);
		// The existing epoch validates final projection compatibility before asserting the unknown budget.
		expect(error).toEqual(new Error("Committed context epoch requires a compatible final provider projection"));
		expect(execute).toHaveBeenCalledTimes(2);
		expect(sends.map((send) => send.request.purpose)).toEqual(["main", "main"]);
		expect(sends[1].body).not.toContain("Archived public history data");
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
	});

	it("compacts measured public pressure below 20k and resumes only after the summary ACK", async () => {
		const { harness, prompt, execute, failures, sends, transitions, toolText, olderToolText } =
			await createPublicPressureFixture(true, 70_000, 75_000);
		const summaryReached = createDeferred();
		const allowSummaryAck = createDeferred();
		const bindCompaction = harness.sessionManager.bindCompactionSink.bind(harness.sessionManager);
		vi.spyOn(harness.sessionManager, "bindCompactionSink").mockImplementation((...args) => {
			const sink = bindCompaction(...args);
			const append = sink[appendContextEpoch].bind(sink);
			vi.spyOn(sink, appendContextEpoch).mockImplementation(async (...values) => {
				if (!values[0].includeSummary) return append(...values);
				summaryReached.resolve();
				await allowSummaryAck.promise;
				const id = await append(...values);
				transitions.push("summary_ack");
				return id;
			});
			return sink;
		});
		const continueAgent = vi.spyOn(harness.session.agent, "continue");
		let completed = false;
		const completion = harness.session.promptAndWait(prompt).then(() => {
			completed = true;
		});
		try {
			await Promise.race([
				summaryReached.promise,
				completion.then(() => {
					throw new Error("Action completed before its summary ACK");
				}),
			]);
			expect(completed).toBe(false);
			expect(execute).toHaveBeenCalledTimes(2);
			expect(sends.filter((send) => send.request.purpose === "main")).toHaveLength(2);
			expect(sends.some((send) => send.request.purpose === "summary")).toBe(true);
			expect(transitions).not.toContain("summary_ack");
			expect(failures).toHaveLength(1);
			const pressure = failures[0];
			expect(pressure).toBeInstanceOf(PublicContextBudgetError);
			if (!(pressure instanceof PublicContextBudgetError)) throw pressure;
			expect(pressure.originalAssessment).toMatchObject({
				status: "unknown",
				unknown: ["media, opaque or unsupported replay token coverage unknown"],
			});
			expect(pressure.assessment).toMatchObject({
				status: "over-budget",
				contextTokens: 272_000,
				outputReserveTokens: 128_000,
				marginTokens: 1_024,
			});
			const entries = await harness.sessionManager.readEntries();
			const result = entries.find(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					getMessageText(entry.message) === toolText,
			);
			expect(result).toBeDefined();
			expect(pressure.source).toMatchObject({
				sessionId: harness.sessionManager.getSessionId(),
				leafId: result!.id,
				persistent: true,
			});
			expect(entries.filter((entry) => entry.type === "compaction" && entry.summary)).toHaveLength(0);
		} finally {
			allowSummaryAck.resolve();
		}
		await completion;
		await harness.session.waitForHeadlessIdle();

		const mains = sends.filter((send) => send.request.purpose === "main");
		expect(mains).toHaveLength(3);
		const resumed = mains.at(-1)!;
		expect(transitions.filter((transition) => transition === "summary_ack")).toHaveLength(1);
		expect(transitions.indexOf("public_pressure")).toBeLessThan(transitions.indexOf("summary_send"));
		expect(transitions.indexOf("summary_ack")).toBeLessThan(transitions.lastIndexOf("main_send"));
		expect(resumed.body).toContain("The old task is complete; retain the current tool result.");
		expect(resumed.body).toContain(toolText);
		expect(resumed.body).not.toContain(olderToolText!);
		expect(resumed.body).not.toContain("OLD_PREFIX:");
		expect(resumed.body).not.toContain("fixture-opaque-reasoning");
		expect(resumed.request.contextEpoch).not.toEqual(mains[0].request.contextEpoch);
		const entries = await harness.sessionManager.readEntries();
		const summaries = entries.filter((entry) => entry.type === "compaction" && entry.summary);
		expect(summaries).toHaveLength(1);
		expect(summaries[0]).toMatchObject({
			fromHook: false,
			summary: expect.stringContaining("retain the current tool result"),
		});
		expect(
			entries.filter(
				(entry) =>
					entry.type === "message" && entry.message.role === "user" && getMessageText(entry.message) === prompt,
			),
		).toHaveLength(1);
		expect(entries.filter((entry) => entry.type === "message" && entry.message.role === "toolResult")).toHaveLength(
			2,
		);
		expect(entries.some((entry) => entry.type === "message" && getMessageText(entry.message) === olderToolText)).toBe(
			true,
		);
		const latestToolCall = entries
			.filter(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					entry.message.content.some((part) => part.type === "toolCall"),
			)
			.at(-1)!;
		expect(summaries[0]).toMatchObject({ firstKeptEntryId: latestToolCall.id });
		expect(harness.settingsManager.getCompactionSettings().keepRecentTokens).toBe(20_000);
		expect(execute).toHaveBeenCalledTimes(2);
		expect(continueAgent).not.toHaveBeenCalled();
		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
		expect(harness.eventsOfType("agent_end")).toHaveLength(1);
		expect(harness.eventsOfType("tool_execution_end")).toHaveLength(2);
		expect(harness.session.getLastAssistantText()).toBe("Finished after the acknowledged summary.");
		expect(harness.session.getSessionActionRecoverySnapshot().actions).toHaveLength(0);
	});

	it("reports the original measured budget refusal when the acknowledged public tail still exceeds the limit", async () => {
		const { harness, prompt, execute, failures, sends, toolText } = await createPublicPressureFixture(true, 140_000);
		const continueAgent = vi.spyOn(harness.session.agent, "continue");
		const error: unknown = await harness.session.promptAndWait(prompt).then(
			() => undefined,
			(failure: unknown) => failure,
		);
		expect(error).toBeInstanceOf(RequestTokenBudgetError);
		expect(error).not.toBeInstanceOf(PublicContextBudgetError);
		if (!(error instanceof RequestTokenBudgetError)) throw new Error("Expected the original request budget refusal");
		expect(error.assessment).toMatchObject({
			status: "over-budget",
			unknown: [],
			contextTokens: 272_000,
			outputReserveTokens: 128_000,
			marginTokens: 1_024,
		});
		await harness.session.waitForIdle();
		expect(failures).toHaveLength(1);
		expect(failures[0]).toBeInstanceOf(PublicContextBudgetError);
		expect(sends.filter((send) => send.request.purpose === "main")).toHaveLength(1);
		expect(sends.some((send) => send.request.purpose === "summary")).toBe(true);
		const entries = await harness.sessionManager.readEntries();
		expect(entries.filter((entry) => entry.type === "compaction" && entry.summary)).toHaveLength(1);
		expect(entries.some((entry) => entry.type === "message" && getMessageText(entry.message) === toolText)).toBe(
			true,
		);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
		expect(harness.eventsOfType("agent_end")).toHaveLength(0);
		expect(execute).toHaveBeenCalledOnce();
		expect(continueAgent).not.toHaveBeenCalled();
		expect(harness.session.getSessionActionRecoverySnapshot().actions).toHaveLength(0);
	});

	it("keeps the original public-pressure refusal when the tool continuation has no removable prefix", async () => {
		const { harness, prompt, execute, failures, sends, transitions } = await createPublicPressureFixture(false);
		const continueAgent = vi.spyOn(harness.session.agent, "continue");
		const completion = harness.session.promptAndWait(prompt);
		await expect(completion).rejects.toBeInstanceOf(PublicContextBudgetError);
		await harness.session.waitForIdle();

		expect(failures).toHaveLength(1);
		const pressure = failures[0];
		if (!(pressure instanceof PublicContextBudgetError)) throw pressure;
		await expect(completion).rejects.toBe(pressure);
		expect(pressure.message).toContain("Request token budget over-budget");
		expect(pressure.originalAssessment.status).toBe("unknown");
		expect(pressure.assessment).toMatchObject({
			status: "over-budget",
			outputReserveTokens: 128_000,
			contextTokens: 272_000,
		});
		expect(transitions).toEqual(["main_send", "public_pressure"]);
		expect(sends).toHaveLength(1);
		expect(sends[0].request.purpose).toBe("main");
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end")[0]).toMatchObject({ result: undefined });
		expect(harness.eventsOfType("compaction_end")[0].errorMessage).toContain("too short");
		const entries = await harness.sessionManager.readEntries();
		expect(entries.filter((entry) => entry.type === "compaction" && entry.summary)).toHaveLength(0);
		expect(
			entries.filter(
				(entry) =>
					entry.type === "message" && entry.message.role === "user" && getMessageText(entry.message) === prompt,
			),
		).toHaveLength(1);
		expect(entries.filter((entry) => entry.type === "message" && entry.message.role === "assistant")).toHaveLength(1);
		expect(entries.filter((entry) => entry.type === "message" && entry.message.role === "toolResult")).toHaveLength(
			1,
		);
		expect(execute).toHaveBeenCalledOnce();
		expect(continueAgent).not.toHaveBeenCalled();
		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
		expect(harness.eventsOfType("agent_end")).toHaveLength(0);
		expect(harness.eventsOfType("tool_execution_end")).toHaveLength(1);
		expect(harness.session.getSessionActionRecoverySnapshot().actions).toHaveLength(0);
	});

	it("resumes the interrupted tool loop when a threshold compaction is skipped", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as SessionInternals;
		const context = midToolLoopContext(harness);

		// The direct stop adapter retains the interrupted tool boundary for the checkpoint.
		const shouldStop = await internals._shouldStopAfterTurn(context);
		expect(shouldStop).toBe(true);
		expect(internals._pendingCheckpoint?.boundary).toEqual({ kind: "tool", state: "pending" });

		const continueSpy = vi.spyOn(harness.session.agent, "continue").mockResolvedValue();

		// The in-memory session has no persisted entries, so _performCompaction throws CompactionSkippedError.
		await internals._runAutoCompaction("threshold", false);
		await vi.advanceTimersByTimeAsync(500);

		const endEvents = harness.eventsOfType("compaction_end");
		expect(endEvents).toHaveLength(1);
		expect(endEvents[0].errorMessage).toContain("skipped");

		expect(continueSpy).toHaveBeenCalledTimes(1);
	});

	it("control: a skipped requested compaction mid tool loop does resume", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as SessionInternals;
		midToolLoopContext(harness);
		internals._pendingCheckpoint = internals._captureCheckpointResume(internals._captureCompactionOwner(), {
			kind: "tool",
			state: "pending",
		});

		const continueSpy = vi.spyOn(harness.session.agent, "continue").mockResolvedValue();

		await internals._runAutoCompaction("requested", false);
		await vi.advanceTimersByTimeAsync(500);

		expect(continueSpy).toHaveBeenCalledTimes(1);
	});

	it("e2e: tool loop interrupted by a skipped threshold compaction resumes", async () => {
		const bigTool = {
			name: "big",
			label: "big",
			description: "returns big text",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text" as const, text: "x".repeat(40_000) }],
				details: {},
			}),
		};
		const harness = await createHarness({
			tools: [bigTool],
			// Huge keepRecentTokens: prepareCompaction finds nothing to summarize and throws CompactionSkippedError.
			settings: { compaction: { enabled: true, reserveTokens: 500, keepRecentTokens: 1_000_000 } },
			models: [{ id: "faux-1", contextWindow: 6_000 }],
			persistSession: true,
		});
		harnesses.push(harness);
		const outcomes: AgentTurnOutcome["kind"][] = [];
		const getTurnOutcome = harness.session.agent.getTurnOutcome!;
		harness.session.agent.getTurnOutcome = async (context, signal) => {
			const outcome = await getTurnOutcome(context, signal);
			outcomes.push(outcome.kind);
			return outcome;
		};
		const legacyStop = vi.spyOn(harness.session.agent, "shouldStopAfterTurn");
		const continueAgent = vi.spyOn(harness.session.agent, "continue");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("big", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("final answer after the tool call"),
		]);

		await harness.session.prompt("run the tool then summarize");
		await new Promise((resolve) => setTimeout(resolve, 300));
		await harness.session.waitForIdle();
		await new Promise((resolve) => setTimeout(resolve, 300));

		expect(harness.eventsOfType("compaction_start").map((event) => event.reason)).toContain("threshold");
		expect(harness.eventsOfType("compaction_end")[0]?.errorMessage).toContain("skipped");
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(outcomes[0]).toBe("checkpoint_then_continue");
		expect(legacyStop).not.toHaveBeenCalled();
		expect(continueAgent).toHaveBeenCalledTimes(1);
		expect(
			(await harness.sessionManager.readEntries()).filter((entry) => entry.type === "compaction" && entry.summary),
		).toEqual([]);
	});

	it("headless idle includes a successful post-compaction continuation", async () => {
		const bigTool = {
			name: "big",
			label: "big",
			description: "returns big text",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text" as const, text: "x".repeat(40_000) }],
				details: {},
			}),
		};
		const harness = await createHarness({
			tools: [bigTool],
			// Retain the 10k-token tool result plus its call; the earlier completed turn is summarized.
			settings: { compaction: { enabled: true, reserveTokens: 500, keepRecentTokens: 10_001 } },
			models: [{ id: "faux-1", contextWindow: 12_000 }],
			persistSession: true,
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
		// A prior completed turn gives the first threshold checkpoint a whole group to summarize.
		const earlierUser = {
			role: "user" as const,
			content: "Earlier context to retain.\n".repeat(600),
			timestamp: Date.now() - 2_000,
		};
		const earlierAssistant = createAssistant(harness, { stopReason: "stop", timestamp: Date.now() - 1_000 });
		earlierAssistant.content = [{ type: "text", text: "The earlier work is complete." }];
		await harness.sessionManager.appendMessage(earlierUser);
		await harness.sessionManager.appendMessage(earlierAssistant);
		harness.session.agent.state.messages.push(earlierUser, earlierAssistant);
		const transitions: string[] = [];
		const getTurnOutcome = harness.session.agent.getTurnOutcome!;
		harness.session.agent.getTurnOutcome = async (context, signal) => {
			const outcome = await getTurnOutcome(context, signal);
			if (outcome.kind === "checkpoint_then_continue") {
				expect(context.hasMoreToolCalls).toBe(true);
				transitions.push("checkpoint_then_continue");
			}
			return outcome;
		};
		const legacyStop = vi.spyOn(harness.session.agent, "shouldStopAfterTurn");
		const bindCompactionSink = harness.sessionManager.bindCompactionSink.bind(harness.sessionManager);
		vi.spyOn(harness.sessionManager, "bindCompactionSink").mockImplementation((...args) => {
			const sink = bindCompactionSink(...args);
			const appendEpoch = sink[appendContextEpoch].bind(sink);
			vi.spyOn(sink, appendContextEpoch).mockImplementation(async (...values) => {
				const id = await appendEpoch(...values);
				if (values[0].includeSummary) transitions.push("checkpoint_ack");
				return id;
			});
			const append = sink.appendCompaction.bind(sink);
			vi.spyOn(sink, "appendCompaction").mockImplementation(async (...values) => {
				const id = await append(...values);
				transitions.push("checkpoint_ack");
				return id;
			});
			return sink;
		});
		let initialRun = true;
		harness.session.agent.subscribe((event) => {
			if (event.type !== "agent_start") return;
			if (initialRun) initialRun = false;
			else transitions.push("resume");
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("big", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("final answer after successful compaction"),
		]);

		await harness.session.prompt("run the tool then summarize");
		await harness.session.waitForHeadlessIdle();

		expect(harness.eventsOfType("compaction_end").find((event) => event.result)?.result).toBeDefined();
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.getLastAssistantText()).toBe("final answer after successful compaction");
		expect(transitions).toEqual(["checkpoint_then_continue", "checkpoint_ack", "resume"]);
		expect(legacyStop).not.toHaveBeenCalled();
		expect(
			(await harness.sessionManager.readEntries()).filter(
				(entry) => entry.type === "compaction" && entry.summary === "auto compacted",
			),
		).toHaveLength(1);
	});

	it("rejects headless idle waiters when a continuation cannot start", async () => {
		vi.useFakeTimers();
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionInternals;
		midToolLoopContext(harness);
		const directive = sessionInternals._captureCheckpointResume(sessionInternals._captureCompactionOwner(), {
			kind: "tool",
			state: "pending",
		});
		vi.spyOn(harness.session.agent, "continue").mockRejectedValueOnce(new Error("continuation failed"));

		sessionInternals._schedulePostCompactionContinue(directive);
		const idle = harness.session.waitForHeadlessIdle();
		const rejectedIdle = expect(idle).rejects.toThrow("continuation failed");
		await vi.advanceTimersByTimeAsync(100);

		await rejectedIdle;
	});

	it("does not expose a failed continuation to later headless idle waiters", async () => {
		vi.useFakeTimers();
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionInternals;
		midToolLoopContext(harness);
		const directive = sessionInternals._captureCheckpointResume(sessionInternals._captureCompactionOwner(), {
			kind: "tool",
			state: "pending",
		});
		vi.spyOn(harness.session.agent, "continue").mockRejectedValueOnce(new Error("continuation failed"));

		sessionInternals._schedulePostCompactionContinue(directive);
		await vi.advanceTimersByTimeAsync(100);

		await expect(harness.session.waitForHeadlessIdle()).resolves.toBeUndefined();
	});

	// BUG B (end-to-end): unlike the tests above, the threshold compaction here SUCCEEDS.
	it("e2e: an active goal keeps continuing after a successful threshold compaction", async () => {
		const sessionRef: { current?: AgentSession } = {};
		const harness = await createHarness({
			tools: [createFauxIpythonTool(sessionRef)],
			// Let a running goal continuation cross the threshold while remaining well below overflow.
			settings: { compaction: { enabled: true, reserveTokens: 8_000, keepRecentTokens: 1 } },
			models: [{ id: "faux-1", contextWindow: 10_000 }],
			persistSession: true,
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
		sessionRef.current = harness.session;
		const largeStep = "x".repeat(3_500);
		harness.setResponses([
			fauxAssistantMessage(`step one done, more to do ${largeStep}`),
			fauxAssistantMessage(`step two done, still more to do ${largeStep}`),
			fauxAssistantMessage(`step three done, still not finished ${largeStep}`),
			fauxAssistantMessage(fauxToolCall("ipython", { code: "goal.complete" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Goal complete."),
		]);

		await harness.session.prompt("/goal finish the task");
		await vi.waitFor(
			() => {
				const compactionReasons = harness.eventsOfType("compaction_start").map((event) => event.reason);
				expect(compactionReasons).toContain("threshold");
				expect(compactionReasons).not.toContain("overflow");
				expect(harness.eventsOfType("compaction_end").find((event) => event.result)?.result).toBeDefined();
				expect(harness.getPendingResponseCount()).toBe(0);
				expect(harness.session.goalState.status).toBe("complete");
			},
			{ timeout: 5_000 },
		);
	});

	// With both drivers active the goal continuation takes exclusive priority, matching _getContinuationMessages.
	it("queues only the goal continuation when a goal and autonomous mode are both active", async () => {
		const sessionRef: { current?: AgentSession } = {};
		const harness = await createHarness({
			tools: [createFauxIpythonTool(sessionRef)],
			autonomous: { enabled: true, maxContinuations: 5 },
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(harness);
		sessionRef.current = harness.session;
		await harness.session.handleGoalHostRequest("goal.create", { objective: "finish the task" });
		const internals = harness.session as unknown as SessionInternals;
		const context = midToolLoopContext(harness);

		const shouldStop = await internals._shouldStopAfterTurn(context);
		expect(shouldStop).toBe(true);
		expect(internals._pendingCheckpoint?.boundary).toEqual({ kind: "tool", state: "pending" });
		expect(internals._pendingCheckpoint?.actions).toHaveLength(1);

		expect(harness.session.queuedActionCount).toBe(1);
		expect(harness.session.goalState.continuationsUsed).toBe(1);
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(0);
	});

	// A user-cancelled compaction must withdraw the goal continuation queued for it.
	it("withdraws the queued goal continuation when the threshold compaction is cancelled", async () => {
		const sessionRef: { current?: AgentSession } = {};
		const harness = await createHarness({
			tools: [createFauxIpythonTool(sessionRef)],
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(harness);
		sessionRef.current = harness.session;
		await harness.session.handleGoalHostRequest("goal.create", { objective: "finish the task" });
		const internals = harness.session as unknown as SessionInternals;
		const context = midToolLoopContext(harness);

		const shouldStop = await internals._shouldStopAfterTurn(context);
		expect(shouldStop).toBe(true);
		expect(harness.session.queuedActionCount).toBe(1);
		expect(harness.session.goalState.continuationsUsed).toBe(1);

		vi.spyOn(internals, "_performCompaction").mockRejectedValue(new Error("Compaction cancelled"));
		await internals._runAutoCompaction("threshold", false);

		const endEvents = harness.eventsOfType("compaction_end");
		expect(endEvents).toHaveLength(1);
		expect(endEvents[0].aborted).toBe(true);
		expect(harness.session.queuedActionCount).toBe(0);
		expect(harness.session.goalState.continuationsUsed).toBe(0);

		// The cancellation must not consume the continuation: the next natural threshold stop re-queues it.
		const shouldStopAgain = await internals._shouldStopAfterTurn(context);
		expect(shouldStopAgain).toBe(true);
		expect(harness.session.queuedActionCount).toBe(1);
		expect(harness.session.goalState.continuationsUsed).toBe(1);
	});

	// A stale marker (continuation already consumed, goal completed) must not be rolled back.
	it("keeps completed-goal bookkeeping when a later threshold compaction is cancelled", async () => {
		const sessionRef: { current?: AgentSession } = {};
		const harness = await createHarness({
			tools: [createFauxIpythonTool(sessionRef)],
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(harness);
		sessionRef.current = harness.session;
		await harness.session.handleGoalHostRequest("goal.create", { objective: "finish the task" });
		const internals = harness.session as unknown as SessionInternals;
		const context = midToolLoopContext(harness);

		await internals._shouldStopAfterTurn(context);
		expect(harness.session.goalState.continuationsUsed).toBe(1);

		// Completing the goal clears the queued continuation but leaves the marker stale.
		await harness.session.handleGoalHostRequest("goal.complete");
		expect(harness.session.queuedActionCount).toBe(0);

		const shouldStop = await internals._shouldStopAfterTurn(context);
		expect(shouldStop).toBe(true);
		vi.spyOn(internals, "_performCompaction").mockRejectedValue(new Error("Compaction cancelled"));
		await internals._runAutoCompaction("threshold", false);

		expect(harness.session.goalState.status).toBe("complete");
		expect(harness.session.goalState.continuationsUsed).toBe(1);
	});
});
