import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import {
	DAEMON_DEFAULT_SERVER_CAPABILITIES,
	DAEMON_PROTOCOL_INFO,
	DAEMON_SCHEMA_REVISION,
	type DaemonCommand,
	type DaemonResponse,
} from "../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import { DaemonWorkerClient } from "../src/modes/daemon/daemon-worker-client.js";

interface TestWorker {
	client?: DaemonWorkerClient;
	descriptor: { workerId: string };
	transcriptCaches: Map<string, unknown>;
	snapshotCache: Map<string, unknown>;
}

interface SupervisorHarness {
	syncStatusSummaryInterest(target?: TestWorker): void;
	waitForWorkerCompletion(
		client: DaemonSocketClient,
		command: Extract<DaemonCommand, { type: "wait_for_headless_completion" }>,
	): Promise<DaemonResponse>;
	failWorkerSnapshotCache(
		worker: TestWorker,
		activeSessionId: string,
		error: Error,
		closeWorkerChannel: boolean,
	): void;
}

function peer(observed = false): DaemonSocketClient {
	return { socket: new EventEmitter() as Socket, rosterSubscribed: observed } as DaemonSocketClient;
}

function worker(supported = true) {
	const requestWorker = vi
		.fn()
		.mockResolvedValue({ type: "response", command: "worker_set_status_summary_interest", success: true });
	const request = vi
		.fn()
		.mockResolvedValue({ type: "response", command: "wait_for_headless_completion", success: true, data: {} });
	const close = vi.fn();
	const client = {
		supportsServerCapability: () => supported,
		requestWorker,
		request,
		close,
	} as unknown as DaemonWorkerClient;
	const value: TestWorker = {
		client,
		descriptor: { workerId: "worker" },
		transcriptCaches: new Map(),
		snapshotCache: new Map(),
	};
	return { value, client, requestWorker, request, close };
}

function harness(clients: DaemonSocketClient[], workers: TestWorker[]) {
	const log = vi.fn();
	const handleWorkerClose = vi.fn();
	const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
		clients: new Set(clients),
		workers: new Map(workers.map((value, index) => [String(index), value])),
		statusSummaryInterests: new WeakMap(),
		statusSummaryInterestUpdates: new WeakSet(),
		ready: Promise.resolve(),
		protocolClientIds: new WeakMap(),
		cancelOwnedWorkerCleanup: vi.fn(),
		assertServingCurrentOwnership: vi.fn().mockResolvedValue(undefined),
		log,
		handleWorkerClose,
		findWorkerForClient: vi.fn().mockResolvedValue({ worker: workers[0], summary: { id: "root" } }),
		requireAvailableWorkerClient: () => workers[0]!.client,
	}) as SupervisorHarness;
	return { supervisor, log, handleWorkerClose };
}

