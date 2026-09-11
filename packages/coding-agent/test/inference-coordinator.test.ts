import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentEvent, type AgentMessage, type StreamFn } from "@ponythewhite/base-context-agent";
import * as ai from "@ponythewhite/base-context-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as realBedrock from "../../ai/src/providers/amazon-bedrock.js";
import { ProviderAttemptTracker } from "../../ai/src/utils/provider-attempts.js";
import { CanonicalContextCompiler, getCanonicalViewUnits } from "../src/core/canonical-context.js";
import { type CompactionPreparation, compact } from "../src/core/compaction/compaction.js";
import { createFileOps } from "../src/core/compaction/utils.js";
import {
	bindAuxiliaryInferenceStream,
	captureNativeCompactionRequests,
	captureNativeReviewerRequests,
	createNativeInferenceStream,
	InferenceCoordinator,
} from "../src/core/inference-coordinator.js";
import { convertToLlm } from "../src/core/messages.js";
import { renderPublicHistory } from "../src/core/public-context.js";
import type {
	BoundRequestSink,
	NativeRequestEvent,
	RequestPurpose,
	SourceSnapshotRef,
} from "../src/core/request-events.js";
import type {
	RequestViewCandidate,
	RequestViewCommit,
	RequestViewValidate,
} from "../src/core/request-view-selection.js";
import { MODEL_REQUEST_ID_HEADER } from "../src/core/semantic-edges.js";
import { bindNativeEntryWriter } from "../src/core/session-entry-origin.js";
import { readSessionJournal } from "../src/core/session-journal-reader.js";
import { type SessionEntry, type SessionHeader, SessionManager } from "../src/core/session-manager.js";

const model: ai.Model<"openai-responses"> = {
	api: "openai-responses",
	provider: "openai",
	id: "test",
	name: "Test",
	baseUrl: "https://example.invalid",
	input: ["text"],
	reasoning: false,
	contextWindow: 100,
	maxTokens: 20,
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
};
const context: ai.Context = { messages: [{ role: "user", content: "not-receipt-payload", timestamp: 1 }] };
const output = (): ai.AssistantMessage => ({
	role: "assistant",
	api: model.api,
	provider: model.provider,
	model: model.id,
	content: [{ type: "text", text: "OK" }],
	stopReason: "stop",
	timestamp: 1,
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
});
const source = (sessionId: string): SourceSnapshotRef => ({
	sessionId,
	leafId: "leaf",
	sourceSequence: 1,
	persistent: false,
});

function fakeTransport(sent: () => void | Promise<void>, gate?: Promise<void>): typeof ai.streamSimple {
	return (_model, _context, options) => {
		const events = ai.createAssistantMessageEventStream();
		void (async () => {
			const descriptor: ai.ProviderAttemptInfo = {
				api: model.api,
				provider: model.provider,
				model: model.id,
				transport: "http",
				ordinal: 1,
				kind: "initial",
			};
			const attemptId = await options!.attempts!.admit(descriptor);
			await sent();
			await gate;
			await options!.attempts!.settle({
				...descriptor,
				attemptId,
				outcome: "completed",
				rawUsage: [],
				usage: {},
				usageCompleteness: "none",
				timing: { queuedAt: 1, admittedAt: 2, sentAt: 3, settledAt: 4 },
			});
			const message = output();
			events.push({ type: "done", reason: "stop", message });
			events.end(message);
		})().catch((error) => {
			const message = { ...output(), stopReason: "error" as const, errorMessage: String(error) };
			events.push({ type: "error", reason: "error", error: message });
			events.end(message);
		});
		return events;
	};
}

const replayTools = [
	{
		name: "fixture_lookup",
		label: "Fixture lookup",
		description: "Local replay fixture",
		parameters: ai.Type.Object({ value: ai.Type.String() }),
		execute: async () => ({ content: [{ type: "text" as const, text: "tool result retained" }], details: {} }),
	},
];

const { compat: _responsesCompat, ...sharedFixtureModel } = model;
const codexModel: ai.Model<"openai-codex-responses"> = {
	...sharedFixtureModel,
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
};

function codexFixtureKey(): string {
	const payload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: "native-fixture-account" },
		}),
	).toString("base64");
	return `fixture.${payload}.fixture`;
}

async function appendReplayToolHistory(
	manager: SessionManager,
	requestModel: ai.Model<"openai-responses" | "openai-codex-responses"> = model,
) {
	const callId = await manager.appendMessage({
		...output(),
		api: requestModel.api,
		provider: requestModel.provider,
		model: requestModel.id,
		stopReason: "toolUse",
		content: [
			{ type: "toolCall", id: "call_history|fc_history", name: "fixture_lookup", arguments: { value: "kept" } },
		],
	});
	const resultId = await manager.appendMessage({
		role: "toolResult",
		toolCallId: "call_history|fc_history",
		toolName: "fixture_lookup",
		content: [{ type: "text", text: "tool result retained" }],
		isError: false,
		timestamp: 3,
	});
	return { callId, resultId };
}

// The same local WebSocket interface used by the existing Codex cached-stream fixture.
function installNativeCodexSocket(reply: (body: Record<string, unknown>) => unknown[]) {
	const previous = globalThis.WebSocket;
	const sent: Record<string, unknown>[] = [];
	class FixtureWebSocket {
		static OPEN = 1;
		readyState = FixtureWebSocket.OPEN;
		private listeners = new Map<string, Set<(event: unknown) => void>>();
		constructor(_url: string, _protocols?: string | string[] | { headers?: Record<string, string> }) {
			queueMicrotask(() => this.dispatch("open", {}));
		}
		addEventListener(type: string, listener: (event: unknown) => void) {
			const listeners = this.listeners.get(type) ?? new Set();
			listeners.add(listener);
			this.listeners.set(type, listeners);
		}
		removeEventListener(type: string, listener: (event: unknown) => void) {
			this.listeners.get(type)?.delete(listener);
		}
		send(data: string) {
			const body = JSON.parse(data) as Record<string, unknown>;
			sent.push(body);
			const events = reply(body);
			queueMicrotask(() => {
				for (const event of events) this.dispatch("message", { data: JSON.stringify(event) });
			});
		}
		close() {
			this.readyState = 3;
		}
		private dispatch(type: string, event: unknown) {
			for (const listener of this.listeners.get(type) ?? []) listener(event);
		}
	}
	globalThis.WebSocket = FixtureWebSocket as unknown as typeof WebSocket;
	return {
		sent,
		restore: () => {
			globalThis.WebSocket = previous;
		},
	};
}

function createBudgetAgent(
	manager: SessionManager,
	contextTokens: number | undefined,
	releaseError?: Error,
	commitView?: RequestViewCommit,
	validateView?: RequestViewValidate,
	native?: {
		model: ai.Model<"openai-responses" | "openai-codex-responses">;
		apiKey: string;
		tools?: typeof replayTools;
	},
) {
	const requestModel = native?.model ?? model;
	const facts: NativeRequestEvent[] = [];
	const requests = new InferenceCoordinator(
		() => {
			const sink = manager.bindRequestSink();
			return {
				source: sink.source,
				readHistory: (read) => sink.readHistory(read),
				retain: () => sink.retain(),
				async release() {
					await sink.release();
					if (releaseError) throw releaseError;
				},
				async persist(event) {
					await sink.persist(event);
					facts.push(event);
				},
			};
		},
		undefined,
		contextTokens === undefined
			? undefined
			: {
					mode: "enforce",
					profiles: [
						{
							id: "offline-native-responses",
							revision: "1",
							api: requestModel.api,
							provider: requestModel.provider,
							url:
								requestModel.api === "openai-codex-responses"
									? `${requestModel.baseUrl}/codex/responses`
									: `${requestModel.baseUrl}/responses`,
							model: requestModel.id,
							authMode: requestModel.api === "openai-codex-responses" ? "fixture-subscription" : "api-key",
							templateRevision: "offline-responses-1",
							replayFamily: "responses",
							contextTokens,
							outputCeilingTokens: 20,
							estimate: { tokensPerUtf8Byte: 1, templateTokens: 0, marginTokens: 0 },
						},
					],
				},
	);
	const agent = new Agent({
		initialState: { model: requestModel, ...(native?.tools ? { tools: native.tools } : {}) },
		getApiKey: () => native?.apiKey ?? "not-receipt-key",
		convertToLlm: commitView ? convertToLlm : undefined,
	});
	let viewMessages: AgentMessage[] | undefined;
	if (commitView) {
		const compiler = new CanonicalContextCompiler();
		agent.bindContextOwner(async () => {
			const capture = requests.capture();
			try {
				viewMessages = await capture.readHistory((view) =>
					compiler.compile(view, { maxMessages: 32, maxSourceBytes: 128 * 1024 }),
				);
				capture.bindRequestViewBoundary(viewMessages, commitView, validateView);
				return {
					messages: viewMessages,
					adoptMessages: true,
					streamContext: capture,
					release: () => capture.dispose(),
				};
			} catch (error) {
				try {
					await capture.dispose();
				} catch (cleanupError) {
					throw new AggregateError([error, cleanupError], "Fixture context and source release failed");
				}
				throw error;
			}
		});
	}
	let events: Awaited<ReturnType<StreamFn>> | undefined;
	agent.bindStreamOwner((streamFn) => {
		const owned = requests.bindStream(streamFn, { purpose: "main" });
		return async (...args) => {
			events = await owned(...args);
			return events;
		};
	});
	const lifecycle: AgentEvent[] = [];
	const inputAcks: string[] = [];
	agent.subscribe(async (event) => {
		lifecycle.push(event);
		if (event.type === "message_end" && (event.message.role === "user" || event.message.role === "assistant")) {
			const id = await manager.appendMessage(event.message);
			if (event.message.role === "user") inputAcks.push(id);
		}
	});
	return {
		agent,
		requests,
		facts,
		lifecycle,
		inputAcks,
		get viewMessages() {
			return viewMessages!;
		},
		get events() {
			return events!;
		},
	};
}

