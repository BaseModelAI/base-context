import type { AgentMessage } from "@ponythewhite/base-context-agent";
import { getModel } from "@ponythewhite/base-context-ai";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent, AgentSessionEventListener, PromptOptions } from "../src/core/agent-session.js";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import { emptyGoalState } from "../src/core/goals.js";
import { DEFAULT_FORK_MESSAGE_LIMITS, readUserMessagesForForking } from "../src/core/session-fork-messages.js";
import { SessionManager } from "../src/core/session-manager.js";
import { DEFAULT_SESSION_TREE_LIMITS, readSessionTree } from "../src/core/session-tree.js";
import { InProcessAgentConnection } from "../src/modes/agent-connection/in-process-agent-connection.js";
import type { AgentConnectionEvent, AgentConnectionState } from "../src/modes/agent-connection/types.js";

type RuntimeSession = AgentSessionRuntime["session"];
type RuntimeRebindCallback = Parameters<AgentSessionRuntime["setRebindSession"]>[0];
type RuntimeBeforeInvalidateCallback = Parameters<AgentSessionRuntime["setBeforeSessionInvalidate"]>[0];

interface FakeSessionControl {
	session: RuntimeSession;
	listenerCount(): number;
	unsubscribeCount(): number;
	emit(event: AgentSessionEvent): void;
}

class FakeRuntime {
	private _session: RuntimeSession;
	rebindSession: RuntimeRebindCallback;
	beforeSessionInvalidate: RuntimeBeforeInvalidateCallback;
	disposed = false;

	constructor(session: RuntimeSession) {
		this._session = session;
	}

	get session(): RuntimeSession {
		return this._session;
	}

	setRebindSession(callback?: RuntimeRebindCallback): void {
		this.rebindSession = callback;
	}

	setBeforeSessionInvalidate(callback?: RuntimeBeforeInvalidateCallback): void {
		this.beforeSessionInvalidate = callback;
	}

	invalidateCurrentSession(): void {
		this.beforeSessionInvalidate?.();
	}

	async replaceSession(session: RuntimeSession): Promise<void> {
		this._session = session;
		await this.rebindSession?.(session);
	}

	async dispose(): Promise<void> {
		this.disposed = true;
	}
}

function asRuntime(runtime: FakeRuntime): AgentSessionRuntime {
	return runtime as unknown as AgentSessionRuntime;
}

function userMessage(text: string, timestamp: number): AgentMessage {
	return {
		role: "user",
		content: text,
		timestamp,
	};
}

function createFakeSession(id: string, messages: AgentMessage[]): FakeSessionControl {
	const listeners = new Set<AgentSessionEventListener>();
	let unsubscriptions = 0;
	const thinkingLevel: AgentConnectionState["thinkingLevel"] = "medium";
	const buildSessionContext = async () => ({
		messages,
		thinkingLevel,
		model: null,
	});
	const model = getModel("openai", "gpt-5.1");
	const session = {
		sessionManager: {
			getCwd: () => `/tmp/${id}`,
			getSessionDir: () => "/tmp/prime-agent-sessions",
			getLeafId: () => `${id}-leaf`,
			getEntries: () => [],
			getCompactionCount: () => 0,
			getTree: () => [],
			supportsCapturedHistoryReads: () => false,
			materializeResidentHistory: () => ({
				header: null,
				entries: [],
				retentions: [],
				leafId: `${id}-leaf`,
				sourceBytes: 0,
			}),
			buildSessionContext,
		},
		buildSessionContext,
		model: undefined,
		thinkingLevel,
		getAvailableThinkingLevels: () => ["minimal", "low", "medium", "high", "xhigh"],
		isStreaming: false,
		isCompacting: false,
		retryAttempt: 0,
		steeringMode: "all",
		followUpMode: "one-at-a-time",
		sessionFile: `/tmp/${id}.jsonl`,
		sessionId: id,
		sessionName: `${id} name`,
		autoCompactionEnabled: true,
		messages,
		getSessionActionSnapshot: () => ({ queuedCount: 0, steering: [], followUps: [] }),
		goalState: emptyGoalState(),
		modelRegistry: {
			refreshModelCatalog: async () => ({ models: model ? [model] : [], configuredProviders: ["openai"] }),
		},
		scopedModels: [],
		getActiveToolNames: () => ["ipython"],
		getContextUsage: async () => undefined,
		cancelRlmChildRun: (childId: string) => childId === "child-1",
		getRlmChildSnapshots: () => [],
		getToolDefinition: (toolName: string) => ({
			name: toolName,
			label: toolName,
			description: `${toolName} description`,
			promptSnippet: `${toolName} prompt`,
			promptGuidelines: [`Use ${toolName}`],
			parameters: { type: "object" },
			renderShell: "self",
			execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
			renderCall: () => undefined,
			renderResult: () => undefined,
		}),
		subscribe(listener: AgentSessionEventListener) {
			listeners.add(listener);
			return () => {
				unsubscriptions++;
				listeners.delete(listener);
			};
		},
	} as unknown as RuntimeSession;

	return {
		session,
		listenerCount: () => listeners.size,
		unsubscribeCount: () => unsubscriptions,
		emit(event: AgentSessionEvent) {
			for (const listener of [...listeners]) {
				listener(event);
			}
		},
	};
}