describe("optional daemon completion and recap observations", () => {
	it("propagates roster interest, not headless attachment, only to capable workers", async () => {
		const current = worker();
		const legacy = worker(false);
		const observer = peer();
		const { supervisor } = harness([observer], [current.value, legacy.value]);
		supervisor.syncStatusSummaryInterest();
		expect(current.requestWorker).toHaveBeenLastCalledWith({
			type: "worker_set_status_summary_interest",
			observed: false,
		});
		expect(legacy.requestWorker).not.toHaveBeenCalled();
		await new Promise<void>((resolve) => setImmediate(resolve));
		observer.rosterSubscribed = true;
		supervisor.syncStatusSummaryInterest();
		supervisor.syncStatusSummaryInterest();
		expect(current.requestWorker).toHaveBeenCalledTimes(2);
		expect(current.requestWorker).toHaveBeenLastCalledWith({
			type: "worker_set_status_summary_interest",
			observed: true,
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		observer.rosterSubscribed = false;
		supervisor.syncStatusSummaryInterest();
		expect(current.requestWorker).toHaveBeenLastCalledWith({
			type: "worker_set_status_summary_interest",
			observed: false,
		});
		await Promise.resolve();
	});

	it("serializes recap-interest transitions across a held worker admission", async () => {
		const current = worker();
		const observer = peer(true);
		const { supervisor } = harness([observer], [current.value]);
		let release!: (response: DaemonResponse) => void;
		current.requestWorker.mockImplementationOnce(
			() =>
				new Promise<DaemonResponse>((resolve) => {
					release = resolve;
				}),
		);
		supervisor.syncStatusSummaryInterest();
		observer.rosterSubscribed = false;
		supervisor.syncStatusSummaryInterest();
		expect(current.requestWorker).toHaveBeenCalledTimes(1);
		release({ type: "response", command: "worker_set_status_summary_interest", success: true });
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(current.requestWorker).toHaveBeenLastCalledWith({
			type: "worker_set_status_summary_interest",
			observed: false,
		});
		expect(current.requestWorker).toHaveBeenCalledTimes(2);
	});

	it.each([1000, undefined])(
		"returns a wait result and cancels only a disconnected observation (%s)",
		async (timeoutMs) => {
			const current = worker();
			const observer = peer();
			const { supervisor } = harness([observer], [current.value]);
			const command = {
				id: "public",
				type: "wait_for_headless_completion",
				activeSessionId: "root",
				timeoutMs,
				waitForRlmQuiescence: true,
			} as const;
			await expect(supervisor.waitForWorkerCompletion(observer, command)).resolves.toMatchObject({
				id: "public",
				success: true,
			});
			expect(observer.socket.listenerCount("close")).toBe(0);
			expect(current.request.mock.calls[0]![0]).toMatchObject({
				waitForRlmQuiescence: true,
				waitId: expect.any(String),
				...(timeoutMs === undefined ? {} : { timeoutMs: expect.any(Number) }),
			});
			let sent!: () => void;
			const admitted = new Promise<void>((resolve) => {
				sent = resolve;
			});
			current.request.mockImplementationOnce(() => {
				sent();
				return new Promise(() => {});
			});
			const pending = supervisor.waitForWorkerCompletion(observer, command);
			const rejected = expect(pending).rejects.toThrow("Completion wait client disconnected");
			await admitted;
			observer.socket.emit("close");
			await rejected;
			expect(current.requestWorker).toHaveBeenLastCalledWith(
				{ type: "worker_cancel_completion_wait", waitId: current.request.mock.calls[1]![0].waitId },
				5000,
			);
			expect(observer.socket.listenerCount("close")).toBe(0);
			expect(current.close).not.toHaveBeenCalled();
		},
	);

	it("keeps untimed completion usable with a worker lacking optional diagnostics", async () => {
		const legacy = worker(false);
		const observer = peer();
		const { supervisor } = harness([observer], [legacy.value]);
		await expect(
			supervisor.waitForWorkerCompletion(observer, {
				type: "wait_for_headless_completion",
				activeSessionId: "root",
			}),
		).resolves.toMatchObject({ success: true });
		expect(legacy.request.mock.calls[0]![0]).not.toHaveProperty("waitId");
		expect(legacy.request.mock.calls[0]![0]).not.toHaveProperty("timeoutMs");
		expect(legacy.requestWorker).not.toHaveBeenCalled();
	});

	it("bounds an unresponsive worker transport and cancels only its observation", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
		try {
			const current = worker();
			const observer = peer();
			const { supervisor } = harness([observer], [current.value]);
			const transport = new DaemonWorkerClient("/unused");
			const channel = { send: vi.fn().mockResolvedValue(undefined), close: vi.fn() };
			const socket = { destroyed: false, destroy: vi.fn() };
			Reflect.set(transport, "channel", channel);
			Reflect.set(transport, "socket", socket);
			Reflect.set(transport, "helloMessage", {
				type: "daemon_hello",
				protocol: DAEMON_PROTOCOL_INFO,
				schemaRevision: DAEMON_SCHEMA_REVISION,
				serverCapabilities: DAEMON_DEFAULT_SERVER_CAPABILITIES,
			});
			current.request.mockImplementation((...args: Parameters<DaemonWorkerClient["request"]>) =>
				transport.request(...args),
			);
			let settled = false;
			const pending = supervisor.waitForWorkerCompletion(observer, {
				type: "wait_for_headless_completion",
				activeSessionId: "root",
				timeoutMs: 20,
			});
			void pending.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			const rejection = expect(pending).rejects.toMatchObject({
				diagnostics: {
					complete: false,
					elapsedMs: 1020,
					blockers: [{ kind: "worker_response", id: "root" }],
				},
			});
			await vi.advanceTimersByTimeAsync(20);
			expect(settled).toBe(false);
			expect(current.request.mock.calls[0]![1]).toBe(1020);
			await vi.advanceTimersByTimeAsync(1000);
			await rejection;
			expect(current.requestWorker).toHaveBeenLastCalledWith(
				{
					type: "worker_cancel_completion_wait",
					waitId: current.request.mock.calls[0]![0].waitId,
				},
				5000,
			);
			expect((Reflect.get(transport, "pending") as Map<string, unknown>).size).toBe(0);
			expect(observer.socket.listenerCount("close")).toBe(0);
			expect(vi.getTimerCount()).toBe(0);
			expect(channel.close).not.toHaveBeenCalled();
			expect(socket.destroy).not.toHaveBeenCalled();
			expect(current.close).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("includes supervisor admission in the completion deadline", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		try {
			const current = worker();
			const observer = peer();
			const { supervisor } = harness([observer], [current.value]);
			Reflect.set(supervisor, "ready", new Promise<void>(() => {}));
			const pending = supervisor.waitForWorkerCompletion(observer, {
				type: "wait_for_headless_completion",
				activeSessionId: "root",
				timeoutMs: 20,
			});
			const rejection = expect(pending).rejects.toMatchObject({
				diagnostics: {
					complete: false,
					elapsedMs: 20,
					blockers: [{ kind: "supervisor_admission", id: "root" }],
				},
			});
			await vi.advanceTimersByTimeAsync(20);
			await rejection;
			expect(current.request).not.toHaveBeenCalled();
			expect(observer.socket.listenerCount("close")).toBe(0);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps the concrete snapshot failure when closing the shared worker client", () => {
		const current = worker();
		const { supervisor, handleWorkerClose } = harness([], [current.value]);
		const failure = new Error("Snapshot fragment identity mismatch");
		supervisor.failWorkerSnapshotCache(current.value, "root", failure, true);
		expect(handleWorkerClose).toHaveBeenCalledWith(current.value, current.client, failure);
		expect(current.close).toHaveBeenCalledWith(failure);
	});
});
