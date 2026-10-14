import { describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { DaemonCommand, DaemonResponse } from "../src/modes/daemon/daemon-protocol.js";
import { DaemonRlmCapacityCoordinator } from "../src/modes/daemon/daemon-rlm-capacity-coordinator.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import { createDeferred } from "./suite/scheduling.js";

type CapacityCommand = Extract<DaemonCommand, { type: "rlm_capacity" }>;
interface CapacityHarness {
	handleRlmCapacity(command: CapacityCommand): Promise<DaemonResponse>;
}

interface ReclaimHarness {
	reclaimStaleWorkerRegistration(worker: unknown): Promise<boolean>;
}

function createHarness(capacity: DaemonRlmCapacityCoordinator, family: () => Promise<string>): CapacityHarness {
	const worker = {
		descriptor: {
			workerId: "worker",
			workerInstanceId: "instance",
			authenticationToken: "token",
			pid: process.pid,
			sessionDir: "/fixture",
		},
	};
	return Object.assign(Object.create(DaemonSupervisor.prototype), {
		workers: new Map([["worker", worker]]),
		rlmCapacity: capacity,
		pendingRlmCapacity: new Set(),
		rlmCapacityAdmissions: new Set(),
		releasedDuringCapacityRecovery: new Map(),
		processIdentity: () => "current",
		assertRlmJournalAdmission: () => ({ ledgerPath: "/fixture/ledger.jsonl" }),
		rlmJournalScope: () => ({ journalPath: "/fixture/ledger.jsonl" }),
		rlmCapacityFamily: family,
		assertServingCurrentOwnership: async () => {},
	}) as CapacityHarness;
}

function command(operation: CapacityCommand["operation"]): CapacityCommand {
	return { type: "rlm_capacity", workerToken: "token", workerInstanceId: "instance", operation };
}

describe("daemon capacity release ordering", () => {
	it.each(["current", "gone"])("keeps capacity until a failed worker is gone (%s)", async (identity) => {
		const capacity = new DaemonRlmCapacityCoordinator(SettingsManager.inMemory());
		await capacity.setMaxSubagents("family", 1);
		capacity.reserve("worker:instance", "child", "family");
		const worker = { descriptor: { workerId: "worker", workerInstanceId: "instance", lifecycle: "failed" } };
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([["worker", worker]]),
			rlmCapacity: capacity,
			pendingRlmCapacity: new Set(),
			releasedDuringCapacityRecovery: new Map(),
			processIdentity: () => identity,
			recoverUncertainWorkerOperations: async () => {},
			invalidateWorkerSessionInputPauses: () => {},
			flipWorkerRosterEntriesInactive: () => {},
			deleteWorkerDescriptor: () => {},
		}) as ReclaimHarness;
		expect(await supervisor.reclaimStaleWorkerRegistration(worker)).toBe(identity === "gone");
		if (identity === "gone") expect(() => capacity.reserve("replacement", "next", "family")).not.toThrow();
		else expect(() => capacity.reserve("replacement", "next", "family")).toThrow("limit reached");
	});

	it("releases an admitted claim without cancelling a different pending reservation", async () => {
		const family = createDeferred<string>();
		const capacity = new DaemonRlmCapacityCoordinator(SettingsManager.inMemory());
		await capacity.setMaxSubagents("family", 1);
		capacity.reserve("worker:instance", "first", "family");
		const supervisor = createHarness(capacity, () => family.promise);
		const pending = supervisor.handleRlmCapacity(
			command({ op: "reserve", reservationId: "second", sessionId: "root", sessionFile: "/fixture/root.jsonl" }),
		);
		await supervisor.handleRlmCapacity(command({ op: "release", reservationId: "first" }));
		family.resolve("family");
		expect((await pending).success).toBe(true);
		expect(() => capacity.reserve("other", "third", "family")).toThrow("limit reached");
		await supervisor.handleRlmCapacity(command({ op: "release", reservationId: "second" }));
		expect(() => capacity.reserve("other", "third", "family")).not.toThrow();
	});

	it("does not restore a claim after its release was acknowledged during family lookup", async () => {
		const family = createDeferred<string>();
		const capacity = new DaemonRlmCapacityCoordinator(SettingsManager.inMemory());
		await capacity.setMaxSubagents("family", 1);
		const supervisor = createHarness(capacity, () => family.promise);
		const pending = supervisor.handleRlmCapacity(
			command({ op: "reserve", reservationId: "abandoned", sessionId: "root", sessionFile: "/fixture/root.jsonl" }),
		);
		expect((await supervisor.handleRlmCapacity(command({ op: "release", reservationId: "abandoned" }))).success).toBe(
			true,
		);
		family.resolve("family");
		await expect(pending).rejects.toThrow("released during admission");
		expect(() => capacity.reserve("worker:instance", "next", "family")).not.toThrow();
	});
});
