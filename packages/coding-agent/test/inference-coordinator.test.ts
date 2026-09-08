import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentEvent, type StreamFn } from "@ponythewhite/base-context-agent";
import * as ai from "@ponythewhite/base-context-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as realBedrock from "../../ai/src/providers/amazon-bedrock.js";
import {
	bindAuxiliaryInferenceStream,
	createNativeInferenceStream,
	InferenceCoordinator,
} from "../src/core/inference-coordinator.js";
import type {
	BoundRequestSink,
	NativeRequestEvent,
	RequestPurpose,
	SourceSnapshotRef,
} from "../src/core/request-events.js";
import { MODEL_REQUEST_ID_HEADER } from "../src/core/semantic-edges.js";
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

function createBudgetAgent(manager: SessionManager, contextTokens: number, releaseError?: Error) {
	const facts: NativeRequestEvent[] = [];
	const requests = new InferenceCoordinator(
		() => {
			const sink = manager.bindRequestSink();
			return {
				source: sink.source,
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
		{
			mode: "enforce",
			profiles: [
				{
					id: "offline-native-responses",
					revision: "1",
					api: model.api,
					provider: model.provider,
					url: `${model.baseUrl}/responses`,
					model: model.id,
					authMode: "api-key",
					templateRevision: "offline-responses-1",
					replayFamily: "responses",
					contextTokens,
					outputCeilingTokens: 20,
					estimate: { tokensPerUtf8Byte: 1, templateTokens: 0, marginTokens: 0 },
				},
			],
		},
	);
	const agent = new Agent({ initialState: { model }, getApiKey: () => "not-receipt-key" });
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
		get events() {
			return events!;
		},
	};
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

describe("native inference coordination", () => {
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
	});
});
