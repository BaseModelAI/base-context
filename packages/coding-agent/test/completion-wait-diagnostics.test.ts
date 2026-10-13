import { afterEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import type { AgentAutonomousStatus } from "../src/core/autonomous.js";
import {
	CompletionWaitTimeoutError,
	observeCompletion,
	validateCompletionTimeout,
	withCompletionDeadline,
} from "../src/core/completion.js";
import { deserializeDaemonError, serializeDaemonError } from "../src/modes/daemon/daemon-errors.js";
import {
	COMPLETION_WAIT_DIAGNOSTICS_COMPATIBILITY,
	DAEMON_COMMAND_FIELD_COMPATIBILITY,
	DAEMON_DEFAULT_SERVER_CAPABILITIES,
	DAEMON_PROTOCOL_INFO,
	DAEMON_RESPONSE_FIELD_COMPATIBILITY,
	DAEMON_SCHEMA_REVISION,
	type DaemonCommand,
	failure,
	getDaemonCommandCompatibilities,
	meetsDaemonCommandCompatibility,
} from "../src/modes/daemon/daemon-protocol.js";
import { waitForHeadlessCompletion } from "../src/modes/headless-completion.js";
import { RPC_COMMAND_FIELD_COMPATIBILITY, RPC_RESPONSE_FIELD_COMPATIBILITY } from "../src/modes/rpc/rpc-types.js";

function blockerSubject(sessionId: string) {
	return {
		sessionId,
		requests: { hasPending: false },
		_pendingIpythonExecutions: new Map<string, unknown>(),
		_rlmChildAdmissions: new Set(),
		_activeRlmChildRuns: new Map(),
		_pendingRlmChildAdmissionsForQuiescence: Reflect.get(
			AgentSession.prototype,
			"_pendingRlmChildAdmissionsForQuiescence",
		) as () => unknown[],
		_deletingRlmChildren: new Set(),
		_childUsageWrites: new Set(),
		_unsettledRlmChildRuns: new Set(),
		_hasTerminalRlmQuiescenceFailure: () => false,
		_hasDeferredRlmTerminalNotices: () => false,
	};
}

function completionSession(work: Promise<void>) {
	const status = { enabled: false } as AgentAutonomousStatus;
	const subject = blockerSubject("parent");
	const child = blockerSubject("child");
	child._pendingIpythonExecutions.set("cell", {});
	const fake = {
		...subject,
		_rlmSubtreeSessions: () => [subject, child],
		waitForHeadlessIdle: vi.fn((signal?: AbortSignal) => observeCompletion(work, signal)),
		waitForRlmQuiescence: vi.fn((_external?: AbortSignal, options?: { signal?: AbortSignal }) =>
			observeCompletion(work, options?.signal),
		),
		getAutonomousStatus: vi.fn(() => status),
		getCompletionBlockers: vi.fn(() =>
			AgentSession.prototype.getCompletionBlockers.call(fake as unknown as AgentSession),
		),
	};
	return { session: fake as unknown as AgentSession, fake, child, status };
}

describe("completion wait diagnostics", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("keeps default completion and clears a successful optional deadline", async () => {
		vi.useFakeTimers();
		const { session, fake, status } = completionSession(Promise.resolve());
		expect(await waitForHeadlessCompletion(session)).toBe(status);
		expect(fake.waitForHeadlessIdle).toHaveBeenCalledWith(undefined);
		expect(fake.getCompletionBlockers).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		const external = new AbortController();
		const remove = vi.spyOn(external.signal, "removeEventListener");
		expect(
			await waitForHeadlessCompletion(session, {
				timeoutMs: 50,
				signal: external.signal,
				waitForRlmQuiescence: true,
			}),
		).toBe(status);
		expect(fake.waitForRlmQuiescence).toHaveBeenCalledWith(undefined, {
			waitForOwnedChildDeletion: true,
			signal: expect.any(AbortSignal),
		});
		expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
		expect(vi.getTimerCount()).toBe(0);
	});

	it("times out observation with current descendant blockers, leaving owned work intact and removing listeners", async () => {
		vi.useFakeTimers();
		let finish!: () => void;
		const work = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const { session, fake, child } = completionSession(work);
		const external = new AbortController();
		const externalRemove = vi.spyOn(external.signal, "removeEventListener");
		let waitSignal: AbortSignal | undefined;
		let add: MockInstance<AbortSignal["addEventListener"]> | undefined;
		let remove: MockInstance<AbortSignal["removeEventListener"]> | undefined;
		fake.waitForHeadlessIdle.mockImplementation((signal) => {
			waitSignal = signal;
			add = vi.spyOn(signal!, "addEventListener");
			remove = vi.spyOn(signal!, "removeEventListener");
			return observeCompletion(work, signal);
		});
		const waiting = waitForHeadlessCompletion(session, { timeoutMs: 40, signal: external.signal });
		const outcome = waiting.catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(40);
		const error = await outcome;
		expect(error).toBeInstanceOf(CompletionWaitTimeoutError);
		expect((error as CompletionWaitTimeoutError).diagnostics).toEqual({
			complete: false,
			elapsedMs: 40,
			blockers: [{ kind: "ipython", sessionId: "child", count: 1 }],
		});
		expect(child._pendingIpythonExecutions.size).toBe(1);
		expect(fake.getAutonomousStatus).not.toHaveBeenCalled();
		expect(waitSignal?.aborted).toBe(true);
		expect(external.signal.aborted).toBe(false);
		for (const [event, callback] of add!.mock.calls) expect(remove).toHaveBeenCalledWith(event, callback);
		expect(externalRemove).toHaveBeenCalledWith("abort", expect.any(Function));
		expect(vi.getTimerCount()).toBe(0);
		finish();
		await work;
		fake.waitForHeadlessIdle.mockImplementation((signal) => observeCompletion(work, signal));
		expect(await waitForHeadlessCompletion(session)).toBe(fake.getAutonomousStatus());
	});

	it("accepts finite nonnegative timeouts and rejects invalid values before starting observation", async () => {
		vi.useFakeTimers();
		for (const timeoutMs of [undefined, 0, 0.5, 2_147_483_648])
			expect(() => validateCompletionTimeout(timeoutMs)).not.toThrow();
		const operation = vi.fn().mockResolvedValue(undefined);
		for (const timeoutMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
			await expect(withCompletionDeadline(operation, { timeoutMs, getBlockers: () => [] })).rejects.toThrow(
				"finite and nonnegative",
			);
		}
		await expect(withCompletionDeadline(operation, { timeoutMs: 0, getBlockers: () => [] })).rejects.toBeInstanceOf(
			CompletionWaitTimeoutError,
		);
		expect(operation).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("gates only optional wait fields for old peers and roundtrips timeout diagnostics", () => {
		const current = {
			protocol: DAEMON_PROTOCOL_INFO,
			schemaRevision: DAEMON_SCHEMA_REVISION,
			serverCapabilities: DAEMON_DEFAULT_SERVER_CAPABILITIES,
		};
		const older = {
			...current,
			schemaRevision: 51,
			serverCapabilities: DAEMON_DEFAULT_SERVER_CAPABILITIES.filter(
				(capability) => capability !== "completion_wait_diagnostics",
			),
		};
		const ordinary: DaemonCommand = { type: "wait_for_headless_completion", activeSessionId: "parent" };
		const timed: DaemonCommand = { ...ordinary, timeoutMs: 10 };
		const supported = (command: DaemonCommand, peer: typeof older | typeof current) =>
			getDaemonCommandCompatibilities(command).every((requirement) =>
				meetsDaemonCommandCompatibility(peer, requirement),
			);
		expect(supported(ordinary, older)).toBe(true);
		expect(supported(ordinary, current)).toBe(true);
		expect(supported(timed, older)).toBe(false);
		expect(supported(timed, current)).toBe(true);
		expect(DAEMON_COMMAND_FIELD_COMPATIBILITY.wait_for_headless_completion.timeoutMs).toBe(
			COMPLETION_WAIT_DIAGNOSTICS_COMPATIBILITY,
		);
		expect(DAEMON_RESPONSE_FIELD_COMPATIBILITY.wait_for_headless_completion.errorInfo).toBe(
			COMPLETION_WAIT_DIAGNOSTICS_COMPATIBILITY,
		);
		expect(RPC_COMMAND_FIELD_COMPATIBILITY.wait_for_completion.timeoutMs).toBe(
			COMPLETION_WAIT_DIAGNOSTICS_COMPATIBILITY,
		);
		expect(RPC_RESPONSE_FIELD_COMPATIBILITY.wait_for_completion.errorInfo).toBe(
			COMPLETION_WAIT_DIAGNOSTICS_COMPATIBILITY,
		);
		const original = new CompletionWaitTimeoutError({
			complete: false,
			elapsedMs: 10,
			blockers: [{ kind: "child_runs", sessionId: "parent", count: 1 }],
		});
		const response = failure("wait-1", ordinary.type, original, serializeDaemonError(original));
		if (response.success) throw new Error("Expected timeout failure");
		const restored = deserializeDaemonError(JSON.parse(JSON.stringify(response)));
		expect(restored).toBeInstanceOf(CompletionWaitTimeoutError);
		expect((restored as CompletionWaitTimeoutError).diagnostics).toEqual(original.diagnostics);
	});
});
