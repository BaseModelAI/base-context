import { afterEach, describe, expect, it, vi } from "vitest";
import * as sessionLease from "../src/core/session-lease.js";
import {
	DAEMON_PROTOCOL_INFO,
	DAEMON_PROTOCOL_NAME,
	DAEMON_SCHEMA_ID,
	DAEMON_SCHEMA_REVISION,
	type DaemonOutbound,
} from "../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import { DaemonWorkerClient, DaemonWorkerCompatibilityError } from "../src/modes/daemon/daemon-worker-client.js";
import type { DaemonWorkerDescriptor } from "../src/modes/daemon/daemon-worker-protocol.js";
import * as childProcess from "../src/utils/child-process.js";

interface TestWorker {
	descriptor: DaemonWorkerDescriptor;
	client?: DaemonWorkerClient;
	compatibilityError?: DaemonWorkerCompatibilityError;
	ownerCleanupTimer?: ReturnType<typeof setTimeout>;
	intentionalStop: boolean;
	stopRevision: number;
	deferredRecoveryRounds: number;
}

interface SupervisorHarness {
	adoptOrRecoverWorker(worker: TestWorker): Promise<void>;
	recoverWorker(worker: TestWorker): Promise<void>;
	connectWorker(worker: TestWorker, timeoutMs: number): Promise<DaemonWorkerClient>;
	reclaimStaleWorkerRegistration(worker: TestWorker, freshCreate: boolean): Promise<boolean>;
	scheduleOwnedWorkerCleanup(worker: TestWorker): void;
}

const legacyHello = {
	type: "daemon_hello",
	socketPath: "/mock/worker.sock",
	protocol: { name: DAEMON_PROTOCOL_NAME, version: 8 },
	schemaId: DAEMON_SCHEMA_ID,
	schemaRevision: 27,
	appVersion: "old",
	clientId: "supervisor",
	serverCapabilities: [],
} satisfies Extract<DaemonOutbound, { type: "daemon_hello" }>;

afterEach(() => {
	vi.clearAllTimers();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("supervisor compatibility refusal", () => {
	it.each([
		{ operation: "adoptOrRecoverWorker", owned: false },
		{ operation: "adoptOrRecoverWorker", owned: true },
		{ operation: "recoverWorker", owned: false },
		{ operation: "recoverWorker", owned: true },
	] as const)("parks $operation (owned=$owned) without replacing its live owner", async ({ operation, owned }) => {
		vi.useFakeTimers();
		const timers = vi.spyOn(globalThis, "setTimeout");
		vi.spyOn(childProcess, "isProcessAlive").mockReturnValue(true);
		vi.spyOn(sessionLease, "getProcessStartId").mockReturnValue("start-1");
		const connect = vi.spyOn(DaemonWorkerClient.prototype, "connect").mockResolvedValue();
		const hello = vi.spyOn(DaemonWorkerClient.prototype, "waitForHello").mockResolvedValue(legacyHello);
		const close = vi.spyOn(DaemonWorkerClient.prototype, "close").mockImplementation(() => {});
		const refusal = new DaemonWorkerCompatibilityError(legacyHello);
		const authenticate = vi.spyOn(DaemonWorkerClient.prototype, "authenticateWorker").mockRejectedValue(refusal);
		const worker: TestWorker = {
			descriptor: {
				version: 2,
				workerId: "worker-1",
				pid: 12345,
				processStartId: "start-1",
				workerInstanceId: "incarnation-1",
				socketPath: "/mock/worker.sock",
				supervisorSocketPath: "/mock/supervisor.sock",
				authenticationToken: "mock-token",
				rootActiveSessionId: "active-1",
				recoveryJournalPath: "/mock/recovery.jsonl",
				ownerClientId: owned ? "owner-1" : undefined,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
				lifecycle: "recovering",
				createCommand: { type: "create" },
				consecutiveFailures: 2,
				lastFailureAt: "2026-01-01T00:00:00.000Z",
			},
			intentionalStop: false,
			stopRevision: 3,
			deferredRecoveryRounds: 4,
		};
		const workers = new Map([[worker.descriptor.workerId, worker]]);
		const effects = {
			persistWorker: vi.fn(),
			markWorkerRosterEntries: vi.fn(),
			subscribeWorker: vi.fn(),
			refreshWorkerSummaries: vi.fn(),
			recoverUncertainWorkerOperations: vi.fn(),
			launchWorker: vi.fn(),
			stopWorker: vi.fn().mockResolvedValue(undefined),
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), effects, {
			workers,
			clients: new Set(),
			assertRecoveryAllowed: vi.fn().mockResolvedValue(undefined),
			supervisorAuthenticationClaim: vi.fn(() => ({})),
			processIdentity: vi.fn(() => "current"),
			log: vi.fn(),
		}) as SupervisorHarness;
		const originalDescriptor = { ...worker.descriptor };
		supervisor.scheduleOwnedWorkerCleanup(worker);
		const cleanupCallback = timers.mock.calls.find(([, delay]) => delay === 30_000)?.[0];
		const parking = supervisor[operation](worker);
		await vi.advanceTimersByTimeAsync(250);
		await parking;

		expect(worker.descriptor).toEqual({ ...originalDescriptor, lastError: refusal.message });
		expect(worker.compatibilityError).toBe(refusal);
		expect(worker.client).toBeUndefined();
		expect(worker.ownerCleanupTimer).toBeUndefined();
		expect(worker.intentionalStop).toBe(false);
		expect(worker.stopRevision).toBe(3);
		expect(worker.deferredRecoveryRounds).toBe(4);
		expect(workers.get("worker-1")).toBe(worker);
		expect(connect).toHaveBeenCalledTimes(1);
		expect(close).toHaveBeenCalledTimes(1);
		expect(effects.subscribeWorker).not.toHaveBeenCalled();
		expect(effects.recoverUncertainWorkerOperations).not.toHaveBeenCalled();
		expect(effects.launchWorker).not.toHaveBeenCalled();
		expect(await supervisor.reclaimStaleWorkerRegistration(worker, true)).toBe(false);
		supervisor.scheduleOwnedWorkerCleanup(worker);
		// Even an already-queued callback must leave the incompatible owner alone.
		if (typeof cleanupCallback === "function") cleanupCallback();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(connect).toHaveBeenCalledTimes(1);
		expect(effects.stopWorker).not.toHaveBeenCalled();

		hello.mockResolvedValue({
			...legacyHello,
			protocol: DAEMON_PROTOCOL_INFO,
			schemaRevision: DAEMON_SCHEMA_REVISION,
			serverCapabilities: ["native_inference_ownership"],
		});
		authenticate.mockResolvedValue({
			type: "response",
			command: "worker_auth",
			success: true,
			data: { capabilities: ["agent_roster"] },
		});
		await supervisor.connectWorker(worker, 2000);
		expect(worker.compatibilityError).toBeUndefined();
		expect(worker.descriptor.lastError).toBeUndefined();
		expect(worker.client).toBeDefined();
		supervisor.scheduleOwnedWorkerCleanup(worker);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(effects.stopWorker).toHaveBeenCalledTimes(owned ? 1 : 0);
	});
});
