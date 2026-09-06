import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalSessionPath } from "../src/core/session-lease.js";
import type { DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import {
	createDaemonCommandEnvelope,
	type DaemonCommand,
	type DaemonResponse,
} from "../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import { MutationDrainLatch } from "../src/modes/daemon/mutation-drain-latch.js";
import { type RlmSpawnLedger, rlmLedgerPath } from "../src/modes/daemon/rlm-ledger.js";
import type { RlmLedgerMutation } from "../src/modes/daemon/rlm-ledger-mutations.js";

interface SupervisorHarness {
	handleLine(client: DaemonSocketClient, line: string): Promise<void>;
	handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonResponse | undefined>;
	assertCurrentOwnership(): Promise<void>;
	closeRlmJournalOwner(): Promise<void>;
	rlmSpawnLedger(): RlmSpawnLedger;
}

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

function fixture() {
	const agentDir = "/mock/base-context";
	const sessionDir = "/mock/base-context/sessions";
	const actor = {
		ledgerPath: canonicalSessionPath(rlmLedgerPath(agentDir, sessionDir)),
		mutate: vi.fn(async (_mutation: RlmLedgerMutation) => {}),
		close: vi.fn(async () => {}),
	};
	const ownership = {
		assertCurrent: vi.fn(async () => {}),
		assertJournalCurrent: vi.fn(),
	};
	const worker = {
		descriptor: {
			workerId: "worker-1",
			authenticationToken: "worker-token",
			workerInstanceId: "worker-incarnation",
			pid: 12345,
			processStartId: "worker-start",
			sessionDir,
		},
	};
	const write = vi.fn(() => true);
	const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
		defaultSessionConfig: { agentDir, sessionDir },
		rlmJournalOwner: actor,
		ownership,
		workers: new Map([["worker-1", worker]]),
		clients: new Set(),
		protocolClientIds: new WeakMap(),
		mutationDrain: new MutationDrainLatch(),
		ready: Promise.resolve(),
		shuttingDown: true,
		updateRestartPhase: "fencing",
		idleEvictionFence: new Promise<void>(() => {}),
		processIdentity: vi.fn(() => "current"),
		commandJournal: {
			lookup: vi.fn(),
			begin: vi.fn(() => ({ status: "new" })),
			recordResult: vi.fn(),
		},
		write,
		log: vi.fn(),
	}) as SupervisorHarness;
	const client = { id: "worker-connection" } as DaemonSocketClient;
	const command = {
		id: "mutation-1",
		type: "rlm_ledger_mutate",
		workerToken: "worker-token",
		workerInstanceId: "worker-incarnation",
		mutation: { op: "rename_by_path", child: "/mock/base-context/child.jsonl", name: "renamed" },
	} satisfies Extract<DaemonCommand, { type: "rlm_ledger_mutate" }>;
	return { supervisor, client, command, actor, ownership, worker, write };
}

afterEach(() => vi.restoreAllMocks());

describe("supervisor remote RLM journal", () => {
	it("allows authenticated final facts through shutdown/update/idle fences, not runtime work or a foreign family", async () => {
		const { supervisor, client, command, actor, worker, write } = fixture();
		const entered = deferred();
		const ack = deferred();
		actor.mutate.mockImplementation(async () => {
			entered.resolve();
			await ack.promise;
		});
		const handling = supervisor.handleLine(client, JSON.stringify(createDaemonCommandEnvelope(command, command.id)));
		await entered.promise;
		expect(write).not.toHaveBeenCalled();
		await supervisor.handleLine(client, JSON.stringify(createDaemonCommandEnvelope({ type: "create" }, "runtime")));
		expect(write).toHaveBeenCalledWith(client, expect.objectContaining({ id: "runtime", success: false }));
		await expect(supervisor.handleCommand(client, { ...command, workerInstanceId: "stale" })).rejects.toThrow(
			"authentication",
		);
		worker.descriptor.sessionDir = "/mock/other-family";
		await expect(supervisor.handleCommand(client, command)).rejects.toThrow("family");
		expect(actor.mutate).toHaveBeenCalledTimes(1);
		ack.resolve();
		await handling;
		expect(write).toHaveBeenCalledWith(client, expect.objectContaining({ id: command.id, success: true }));
		await supervisor.closeRlmJournalOwner();
	});

	it("fences new admissions on ownership loss but drains queued facts before closing the actor", async () => {
		const { supervisor, client, command, actor, ownership } = fixture();
		const firstEntered = deferred();
		const secondEntered = deferred();
		const firstAck = deferred();
		const secondAck = deferred();
		actor.mutate
			.mockImplementationOnce(async () => {
				firstEntered.resolve();
				await firstAck.promise;
			})
			.mockImplementationOnce(async () => {
				secondEntered.resolve();
				await secondAck.promise;
			});
		const first = supervisor.handleCommand(client, command);
		const second = supervisor.handleCommand(client, { ...command, id: "mutation-2" });
		ownership.assertCurrent.mockRejectedValue(new Error("ownership lost"));
		ownership.assertJournalCurrent.mockImplementation(() => {
			throw new Error("ownership lost");
		});
		await expect(supervisor.assertCurrentOwnership()).rejects.toThrow("ownership lost");
		const closing = supervisor.closeRlmJournalOwner();
		await firstEntered.promise;
		expect(actor.close).not.toHaveBeenCalled();
		await expect(supervisor.handleCommand(client, command)).rejects.toThrow("admission is closed");
		await expect(supervisor.rlmSpawnLedger().mutate(command.mutation)).rejects.toThrow("admission is closed");
		firstAck.resolve();
		await first;
		await secondEntered.promise;
		expect(actor.close).not.toHaveBeenCalled();
		secondAck.resolve();
		await second;
		await closing;
		expect(actor.mutate).toHaveBeenCalledTimes(2);
		expect(ownership.assertJournalCurrent).toHaveBeenCalledTimes(2);
		expect(actor.close).toHaveBeenCalledTimes(1);
	});
});
