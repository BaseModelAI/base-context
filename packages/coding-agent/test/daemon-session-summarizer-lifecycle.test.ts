import { type AssistantMessage, getModel } from "@ponythewhite/base-context-ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ActiveSessionState } from "../src/modes/daemon/active-session-state.js";
import {
	buildStatusContext,
	DaemonSessionSummarizer,
	type GenerateAgentStatusParams,
} from "../src/modes/daemon/daemon-session-summarizer.js";

// The debounce the summarizer waits for after a turn settles (kept in sync with
// SETTLE_DEBOUNCE_MS in the module).
const SETTLE_MS = 2000;
const REFRESH_MS = 60_000;

function assistantMessage(
	options: Pick<AssistantMessage, "content" | "stopReason" | "errorMessage">,
): AssistantMessage {
	const model = getModel("openai", "gpt-4o-mini");
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 0,
		...options,
	};
}

function makeState(
	opts: { working?: boolean; messages?: number; kind?: "top-level" | "subagent"; persisted?: unknown } = {},
): ActiveSessionState {
	const appended: unknown[] = [];
	const state = {
		activeSessionId: "a1",
		summaryState: undefined,
		runtime: {
			metadata: { kind: opts.kind ?? "top-level" },
			session: {
				isStreaming: opts.working ?? false,
				isCompacting: false,
				isSessionActive: opts.working ?? false,
				sessionActions: { queuedCount: 0, steering: [], followUps: [] },
				messages: Array.from({ length: opts.messages ?? 2 }, () => ({ role: "user", content: "hi" })),
				state: { streamingMessage: undefined },
				model: getModel("openai", "gpt-4o-mini"),
				modelRegistry: {},
				sessionManager: {
					getSessionId: () => "session-1",
					getSessionFile: () => undefined,
					appendAgentStatus: (s: unknown) => appended.push(s),
					getLatestAgentStatus: () => opts.persisted,
				},
			},
		},
	} as unknown as ActiveSessionState;
	(state as unknown as { appendedStatuses: unknown[] }).appendedStatuses = appended;
	return state;
}

