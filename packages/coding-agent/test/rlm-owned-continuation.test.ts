import type { AssistantMessage } from "@ponythewhite/base-context-ai";
import { describe, expect, it, vi } from "vitest";
import { AgentSession, rlmAssistantPreview } from "../src/core/agent-session.js";
import * as autonomous from "../src/core/autonomous.js";
import { createAutonomousRuntimeState } from "../src/core/autonomous.js";
import { emptyGoalState, type GoalState } from "../src/core/goals.js";

const defer = Reflect.get(AgentSession.prototype, "_deferAutonomousContinuationForRlmWork") as (
	this: object,
	message: AssistantMessage,
	signal?: AbortSignal,
) => boolean;
const resume = Reflect.get(AgentSession.prototype, "_resumeGoalContinuationAfterRlmWork") as (
	this: object,
) => Promise<void>;
const message = {
	role: "assistant",
	content: [{ type: "text", text: "Delegated work." }],
	stopReason: "stop",
} as AssistantMessage;

function harness() {
	const mode = Object.assign(Object.create(AgentSession.prototype), {
		_autonomousState: createAutonomousRuntimeState({ enabled: true }),
		_sessionInputArrivalEpoch: 0,
		_sessionInputCheckpointWaiters: new Set(),
		_surfaceSessionInputError: (error: unknown) => {
			throw error;
		},
		_sessionInputAdmissionPauses: new Set(),
		_sessionInputPumpSuspended: false,
		_captureCompactionOwner: () => ({}),
		_isCompactionSourceOwnerCurrent: () => true,
		_hasUnsettledRlmQuiescenceWork: () => true,
		_goals: { state: { status: "idle" } },
		_cwd: process.cwd(),
		_createPreparedTurnAction: vi.fn((_kind: string, text: string) => ({ text })),
		_admitSessionInput: vi.fn(() => ({ accepted: true })),
	}) as {
		_autonomousState: ReturnType<typeof createAutonomousRuntimeState>;
		_sessionInputArrivalEpoch: number;
		_hasUnsettledRlmQuiescenceWork: () => boolean;
		_admitSessionInput: ReturnType<typeof vi.fn>;
	};
	Object.defineProperties(mode, { isStreaming: { value: false }, unfinishedActionCount: { value: 0 } });
	return mode;
}

describe("owned autonomous continuation", () => {
	it("holds without consuming a continuation and wakes once at physical settlement", async () => {
		const mode = harness();
		expect(defer.call(mode, message)).toBe(true);
		await resume.call(mode);
		expect(mode._admitSessionInput).not.toHaveBeenCalled();
		expect(mode._autonomousState.continuationsUsed).toBe(0);
		mode._autonomousState.tokensUsed = 17;
		mode._hasUnsettledRlmQuiescenceWork = () => false;
		await resume.call(mode);
		await resume.call(mode);
		expect(mode._admitSessionInput).toHaveBeenCalledTimes(1);
		expect(mode._autonomousState.continuationsUsed).toBe(1);
		expect(mode._autonomousState.tokensUsed).toBe(17);
	});

	it("drops a held continuation after new input instead of injecting stale work", async () => {
		const mode = harness();
		expect(defer.call(mode, message)).toBe(true);
		mode._sessionInputArrivalEpoch++;
		mode._hasUnsettledRlmQuiescenceWork = () => false;
		await resume.call(mode);
		expect(mode._admitSessionInput).not.toHaveBeenCalled();
		expect(mode._autonomousState.continuationsUsed).toBe(0);
	});
});