async function appendSelectionHistory(
	manager: SessionManager,
	requestModel: ai.Model<"openai-responses" | "openai-codex-responses"> = model,
) {
	const assistant = { ...output(), api: requestModel.api, provider: requestModel.provider, model: requestModel.id };
	await manager.appendMessage({ role: "user", content: "old question", timestamp: 1 });
	const olderText = "older answer for selection ".repeat(1024);
	const olderId = await manager.appendMessage({
		...assistant,
		content: [{ type: "text", text: olderText, textSignature: "msg_history_old" }],
	});
	await manager.appendMessage({ role: "user", content: "recent question", timestamp: 2 });
	const latestId = await manager.appendMessage({
		...assistant,
		content: [{ type: "text", text: "keep recent answer", textSignature: "msg_history_recent" }],
	});
	const tool = await appendReplayToolHistory(manager, requestModel);
	return { olderText, olderId, latestId, ...tool };
}

const fixtureDirs: string[] = [];
const managers: SessionManager[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	try {
		await Promise.all(managers.splice(0).map((manager) => manager.close()));
	} finally {
		for (const dir of fixtureDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	}
});

function auxiliaryResponse(): Response {
	const item = {
		type: "message",
		id: "msg_auxiliary",
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text: "OK", annotations: [] }],
	};
	const events = [
		{ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
		{ type: "response.output_item.done", output_index: 0, item },
		{
			type: "response.completed",
			response: {
				id: "resp_auxiliary",
				model: model.id,
				status: "completed",
				usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11, input_tokens_details: { cached_tokens: 0 } },
			},
		},
	];
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

async function auxiliaryFixture() {
	const dir = mkdtempSync(join(tmpdir(), "base-context-auxiliary-caps-"));
	fixtureDirs.push(dir);
	const manager = await SessionManager.create(dir, dir);
	managers.push(manager);
	await manager.appendMessage(context.messages[0]!);
	return { manager, requests: new InferenceCoordinator(() => manager.bindRequestSink()) };
}