describe("DaemonSessionSummarizer lifecycle", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test("runs the model call after the settle debounce and records the verdict", async () => {
		vi.useFakeTimers();
		const generate = vi.fn().mockResolvedValue({ summary: "Added the health endpoint", taskState: "completed" });
		const onStatusChanged = vi.fn();
		const summarizer = new DaemonSessionSummarizer(() => [], onStatusChanged, generate);
		const state = makeState({ working: false });

		summarizer.notifyActivity(state);
		// No model call until the agent has settled for the debounce window.
		await vi.advanceTimersByTimeAsync(SETTLE_MS - 500);
		expect(generate).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(600);
		expect(generate).toHaveBeenCalledOnce();
		expect(generate.mock.calls[0]?.[0].model).toBe(state.runtime.session.model);
		expect(state.summaryState).toMatchObject({ summary: "Added the health endpoint", taskState: "completed" });
		expect(onStatusChanged).toHaveBeenCalled();
	});

	test("a failing model on an idle session settles to a needs_input fallback verdict", async () => {
		vi.useFakeTimers();
		const generate = vi.fn().mockResolvedValue(undefined); // 404 / 401 / timeout / unparseable
		const summarizer = new DaemonSessionSummarizer(() => [], undefined, generate);
		const state = makeState({ working: false });

		summarizer.notifyActivity(state);
		await vi.advanceTimersByTimeAsync(SETTLE_MS + 500);
		expect(generate).toHaveBeenCalledOnce();
		// The activity axis holds an unjudged idle session at "working"; the fallback
		// settles it to needs_input so it doesn't spin forever.
		expect(state.summaryState).toMatchObject({ taskState: "needs_input", basedOnMessageCount: 2 });
	});

	test("retries after a needs_input fallback until a real summary lands", async () => {
		vi.useFakeTimers();
		const generate = vi
			.fn()
			.mockResolvedValueOnce(undefined) // transient failure → blank needs_input fallback
			.mockResolvedValue({ summary: "Reviewed the diff", taskState: "completed" });
		const summarizer = new DaemonSessionSummarizer(() => [], undefined, generate);
		const state = makeState({ working: false });

		summarizer.notifyActivity(state);
		await vi.advanceTimersByTimeAsync(SETTLE_MS + 500);
		expect(state.summaryState).toMatchObject({ summary: "", taskState: "needs_input" });

		summarizer.notifyActivity(state);
		await vi.advanceTimersByTimeAsync(SETTLE_MS + 500);
		expect(generate).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(REFRESH_MS);
		expect(generate).toHaveBeenCalledTimes(2);
		expect(state.summaryState).toMatchObject({ summary: "Reviewed the diff", taskState: "completed" });
		await summarizer.stop();
	});

	test("generates the first bounded input even when a working recap already exists", async () => {
		vi.useFakeTimers();
		const generate = vi.fn().mockResolvedValue({ summary: "Editing the router" });
		const summarizer = new DaemonSessionSummarizer(() => [], undefined, generate);
		const state = makeState({ working: true });
		// A seeded recap has no in-memory prompt snapshot yet.
		state.summaryState = { summary: "Editing the router", taskState: undefined, basedOnMessageCount: 2 };

		summarizer.notifyActivity(state);
		await vi.advanceTimersByTimeAsync(SETTLE_MS + 500);
		expect(generate).toHaveBeenCalledOnce();
		expect(generate.mock.calls[0]?.[0]).toMatchObject({ isWorking: true });
	});

	test("a working refresh preserves a still-valid verdict at the same message count", async () => {
		vi.useFakeTimers();
		const generate = vi.fn().mockResolvedValue({ summary: "Editing the router" }); // working → no verdict
		const summarizer = new DaemonSessionSummarizer(() => [], undefined, generate);
		const state = makeState({ working: true });
		state.summaryState = { summary: "Asked which db", taskState: "needs_input", basedOnMessageCount: 2 };

		summarizer.notifyActivity(state);
		await vi.advanceTimersByTimeAsync(SETTLE_MS + 500);
		expect(state.summaryState).toMatchObject({ summary: "Editing the router", taskState: "needs_input" });
	});

	test("discards a verdict when the session is forgotten (closed) mid-call", async () => {
		vi.useFakeTimers();
		const state = makeState({ working: false });
		let summarizer!: DaemonSessionSummarizer;
		const generate = vi.fn().mockImplementation(async () => {
			summarizer.forget(state.activeSessionId); // session closes while the model runs
			return { summary: "Result after close", taskState: "completed" };
		});
		summarizer = new DaemonSessionSummarizer(() => [], undefined, generate);

		summarizer.notifyActivity(state);
		await vi.advanceTimersByTimeAsync(SETTLE_MS + 500);
		expect(generate).toHaveBeenCalledOnce();
		expect(state.summaryState).toBeUndefined();
	});

	test("discards a verdict when a new turn arrives during the model call", async () => {
		vi.useFakeTimers();
		const state = makeState({ working: false });
		const generate = vi.fn().mockImplementation(async () => {
			(state.runtime.session.messages as unknown[]).push({ role: "user", content: "another task" });
			return { summary: "Stale summary for the old turn", taskState: "completed" };
		});
		const summarizer = new DaemonSessionSummarizer(() => [], undefined, generate);

		summarizer.notifyActivity(state);
		await vi.advanceTimersByTimeAsync(SETTLE_MS + 500);
		expect(generate).toHaveBeenCalledOnce();
		expect(state.summaryState).toBeUndefined();
	});

	test("summarizes a subagent and persists its settled idle verdict", async () => {
		vi.useFakeTimers();
		const generate = vi.fn().mockResolvedValue({ summary: "Auditing the migration scripts", taskState: "completed" });
		const summarizer = new DaemonSessionSummarizer(() => [], undefined, generate);
		const state = makeState({ working: false, kind: "subagent" });

		summarizer.notifyActivity(state);
		await vi.advanceTimersByTimeAsync(SETTLE_MS + 500);

		expect(generate).toHaveBeenCalledOnce();
		expect(state.summaryState).toMatchObject({ summary: "Auditing the migration scripts", taskState: "completed" });
		expect((state as unknown as { appendedStatuses: unknown[] }).appendedStatuses).toHaveLength(1);
	});

	test("repairs a seeded completed error verdict after the native async write without a classifier", async () => {
		vi.useFakeTimers();
		const previous = { summary: "Completed the task", taskState: "completed", basedOnMessageCount: 2 };
		const state = makeState({ persisted: previous });
		state.runtime.session.messages[1] = assistantMessage({
			content: [],
			stopReason: "error",
			errorMessage: "  400 invalid\n request  ",
		});
		const generate = vi.fn();
		const getRequests = vi.fn();
		const onStatusChanged = vi.fn();
		const summarizer = new DaemonSessionSummarizer(() => [], onStatusChanged, generate, getRequests);
		let finishWrite!: () => void;
		const writing = new Promise<void>((resolve) => {
			finishWrite = resolve;
		});
		const manager = state.runtime.session.sessionManager;
		const append = manager.appendAgentStatus.bind(manager);
		const appendStatus = vi.spyOn(manager, "appendAgentStatus").mockImplementation(async (status) => {
			await writing;
			return append(status);
		});
		summarizer.seed(state);
		summarizer.notifyActivity(state);
		await vi.advanceTimersByTimeAsync(SETTLE_MS + 500);
		expect(appendStatus).toHaveBeenCalledOnce();
		expect(state.summaryState).toEqual(previous);
		expect(onStatusChanged).not.toHaveBeenCalled();
		finishWrite();
		await vi.advanceTimersByTimeAsync(0);
		expect(state.summaryState).toEqual({
			summary: "Model request failed: 400 invalid request",
			taskState: "needs_input",
			basedOnMessageCount: 2,
		});
		expect(onStatusChanged).toHaveBeenCalledOnce();
		summarizer.notifyActivity(state);
		await vi.advanceTimersByTimeAsync(SETTLE_MS + 500);
		expect(appendStatus).toHaveBeenCalledOnce();
		expect(generate).not.toHaveBeenCalled();
		expect(getRequests).not.toHaveBeenCalled();
		await summarizer.stop();
	});

	test("classifies a successful final turn normally after an earlier recovered error", async () => {
		vi.useFakeTimers();
		const state = makeState();
		state.runtime.session.messages.push(
			assistantMessage({ content: [], stopReason: "error", errorMessage: "429 temporary" }),
			assistantMessage({
				content: [{ type: "text", text: "Finished the requested change" }],
				stopReason: "stop",
			}),
		);
		const generate = vi.fn().mockResolvedValue({ summary: "Finished the requested change", taskState: "completed" });
		const summarizer = new DaemonSessionSummarizer(() => [], undefined, generate);
		summarizer.notifyActivity(state);
		await vi.advanceTimersByTimeAsync(SETTLE_MS + 500);
		expect(generate).toHaveBeenCalledOnce();
		expect(state.summaryState).toEqual({
			summary: "Finished the requested change",
			taskState: "completed",
			basedOnMessageCount: 4,
		});
		expect((state as unknown as { appendedStatuses: unknown[] }).appendedStatuses).toHaveLength(1);
		await summarizer.stop();
	});

	test("skips unchanged working inputs across sweeps and preserves local operation state", async () => {
		vi.useFakeTimers();
		const state = makeState({ working: true });
		const actions = { queuedCount: 1, steering: [], followUps: [{ text: "next task" }] };
		Object.assign(state.runtime.session, {
			isStreaming: false,
			isCompacting: true,
			getSessionActionSnapshot: () => actions,
		});
		state.runtime.session.messages[0] = { role: "user", content: "A".repeat(601), timestamp: 0 };
		const generate = vi.fn().mockResolvedValue({ summary: "Compacting the research context" });
		const summarizer = new DaemonSessionSummarizer(() => [state], undefined, generate);
		summarizer.start();
		summarizer.notifyActivity(state);
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		state.runtime.session.messages[0] = {
			role: "user",
			content: `${"A".repeat(600)}different hidden suffix`,
			timestamp: 100,
		};
		await vi.advanceTimersByTimeAsync(150_000);
		expect(generate).toHaveBeenCalledOnce();
		expect(state.summaryState?.summary).toBe("Compacting the research context");
		expect(state.runtime.session.isSessionActive).toBe(true);
		expect(state.runtime.session.isCompacting).toBe(true);
		expect(state.runtime.session.getSessionActionSnapshot()).toBe(actions);
		expect(state.runtime.session.getSessionActionSnapshot().queuedCount).toBe(1);
		await summarizer.stop();
	});

	test("coalesces rapid streaming changes and generates the latest bounded input after the interval", async () => {
		vi.useFakeTimers();
		const state = makeState({ working: true });
		const inputs: string[] = [];
		const generate = vi.fn(async (params: GenerateAgentStatusParams) => {
			inputs.push(buildStatusContext(params.messages, params.isWorking));
			return { summary: "Editing the router" };
		});
		const summarizer = new DaemonSessionSummarizer(() => [], undefined, generate);
		summarizer.notifyActivity(state);
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		for (let i = 0; i < 5; i++) {
			Object.assign(state.runtime.session.state, {
				streamingMessage: assistantMessage({
					content: [{ type: "text", text: `Progress ${i}` }],
					stopReason: "stop",
				}),
			});
			summarizer.notifyActivity(state);
			await vi.advanceTimersByTimeAsync(SETTLE_MS);
		}
		expect(generate).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(REFRESH_MS - 5 * SETTLE_MS - 1);
		expect(generate).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(1);
		expect(generate).toHaveBeenCalledTimes(2);
		expect(inputs[1]).toContain("assistant: Progress 4");
		await summarizer.stop();
	});

	test("publishes a final idle verdict without waiting for the working refresh interval", async () => {
		vi.useFakeTimers();
		const state = makeState({ working: true });
		const generate = vi
			.fn()
			.mockResolvedValueOnce({ summary: "Editing the router" })
			.mockResolvedValue({ summary: "Finished the router", taskState: "completed" });
		const summarizer = new DaemonSessionSummarizer(() => [], undefined, generate);
		summarizer.notifyActivity(state);
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		Object.assign(state.runtime.session, { isSessionActive: false, isStreaming: false });
		summarizer.notifyActivity(state);
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect(generate).toHaveBeenCalledTimes(2);
		expect(generate.mock.calls[1]?.[0].isWorking).toBe(false);
		expect(state.summaryState?.taskState).toBe("completed");
		expect((state as unknown as { appendedStatuses: unknown[] }).appendedStatuses).toHaveLength(1);
		await summarizer.stop();
	});

	test("refreshes idle currency locally when new messages have the same bounded input", async () => {
		vi.useFakeTimers();
		const state = makeState({ messages: 8 });
		const generate = vi.fn().mockResolvedValue({ summary: "Reviewed the request", taskState: "completed" });
		const onStatusChanged = vi.fn();
		const summarizer = new DaemonSessionSummarizer(() => [], onStatusChanged, generate);
		summarizer.notifyActivity(state);
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		state.runtime.session.messages.push({ role: "user", content: "hi", timestamp: 0 });
		summarizer.notifyActivity(state);
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect(generate).toHaveBeenCalledOnce();
		expect(state.summaryState).toEqual({
			summary: "Reviewed the request",
			taskState: "completed",
			basedOnMessageCount: 9,
		});
		expect(onStatusChanged).toHaveBeenCalledTimes(2);
		await summarizer.stop();
	});

	test("notices changed idle content at the same message count", async () => {
		vi.useFakeTimers();
		const state = makeState();
		const generate = vi.fn().mockResolvedValue({ summary: "Reviewed the request", taskState: "completed" });
		const summarizer = new DaemonSessionSummarizer(() => [], undefined, generate);
		summarizer.notifyActivity(state);
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		state.runtime.session.messages[1] = { role: "user", content: "Different request", timestamp: 0 };
		summarizer.notifyActivity(state);
		await vi.advanceTimersByTimeAsync(REFRESH_MS);
		expect(generate).toHaveBeenCalledTimes(2);
		await summarizer.stop();
	});

	test.each(["message", "stream", "session", "file", "model"] as const)(
		"discards a result when its %s source changes without a message-count change",
		async (change) => {
			vi.useFakeTimers();
			const state = makeState({ working: change === "stream" });
			const generate = vi.fn(async () => {
				switch (change) {
					case "message":
						state.runtime.session.messages[0] = { role: "user", content: "Replaced", timestamp: 0 };
						break;
					case "stream":
						Object.assign(state.runtime.session.state, {
							streamingMessage: assistantMessage({
								content: [{ type: "text", text: "New progress" }],
								stopReason: "stop",
							}),
						});
						break;
					case "session":
						vi.spyOn(state.runtime.session.sessionManager, "getSessionId").mockReturnValue("replacement");
						break;
					case "file":
						vi.spyOn(state.runtime.session.sessionManager, "getSessionFile").mockReturnValue("replacement.jsonl");
						break;
					case "model":
						Object.assign(state.runtime.session, { model: getModel("openai", "gpt-4o") });
				}
				return { summary: "Stale result", taskState: "completed" as const };
			});
			const summarizer = new DaemonSessionSummarizer(() => [], undefined, generate);
			summarizer.notifyActivity(state);
			await vi.advanceTimersByTimeAsync(SETTLE_MS);
			expect(state.summaryState).toBeUndefined();
			expect((state as unknown as { appendedStatuses: unknown[] }).appendedStatuses).toHaveLength(0);
			await summarizer.stop();
		},
	);

	test("coalesces concurrent activity and settles the final transition after the in-flight call", async () => {
		vi.useFakeTimers();
		const state = makeState({ working: true });
		let finish!: () => void;
		const pending = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const generate = vi
			.fn()
			.mockImplementationOnce(async () => {
				await pending;
				return { summary: "Stale working recap" };
			})
			.mockResolvedValue({ summary: "Finished the task", taskState: "completed" });
		const summarizer = new DaemonSessionSummarizer(() => [], undefined, generate);
		summarizer.notifyActivity(state);
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		Object.assign(state.runtime.session, { isSessionActive: false, isStreaming: false });
		for (let i = 0; i < 3; i++) {
			summarizer.notifyActivity(state);
			await vi.advanceTimersByTimeAsync(SETTLE_MS);
		}
		expect(generate).toHaveBeenCalledOnce();
		finish();
		await vi.advanceTimersByTimeAsync(0);
		expect(state.summaryState).toBeUndefined();
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect(generate).toHaveBeenCalledTimes(2);
		expect(state.summaryState?.taskState).toBe("completed");
		await summarizer.stop();
	});

	test.each(["stop", "forget"] as const)("%s aborts the in-flight call and cancels coalesced work", async (action) => {
		vi.useFakeTimers();
		const state = makeState({ working: true });
		let signal: AbortSignal | undefined;
		const generate = vi.fn(
			(params: GenerateAgentStatusParams) =>
				new Promise<undefined>((resolve) => {
					signal = params.signal;
					signal?.addEventListener("abort", () => resolve(undefined), { once: true });
				}),
		);
		const summarizer = new DaemonSessionSummarizer(() => [state], undefined, generate);
		summarizer.start();
		summarizer.notifyActivity(state);
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		summarizer.notifyActivity(state);
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		if (action === "stop") await summarizer.stop();
		else await summarizer.forget(state.activeSessionId);
		expect(signal?.aborted).toBe(true);
		await vi.advanceTimersByTimeAsync(2 * REFRESH_MS);
		expect(generate).toHaveBeenCalledOnce();
		expect(state.summaryState).toBeUndefined();
		await summarizer.stop();
	});

	test("finalizes after a working change was deferred, and reports terminal errors locally", async () => {
		vi.useFakeTimers();
		const state = makeState();
		const generate = vi.fn().mockResolvedValue({ summary: "Reviewed the request", taskState: "completed" });
		const summarizer = new DaemonSessionSummarizer(() => [], undefined, generate);
		summarizer.notifyActivity(state);
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		Object.assign(state.runtime.session, { isSessionActive: true });
		state.runtime.session.messages[1] = { role: "user", content: "Another request", timestamp: 0 };
		summarizer.notifyActivity(state);
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect(generate).toHaveBeenCalledOnce();
		Object.assign(state.runtime.session, { isSessionActive: false });
		summarizer.notifyActivity(state);
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect(generate).toHaveBeenCalledTimes(2);
		state.runtime.session.messages[1] = assistantMessage({
			content: [],
			stopReason: "error",
			errorMessage: "Invalid request",
		});
		summarizer.notifyActivity(state);
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect(generate).toHaveBeenCalledTimes(2);
		expect(state.summaryState).toMatchObject({
			summary: "Model request failed: Invalid request",
			taskState: "needs_input",
		});
		await summarizer.stop();
	});

	test("a replacement source does not inherit an unchanged-input skip or minimum interval", async () => {
		vi.useFakeTimers();
		const state = makeState({ working: true });
		const generate = vi.fn().mockResolvedValue({ summary: "Reviewed the request" });
		const summarizer = new DaemonSessionSummarizer(() => [], undefined, generate);
		summarizer.notifyActivity(state);
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		vi.spyOn(state.runtime.session.sessionManager, "getSessionId").mockReturnValue("replacement");
		summarizer.notifyActivity(state);
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect(generate).toHaveBeenCalledTimes(2);
		expect(generate.mock.calls.map((call) => call[0].sessionId)).toEqual(["session-1", "replacement"]);
		await summarizer.stop();
	});

	test.each(["stop", "forget"] as const)("%s cancels a minimum-interval deferred refresh", async (action) => {
		vi.useFakeTimers();
		const state = makeState({ working: true });
		const generate = vi.fn().mockResolvedValue({ summary: "Reviewed the request" });
		const summarizer = new DaemonSessionSummarizer(() => [], undefined, generate);
		summarizer.notifyActivity(state);
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		state.runtime.session.messages[1] = { role: "user", content: "Changed request", timestamp: 0 };
		summarizer.notifyActivity(state);
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		if (action === "stop") await summarizer.stop();
		else await summarizer.forget(state.activeSessionId);
		await vi.advanceTimersByTimeAsync(REFRESH_MS);
		expect(generate).toHaveBeenCalledOnce();
		await summarizer.stop();
	});

	test("seeds a subagent's persisted recap into memory", () => {
		const summarizer = new DaemonSessionSummarizer(() => [], undefined, vi.fn());
		const persisted = { summary: "Reviewing the diff", taskState: "needs_input", basedOnMessageCount: 3 };
		const state = makeState({ kind: "subagent", persisted });

		summarizer.seed(state);
		expect(state.summaryState).toEqual(persisted);
	});
});