describe("continuation admission after awaited preparation", () => {
	it.each(["turn", "threshold"])("holds %s autonomous continuation when a gate admits owned work", async (path) => {
		const parent = Object.assign(harness(), {
			_captureGoalContinuationOwner: () => ({ goal: {}, manager: { supportsCapturedHistoryReads: () => false } }),
			_isGoalContinuationOwnerCurrent: () => true,
			_isCompactionOwnerCurrent: () => true,
			_contextOptimizationAllowed: () => true,
			_getGoalContinuationMessages: async () => ({ kind: "finish" }),
			_queuedAutonomousThresholdContinuations: new Map(),
			_autonomousContinuationSuppressedMessages: new Set(),
		});
		Object.defineProperty(parent, "queuedActionCount", { value: 0 });
		let owned = false;
		parent._hasUnsettledRlmQuiescenceWork = () => owned;
		let release!: () => void;
		let started!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const entered = new Promise<void>((resolve) => {
			started = resolve;
		});
		const gate = vi.spyOn(autonomous, "nextAutonomousContinuation").mockImplementation(async (state) => {
			started();
			await held;
			state.continuationsUsed++;
			return { role: "user", content: "Continue", timestamp: 0 };
		});
		try {
			const run = Reflect.get(
				AgentSession.prototype,
				path === "turn" ? "_getContinuationOutcome" : "_queueAutonomousContinuationForThresholdCompaction",
			) as (this: object, input: object, owner?: object) => Promise<unknown>;
			const pending = run.call(parent, path === "turn" ? { message, newMessages: [] } : message, {});
			await entered;
			owned = true;
			release();
			expect(await pending).toEqual(path === "turn" ? { kind: "wait_for_owned_work" } : undefined);
			expect(parent._autonomousState.continuationsUsed).toBe(0);
			expect(parent._admitSessionInput).not.toHaveBeenCalled();
			owned = false;
			await resume.call(parent);
			expect(parent._autonomousState.continuationsUsed).toBe(1);
			expect(parent._admitSessionInput).toHaveBeenCalledTimes(1);
		} finally {
			release();
			gate.mockRestore();
		}
	});

	it.each(["turn", "threshold", "resume"])(
		"holds %s goal continuation when persistence admits owned work",
		async (path) => {
			const before: GoalState = { ...emptyGoalState(), active: true, status: "active", objective: "Complete work" };
			const owner = { goal: before };
			let owned = false;
			let release!: () => void;
			let started!: () => void;
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			const entered = new Promise<void>((resolve) => {
				started = resolve;
			});
			let blocked = false;
			const parent = Object.assign(harness(), {
				_goals: { state: before },
				_goalContinuationAwaitsRlmWork: path === "resume",
				_goalContinuationHasProgress: true,
				_captureGoalContinuationOwner: () => owner,
				_isGoalContinuationOwnerCurrent: () => true,
				_assertGoalContinuationOwner: () => {},
				_contextOptimizationAllowed: () => true,
				_ensureGoalRuntimeActive: () => {},
				_scheduleGoalContinuationAfterRlmWork: () => {},
				_stopGoalContinuationForTerminalMessage: async () => false,
				_setGoalState: async (goal: GoalState) => {
					if (!blocked) {
						blocked = true;
						started();
						await held;
					}
					owner.goal = goal;
					parent._goals.state = goal;
				},
			});
			parent._hasUnsettledRlmQuiescenceWork = () => owned;
			const run = Reflect.get(
				AgentSession.prototype,
				path === "turn"
					? "_getGoalContinuationOutcome"
					: path === "threshold"
						? "_queueGoalContinuationForThresholdCompaction"
						: "_resumeGoalContinuationAfterRlmWork",
			) as (this: object, input: object, owner?: object) => Promise<unknown>;
			const pending = run.call(parent, path === "turn" ? { message } : message, owner);
			await entered;
			owned = true;
			release();
			expect(await pending).toEqual(path === "turn" ? { kind: "wait_for_owned_work" } : undefined);
			expect(owner.goal.continuationsUsed).toBe(0);
			expect(parent._admitSessionInput).not.toHaveBeenCalled();
			expect(parent._goalContinuationAwaitsRlmWork).toBe(true);
			owned = false;
			await resume.call(parent);
			expect(owner.goal.continuationsUsed).toBe(1);
			expect(parent._admitSessionInput).toHaveBeenCalledTimes(1);
		},
	);
});

describe("bounded child preview", () => {
	it("keeps short assistant text", () => {
		expect(rlmAssistantPreview(message)).toBe("Delegated work.");
	});
	it("uses the bounded suffix of long multi-block output", () => {
		const large = {
			...message,
			content: [
				{ type: "text", text: "old ".repeat(100_000) },
				{ type: "text", text: " latest result" },
			],
		} as AssistantMessage;
		const preview = rlmAssistantPreview(large);
		expect(preview.length).toBeLessThanOrEqual(160);
		expect(preview.endsWith("latest result")).toBe(true);
	});
});

