import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import * as childProcess from "../src/utils/child-process.js";

interface StoppingSupervisor {
	stopWorker(worker: object, removeDescriptor: boolean): Promise<void>;
}

function createStoppingWorker() {
	const state = { alive: true };
	const client = { request: vi.fn().mockResolvedValue(undefined), close: vi.fn() };
	const worker = {
		descriptor: {
			workerId: "owned-worker",
			pid: 111_223,
			processStartId: "proc:owned-worker",
			rootActiveSessionId: "owned-session",
			stopRequestedAt: undefined as string | undefined,
		},
		client,
		snapshotCache: new Map(),
		transcriptCaches: new Map(),
		snapshotGenerations: new Map(),
		stopRevision: 0,
	};
	const workers = new Map([[worker.descriptor.workerId, worker]]);
	const methods = {
		workers,
		shuttingDown: false,
		processIdentity: vi.fn().mockReturnValue("current"),
		persistWorkerStopTombstone: vi.fn(() => {
			worker.descriptor.stopRequestedAt = new Date().toISOString();
		}),
		scheduleWorkerStopFinalization: vi.fn(),
		invalidateWorkerSessionInputPauses: vi.fn(),
		releaseWorkerRlmCapacity: vi.fn(),
		flipWorkerRosterEntriesInactive: vi.fn(),
		deleteWorkerDescriptor: vi.fn(),
		broadcastHeartbeatsChanged: vi.fn(),
	};
	const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), methods) as StoppingSupervisor;
	vi.spyOn(childProcess, "processIdExists").mockImplementation(() => state.alive);
	const signal = vi.spyOn(childProcess, "signalProcessGroupOrProcess").mockImplementation(() => {});
	return { supervisor, worker, client, methods, state, signal };
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("owned worker graceful shutdown", () => {
	it("waits for a normal process exit beyond the old two-second grace", async () => {
		vi.useFakeTimers();
		const { supervisor, worker, client, methods, state, signal } = createStoppingWorker();
		let settled = false;
		const stopping = supervisor.stopWorker(worker, true).then(() => {
			settled = true;
		});
		setTimeout(() => {
			state.alive = false;
		}, 3000);

		await vi.advanceTimersByTimeAsync(2000);
		expect(settled).toBe(false);
		expect(methods.workers.has(worker.descriptor.workerId)).toBe(true);
		expect(methods.deleteWorkerDescriptor).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1000);
		await stopping;
		expect(client.request).toHaveBeenCalledWith({ type: "shutdown" }, 5000);
		expect(settled).toBe(true);
		expect(methods.workers.has(worker.descriptor.workerId)).toBe(false);
		expect(methods.deleteWorkerDescriptor).toHaveBeenCalledWith(worker);
		expect(methods.scheduleWorkerStopFinalization).not.toHaveBeenCalled();
		expect(signal).not.toHaveBeenCalled();
	});

	it("keeps the stop tombstone and reports a worker still alive after twenty seconds", async () => {
		vi.useFakeTimers();
		const { supervisor, worker, methods, signal } = createStoppingWorker();
		let settled = false;
		const stopping = supervisor.stopWorker(worker, true).then(
			() => undefined,
			(error: unknown) => {
				settled = true;
				return error;
			},
		);

		await vi.advanceTimersByTimeAsync(19_975);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(25);
		const error = await stopping;
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("Session worker owned-worker did not stop");
		expect(worker.descriptor.stopRequestedAt).toBeDefined();
		expect(methods.workers.has(worker.descriptor.workerId)).toBe(true);
		expect(methods.deleteWorkerDescriptor).not.toHaveBeenCalled();
		expect(methods.scheduleWorkerStopFinalization).toHaveBeenCalledWith(worker);
		expect(signal).not.toHaveBeenCalled();
	});
});