describe("native inference coordination", () => {
	it("shares native auxiliary attempt caps across captures and resets on a new invocation", async () => {
		const { manager, requests } = await auxiliaryFixture();
		const captures: InferenceCoordinator[] = [];
		const offlineFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => auxiliaryResponse());
		const options = { apiKey: "offline-auxiliary-key", maxRetries: 0 };
		try {
			const summaries = requests[captureNativeCompactionRequests]();
			captures.push(summaries);
			const preparation: CompactionPreparation = {
				firstKeptEntryId: manager.getLeafId()!,
				messagesToSummarize: [context.messages[0]!],
				turnPrefixMessages: [context.messages[0]!],
				isSplitTurn: true,
				tokensBefore: 20,
				fileOps: createFileOps(),
				settings: { enabled: true, reserveTokens: 16, keepRecentTokens: 10 },
			};
			const summarize = (capture: InferenceCoordinator) =>
				compact(preparation, model, options.apiKey, undefined, undefined, undefined, undefined, undefined, capture);
			// Each real compact() fans out to history and turn-prefix native Responses calls.
			await summarize(summaries);
			await summarize(summaries);
			expect(offlineFetch).toHaveBeenCalledTimes(4);
			const nested = summaries.capture();
			const nestedNative = nested[captureNativeReviewerRequests]();
			captures.push(nested, nestedNative);
			for (const capture of [summaries, nested, nestedNative]) {
				await expect(capture.complete(model, context, options, { purpose: "other" })).rejects.toThrow(
					"Native auxiliary operation attempt limit exhausted",
				);
			}
			expect(offlineFetch).toHaveBeenCalledTimes(4);
			const fresh = requests[captureNativeCompactionRequests]();
			captures.push(fresh);
			await summarize(fresh);
			expect(offlineFetch).toHaveBeenCalledTimes(6);

			// Labels cannot mint a quota; ordinary root captures and MAIN/child remain uncapped.
			const generic = requests.capture();
			captures.push(generic);
			for (const purpose of ["summary", "summary", "summary", "summary", "summary", "main", "child"] as const) {
				await expect(
					generic.complete(model, context, options, { purpose, purposeDetail: "compaction" }),
				).resolves.toMatchObject({
					stopReason: "stop",
				});
			}
			expect(offlineFetch).toHaveBeenCalledTimes(13);
		} finally {
			await Promise.all(captures.map((capture) => capture.dispose()));
			await requests.dispose();
		}
	});

	it("charges admitted SDK retries before refusing transport and permits a fresh auxiliary invocation", async () => {
		const { manager, requests } = await auxiliaryFixture();
		const captures: InferenceCoordinator[] = [];
		let failing = true;
		const offlineFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
			failing
				? new Response(JSON.stringify({ error: { message: "offline retry failure", type: "server_error" } }), {
						status: 503,
						headers: { "content-type": "application/json", "retry-after-ms": "1" },
					})
				: auxiliaryResponse(),
		);
		const request = { purpose: "refine", purposeDetail: "auto-refine-review" } as const;
		const options = { apiKey: "offline-auxiliary-key", maxRetries: 2 };
		try {
			const review = requests[captureNativeReviewerRequests]();
			captures.push(review);
			// The real OpenAI SDK retries below its stream API. Its third send must never reach fetch.
			await expect(review.complete(model, context, options, request)).rejects.toThrow(
				"Native auxiliary operation attempt limit exhausted",
			);
			expect(offlineFetch).toHaveBeenCalledTimes(2);
			failing = false;
			// A new logical completion on that same capture cannot refund either failed admission.
			await expect(review.complete(model, context, { ...options, maxRetries: 0 }, request)).rejects.toThrow(
				"Native auxiliary operation attempt limit exhausted",
			);
			expect(offlineFetch).toHaveBeenCalledTimes(2);
			const facts: NativeRequestEvent[] = [];
			for await (const record of readSessionJournal(manager.getSessionFile()!)) {
				const entry = record.entry as SessionEntry | SessionHeader;
				if (entry.type === "request") facts.push(entry.request);
			}
			expect(
				facts.filter((event) => event.type === "attempt_admitted").map((event) => event.descriptor.kind),
			).toEqual(["initial", "retry"]);
			expect(
				facts.filter((event) => event.type === "attempt_settled").map((event) => event.receipt.outcome),
			).toEqual(["failed", "failed"]);
			const fresh = requests[captureNativeReviewerRequests]();
			captures.push(fresh);
			await expect(fresh.complete(model, context, { ...options, maxRetries: 0 }, request)).resolves.toMatchObject({
				stopReason: "stop",
			});
			expect(offlineFetch).toHaveBeenCalledTimes(3);
		} finally {
			await Promise.all(captures.map((capture) => capture.dispose()));
			await requests.dispose();
		}
	});

	it("admits all purposes before transport and stores only physical facts", async () => {
		const facts: NativeRequestEvent[] = [];
		const dir = mkdtempSync(join(tmpdir(), "base-context-inference-"));
		fixtureDirs.push(dir);
		const manager = await SessionManager.create(dir, dir);
		managers.push(manager);
		await manager.appendMessage(context.messages[0]!);
		const realSink = manager.bindRequestSink();
		const initialLeaf = manager.getLeafId();
		const sourceSnapshot = await realSink.source;
		const diskRecords = async () => {
			const records: Array<SessionEntry | SessionHeader> = [];
			for await (const record of readSessionJournal(sourceSnapshot.sessionFile!)) {
				records.push(record.entry as SessionEntry | SessionHeader);
			}
			return records;
		};
		const sink: BoundRequestSink = {
			source: realSink.source,
			retain: () => realSink.retain(),
			release: () => realSink.release(),
			async persist(event) {
				await Promise.resolve();
				await realSink.persist(event);
				facts.push(event);
			},
		};
		const requests = new InferenceCoordinator(() => sink);
		let sends = 0;
		const nativeStreamSimple = ai.streamSimple;
		vi.spyOn(ai, "streamSimple").mockImplementation(
			fakeTransport(async () => {
				expect(facts.at(-1)?.type).toBe("attempt_admitted");
				expect((await diskRecords()).at(-1)).toMatchObject({ request: { type: "attempt_admitted" } });
				sends++;
			}),
		);
		const purposes: RequestPurpose[] = ["main", "summary", "refine", "learning", "child", "native-control", "other"];
		for (const purpose of purposes) {
			await requests.complete(
				model,
				context,
				{ apiKey: "not-receipt-key", headers: { authorization: "not-receipt-header" } },
				{ purpose },
			);
		}
		expect(sends).toBe(purposes.length);
		expect(facts.filter((fact) => fact.type === "attempt_settled").map((fact) => fact.purpose)).toEqual(purposes);
		expect(new Set(facts.map((fact) => fact.attemptId)).size).toBe(purposes.length);
		expect(facts[0]).toMatchObject({
			owner: { sessionId: manager.getSessionId() },
			modelContract: { profile: { status: "unvalidated" }, pricing: { status: "unvalidated" } },
		});
		expect(sourceSnapshot.persistent).toBe(true);
		expect(initialLeaf).toBeTypeOf("string");
		expect((await diskRecords()).filter((entry) => entry.type === "request")).toHaveLength(purposes.length * 2);
		await requests.dispose();
		expect(manager.getLeafId()).toBe(initialLeaf);
		expect(JSON.stringify(facts)).not.toContain("not-receipt");

		const selectionHistory = await appendSelectionHistory(manager);
		// Offline transport only; native serialization, admission and source persistence remain real.
		vi.mocked(ai.streamSimple).mockImplementation(nativeStreamSimple);
		const budgeted = createBudgetAgent(manager, 4096);
		const offlineFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			expect(budgeted.inputAcks).toHaveLength(1);
			expect(budgeted.facts).toHaveLength(1);
			expect((await diskRecords()).at(-1)).toMatchObject({
				request: {
					type: "attempt_admitted",
					descriptor: { requestBudget: { status: "within-estimate", limitSource: "explicit-profile" } },
				},
			});
			const item = {
				type: "message",
				id: "msg_offline",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "OK", annotations: [] }],
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
						id: "resp_offline",
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
			]
				.map((event) => `data: ${JSON.stringify(event)}\n\n`)
				.join("");
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		});
		try {
			await budgeted.agent.prompt("offline budget happy input");
			expect(await budgeted.events.result()).toMatchObject({
				stopReason: "stop",
				content: [{ type: "text", text: "OK" }],
			});
			expect(offlineFetch).toHaveBeenCalledTimes(1);
			expect(budgeted.facts.map((fact) => fact.type)).toEqual(["attempt_admitted", "attempt_settled"]);
			expect(budgeted.facts[0]).toMatchObject({ source: { leafId: budgeted.inputAcks[0], persistent: true } });
			expect(budgeted.facts[1]).toMatchObject({
				receipt: { outcome: "completed", usage: { inputTotal: 10, output: 1 } },
			});
			const records = await diskRecords();
			expect(records.find((entry) => entry.id === budgeted.inputAcks[0])).toMatchObject({
				type: "message",
				message: { role: "user", content: [{ text: "offline budget happy input" }] },
			});
			expect(records.at(-1)).toMatchObject({ type: "message", message: { role: "assistant", stopReason: "stop" } });
			expect(
				budgeted.lifecycle
					.filter(
						(event) =>
							(event.type === "message_start" || event.type === "message_end") &&
							event.message.role === "assistant",
					)
					.map((event) => event.type),
			).toEqual(["message_start", "message_end"]);
		} finally {
			await budgeted.requests.dispose();
		}

		// Actual native payload selection with an offline acceptance hook; Root owns the canonical epoch ACK.
		const selectionManager = manager;
		const history = selectionHistory;
		const signedReply = await budgeted.events.result();
		expect(signedReply.content[0]).toMatchObject({ textSignature: JSON.stringify({ v: 1, id: "msg_offline" }) });
		const signedReplyId = selectionManager.getLeafId()!;
		await selectionManager[bindNativeEntryWriter]().captureGoalOperation({
			version: 1,
			kind: "goal_operation",
			operation: "create",
			actor: "interactive",
			actionId: "view-selection-fixture",
			submittedText: "/goal Keep required task continuity",
		})({
			goalId: "ViewSelection/Goal",
			objective: "Keep required task continuity",
			active: true,
			status: "active",
			tokensUsed: 0,
			timeUsedSeconds: 0,
			continuationsUsed: 0,
		});
		let accept!: () => void;
		const accepted = new Promise<void>((resolve) => {
			accept = resolve;
		});
		let announce!: (candidate: RequestViewCandidate) => void;
		const offered = new Promise<RequestViewCandidate>((resolve) => {
			announce = resolve;
		});
		const commitView = vi.fn(async (candidate: RequestViewCandidate) => {
			announce(candidate);
			await accepted;
		});
		const selecting = createBudgetAgent(selectionManager, 8192, undefined, commitView, undefined, {
			model,
			apiKey: "not-receipt-key",
			tools: replayTools,
		});
		const payloadHook = vi.fn((payload: unknown) => ({
			...(payload as Record<string, unknown>),
			metadata: { view_fixture: "single-pass" },
		}));
		selecting.agent.onPayload = payloadHook;
		const sendsBeforeSelection = offlineFetch.mock.calls.length;
		let sentBody: string | undefined;
		offlineFetch.mockImplementation(async (_input, init) => {
			sentBody = String(init?.body);
			expect(selecting.facts.at(-1)).toMatchObject({
				type: "attempt_admitted",
				descriptor: { requestBudget: { status: "within-estimate", limitSource: "explicit-profile" } },
			});
			const item = {
				type: "message",
				id: "msg_selection",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "selected OK", annotations: [] }],
			};
			return new Response(
				[
					{ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
					{ type: "response.output_item.done", output_index: 0, item },
					{ type: "response.completed", response: { id: "resp_selection", model: model.id, status: "completed" } },
				]
					.map((event) => `data: ${JSON.stringify(event)}\n\n`)
					.join(""),
				{
					status: 200,
					headers: { "content-type": "text/event-stream" },
				},
			);
		});
		try {
			const running = selecting.agent.prompt("new current input");
			const candidate = await Promise.race([
				offered,
				running.then(() => {
					throw new Error("Expected a request view candidate");
				}),
			]);
			expect(offlineFetch).toHaveBeenCalledTimes(sendsBeforeSelection);
			expect(selecting.facts).toEqual([]);
			expect(selecting.inputAcks).toHaveLength(1);
			expect(candidate.source).toMatchObject({
				sessionId: selectionManager.getSessionId(),
				leafId: selecting.inputAcks[0],
				persistent: true,
			});
			expect(candidate.originalAssessment.status).toBe("over-budget");
			expect(candidate.assessment.status).toBe("within-estimate");
			expect(candidate.assessment.profile).toEqual(candidate.originalAssessment.profile);
			const fullUnits = getCanonicalViewUnits(selecting.viewMessages)!;
			expect(candidate.selectedUnitIds).not.toContain(
				fullUnits.find((unit) => unit.exactSources.includes(history.olderId))!.id,
			);
			expect(candidate.selectedUnitIds).toContain(
				fullUnits.find((unit) => unit.exactSources.includes(history.latestId))!.id,
			);
			expect(candidate.selectedUnitIds).toContain(
				fullUnits.find((unit) => unit.exactSources.includes(signedReplyId))!.id,
			);
			expect(candidate.projection.replayContract).toBe("message-groups");
			// This hook added a non-native field: selection still works, but fresh-window permission is absent.
			expect(candidate.projection.publicWindow).toBeUndefined();
			expect(candidate.projection.encodePublicWindow).toBeUndefined();
			for (const entryId of [history.callId, history.resultId]) {
				expect(candidate.selectedUnitIds).toContain(
					fullUnits.find((unit) => unit.exactSources.includes(entryId))!.id,
				);
			}
			for (const unit of fullUnits.filter((unit) => unit.kind === "task-frame"))
				expect(candidate.selectedUnitIds).toContain(unit.id);
			expect(candidate.selectedUnitIds.every((id) => fullUnits.some((unit) => unit.id === id))).toBe(true);
			accept();
			await running;
			expect(commitView).toHaveBeenCalledTimes(1);
			expect(payloadHook).toHaveBeenCalledTimes(1);
			expect(offlineFetch).toHaveBeenCalledTimes(sendsBeforeSelection + 1);
			expect(sentBody).toBe(candidate.request.body);
			expect(sentBody).not.toContain(history.olderText);
			expect(sentBody).toContain("old question");
			expect(sentBody).toContain("new current input");
			expect(sentBody).toContain("keep recent answer");
			expect(sentBody).toContain("Keep required task continuity");
			expect(JSON.parse(sentBody!).metadata).toEqual({ view_fixture: "single-pass" });
			expect(JSON.parse(sentBody!).tools[0].name).toBe("fixture_lookup");
			expect(JSON.parse(sentBody!).input).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ type: "function_call", id: "fc_history", call_id: "call_history" }),
					expect.objectContaining({
						type: "function_call_output",
						call_id: "call_history",
						output: "tool result retained",
					}),
				]),
			);
			expect(JSON.parse(sentBody!).input).toContainEqual(
				expect.objectContaining({
					type: "message",
					role: "assistant",
					id: "msg_offline",
					status: "completed",
				}),
			);
			expect(selecting.facts.map((fact) => fact.type)).toEqual(["attempt_admitted", "attempt_settled"]);
			expect(selecting.facts[0]).toMatchObject({
				type: "attempt_admitted",
				descriptor: { requestBudget: candidate.assessment },
			});
			expect(await selecting.events.result()).toMatchObject({ content: [{ type: "text", text: "selected OK" }] });
		} finally {
			accept();
			await selecting.requests.dispose();
		}

		// Official Codex WS: actual full-view offers, a real parsed opaque reply, then exact ACK-backed delta reuse.
		const publicCodexModel = { ...codexModel, baseUrl: "https://chatgpt.com/backend-api" };
		const codexDir = mkdtempSync(join(tmpdir(), "base-context-native-codex-view-"));
		fixtureDirs.push(codexDir);
		const codexManager = await SessionManager.create(codexDir, codexDir);
		managers.push(codexManager);
		await appendReplayToolHistory(codexManager, codexModel);
		const codexOffers: RequestViewCandidate[] = [];
		const codex = createBudgetAgent(
			codexManager,
			8192,
			undefined,
			async (candidate) => {
				codexOffers.push(candidate);
				expect(candidate.selectedUnitIds).toEqual(
					getCanonicalViewUnits(codex.viewMessages)!.map((unit) => unit.id),
				);
			},
			undefined,
			{ model: publicCodexModel, apiKey: codexFixtureKey(), tools: replayTools },
		);
		const codexSession = codexManager.getSessionId();
		codex.agent.streamFn = createNativeInferenceStream(async (_model, _context, options) => ({
			...options,
			transport: "websocket-cached",
			sessionId: codexSession,
		}));
		const codexPayload = vi.fn();
		codex.agent.onPayload = codexPayload;
		let codexReplies = 0;
		let offlinePublic: ai.ProviderRequestPublicWindow | undefined;
		let publicMeasurements: readonly [ai.ProviderRequestRepresentation][] = [];
		const socket = installNativeCodexSocket((actualBody) => {
			expect(codex.facts.at(-1)).toMatchObject({ type: "attempt_admitted" });
			const turn = ++codexReplies;
			if (offlinePublic) {
				expect(turn).toBe(4);
				expect(codexOffers).toHaveLength(3);
				expect(actualBody).toEqual({ type: "response.create", ...JSON.parse(offlinePublic.request.body!) });
				expect(actualBody.previous_response_id).toBeUndefined();
				expect(codex.facts.at(-1)).toMatchObject({
					descriptor: { kind: "initial", requestBudget: { retainedInputTokens: 0 } },
				});
				expect(publicMeasurements.length).toBeGreaterThanOrEqual(2);
				for (const [measured] of publicMeasurements) expect(measured.retainedPrefix).toBeUndefined();
			} else expect(codexOffers).toHaveLength(turn);
			const text = {
				type: "message",
				id: `msg_codex_${turn}`,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: `Codex reply ${turn}`, annotations: [] }],
			};
			const reasoning = {
				type: "reasoning",
				id: "rs_codex_1",
				encrypted_content: "fixture-opaque-reasoning",
				summary: [],
			};
			return [
				...(turn === 1
					? [
							{ type: "response.output_item.added", item: reasoning },
							{ type: "response.output_item.done", item: reasoning },
						]
					: []),
				{ type: "response.output_item.added", item: { ...text, content: [] } },
				{ type: "response.output_item.done", item: text },
				{
					type: "response.completed",
					response: {
						id: `resp_codex_${turn}`,
						model: codexModel.id,
						status: "completed",
						usage: {
							input_tokens: 5,
							output_tokens: 3,
							total_tokens: 8,
							input_tokens_details: { cached_tokens: 2 },
							output_tokens_details: { reasoning_tokens: 1 },
						},
					},
				},
			];
		});
		try {
			await codex.agent.prompt("Codex first input");
			const firstCodexReply = await codex.events.result();
			expect(firstCodexReply.content[0]).toMatchObject({ type: "thinking" });
			expect(firstCodexReply.content[1]).toMatchObject({
				textSignature: JSON.stringify({ v: 1, id: "msg_codex_1" }),
			});
			await codex.agent.prompt("Codex next input");
			expect(codexPayload).toHaveBeenCalledTimes(2);
			expect(socket.sent).toHaveLength(2);
			expect(offlineFetch).toHaveBeenCalledTimes(sendsBeforeSelection + 1);
			expect(codexOffers[0].request.api).toBe("openai-codex-responses");
			expect(codexOffers[1].projection.replayContract).toBe("message-groups");
			expect(codexOffers[0].projection.publicWindow).toBe(true);
			expect(codexOffers[1].projection.publicWindow).toBe(true);
			expect(codexOffers[1].request.retainedPrefix).toMatchObject({ inputTokens: 5, outputTokens: 3 });
			expect(codexOffers[1].assessment.retainedInputTokens).toBe(8);
			const logical = JSON.parse(codexOffers[1].request.body!);
			expect(logical.previous_response_id).toBeUndefined();
			expect(logical.input).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ type: "function_call", call_id: "call_history" }),
					expect.objectContaining({ type: "function_call_output", call_id: "call_history" }),
					expect.objectContaining({ type: "reasoning", encrypted_content: "fixture-opaque-reasoning" }),
					expect.objectContaining({ type: "message", id: "msg_codex_1" }),
				]),
			);
			expect(socket.sent[1]).toMatchObject({
				type: "response.create",
				previous_response_id: "resp_codex_1",
				input: [{ role: "user", content: [{ type: "input_text", text: "Codex next input" }] }],
			});
			expect(codex.facts.map((fact) => fact.type)).toEqual([
				"attempt_admitted",
				"attempt_settled",
				"attempt_admitted",
				"attempt_settled",
			]);
			expect(codex.facts[2]).toMatchObject({ descriptor: { requestBudget: codexOffers[1].assessment } });
			expect(codex.facts[3]).toMatchObject({
				receipt: {
					transport: "websocket",
					kind: "transport-continuation",
					usageCompleteness: "complete",
					usage: { inputTotal: 5, output: 3 },
				},
			});

			// This public canonical fixture tests transport reset, not Root's summary renderer or epoch permission check.
			const publicReply = firstCodexReply.content.find((block) => block.type === "text");
			const tokensBefore = codexOffers[1].originalAssessment.estimatedInputTokens;
			if (!publicReply || publicReply.type !== "text" || tokensBefore === null) {
				throw new Error("Expected actual public reply and measured full context");
			}
			const publicTail = await codexManager.appendMessage({
				role: "user",
				content: `Public retained reply: ${publicReply.text}`,
				timestamp: Date.now(),
			});
			await codexManager.appendCompaction(
				"Public completed tool history: tool result retained",
				publicTail,
				tokensBefore,
			);
			await codex.agent.prompt("Fresh public window input");
			expect(codexPayload).toHaveBeenCalledTimes(3);
			expect(codexOffers).toHaveLength(3);
			expect(codexOffers[2].projection.publicWindow).toBe(true);
			expect(codexOffers[2].request.retainedPrefix).toBeUndefined();
			expect(codexOffers[2].assessment.retainedInputTokens).toBe(0);
			const fresh = JSON.parse(codexOffers[2].request.body!);
			expect(socket.sent).toHaveLength(3);
			expect(socket.sent[2]).toEqual({ type: "response.create", ...fresh });
			expect(fresh.previous_response_id).toBeUndefined();
			expect(fresh.conversation).toBeUndefined();
			expect(fresh.input.length).toBeGreaterThan(1);
			expect(codexOffers[2].request.body).toContain("Public retained reply: Codex reply 1");
			expect(codexOffers[2].request.body).toContain("Fresh public window input");
			expect(codexOffers[2].request.body).not.toContain("fixture-opaque-reasoning");
			expect(codexOffers[2].request.body).not.toContain("rs_codex_1");
			expect(codex.facts[4]).toMatchObject({ type: "attempt_admitted", descriptor: { kind: "initial" } });
			expect(codex.facts[5]).toMatchObject({ type: "attempt_settled", receipt: { kind: "initial" } });
			expect(offlineFetch).toHaveBeenCalledTimes(sendsBeforeSelection + 1);

			// AI-only callback acceptance, not a canonical epoch ACK. Real measure/admit/settle remain installed.
			let releaseOfflineAcceptance!: () => void;
			const acceptanceGate = new Promise<void>((resolve) => {
				releaseOfflineAcceptance = resolve;
			});
			let announceOfflineAcceptance!: () => void;
			const acceptanceReady = new Promise<void>((resolve) => {
				announceOfflineAcceptance = resolve;
			});
			const offlineAcceptance = vi.fn(async () => {
				announceOfflineAcceptance();
				await acceptanceGate;
			});
			let restorePublicMeter: (() => void) | undefined;
			codex.agent.streamFn = createNativeInferenceStream(async (_model, _context, options) => {
				const observer = options?.attempts;
				if (!observer?.prepareRequest || !observer.measureRequest)
					throw new Error("Expected actual native observer");
				const meter = vi.spyOn(observer, "measureRequest");
				publicMeasurements = meter.mock.calls;
				restorePublicMeter = () => meter.mockRestore();
				observer.prepareRequest = async (request, projection) => {
					expect(request.retainedPrefix).toMatchObject({ inputTokens: 5, outputTokens: 3 });
					expect(projection.publicWindow).toBe(true);
					const messages = codex.viewMessages!;
					const units = getCanonicalViewUnits(messages)!;
					const replacements = projection.publicMessageGroups!.flatMap((group) =>
						group.map((messageIndex) => {
							const rendered = renderPublicHistory(
								messages[messageIndex],
								units[messageIndex].exactSources[0],
								128 * 1024,
							);
							if (rendered.role !== "custom" || typeof rendered.content !== "string") {
								throw new Error("Expected actual public source data");
							}
							return { messageIndex, text: rendered.content };
						}),
					);
					const encoded = projection.encodePublicWindow?.(replacements);
					if (!encoded) throw new Error("Expected actual public request encoding");
					offlinePublic = encoded;
					expect(encoded.projection.publicWindow).toBe(true);
					expect(encoded.projection.encodePublicWindow).toBeUndefined();
					expect(encoded.request.retainedPrefix).toBeUndefined();
					const assessment = observer.measureRequest!(encoded.request);
					expect(assessment).toMatchObject({ status: "within-estimate", retainedInputTokens: 0 });
					const before = JSON.parse(request.body!);
					const after = JSON.parse(encoded.request.body!);
					expect({ ...after, input: undefined }).toEqual({ ...before, input: undefined });
					for (const [itemIndex, messageIndex] of projection.messageIndices.entries()) {
						if (messageIndex !== null && replacements.some((entry) => entry.messageIndex === messageIndex))
							continue;
						expect(after.input).toContainEqual(before.input[itemIndex]);
					}
					for (const replacement of replacements) {
						const itemIndex = encoded.projection.messageIndices.indexOf(replacement.messageIndex);
						expect(after.input[itemIndex]).toEqual({
							role: "user",
							content: [{ type: "input_text", text: replacement.text }],
						});
					}
					await offlineAcceptance();
					return encoded.request.body;
				};
				return { ...options, transport: "websocket-cached", sessionId: codexSession };
			});
			const publicRun = codex.agent.prompt("Actual public encoding through the native tracker");
			try {
				await Promise.race([acceptanceReady, publicRun]);
				expect(offlineAcceptance).toHaveBeenCalledTimes(1);
				expect(socket.sent).toHaveLength(3);
				expect(codex.facts).toHaveLength(6);
				releaseOfflineAcceptance();
				await publicRun;
				expect(socket.sent).toHaveLength(4);
				expect(codexPayload).toHaveBeenCalledTimes(4);
				expect(codex.facts).toHaveLength(8);
				expect(codex.facts[7]).toMatchObject({
					receipt: { kind: "initial", requestBudget: { retainedInputTokens: 0 } },
				});
				expect(offlineFetch).toHaveBeenCalledTimes(sendsBeforeSelection + 1);
			} finally {
				releaseOfflineAcceptance();
				await publicRun.catch(() => undefined);
				restorePublicMeter?.();
			}
		} finally {
			await codex.requests.dispose();
			ai.cleanupSessionResources(codexSession);
			socket.restore();
		}

		// Official Codex SSE also omits only the proven older literal, preserving the complete tool exchange.
		const codexSubsetDir = mkdtempSync(join(tmpdir(), "base-context-native-codex-subset-"));
		fixtureDirs.push(codexSubsetDir);
		const codexSubsetManager = await SessionManager.create(codexSubsetDir, codexSubsetDir);
		managers.push(codexSubsetManager);
		const codexHistory = await appendSelectionHistory(codexSubsetManager, codexModel);
		const codexCandidates: RequestViewCandidate[] = [];
		const codexSubset = createBudgetAgent(
			codexSubsetManager,
			8192,
			undefined,
			async (candidate) => {
				codexCandidates.push(candidate);
			},
			undefined,
			{ model: publicCodexModel, apiKey: codexFixtureKey(), tools: replayTools },
		);
		codexSubset.agent.streamFn = createNativeInferenceStream(async (_model, _context, options) => ({
			...options,
			transport: "sse",
		}));
		const codexSubsetPayload = vi.fn();
		codexSubset.agent.onPayload = codexSubsetPayload;
		offlineFetch.mockImplementation(async (_input, init) => {
			expect(String(init?.body)).toBe(codexCandidates[0].request.body);
			expect(codexSubset.facts.at(-1)).toMatchObject({ type: "attempt_admitted" });
			const item = {
				type: "message",
				id: "msg_codex_subset",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "Codex selected", annotations: [] }],
			};
			return new Response(
				[
					{ type: "response.output_item.added", item: { ...item, content: [] } },
					{ type: "response.output_item.done", item },
					{
						type: "response.completed",
						response: { id: "resp_codex_subset", model: codexModel.id, status: "completed" },
					},
				]
					.map((event) => `data: ${JSON.stringify(event)}\n\n`)
					.join(""),
				{
					status: 200,
					headers: { "content-type": "text/event-stream" },
				},
			);
		});
		try {
			await codexSubset.agent.prompt("Codex subset current input");
			expect(codexSubsetPayload).toHaveBeenCalledTimes(1);
			expect(codexCandidates[0].originalAssessment.status).toBe("over-budget");
			expect(codexCandidates[0].assessment.status).toBe("within-estimate");
			expect(codexCandidates[0].projection.publicWindow).toBe(true);
			const codexUnits = getCanonicalViewUnits(codexSubset.viewMessages)!;
			expect(codexCandidates[0].selectedUnitIds).not.toContain(
				codexUnits.find((unit) => unit.exactSources.includes(codexHistory.olderId))!.id,
			);
			for (const entryId of [codexHistory.callId, codexHistory.resultId]) {
				expect(codexCandidates[0].selectedUnitIds).toContain(
					codexUnits.find((unit) => unit.exactSources.includes(entryId))!.id,
				);
			}
			expect(codexSubset.facts.map((fact) => fact.type)).toEqual(["attempt_admitted", "attempt_settled"]);
			expect(await codexSubset.events.result()).toMatchObject({
				content: [{ type: "text", text: "Codex selected" }],
			});
		} finally {
			await codexSubset.requests.dispose();
		}
	});

	it("keeps late settlement and semantic retries on their captured source and rebinds children", async () => {
		const facts: NativeRequestEvent[] = [];
		let current = source("parent");
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let notifySent!: () => void;
		const sent = new Promise<void>((resolve) => {
			notifySent = resolve;
		});
		const requests = new InferenceCoordinator(() => {
			const captured = current;
			return {
				source: Promise.resolve(captured),
				retain: () => {},
				release: async () => {},
				async persist(event) {
					expect(event.source).toEqual(captured);
					facts.push(event);
				},
			};
		});
		vi.spyOn(ai, "streamSimple").mockImplementation(fakeTransport(notifySent, gate));
		const main = requests.bindStream(ai.streamSimple, { purpose: "main" });
		const options = { headers: { [MODEL_REQUEST_ID_HEADER]: "same-operation" } };
		const first = await main(model, context, options);
		await sent;
		current = source("selected-later");
		release();
		await first.result();
		await (await main(model, context, options)).result();
		expect(
			facts.slice(0, 4).every((fact) => fact.source.sessionId === "parent" && fact.operationId === "same-operation"),
		).toBe(true);
		expect(facts[0].attemptId).not.toBe(facts[2].attemptId);
		const child = new InferenceCoordinator(
			() => ({
				source: Promise.resolve(source("child")),
				retain: () => {},
				release: async () => {},
				async persist(event) {
					facts.push(event);
				},
			}),
			() => ({ parentSessionId: "parent" }),
		);
		await (
			await child.bindStream(main, { purpose: "child", parentOperationId: "same-operation" })(model, context)
		).result();
		expect(facts.at(-1)).toMatchObject({
			purpose: "child",
			owner: { sessionId: "child", parentSessionId: "parent" },
			parentOperationId: "same-operation",
		});
		const side = bindAuxiliaryInferenceStream(main as StreamFn, {
			purpose: "other",
			purposeDetail: "side-question",
			operationId: "side",
		});
		current = source("selected-again");
		await (await side(model, context)).result();
		await side.dispose();
		expect(facts.at(-1)).toMatchObject({
			purposeDetail: "side-question",
			source: { sessionId: "selected-later" },
			operationId: "side",
		});
		// Native operation identity survives failure of the optional semantic recorder.
		const noSemantic = requests.bindStream(ai.streamSimple, { purpose: "main" });
		await (await noSemantic(model, context)).result();
		const original = facts.at(-1)!;
		requests.prepareTurnRetry();
		await (await noSemantic(model, context)).result();
		expect(facts.at(-1)?.operationId).toBe(original.operationId);
		expect(facts.at(-1)?.attemptId).not.toBe(original.attemptId);

		const firstCompiled = requests.capture();
		const compiledSource = current;
		current = source("after-compiler-capture");
		try {
			await (await main(model, context, options, firstCompiled)).result();
			expect(facts.at(-1)).toMatchObject({ source: compiledSource, operationId: "same-operation" });
			expect(vi.mocked(ai.streamSimple).mock.calls.at(-1)).toHaveLength(3);
			expect(vi.mocked(ai.streamSimple).mock.calls.at(-1)?.[2]).not.toHaveProperty("streamContext");
		} finally {
			await firstCompiled.dispose();
		}
		const nextCompiled = requests.capture();
		const nextCompiledSource = current;
		current = source("after-next-capture");
		try {
			await (await main(model, context, options, nextCompiled)).result();
			expect(facts.at(-1)).toMatchObject({ source: nextCompiledSource, operationId: "same-operation" });
		} finally {
			await nextCompiled.dispose();
		}
		const foreign = child.capture();
		const countBeforeForeign = facts.length;
		try {
			await expect(main(model, context, options, foreign)).rejects.toThrow("not a capture of this inference owner");
			expect(facts).toHaveLength(countBeforeForeign);
		} finally {
			await foreign.dispose();
		}
		// A source frontier, a late source change, or child/auxiliary purpose alone is not an epoch association.
		expect(facts.every((event) => event.contextEpoch === undefined)).toBe(true);
	});
	it("keeps a rejected aggregate's captured sibling owned through receipt persistence", async () => {
		const facts: NativeRequestEvent[] = [];
		let releaseProvider!: () => void;
		const providerGate = new Promise<void>((resolve) => {
			releaseProvider = resolve;
		});
		let releaseWrite!: () => void;
		const writeGate = new Promise<void>((resolve) => {
			releaseWrite = resolve;
		});
		let notifyWrite!: () => void;
		const writing = new Promise<void>((resolve) => {
			notifyWrite = resolve;
		});
		const releaseSink = vi.fn(async () => {});
		const requests = new InferenceCoordinator(() => ({
			source: Promise.resolve(source("subject")),
			retain: () => {},
			release: releaseSink,
			async persist(event) {
				if (event.type === "attempt_settled" && event.purposeDetail === "late-sibling") {
					notifyWrite();
					await writeGate;
				}
				facts.push(event);
			},
		}));
		let sends = 0;
		vi.spyOn(ai, "streamSimple").mockImplementation((...args) =>
			fakeTransport(() => {}, ++sends === 2 ? providerGate : undefined)(...args),
		);
		const group = requests.capture();
		expect(requests.pendingCount).toBe(1); // Unused capture owns the pre-auth wait.
		const firstCapture = group.capture();
		const first = firstCapture.complete(model, context, undefined, { purpose: "summary" }).then(() => {
			throw new Error("aggregate rejected");
		});
		const captured = group.capture();
		const sibling = captured.complete(model, context, undefined, {
			purpose: "summary",
			purposeDetail: "late-sibling",
		});
		try {
			await expect(Promise.all([first, sibling])).rejects.toThrow("aggregate rejected");
			await firstCapture.dispose();
			await group.dispose();
			expect(requests.pendingCount).toBe(1);
			let idle = false;
			const drained = requests.waitForIdle().then(() => {
				idle = true;
			});
			releaseProvider();
			await writing;
			expect(idle).toBe(false);
			expect(requests.hasPending).toBe(true);
			expect(releaseSink).not.toHaveBeenCalled();
			requests.stopAdmission();
			expect(vi.mocked(ai.streamSimple).mock.calls[1]?.[2]?.signal?.aborted).toBe(true);
			await expect(captured.complete(model, context, undefined, { purpose: "summary" })).rejects.toThrow(
				"Inference owner is closing",
			);
			expect(sends).toBe(2);
			releaseWrite();
			await sibling;
			await drained;
			expect(requests.hasPending).toBe(false);
			expect(facts.filter((event) => event.type === "attempt_settled")).toHaveLength(2);
			expect(releaseSink).toHaveBeenCalledTimes(1);
		} finally {
			releaseProvider();
			releaseWrite();
			await Promise.allSettled([first, sibling]);
			await Promise.all([firstCapture.dispose(), captured.dispose(), group.dispose(), requests.dispose()]);
		}
	});
	it("gates custom registrations and later stream assignments before any native send", async () => {
		const facts: NativeRequestEvent[] = [];
		const nativeStreamSimple = ai.streamSimple;
		const requests = new InferenceCoordinator(() => ({
			source: Promise.resolve(source("subject")),
			retain: () => {},
			release: async () => {},
			async persist(event) {
				facts.push(event);
			},
		}));
		const opaque = vi.fn(() => {
			const events = ai.createAssistantMessageEventStream();
			const message = output();
			events.push({ type: "done", reason: "stop", message });
			events.end(message);
			return events;
		});
		const generic = new Agent({ streamFn: opaque });
		await (await generic.streamFn(model, context)).result();
		expect(opaque).toHaveBeenCalledTimes(1); // The generic SDK remains extensible.
		const native = new Agent();
		native.bindStreamOwner((streamFn) => requests.bindStream(streamFn, { purpose: "main" }));
		native.streamFn = opaque;
		await expect(native.streamFn(model, context)).rejects.toThrow("custom or proxy StreamFn");
		expect(() => native.bindStreamOwner((streamFn) => streamFn)).toThrow("already bound");
		try {
			ai.registerApiProvider({ api: model.api, stream: opaque, streamSimple: opaque }, "claimed-built-in");
			await expect(requests.complete(model, context, undefined, { purpose: "main" })).rejects.toThrow(
				"instrumented built-in API route",
			);
			const observer: ai.ProviderAttemptObserver = {
				admit: vi.fn(async () => "unused"),
				settle: vi.fn(async () => {}),
			};
			expect(() => ai.streamSimple(model, context, { attempts: observer, requireProviderAttempts: true })).toThrow(
				"instrumented built-in API route",
			);
			expect(observer.admit).not.toHaveBeenCalled();
			expect(opaque).toHaveBeenCalledTimes(1);
			expect(facts).toEqual([]);
		} finally {
			ai.resetApiProviders();
		}
		const registered = ai.getApiProvider(model.api)!;
		const original = registered.streamSimple;
		try {
			registered.streamSimple = opaque;
			expect(() => ai.assertBuiltInAttemptSupport(model.api)).toThrow("instrumented built-in API route");
		} finally {
			registered.streamSimple = original;
		}
		try {
			ai.setBedrockProviderModule({ streamBedrock: opaque, streamSimpleBedrock: opaque });
			expect(() => ai.assertBuiltInAttemptSupport("bedrock-converse-stream")).toThrow(
				"instrumented built-in API route",
			);
		} finally {
			ai.setBedrockProviderModule(realBedrock);
		}
		expect(() => ai.assertBuiltInAttemptSupport("bedrock-converse-stream")).not.toThrow();
		const faux = ai.registerFauxProvider();
		try {
			faux.setResponses([
				(_context, options) => {
					expect(options?.attempts).toBeUndefined();
					return ai.fauxAssistantMessage("local simulation");
				},
			]);
			const local = await requests.start(faux.getModel(), context, undefined, { purpose: "main" });
			expect(await local.settled).toMatchObject({ physicalCoverage: "local-simulation", attemptIds: [] });
			expect(facts).toEqual([]);
			const registration = ai.getApiProvider(faux.api)!;
			const nativeDispatch = createNativeInferenceStream(async (_model, _context, options) => {
				// Accounting stays available until the real post-auth dispatcher chooses its implementation.
				expect(options?.attempts).toBeDefined();
				await Promise.resolve();
				registration.streamSimple = opaque;
				return options ?? {};
			});
			await expect(
				requests.bindStream(nativeDispatch, { purpose: "main" })(faux.getModel(), context),
			).rejects.toThrow("instrumented built-in API route");
			expect(opaque).toHaveBeenCalledTimes(1);
			expect(facts).toEqual([]);
		} finally {
			faux.unregister();
			await requests.dispose();
		}

		// Expected native refusal semantics; requires the outer Agent boundary to preserve budget errors.
		const offlineFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			throw new Error("Local budget refusal reached offline transport");
		});
		const cleanupError = new Error("offline source release failed");
		for (const releaseError of [undefined, cleanupError]) {
			const dir = mkdtempSync(join(tmpdir(), "base-context-budget-refusal-"));
			fixtureDirs.push(dir);
			const manager = await SessionManager.create(dir, dir);
			managers.push(manager);
			const budgeted = createBudgetAgent(manager, 1, releaseError);
			try {
				const promptFailure = await budgeted.agent.prompt("offline budget refused input").then(
					() => undefined,
					(error: unknown) => error,
				);
				const resultFailure = await budgeted.events.result().then(
					() => undefined,
					(error: unknown) => error,
				);
				const refusal = resultFailure instanceof AggregateError ? resultFailure.errors[0] : resultFailure;
				expect(refusal).toBeInstanceOf(ai.RequestTokenBudgetError);
				expect(refusal).toMatchObject({ assessment: { status: "over-budget", limitSource: "explicit-profile" } });
				if (releaseError) {
					expect(resultFailure).toBeInstanceOf(AggregateError);
					if (resultFailure instanceof AggregateError) {
						expect(resultFailure.errors).toHaveLength(2);
						expect(resultFailure.errors[0]).toBe(refusal);
						expect(resultFailure.errors[1]).toBe(releaseError);
					}
				} else {
					expect(resultFailure).toBe(refusal);
				}
				expect(promptFailure).toBe(resultFailure);
				expect(
					budgeted.lifecycle.filter(
						(event) =>
							(event.type === "message_start" || event.type === "message_end") &&
							event.message.role === "assistant",
					),
				).toEqual([]);
				expect(budgeted.agent.state.messages.filter((message) => message.role === "assistant")).toEqual([]);
				expect(budgeted.inputAcks).toHaveLength(1); // Storage ACK, not frontend authenticity.
				expect(manager.getLeafId()).toBe(budgeted.inputAcks[0]);
				const records: Array<SessionEntry | SessionHeader> = [];
				for await (const record of readSessionJournal(manager.getSessionFile()!)) {
					records.push(record.entry as SessionEntry | SessionHeader);
				}
				expect(records.find((entry) => entry.id === budgeted.inputAcks[0])).toMatchObject({
					type: "message",
					message: { role: "user", content: [{ text: "offline budget refused input" }] },
				});
				expect(records.filter((entry) => entry.type === "message" && entry.message.role === "assistant")).toEqual(
					[],
				);
				expect(records.filter((entry) => entry.type === "request")).toEqual([]);
				expect(budgeted.facts).toEqual([]);
				expect(offlineFetch).not.toHaveBeenCalled();
				expect(budgeted.requests.hasPending).toBe(false);
			} finally {
				await budgeted.requests.dispose();
			}
		}

		// An unmetered adapter must not bypass enforced admission. This remains an offline fake transport.
		const unmeteredSend = vi.fn();
		vi.spyOn(ai, "streamSimple").mockImplementation(fakeTransport(unmeteredSend));
		const unmeteredDir = mkdtempSync(join(tmpdir(), "base-context-budget-unmetered-"));
		fixtureDirs.push(unmeteredDir);
		const unmeteredManager = await SessionManager.create(unmeteredDir, unmeteredDir);
		managers.push(unmeteredManager);
		const unmetered = createBudgetAgent(unmeteredManager, 4096);
		try {
			await expect(unmetered.agent.prompt("offline unmetered input")).rejects.toMatchObject({
				name: "RequestTokenBudgetError",
				assessment: { status: "unknown", limitSource: "unknown", reasoningReservation: "unknown" },
			});
			expect(unmeteredSend).not.toHaveBeenCalled();
			expect(unmetered.facts).toEqual([]);
			expect(unmetered.inputAcks).toHaveLength(1);
			expect(
				(await unmeteredManager.readEntries()).filter(
					(entry) => entry.type === "request" || (entry.type === "message" && entry.message.role === "assistant"),
				),
			).toEqual([]);
		} finally {
			await unmetered.requests.dispose();
		}

		// A single onPayload rewrite breaks the proven input mapping; do not replay it to fit a candidate.
		vi.mocked(ai.streamSimple).mockImplementation(nativeStreamSimple);
		const unmappedDir = mkdtempSync(join(tmpdir(), "base-context-view-unmapped-"));
		fixtureDirs.push(unmappedDir);
		const unmappedManager = await SessionManager.create(unmappedDir, unmappedDir);
		managers.push(unmappedManager);
		await appendSelectionHistory(unmappedManager);
		const commitView = vi.fn(async (_candidate: RequestViewCandidate) => {});
		const validateView = vi.fn(
			(request: ai.ProviderRequestRepresentation, assessment: ai.RequestTokenAssessment | undefined) => {
				expect(request.body).toContain("unmapped hook input");
				expect(assessment?.status).toBe("over-budget");
			},
		);
		const unmapped = createBudgetAgent(unmappedManager, 8192, undefined, commitView, validateView);
		const payloadHook = vi.fn((payload: unknown) => ({
			...(payload as Record<string, unknown>),
			input: [{ role: "user", content: [{ type: "input_text", text: "unmapped hook input ".repeat(2048) }] }],
		}));
		unmapped.agent.onPayload = payloadHook;
		try {
			await expect(unmapped.agent.prompt("retain accepted current input")).rejects.toMatchObject({
				name: "RequestTokenBudgetError",
				assessment: { status: "over-budget", limitSource: "explicit-profile" },
			});
			await expect(unmapped.events.result()).rejects.toBeInstanceOf(ai.RequestTokenBudgetError);
			expect(payloadHook).toHaveBeenCalledTimes(1);
			expect(commitView).not.toHaveBeenCalled();
			expect(validateView).toHaveBeenCalledTimes(1);
			expect(offlineFetch).not.toHaveBeenCalled();
			expect(unmapped.facts).toEqual([]);
			expect(unmapped.inputAcks).toHaveLength(1);
			expect((await unmappedManager.readEntries()).filter((entry) => entry.type === "request")).toEqual([]);
			expect(
				unmapped.lifecycle.filter(
					(event) =>
						(event.type === "message_start" || event.type === "message_end") &&
						event.message.role === "assistant",
				),
			).toEqual([]);
		} finally {
			await unmapped.requests.dispose();
		}

		// A full within-estimate view is offered too. Preserve the actual local rejection, not a model error.
		const rejectedDir = mkdtempSync(join(tmpdir(), "base-context-view-checkpoint-refusal-"));
		fixtureDirs.push(rejectedDir);
		const rejectedManager = await SessionManager.create(rejectedDir, rejectedDir);
		managers.push(rejectedManager);
		const legacyReply = output();
		legacyReply.content = [{ type: "text", text: "legacy reply", textSignature: "msg_legacy" }];
		await rejectedManager.appendMessage(legacyReply);
		const primaryError = new Error("fixture epoch acceptance failed");
		const checkpointCleanupError = new Error("fixture checkpoint cleanup failed");
		const checkpointFailure = new AggregateError([primaryError, checkpointCleanupError], "local checkpoint refusal");
		const rejectView = vi.fn(async (candidate: RequestViewCandidate) => {
			expect(candidate.originalAssessment.status).toBe("within-estimate");
			expect(candidate.assessment).toBe(candidate.originalAssessment);
			expect(candidate.request.body).toContain("msg_legacy");
			expect(candidate.projection.publicWindow).toBe(true);
			expect(candidate.selectedUnitIds).toEqual(
				getCanonicalViewUnits(rejected.viewMessages)!.map((unit) => unit.id),
			);
			throw checkpointFailure;
		});
		const rejected = createBudgetAgent(rejectedManager, 8192, undefined, rejectView, undefined, {
			model: { ...model, baseUrl: "https://api.openai.com/v1" },
			apiKey: "not-receipt-key",
		});
		try {
			expect(ai.isLocalRequestPreparationError(checkpointFailure)).toBe(false);
			await expect(rejected.agent.prompt("attempt full-view checkpoint")).rejects.toBe(checkpointFailure);
			await expect(rejected.events.result()).rejects.toBe(checkpointFailure);
			expect(ai.isLocalRequestPreparationError(checkpointFailure)).toBe(true);
			expect(checkpointFailure.errors[0]).toBe(primaryError);
			expect(checkpointFailure.errors[1]).toBe(checkpointCleanupError);
			expect(rejectView).toHaveBeenCalledTimes(1);
			expect(rejected.facts).toEqual([]);
			expect(rejected.inputAcks).toHaveLength(1);
			expect(offlineFetch).not.toHaveBeenCalled();
			expect(rejected.agent.state.messages.filter((message) => message.role === "assistant")).toEqual([legacyReply]);
			expect(
				rejected.lifecycle.filter(
					(event) =>
						(event.type === "message_start" || event.type === "message_end") &&
						event.message.role === "assistant",
				),
			).toEqual([]);
		} finally {
			await rejected.requests.dispose();
		}

		// Root's synchronous representation guard is still real when no token budget is configured.
		const guardedDir = mkdtempSync(join(tmpdir(), "base-context-view-guard-only-"));
		fixtureDirs.push(guardedDir);
		const guardedManager = await SessionManager.create(guardedDir, guardedDir);
		managers.push(guardedManager);
		const guardFailure = new Error("fixture representation changed");
		const unusedCommit = vi.fn(async (_candidate: RequestViewCandidate) => {});
		const guard = vi.fn(
			(request: ai.ProviderRequestRepresentation, assessment: ai.RequestTokenAssessment | undefined) => {
				expect(request.body).toContain("guard-only current input");
				expect(assessment).toBeUndefined();
				throw guardFailure;
			},
		);
		const guarded = createBudgetAgent(guardedManager, undefined, undefined, unusedCommit, guard);
		try {
			await expect(guarded.agent.prompt("guard-only current input")).rejects.toBe(guardFailure);
			await expect(guarded.events.result()).rejects.toBe(guardFailure);
			expect(ai.isLocalRequestPreparationError(guardFailure)).toBe(true);
			expect(guard).toHaveBeenCalledTimes(1);
			expect(unusedCommit).not.toHaveBeenCalled();
			expect(guarded.facts).toEqual([]);
			expect(guarded.inputAcks).toHaveLength(1);
			expect(offlineFetch).not.toHaveBeenCalled();
			expect(guarded.agent.state.messages.filter((message) => message.role === "assistant")).toEqual([]);
		} finally {
			await guarded.requests.dispose();
		}

		// A local Codex preparation rejection is not a WS transport failure and cannot retry through SSE.
		const codexEdgeDir = mkdtempSync(join(tmpdir(), "base-context-native-codex-refusal-"));
		fixtureDirs.push(codexEdgeDir);
		const codexEdgeManager = await SessionManager.create(codexEdgeDir, codexEdgeDir);
		managers.push(codexEdgeManager);
		await appendReplayToolHistory(codexEdgeManager, codexModel);
		const codexSentinel = new Error("native Codex checkpoint refused");
		const rejectCodex = vi.fn(async (candidate: RequestViewCandidate) => {
			// This route is official. Permission does not bypass a local checkpoint refusal.
			expect(candidate.projection.replayContract).toBe("message-groups");
			expect(candidate.projection.publicWindow).toBe(true);
			if (candidate.originalAssessment.status === "unknown") {
				expect(candidate.originalAssessment).toMatchObject({ estimatedInputTokens: null, retainedInputTokens: 0 });
				expect(candidate.assessment).toMatchObject({ status: "within-estimate", retainedInputTokens: 0 });
				expect(candidate.projection.encodePublicWindow).toBeUndefined();
				expect(candidate.request.body).toContain("retained final item");
				expect(candidate.request.body).not.toContain("unobserved-opaque");
			} else {
				expect(candidate.originalAssessment.status).toBe("within-estimate");
				expect(candidate.projection.encodePublicWindow).toBeTypeOf("function");
				const group = candidate.projection.publicMessageGroups!.find((indices) => indices.length > 1)!;
				expect(group).toHaveLength(2);
				expect(
					candidate.projection.encodePublicWindow!([{ messageIndex: group[0], text: "partial group" }]),
				).toBeUndefined();
			}
			throw codexSentinel;
		});
		const codexEdge = createBudgetAgent(codexEdgeManager, 8192, undefined, rejectCodex, undefined, {
			model: codexModel,
			apiKey: codexFixtureKey(),
			tools: replayTools,
		});
		const codexEdgeSession = codexEdgeManager.getSessionId();
		codexEdge.agent.streamFn = createNativeInferenceStream(async (_model, _context, options) => ({
			...options,
			transport: "websocket-cached",
			sessionId: codexEdgeSession,
		}));
		const codexEdgePayload = vi.fn();
		codexEdge.agent.onPayload = codexEdgePayload;
		const refusedSocket = installNativeCodexSocket(() => {
			throw new Error("Refused Codex request reached send");
		});
		try {
			await expect(codexEdge.agent.prompt("Codex rejected full view")).rejects.toBe(codexSentinel);
			await expect(codexEdge.events.result()).rejects.toBe(codexSentinel);
			expect(ai.isLocalRequestPreparationError(codexSentinel)).toBe(true);
			expect(rejectCodex).toHaveBeenCalledTimes(1);
			expect(codexEdge.facts).toEqual([]);
			expect(refusedSocket.sent).toEqual([]);
			expect(offlineFetch).not.toHaveBeenCalled();

			// No owned prefix exists. The opaque estimate stays unknown; the actual public candidate reaches acceptance.
			await codexEdgeManager.appendMessage({
				...output(),
				api: codexModel.api,
				provider: codexModel.provider,
				model: codexModel.id,
				content: [
					{
						type: "thinking",
						thinking: "",
						thinkingSignature: JSON.stringify({
							type: "reasoning",
							id: "rs_uncached",
							encrypted_content: "unobserved-opaque",
							summary: [],
						}),
					},
					{ type: "text", text: "retained final item", textSignature: "msg_uncached" },
				],
			});
			const opaqueRefusal = await codexEdge.agent.prompt("Codex opaque current input").then(
				() => {
					throw new Error("Expected the actual public-candidate acceptance refusal");
				},
				(error: unknown) => error,
			);
			expect(opaqueRefusal).toBe(codexSentinel);
			await expect(codexEdge.events.result()).rejects.toBe(opaqueRefusal);
			expect(rejectCodex).toHaveBeenCalledTimes(2);
			expect(rejectCodex.mock.calls[1][0].originalAssessment.status).toBe("unknown");
			expect(codexEdgePayload).toHaveBeenCalledTimes(2);
			expect(codexEdge.inputAcks).toHaveLength(2);
			expect(codexEdge.facts).toEqual([]);
			expect(refusedSocket.sent).toEqual([]);
			expect(offlineFetch).not.toHaveBeenCalled();
			expect(codexEdge.agent.state.messages.filter((message) => message.role === "assistant")).toEqual(
				codexEdge.viewMessages.filter((message) => message.role === "assistant"),
			);
			expect(
				codexEdge.lifecycle.filter(
					(event) =>
						(event.type === "message_start" || event.type === "message_end") &&
						event.message.role === "assistant",
				),
			).toEqual([]);

			// Observe the real adapter projection: explicit external state never grants a fresh public window.
			const preparation = vi.spyOn(ProviderAttemptTracker.prototype, "prepareRequest");
			codexEdgePayload.mockImplementationOnce((payload: unknown) => ({
				...(payload as Record<string, unknown>),
				previous_response_id: "resp_external",
				conversation: "conversation_external",
			}));
			try {
				await expect(codexEdge.agent.prompt("Explicit state is not a public window")).rejects.toMatchObject({
					name: "RequestTokenBudgetError",
					assessment: { status: "unknown" },
				});
				await expect(codexEdge.events.result()).rejects.toBeInstanceOf(ai.RequestTokenBudgetError);
				expect(preparation).toHaveBeenCalledTimes(1);
				const [stateRequest, stateProjection] = preparation.mock.calls[0];
				expect(stateProjection?.replayContract).toBe("message-groups");
				expect(stateProjection?.publicWindow).toBeUndefined();
				expect(stateProjection?.encodePublicWindow).toBeUndefined();
				expect(JSON.parse(stateRequest.body!)).toMatchObject({
					previous_response_id: "resp_external",
					conversation: "conversation_external",
				});
				expect(codexEdge.facts).toEqual([]);
				expect(refusedSocket.sent).toEqual([]);
				expect(offlineFetch).not.toHaveBeenCalled();
			} finally {
				preparation.mockRestore();
			}
		} finally {
			await codexEdge.requests.dispose();
			ai.cleanupSessionResources(codexEdgeSession);
			refusedSocket.restore();
		}
	});
});