const waitIdle = Reflect.get(AgentSession.prototype, "_waitForIdleOrSettlement") as (
	this: object,
	settlement: undefined,
	signal: AbortSignal,
) => Promise<void>;

describe("completion observation cancellation", () => {
	it("removes a blocked checkpoint listener without cancelling queued work", async () => {
		const waiters = new Set<() => void>();
		const queued = [{}];
		const mode = {
			_actionStore: { queuedActions: () => queued },
			_isBusyForSessionInput: () => true,
			_sessionInputCheckpointWaiters: waiters,
		};
		const controller = new AbortController();
		const pending = waitIdle.call(mode, undefined, controller.signal);
		expect(waiters.size).toBe(1);
		controller.abort(new Error("client disconnected"));
		await expect(pending).rejects.toThrow("client disconnected");
		expect(waiters.size).toBe(0);
		expect(queued).toHaveLength(1);
	});
	it("does not register an already-cancelled wait", async () => {
		const controller = new AbortController();
		controller.abort(new Error("expired"));
		await expect(waitIdle.call({}, undefined, controller.signal)).rejects.toThrow("expired");
	});
});

const subscribe = Reflect.get(AgentSession.prototype, "_subscribeRlmChildEvents") as (
	this: object,
	id: string,
	child: object,
) => () => void;

describe("child presentation coalescing", () => {
	it("coalesces rehydrated child streaming and bypasses the timer for lifecycle events", async () => {
		vi.useFakeTimers();
		try {
			let listener = (_event: unknown) => {};
			const child = {
				_captureCompactionOwner: () => ({}),
				_isCompactionSourceOwnerCurrent: () => true,
				subscribe: (callback: typeof listener) => {
					listener = callback;
					return () => {};
				},
			};
			const emit = vi.fn();
			const parent = {
				_captureCompactionOwner: () => ({}),
				_isCompactionSourceOwnerCurrent: () => true,
				_emit: emit,
				_rlmChildSnapshotForSession: vi.fn(() => ({ id: "child" })),
			};
			const unsubscribe = subscribe.call(parent, "child", child);
			for (let i = 0; i < 20; i++) listener({ type: "message_update", message });
			expect(emit).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1000);
			expect(emit).toHaveBeenCalledTimes(1);
			listener({ type: "message_update", message });
			listener({ type: "agent_end" });
			expect(emit).toHaveBeenCalledTimes(2);
			unsubscribe();
			await vi.advanceTimersByTimeAsync(1000);
			expect(emit).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});
	it("drops a scheduled preview after its source changes", async () => {
		vi.useFakeTimers();
		try {
			let listener = (_event: unknown) => {};
			let current = true;
			const child = {
				_captureCompactionOwner: () => ({}),
				_isCompactionSourceOwnerCurrent: () => current,
				subscribe: (callback: typeof listener) => {
					listener = callback;
					return () => {};
				},
			};
			const emit = vi.fn();
			const parent = {
				_captureCompactionOwner: () => ({}),
				_isCompactionSourceOwnerCurrent: () => true,
				_emit: emit,
				_rlmChildSnapshotForSession: vi.fn(),
			};
			const unsubscribe = subscribe.call(parent, "child", child);
			listener({ type: "message_update", message });
			current = false;
			await vi.advanceTimersByTimeAsync(1000);
			expect(emit).not.toHaveBeenCalled();
			unsubscribe();
		} finally {
			vi.useRealTimers();
		}
	});
});

const checkpoint = Reflect.get(AgentSession.prototype, "_notifySessionInputCheckpointChange") as (this: object) => void;

