import { describe, expect, it, vi } from "vitest";
import type { WorkerEvictionSnapshot } from "../src/core/session-action-store.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import { MutationDrainLatch } from "../src/modes/daemon/mutation-drain-latch.js";

interface SupervisorFixture {
	runIdleEvictionSweep(now: number): Promise<void>;
	idleEvictionFence?: Promise<void>;
}

function fixture(hasOwnerClient: boolean) {
	const now = Date.parse("2026-08-01T12:00:00.000Z");
	const worker = {
		descriptor: { workerId: "worker", rootActiveSessionId: "root" },
		summaries: new Map(),
		client: { requestWorker: vi.fn(async () => ({ success: true })) },
	};
	const snapshot: WorkerEvictionSnapshot = {
		lifecycle: "ready",
		isConnected: true,
		isStopping: false,
		hasOwnerClient,
		isPreparingUpdateRestart: false,
		hasWakeBlindSchedule: false,
		sessions: [
			{
				isSessionActive: false,
				attachedClients: 0,
				hasRegisteredCronJob: false,
				lastActivityAt: now - 120 * 60_000,
			},
		],
	};
	const mutationDrain = new MutationDrainLatch();
	const refreshWorkerSummaries = vi.fn(async () => {});
	const stopWorker = vi.fn(async () => {});
	const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype) as SupervisorFixture, {
		shuttingDown: false,
		settingsManager: { reload: async () => {}, getIdleEvictionMinutes: () => 90 },
		workers: new Map([["worker", worker]]),
		mutationDrain,
		refreshWorkerSummaries,
		workerEvictionSnapshot: () => snapshot,
		stopWorker,
		log: vi.fn(),
	});
	return { supervisor, worker, mutationDrain, refreshWorkerSummaries, stopWorker, now };
}

describe("idle eviction no-op sweep", () => {
	it("still drains and rechecks an eligible whole worker before eviction", async () => {
		const { supervisor, worker, mutationDrain, refreshWorkerSummaries, stopWorker, now } = fixture(false);
		const drain = vi.spyOn(mutationDrain, "waitForDrain");

		await supervisor.runIdleEvictionSweep(now);

		expect(drain).toHaveBeenCalledOnce();
		expect(refreshWorkerSummaries).toHaveBeenCalledTimes(2);
		expect(worker.client.requestWorker).not.toHaveBeenCalled();
		expect(stopWorker).toHaveBeenCalledWith(worker, true);
		expect(supervisor.idleEvictionFence).toBeUndefined();
	});

	it("passivates children without fencing unrelated mutations when no whole worker is eligible", async () => {
		const { supervisor, worker, mutationDrain, refreshWorkerSummaries, stopWorker, now } = fixture(true);
		const drain = vi.spyOn(mutationDrain, "waitForDrain");
		mutationDrain.begin();
		try {
			await supervisor.runIdleEvictionSweep(now);

			expect(worker.client.requestWorker).toHaveBeenCalledWith(
				{ type: "worker_passivate_idle_children", idleEvictionMinutes: 90, now, limit: 2 },
				30_000,
			);
			expect(refreshWorkerSummaries).toHaveBeenCalledTimes(2);
			expect(drain).not.toHaveBeenCalled();
			expect(stopWorker).not.toHaveBeenCalled();
			expect(supervisor.idleEvictionFence).toBeUndefined();
		} finally {
			mutationDrain.end();
		}
	});
});
