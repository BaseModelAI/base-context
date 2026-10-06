import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { emptyGoalState } from "../src/core/goals.js";
import { SessionGoals } from "../src/core/session-goals.js";
import { SessionManager } from "../src/core/session-manager.js";

type Harness = {
	_goals: SessionGoals;
	_jobWatchController?: { isParked: () => boolean };
	_goalContinuationAwaitsRlmWork: boolean;
	_disposed: boolean;
	_disposing: boolean;
	_sessionInputAdmissionPauses: Set<symbol>;
	_sessionInputPumpSuspended: boolean;
	_hasUnsettledRlmQuiescenceWork: () => boolean;
	_stopGoalContinuationForTerminalMessage: () => boolean;
	_ensureGoalRuntimeActive: () => void;
	_emitGoalUpdate: () => void;
	_createPreparedTurnAction: ReturnType<typeof vi.fn>;
	_admitSessionInput: ReturnType<typeof vi.fn>;
};

const getGoalContinuation = Reflect.get(AgentSession.prototype, "_getGoalContinuationMessages") as (
	this: Harness,
	context: { message: unknown; context: unknown },
) => Promise<unknown[]>;
const maybeResume = Reflect.get(AgentSession.prototype, "_resumeGoalContinuationAfterRlmWork") as (
	this: Harness,
) => Promise<void>;

function harness(overrides: Partial<Harness> = {}): Harness {
	// Use the real goal owner and in-memory persistence; stub only scheduling and admission.
	const sessionManager = SessionManager.inMemory();
	const goals = new SessionGoals(
		() => sessionManager,
		() => {},
	);
	goals.restore({ ...emptyGoalState(), active: true, status: "active", objective: "ship it", goalId: "goal-1" });
	return Object.assign(Object.create(AgentSession.prototype), {
		sessionManager,
		_sessionInputPumpEpoch: 0,
		_goals: goals,
		_goalContinuationAwaitsRlmWork: false,
		_disposed: false,
		_disposing: false,
		_sessionInputAdmissionPauses: new Set(),
		_sessionInputPumpSuspended: false,
		_hasUnsettledRlmQuiescenceWork: () => false,
		_stopGoalContinuationForTerminalMessage: () => false,
		_ensureGoalRuntimeActive: () => {},
		_emitGoalUpdate: () => {},
		_createPreparedTurnAction: vi.fn((schedule: string, _text: string, _images: unknown, options: unknown) => ({
			schedule,
			options,
		})),
		_admitSessionInput: vi.fn(),
		...overrides,
	});
}

const context = { message: { role: "assistant", stopReason: "stop" }, context: {} };

describe("goal continuation vs unsettled subagent work", () => {
	it("defers the continuation while descendant work is unsettled", async () => {
		const mode = harness({ _hasUnsettledRlmQuiescenceWork: () => true });
		await expect(getGoalContinuation.call(mode, context)).resolves.toEqual([]);
		expect(mode._goalContinuationAwaitsRlmWork).toBe(true);
		expect(mode._goals.state.continuationsUsed).toBe(0);
	});

	it("continues normally when no descendant work is pending", async () => {
		const mode = harness();
		const messages = await getGoalContinuation.call(mode, context);
		expect(messages).toHaveLength(1);
		expect(mode._goalContinuationAwaitsRlmWork).toBe(false);
		expect(mode._goals.state.continuationsUsed).toBe(1);
	});

	it("resumes a deferred continuation exactly once, unqueued, idle-waking, and counted", async () => {
		const mode = harness({ _goalContinuationAwaitsRlmWork: true });
		await maybeResume.call(mode);
		await maybeResume.call(mode);
		expect(mode._admitSessionInput).toHaveBeenCalledTimes(1);
		const [action, options] = mode._admitSessionInput.mock.calls[0]!;
		expect((action as { options: { resumeIfIdle: boolean } }).options.resumeIfIdle).toBe(true);
		expect(options).toBeUndefined();
		expect(mode._goals.state.continuationsUsed).toBe(1);
	});

	it("keeps the deferral while admission is paused and retries after release", async () => {
		const paused = harness({
			_goalContinuationAwaitsRlmWork: true,
			_sessionInputAdmissionPauses: new Set([Symbol("pause")]),
		});
		await maybeResume.call(paused);
		expect(paused._admitSessionInput).not.toHaveBeenCalled();
		expect(paused._goalContinuationAwaitsRlmWork).toBe(true);

		paused._sessionInputAdmissionPauses.clear();
		await maybeResume.call(paused);
		expect(paused._admitSessionInput).toHaveBeenCalledTimes(1);
		expect(paused._goalContinuationAwaitsRlmWork).toBe(false);
	});

	it("keeps the deferral while the pump is suspended after an abort", async () => {
		const mode = harness({ _goalContinuationAwaitsRlmWork: true, _sessionInputPumpSuspended: true });
		await maybeResume.call(mode);
		expect(mode._admitSessionInput).not.toHaveBeenCalled();
		expect(mode._goalContinuationAwaitsRlmWork).toBe(true);
	});

	it("keeps the deferral and rolls back the count when admission throws", async () => {
		const mode = harness({
			_goalContinuationAwaitsRlmWork: true,
			_admitSessionInput: vi.fn(() => {
				throw new Error("admission race");
			}),
		});
		await maybeResume.call(mode);
		expect(mode._goalContinuationAwaitsRlmWork).toBe(true);
		expect(mode._goals.state.continuationsUsed).toBe(0);
	});

	it("keeps child-work deferral while a selected watch is parked, then resumes once", async () => {
		let parked = true;
		const mode = harness({
			_goalContinuationAwaitsRlmWork: true,
			_jobWatchController: { isParked: () => parked },
		});
		await maybeResume.call(mode);
		expect(mode._admitSessionInput).not.toHaveBeenCalled();
		expect(mode._goals.state.continuationsUsed).toBe(0);
		expect(mode._goalContinuationAwaitsRlmWork).toBe(true);
		parked = false;
		await maybeResume.call(mode);
		await maybeResume.call(mode);
		expect(mode._admitSessionInput).toHaveBeenCalledTimes(1);
		expect(mode._goals.state.continuationsUsed).toBe(1);
	});

	it("stays deferred while work remains and drops the deferral for inactive goals", async () => {
		const busy = harness({ _goalContinuationAwaitsRlmWork: true, _hasUnsettledRlmQuiescenceWork: () => true });
		await maybeResume.call(busy);
		expect(busy._admitSessionInput).not.toHaveBeenCalled();
		expect(busy._goalContinuationAwaitsRlmWork).toBe(true);

		const inactive = harness({ _goalContinuationAwaitsRlmWork: true });
		inactive._goals.restore({ ...inactive._goals.state, active: false, status: "paused" });
		await maybeResume.call(inactive);
		expect(inactive._admitSessionInput).not.toHaveBeenCalled();
		expect(inactive._goalContinuationAwaitsRlmWork).toBe(false);
	});
});