describe("held continuation settlement ownership", () => {
	it("does not reuse a held owner after autonomous mode is restarted", async () => {
		const parent = harness();
		Object.assign(parent, {
			_clearQueuedAutonomousContinuations: () => {},
			_emitAutonomousStatus: async () => {},
		});
		const command = Reflect.get(AgentSession.prototype, "_handleAutonomousSlashCommand") as (
			this: object,
			text: string,
		) => Promise<boolean>;
		expect(defer.call(parent, message)).toBe(true);
		await command.call(parent, "/autonomous off");
		await command.call(parent, "/autonomous on");
		parent._hasUnsettledRlmQuiescenceWork = () => false;
		await resume.call(parent);
		expect(parent._admitSessionInput).not.toHaveBeenCalled();
		expect(parent._autonomousState.continuationsUsed).toBe(0);
	});

	it("rechecks the token limit accumulated while held without spending a continuation", async () => {
		const parent = harness();
		expect(defer.call(parent, message)).toBe(true);
		parent._autonomousState.tokensUsed = parent._autonomousState.limits.maxTokens;
		await resume.call(parent);
		expect(parent._autonomousState.gateAttempts).toEqual({});
		parent._hasUnsettledRlmQuiescenceWork = () => false;
		await resume.call(parent);
		expect(parent._admitSessionInput).not.toHaveBeenCalled();
		expect(parent._autonomousState.continuationsUsed).toBe(0);
	});
	it("wakes a parent at a retained child's checkpoint without retaining idle waiters", async () => {
		const parent = harness();
		const child = {
			_sessionInputCheckpointWaiters: new Set<() => void>(),
			_rlmParentAdmission: { parent },
		};
		expect(defer.call(parent, message)).toBe(true);
		parent._hasUnsettledRlmQuiescenceWork = () => false;
		checkpoint.call(child);
		await Reflect.get(parent, "_goalResumeOperation");
		expect(parent._admitSessionInput).toHaveBeenCalledTimes(1);
		expect(child._sessionInputCheckpointWaiters.size).toBe(0);
		checkpoint.call(child);
		expect(parent._admitSessionInput).toHaveBeenCalledTimes(1);
	});

	it("flushes terminal presentation before usage settlement and wakes after it", async () => {
		const parent = harness();
		let listener = (_event: unknown) => {};
		let release = () => {};
		const usage = new Promise<{ aggregateUsage: AssistantMessage["usage"] }>((resolve) => {
			release = () => resolve({ aggregateUsage: message.usage });
		});
		const writes = new Set<Promise<void>>();
		const emit = vi.fn();
		Object.assign(parent, {
			sessionManager: { appendChildUsageAttributionWithAggregate: () => usage },
			_rlmChildUsageSources: new Map([["child", { sessionId: "parent", entryId: "entry" }]]),
			_childUsageWrites: writes,
			_emit: emit,
			_rlmChildSnapshotForSession: () => ({ id: "child" }),
		});
		Object.defineProperties(parent, {
			sessionId: { value: "parent" },
			sessionFile: { value: undefined },
			messages: { value: [] },
		});
		const child = {
			_captureCompactionOwner: () => ({}),
			_isCompactionSourceOwnerCurrent: () => true,
			messages: [message],
			subscribe: (callback: typeof listener) => {
				listener = callback;
				return () => {};
			},
		};
		const unsubscribe = subscribe.call(parent, "child", child);
		listener({ type: "message_end", message });
		expect(emit).toHaveBeenCalledTimes(1);
		expect(writes.size).toBe(1);
		parent._hasUnsettledRlmQuiescenceWork = () => writes.size > 0;
		expect(defer.call(parent, message)).toBe(true);
		const pending = [...writes];
		listener({ type: "message_start", message: { ...message, content: [{ type: "text", text: "New turn" }] } });
		release();
		await Promise.all(pending);
		await Reflect.get(parent, "_goalResumeOperation");
		expect(parent._admitSessionInput).toHaveBeenCalledTimes(1);
		expect(writes.size).toBe(0);
		// An old usage acknowledgement must not overwrite the next assistant message.
		expect(emit).toHaveBeenCalledTimes(1);
		unsubscribe();
	});
});

const reserveAdmission = AgentSession.prototype.reserveRlmChildAdmission;
const hasUnsettled = Reflect.get(AgentSession.prototype, "_hasUnsettledRlmQuiescenceWork") as (
	this: object,
	waitForOwnedChildDeletion?: boolean,
) => boolean;
const trackDeletion = Reflect.get(AgentSession.prototype, "_trackRlmSubagentDeletion") as (
	this: object,
	subagent: { rlm_child_id: string },
	startDeletion: () => Promise<void>,
) => Promise<void>;

