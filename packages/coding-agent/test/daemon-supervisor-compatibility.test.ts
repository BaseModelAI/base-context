import { afterEach, describe, expect, it, vi } from "vitest";
import * as sessionLease from "../src/core/session-lease.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import {
	createDaemonCommandEnvelope,
	DAEMON_PROTOCOL_INFO,
	DAEMON_PROTOCOL_NAME,
	DAEMON_SCHEMA_ID,
	DAEMON_SCHEMA_REVISION,
	type DaemonCommand,
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

const baseLegacyHello = {
	type: "daemon_hello",
	socketPath: "/mock/worker.sock",
	protocol: { name: DAEMON_PROTOCOL_NAME, version: 8 },
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
	it.each(
		[8, 9].flatMap(
			(version) =>
				[
					{ operation: "adoptOrRecoverWorker", owned: false, version },
					{ operation: "adoptOrRecoverWorker", owned: true, version },
					{ operation: "recoverWorker", owned: false, version },
					{ operation: "recoverWorker", owned: true, version },
				] as const,
		),
	)(
		"parks protocol$version $operation (owned=$owned) without replacing its live owner",
		async ({ operation, owned, version }) => {
			const legacyHello = {
				...baseLegacyHello,
				protocol: { name: DAEMON_PROTOCOL_NAME, version },
				schemaRevision: version === 8 ? 27 : 28,
				serverCapabilities: version === 9 ? ["native_inference_ownership" as const] : [],
			};
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

			const acquireStop = vi.fn();
			const persistStop = vi.fn();
			const stopSupervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
				acquireWorkerStopOwnership: acquireStop,
				persistWorker: persistStop,
			}) as {
				stopWorker(worker: TestWorker, remove: boolean, force: boolean, archive: boolean): Promise<void>;
				persistWorkerStopTombstone(worker: TestWorker, archive: boolean): void;
			};
			await expect(stopSupervisor.stopWorker(worker, true, true, true)).rejects.toBe(refusal);
			expect(() => stopSupervisor.persistWorkerStopTombstone(worker, true)).toThrow(refusal);
			expect(acquireStop).not.toHaveBeenCalled();
			expect(persistStop).not.toHaveBeenCalled();
			expect(worker.descriptor).toEqual({ ...originalDescriptor, lastError: refusal.message });
			expect(worker.intentionalStop).toBe(false);
			expect(worker.stopRevision).toBe(3);

			hello.mockResolvedValue({
				...legacyHello,
				protocol: DAEMON_PROTOCOL_INFO,
				schemaId: DAEMON_SCHEMA_ID,
				schemaRevision: DAEMON_SCHEMA_REVISION,
				serverCapabilities: ["native_inference_ownership", "canonical_session_ownership"],
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
		},
	);

	it.each([8, 9])("refuses protocol%s public work before registering admission", (version) => {
		for (const prototype of [DaemonSupervisor.prototype, AgentDaemon.prototype]) {
			const admissions = new Map();
			const admissionStore = vi.fn(() => admissions);
			const parser = Object.assign(Object.create(prototype), {
				options: { worker: false },
				promptAdmissions: admissions,
				promptAdmissionsFor: admissionStore,
			}) as {
				parseCommandAndRegisterPromptAdmission(client: { id: string }, line: string): unknown;
			};
			const client = { id: "transport-client" };
			for (const command of [
				{ type: "prompt", activeSessionId: "active", admissionId: "pending", message: "hello" },
				{ type: "attach", activeSessionId: "active", recoveryConfig: { cwd: "/tmp" } },
				{ type: "shutdown", force: true },
			] satisfies DaemonCommand[]) {
				const envelope = createDaemonCommandEnvelope(command, "command", "legacy-client", version);
				expect(() => parser.parseCommandAndRegisterPromptAdmission(client, JSON.stringify(envelope))).toThrow(
					"protocol 10 canonical session ownership",
				);
			}
			expect(admissions.size).toBe(0);
			expect(admissionStore).not.toHaveBeenCalled();
			expect(client.id).toBe("transport-client");
			expect(() =>
				parser.parseCommandAndRegisterPromptAdmission(
					client,
					JSON.stringify(createDaemonCommandEnvelope({ type: "list" }, "inspect", "legacy-client", version)),
				),
			).not.toThrow();
			expect(() =>
				parser.parseCommandAndRegisterPromptAdmission(
					client,
					JSON.stringify(createDaemonCommandEnvelope({ type: "create" }, "current", "current-client")),
				),
			).not.toThrow();
		}
	});

	it("refuses raw and versionless public work without changing private worker framing", () => {
		for (const prototype of [DaemonSupervisor.prototype, AgentDaemon.prototype]) {
			const admissions = new Map();
			const admissionStore = vi.fn(() => admissions);
			const parser = Object.assign(Object.create(prototype), {
				options: { worker: false },
				promptAdmissions: admissions,
				promptAdmissionsFor: admissionStore,
			}) as {
				parseCommandAndRegisterPromptAdmission(client: { id: string }, line: string): unknown;
			};
			const client = { id: "transport-client" };
			for (const command of [
				{ type: "prompt", activeSessionId: "active", admissionId: "pending", message: "hello" },
				{ type: "attach", activeSessionId: "active", recoveryConfig: { cwd: "/tmp" } },
				{ type: "shutdown", force: true },
			] satisfies DaemonCommand[]) {
				const versionless = {
					...createDaemonCommandEnvelope(command, "command", "legacy-client"),
					protocol: { name: DAEMON_PROTOCOL_NAME },
				};
				for (const wire of [command, versionless]) {
					expect(() => parser.parseCommandAndRegisterPromptAdmission(client, JSON.stringify(wire))).toThrow();
				}
			}
			expect(admissions.size).toBe(0);
			expect(admissionStore).not.toHaveBeenCalled();
			expect(client.id).toBe("transport-client");
			const inspect = () => parser.parseCommandAndRegisterPromptAdmission(client, '{"type":"list"}');
			if (prototype === AgentDaemon.prototype) expect(inspect).not.toThrow();
			else expect(inspect).toThrow("Daemon commands require protocol 8 or newer");
		}
		const workerParser = Object.assign(Object.create(AgentDaemon.prototype), { options: { worker: {} } }) as {
			parseCommandAndRegisterPromptAdmission(client: { id: string }, line: string): unknown;
		};
		expect(workerParser.parseCommandAndRegisterPromptAdmission({ id: "worker" }, '{"type":"create"}')).toEqual({
			type: "create",
		});
	});
});