describe("InProcessAgentConnection", () => {
	it.each([
		{ accepted: true, promptResult: "pending", expectedError: undefined },
		{ accepted: false, promptResult: "resolve", expectedError: "Prompt was not accepted by the session." },
		{ accepted: false, promptResult: "reject", expectedError: "real session error" },
	] as const)(
		"settles bare prompts from admission (accepted: $accepted, result: $promptResult)",
		async ({ accepted, promptResult, expectedError }) => {
			const session = createFakeSession("prompt-admission", []);
			let finishTurn = () => {};
			const turn = new Promise<void>((resolve) => {
				finishTurn = resolve;
			});
			const prompt = vi.fn((_message: string, options?: PromptOptions) => {
				options?.preflightResult?.(accepted);
				if (promptResult === "pending") return turn;
				if (promptResult === "reject") return Promise.reject(new Error("real session error"));
				return Promise.resolve();
			});
			Object.assign(session.session, { prompt });
			const connection = new InProcessAgentConnection(asRuntime(new FakeRuntime(session.session)));
			const result = expect(connection.prompt("hello"));

			if (expectedError) await result.rejects.toThrow(expectedError);
			else await result.resolves.toBeUndefined();
			expect(prompt).toHaveBeenCalledWith(
				"hello",
				expect.objectContaining({ preflightResult: expect.any(Function) }),
			);
			finishTurn();
		},
	);
	it("forwards prompt admission cancellation to the session", async () => {
		const session = createFakeSession("prompt-cancellation", []);
		const prompt = vi.fn(
			(_message: string, options?: PromptOptions) =>
				new Promise<void>((_resolve, reject) => {
					options?.signal?.addEventListener("abort", () => reject(new Error("Prompt admission was cancelled.")), {
						once: true,
					});
				}),
		);
		Object.assign(session.session, { prompt });
		const connection = new InProcessAgentConnection(asRuntime(new FakeRuntime(session.session)));
		const controller = new AbortController();

		const admission = connection.prompt("hello", { signal: controller.signal });
		controller.abort();

		await expect(admission).rejects.toThrow("Prompt admission was cancelled.");
		expect(prompt).toHaveBeenCalledWith(
			"hello",
			expect.objectContaining({ signal: controller.signal, preflightResult: expect.any(Function) }),
		);
	});

	it("loads the full model catalog through the connection boundary", async () => {
		const session = createFakeSession("models", []);
		const runtime = new FakeRuntime(session.session);
		const connection = new InProcessAgentConnection(asRuntime(runtime));

		const catalog = await connection.getModelCatalog();

		expect(catalog.configuredProviders).toEqual(["openai"]);
		expect(catalog.models).toHaveLength(1);
		expect(catalog.models[0]).toMatchObject({ provider: "openai", id: "gpt-5.1" });
	});

	it("exposes serializable tool metadata without local execution or renderer callbacks", async () => {
		const session = createFakeSession("tools", []);
		const runtime = new FakeRuntime(session.session);
		const connection = new InProcessAgentConnection(asRuntime(runtime));

		const definition = await connection.getToolDefinition("custom_tool");

		expect(definition).toEqual({
			name: "custom_tool",
			label: "custom_tool",
			description: "custom_tool description",
			promptSnippet: "custom_tool prompt",
			promptGuidelines: ["Use custom_tool"],
			parameters: { type: "object" },
			renderShell: "self",
		});
		expect(definition).not.toHaveProperty("execute");
		expect(definition).not.toHaveProperty("renderCall");
		expect(definition).not.toHaveProperty("renderResult");
	});

	it("cancels rlm child runs through the session", async () => {
		const session = createFakeSession("rlm", []);
		const runtime = new FakeRuntime(session.session);
		const connection = new InProcessAgentConnection(asRuntime(runtime));

		await expect(connection.cancelRlmChild("child-1")).resolves.toBe(true);
		await expect(connection.cancelRlmChild("finished-child")).resolves.toBe(false);
	});

	it("loads session context through the connection boundary", async () => {
		const session = createFakeSession("ctx", [userMessage("context", 1)]);
		const runtime = new FakeRuntime(session.session);
		const connection = new InProcessAgentConnection(asRuntime(runtime));

		await expect(connection.getSessionContext()).resolves.toEqual({
			messages: [userMessage("context", 1)],
			thinkingLevel: "medium",
			model: null,
		});
	});

	it("builds initial snapshots from the current runtime", async () => {
		const messages = [userMessage("snapshot context", 1)];
		const session = createFakeSession("snapshot", messages);
		const getTree = vi.spyOn(session.session.sessionManager, "getTree");
		const getEntries = vi.spyOn(session.session.sessionManager, "getEntries");
		const materialize = vi.spyOn(session.session.sessionManager, "materializeResidentHistory");
		const runtime = new FakeRuntime(session.session);
		const connection = new InProcessAgentConnection(asRuntime(runtime));
		const contextUsage = { tokens: 10, contextWindow: 100, percent: 10 };
		let releaseReads = () => {};
		const readGate = new Promise<void>((resolve) => {
			releaseReads = resolve;
		});
		const getUsage = vi.spyOn(session.session, "getContextUsage").mockImplementation(async () => {
			await readGate;
			return contextUsage;
		});
		const getContext = vi.spyOn(session.session, "buildSessionContext").mockImplementation(async () => {
			const capturedMessages = [...messages];
			await readGate;
			return { messages: capturedMessages, thinkingLevel: "medium", serviceTier: "default", model: null };
		});
		const streamingMessage = {
			role: "assistant",
			content: [{ type: "text", text: "snapshot reply" }],
		} as AgentMessage;
		Object.assign(session.session, { state: { streamingMessage } });

		const getChildren = vi.spyOn(session.session, "getRlmChildSnapshots");
		const pendingSnapshot = connection.getInitialSnapshot();
		expect(getChildren).toHaveBeenCalledTimes(1);
		expect(getUsage).toHaveBeenCalledTimes(1);
		expect(getContext).toHaveBeenCalledTimes(1);
		messages.push(userMessage("pending context", 2));
		Object.assign(session.session, { sessionName: "later name", state: {} });
		releaseReads();
		const snapshot = await pendingSnapshot;

		expect(snapshot).toMatchObject({
			state: {
				cwd: "/tmp/snapshot",
				sessionId: "snapshot",
				sessionName: "snapshot name",
				messageCount: 1,
				leafId: "snapshot-leaf",
				contextUsage,
			},
			messages: [userMessage("snapshot context", 1)],
			streamingMessage,
			sessionContext: {
				messages: [userMessage("snapshot context", 1)],
				thinkingLevel: "medium",
				model: null,
			},
		});
		expect(snapshot).not.toHaveProperty("sessionTree");
		expect(getTree).not.toHaveBeenCalled();
		expect(getEntries).not.toHaveBeenCalled();
		await expect(connection.getSessionTree()).resolves.toEqual({ tree: [], leafId: "snapshot-leaf" });
		expect(materialize).toHaveBeenCalledWith(DEFAULT_SESSION_TREE_LIMITS);
		await expect(connection.getUserMessagesForForking()).resolves.toEqual([]);
		expect(materialize).toHaveBeenCalledWith(DEFAULT_FORK_MESSAGE_LIMITS);
		expect(getEntries).not.toHaveBeenCalled();
		expect(getTree).not.toHaveBeenCalled();
		expect(snapshot.state).not.toBeInstanceOf(Promise);
		expect(snapshot.state.contextUsage).not.toBeInstanceOf(Promise);
		expect(snapshot.sessionContext).not.toBeInstanceOf(Promise);
		messages.push(userMessage("later context", 2));
		expect(snapshot.messages).toEqual([userMessage("snapshot context", 1)]);

		const usageError = new Error("usage read failed");
		const contextError = new Error("context read failed");
		let rejectContext = (_error: Error) => {};
		const contextRead = new Promise<Awaited<ReturnType<RuntimeSession["buildSessionContext"]>>>(
			(_resolve, reject) => {
				rejectContext = reject;
			},
		);
		getUsage.mockRejectedValueOnce(usageError);
		getContext.mockReturnValueOnce(contextRead);
		let snapshotSettled = false;
		const failedSnapshot = connection.getInitialSnapshot().then(
			() => {
				snapshotSettled = true;
			},
			(error: unknown) => {
				snapshotSettled = true;
				return error;
			},
		);
		expect(getUsage).toHaveBeenCalledTimes(2);
		expect(getContext).toHaveBeenCalledTimes(2);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(snapshotSettled).toBe(false);
		rejectContext(contextError);
		const failure = await failedSnapshot;
		expect(failure).toBeInstanceOf(AggregateError);
		expect(failure).toHaveProperty("errors", [usageError, contextError]);

		const root = mkdtempSync(join(tmpdir(), "bc-session-tree-"));
		const manager = await SessionManager.create(root, join(root, "sessions"));
		try {
			const first = await manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
			const branchA = await manager.appendMessage({ role: "user", content: "branch A", timestamp: 2 });
			manager.branch(first);
			const branchB = await manager.appendMessage({ role: "user", content: "branch B", timestamp: 3 });
			await manager.appendLabelChange(first, "root label");
			manager.branch(branchA);
			const expected = structuredClone(manager.getTree());
			vi.spyOn(manager, "getEntries").mockImplementation(() => {
				throw new Error("uncapped entries");
			});
			vi.spyOn(manager, "getFlatTree").mockImplementation(() => {
				throw new Error("uncapped flat tree");
			});
			vi.spyOn(manager, "getTree").mockImplementation(() => {
				throw new Error("uncapped tree");
			});
			const fake = createFakeSession("native-tree", []);
			Object.assign(fake.session, { sessionManager: manager });
			const nativeConnection = new InProcessAgentConnection(asRuntime(new FakeRuntime(fake.session)));
			const pending = nativeConnection.getSessionTree();
			const later = await manager.appendMessage({ role: "user", content: "later append", timestamp: 4 });
			const captured = await pending;
			expect(captured).toEqual({ tree: expected, leafId: branchA });
			const copied = captured.tree[0].entry;
			if (copied.type === "message" && copied.message.role === "user") copied.message.content = "changed copy";
			expect(manager.getEntry(first)).toMatchObject({ message: { content: "root" } });
			await expect(readSessionTree(manager, { ...DEFAULT_SESSION_TREE_LIMITS, maxEntries: 1 })).rejects.toThrow(
				"History entry budget exceeded",
			);
			await expect(readSessionTree(manager, { ...DEFAULT_SESSION_TREE_LIMITS, maxSourceBytes: 1 })).rejects.toThrow(
				"History source byte budget exceeded",
			);
			const image = { type: "image" as const, data: "AA==", mimeType: "image/png" };
			const whitespace = await manager.appendMessage({ role: "user", content: " \t", timestamp: 0 });
			const mixed = await manager.appendMessage({
				role: "user",
				content: [{ type: "text", text: " first" }, image, { type: "text", text: "second " }],
				timestamp: 0,
			});
			await manager.appendMessage({ role: "user", content: "", timestamp: 0 });
			await manager.appendMessage({ role: "user", content: [], timestamp: 0 });
			await manager.appendMessage({ role: "user", content: [image], timestamp: 0 });
			await manager.appendCustomMessageEntry("notice", "not a user message", true);
			await manager.appendMessage({
				role: "toolResult",
				toolCallId: "tool-1",
				toolName: "ipython",
				content: [{ type: "text", text: "not a user message" }],
				isError: false,
				timestamp: 0,
			});
			manager.branch(branchA);
			const expectedFork = [
				{ entryId: first, text: "root" },
				{ entryId: branchA, text: "branch A" },
				{ entryId: branchB, text: "branch B" },
				{ entryId: later, text: "later append" },
				{ entryId: whitespace, text: " \t" },
				{ entryId: mixed, text: " firstsecond " },
			];
			expect(manager.supportsCapturedHistoryReads()).toBe(true);
			const sourceRead = vi.spyOn(manager, "materializeSourceHistory");
			const residentRead = vi.spyOn(manager, "materializeResidentHistory");
			const pendingFork = nativeConnection.getUserMessagesForForking();
			const future = await manager.appendMessage({ role: "user", content: "future fork", timestamp: 5 });
			await expect(pendingFork).resolves.toEqual(expectedFork);
			expect(sourceRead).toHaveBeenCalledWith(DEFAULT_FORK_MESSAGE_LIMITS);
			expect(residentRead).not.toHaveBeenCalled();
			await manager.appendCustomEntry("filtered tail", { text: "still charged to the limits" });
			const complete = await manager.materializeSourceHistory(DEFAULT_FORK_MESSAGE_LIMITS);
			await expect(nativeConnection.getUserMessagesForForking()).resolves.toEqual([
				...expectedFork,
				{ entryId: future, text: "future fork" },
			]);
			await expect(
				readUserMessagesForForking(manager, {
					...DEFAULT_FORK_MESSAGE_LIMITS,
					maxEntries: complete.entries.length - 1,
				}),
			).rejects.toThrow("History entry budget exceeded");
			await expect(
				readUserMessagesForForking(manager, {
					...DEFAULT_FORK_MESSAGE_LIMITS,
					maxSourceBytes: complete.sourceBytes - 1,
				}),
			).rejects.toThrow("History source byte budget exceeded");
			await nativeConnection.dispose();

			const at = (seconds: number) => `2026-01-01T00:00:0${seconds}.000Z`;
			const message = (id: string, parentId: string | null, seconds: number) => ({
				type: "message",
				id,
				parentId,
				timestamp: at(seconds),
				message: { role: "user", content: id, timestamp: seconds },
			});
			const entries = [
				message("root", null, 2),
				{ type: "tool_intent", id: "hidden-intent", parentId: "root", timestamp: at(2) },
				{ type: "request", id: "hidden-request", parentId: "hidden-intent", timestamp: at(2) },
				message("late", "hidden-request", 3),
				message("early", "root", 1),
				message("orphan", "missing", 0),
				{ type: "label", id: "label-1", parentId: "late", targetId: "late", label: "kept label", timestamp: at(4) },
				{
					type: "label",
					id: "label-2",
					parentId: "label-1",
					targetId: "early",
					label: "removed",
					timestamp: at(5),
				},
				{ type: "label", id: "label-3", parentId: "label-2", targetId: "early", timestamp: at(6) },
			];
			const input = join(root, "resident.jsonl");
			writeFileSync(
				input,
				[{ type: "session", version: 3, id: "resident", timestamp: at(0), cwd: root }, ...entries]
					.map((entry) => `${JSON.stringify(entry)}\n`)
					.join(""),
			);
			const resident = await SessionManager.openReadOnly(input);
			try {
				const expectedResident = resident.getTree();
				vi.spyOn(resident, "getEntries").mockImplementation(() => {
					throw new Error("uncapped resident entries");
				});
				vi.spyOn(resident, "getTree").mockImplementation(() => {
					throw new Error("uncapped resident tree");
				});
				appendFileSync(input, `${JSON.stringify(message("future", "root", 7))}\n`);
				const actual = await readSessionTree(resident);
				expect(actual.tree).toEqual(expectedResident);
				expect(actual.leafId).toBe("label-3");
				expect(actual.tree.map((node) => node.entry.id)).toEqual(["root", "orphan"]);
				expect(actual.tree[0].children.map((node) => node.entry.id)).toEqual(["early", "late"]);
				expect(actual.tree[0].children[0].label).toBeUndefined();
				expect(actual.tree[0].children[1]).toMatchObject({
					entry: { parentId: "root" },
					label: "kept label",
					labelTimestamp: at(4),
				});
				await expect(
					readSessionTree(resident, { ...DEFAULT_SESSION_TREE_LIMITS, maxEntries: entries.length - 1 }),
				).rejects.toThrow("Resident history entry budget exceeded");
				await expect(
					readSessionTree(resident, { ...DEFAULT_SESSION_TREE_LIMITS, maxSourceBytes: 1 }),
				).rejects.toThrow("JSON byte limit exceeded");
				expect(resident.supportsCapturedHistoryReads()).toBe(false);
				const residentSourceRead = vi.spyOn(resident, "materializeSourceHistory");
				const residentSession = createFakeSession("resident-fork", []);
				Object.assign(residentSession.session, { sessionManager: resident });
				const residentConnection = new InProcessAgentConnection(
					asRuntime(new FakeRuntime(residentSession.session)),
				);
				await expect(residentConnection.getUserMessagesForForking()).resolves.toEqual([
					{ entryId: "root", text: "root" },
					{ entryId: "late", text: "late" },
					{ entryId: "early", text: "early" },
					{ entryId: "orphan", text: "orphan" },
				]);
				expect(residentSourceRead).not.toHaveBeenCalled();
				await expect(
					readUserMessagesForForking(resident, { ...DEFAULT_FORK_MESSAGE_LIMITS, maxEntries: entries.length - 1 }),
				).rejects.toThrow("Resident history entry budget exceeded");
				await expect(
					readUserMessagesForForking(resident, { ...DEFAULT_FORK_MESSAGE_LIMITS, maxSourceBytes: 1 }),
				).rejects.toThrow("JSON byte limit exceeded");
				await residentConnection.dispose();
			} finally {
				await resident.close();
			}
		} finally {
			vi.restoreAllMocks();
			await manager.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("emits replacement snapshots and rebinds events when the runtime replaces its session", async () => {
		const oldSession = createFakeSession("old", [userMessage("old", 1)]);
		const newSession = createFakeSession("new", [userMessage("new", 2)]);
		const runtime = new FakeRuntime(oldSession.session);
		const connection = new InProcessAgentConnection(asRuntime(runtime));
		const invalidations: string[] = [];
		const events: AgentConnectionEvent[] = [];

		connection.onBeforeSessionInvalidate(() => {
			invalidations.push("invalidated");
		});
		connection.subscribe((event) => {
			events.push(event);
		});

		expect(oldSession.listenerCount()).toBe(1);
		runtime.invalidateCurrentSession();

		const contextUsage = { tokens: 20, contextWindow: 100, percent: 20 };
		let releaseUsage = () => {};
		const usageGate = new Promise<void>((resolve) => {
			releaseUsage = resolve;
		});
		vi.spyOn(newSession.session, "getContextUsage").mockImplementation(async () => {
			await usageGate;
			return contextUsage;
		});
		const replacement = runtime.replaceSession(newSession.session);
		newSession.session.messages.push(userMessage("later replacement", 3));
		Object.assign(newSession.session, { sessionName: "later name" });
		expect(events).toEqual([]);
		releaseUsage();
		await replacement;

		expect(invalidations).toEqual(["invalidated"]);
		expect(oldSession.listenerCount()).toBe(0);
		expect(oldSession.unsubscribeCount()).toBe(1);
		expect(newSession.listenerCount()).toBe(1);
		expect(events).toEqual([
			{
				type: "session_replaced",
				state: expect.objectContaining({
					cwd: "/tmp/new",
					sessionId: "new",
					sessionName: "new name",
					messageCount: 1,
					leafId: "new-leaf",
					activeToolNames: ["ipython"],
					contextUsage,
				}),
				messages: [userMessage("new", 2)],
			},
		]);

		events.length = 0;
		oldSession.emit({ type: "session_action_update", actions: { queuedCount: 1, steering: ["old"], followUps: [] } });
		newSession.emit({
			type: "session_action_update",
			actions: { queuedCount: 2, steering: ["new"], followUps: ["later"] },
		});

		expect(events).toEqual([
			{
				type: "session_event",
				event: {
					type: "session_action_update",
					actions: { queuedCount: 2, steering: ["new"], followUps: ["later"] },
				},
			},
		]);

		await connection.dispose();

		expect(newSession.listenerCount()).toBe(0);
		expect(runtime.rebindSession).toBeUndefined();
		expect(runtime.beforeSessionInvalidate).toBeUndefined();
		expect(runtime.disposed).toBe(true);
	});
});