describe("owned child deletion continuation", () => {
	it.each([false, true])("holds through physical deletion and wakes after settlement (failure=%s)", async (fails) => {
		let finish = () => {};
		const cleanup = new Promise<void>((resolve, reject) => {
			finish = () => (fails ? reject(new Error("cleanup failed")) : resolve());
		});
		const parent = Object.assign(harness(), {
			_hasTerminalRlmQuiescenceFailure: () => false,
			_hasDeferredRlmTerminalNotices: () => false,
			_hasUnsettledRlmQuiescenceWork: function (waitForOwnedChildDeletion?: boolean) {
				return hasUnsettled.call(this, waitForOwnedChildDeletion);
			},
			_rlmChildSessionSnapshot: () => [],
			_rlmChildAdmissions: new Set(),
			_deletingRlmChildren: new Map(),
			_activeRlmChildRuns: new Map(),
			_pendingIpythonExecutions: new Map(),
			_childUsageWrites: new Set(),
			_unsettledRlmChildRuns: new Set(),
			requests: { hasPending: false },
		});
		const deletion = trackDeletion.call(parent, { rlm_child_id: "child" }, () => cleanup);
		const outcome = deletion.catch((error: unknown) => error);
		expect(defer.call(parent, message)).toBe(true);
		await resume.call(parent);
		expect(parent._admitSessionInput).not.toHaveBeenCalled();
		expect(parent._autonomousState.continuationsUsed).toBe(0);
		expect(parent._autonomousState.gateAttempts).toEqual({});
		finish();
		const result = await outcome;
		if (fails) expect(result).toEqual(new Error("cleanup failed"));
		else expect(result).toBeUndefined();
		await Reflect.get(parent, "_goalResumeOperation");
		expect(parent._deletingRlmChildren.size).toBe(0);
		expect(parent._admitSessionInput).toHaveBeenCalledTimes(1);
		expect(parent._autonomousState.continuationsUsed).toBe(1);
	});
});

describe("pending child admission completion", () => {
	it("reports and waits for admission through capacity cleanup without cancelling its owner", async () => {
		let finishCleanup = () => {};
		const cleanup = new Promise<void>((resolve) => {
			finishCleanup = resolve;
		});
		const parent = Object.assign(harness(), {
			_rlmChildAdmissions: new Set(),
			_rlmSubagentCapacity: { reserve: async () => ({ release: () => cleanup }) },
			_activeRlmChildRuns: new Map(),
			_hasTerminalRlmQuiescenceFailure: () => false,
			_hasDeferredRlmTerminalNotices: () => false,
			_hasUnsettledRlmQuiescenceWork: function () {
				return hasUnsettled.call(this);
			},
			_rlmChildSessionSnapshot: () => [],
			_rlmSubtreeSessions: function () {
				return [this];
			},
			_deletingRlmChildren: new Map(),
			_pendingIpythonExecutions: new Map(),
			_childUsageWrites: new Set(),
			_unsettledRlmChildRuns: new Set(),
			_rlmQuiescenceWaitAborts: new Set(),
			requests: { hasPending: false },
			waitForHeadlessIdle: async () => {},
		});
		Object.defineProperties(parent, {
			sessionId: { value: "parent" },
			isSessionActive: { value: false },
			isCompacting: { value: false },
			isRetrying: { value: false },
			isBashRunning: { value: false },
		});
		const admission = await reserveAdmission.call(parent as unknown as AgentSession);
		expect(hasUnsettled.call(parent)).toBe(true);
		expect(AgentSession.prototype.getCompletionBlockers.call(parent as unknown as AgentSession)).toContainEqual({
			kind: "child_admission",
			sessionId: "parent",
			count: 1,
		});
		const cancelled = new AbortController();
		const observation = AgentSession.prototype.waitForRlmQuiescence.call(
			parent as unknown as AgentSession,
			cancelled.signal,
		);
		cancelled.abort();
		await expect(observation).rejects.toThrow("cancelled");
		expect(admission.pending).toBe(true);
		expect(() => admission.assertCurrent()).not.toThrow();
		expect(Reflect.get(parent, "_sessionInputCheckpointWaiters").size).toBe(0);
		let complete = false;
		const wait = AgentSession.prototype.waitForRlmQuiescence.call(parent as unknown as AgentSession).then(() => {
			complete = true;
		});
		const settlement = admission.settle();
		await Promise.resolve();
		expect(admission.pending).toBe(true);
		expect(complete).toBe(false);
		finishCleanup();
		await settlement;
		await wait;
		expect(admission.pending).toBe(false);
		expect(complete).toBe(true);
	});
});
