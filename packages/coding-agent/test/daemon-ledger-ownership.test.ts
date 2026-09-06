import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RlmJournalOwner } from "../src/core/rlm-journal-owner.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import type { DaemonResponse } from "../src/modes/daemon/daemon-protocol.js";
import { DAEMON_WORKER_SUPERVISOR_SOCKET_ENV } from "../src/modes/daemon/daemon-worker-protocol.js";
import { type RlmSpawnLedger, rlmLedgerPath } from "../src/modes/daemon/rlm-ledger.js";

const rpc = vi.hoisted(() => ({ connect: vi.fn(), hello: vi.fn(), request: vi.fn(), close: vi.fn() }));
vi.mock("../src/modes/daemon/daemon-client.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	DaemonClient: class {
		connect = rpc.connect;
		waitForHello = rpc.hello;
		request = rpc.request;
		close = rpc.close;
	},
}));
vi.mock("../src/core/rlm-journal-owner.js", () => ({ RlmJournalOwner: { open: vi.fn() } }));

type ModeLedger = {
	openRlmJournalOwner(): Promise<void>;
	rlmSpawnLedger(): RlmSpawnLedger;
	rlmSpawnLedgerFor(sessionDir: string): RlmSpawnLedger;
	closeRlmJournal(): Promise<void>;
	appendRlmLedgerRenameForState(state: unknown, name: string): Promise<void>;
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("daemon ledger ownership", () => {
	let directory: string;
	let agentDir: string;
	let sessionsDir: string;
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "base-ledger-rpc-"));
		agentDir = join(directory, "agent");
		sessionsDir = join(directory, "sessions");
		vi.clearAllMocks();
		rpc.connect.mockResolvedValue(undefined);
		rpc.hello.mockResolvedValue(undefined);
		vi.stubEnv(DAEMON_WORKER_SUPERVISOR_SOCKET_ENV, join(directory, "supervisor.sock"));
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(directory, { recursive: true, force: true });
	});

	function mode(worker: boolean): ModeLedger {
		return Object.assign(Object.create(AgentDaemon.prototype), {
			agentDir,
			options: {
				defaultSessionConfig: { agentDir, sessionDir: sessionsDir },
				...(worker ? { worker: { authenticationToken: "test-token", workerInstanceId: "instance-1" } } : {}),
			},
			log: vi.fn(),
		}) as ModeLedger;
	}

	it("awaits the authenticated owner ack without a local writer and preserves ambiguous failure", async () => {
		const worker = mode(true);
		const ack = deferred<DaemonResponse>();
		rpc.request.mockReturnValueOnce(ack.promise);
		const mutation = {
			childId: "child",
			parent: join(sessionsDir, "parent.jsonl"),
			child: join(sessionsDir, "child.jsonl"),
			depth: 1,
			name: "child",
		};
		const append = worker.rlmSpawnLedger().appendSpawn(mutation);
		let settled = false;
		void append.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await vi.waitFor(() => expect(rpc.request).toHaveBeenCalledOnce());
		expect(settled).toBe(false);
		expect(rpc.request).toHaveBeenCalledWith(
			{
				type: "rlm_ledger_mutate",
				workerToken: "test-token",
				workerInstanceId: "instance-1",
				mutation: { op: "spawn", ...mutation },
			},
			30_000,
			{ recoverable: false },
		);
		expect(existsSync(rlmLedgerPath(agentDir, sessionsDir))).toBe(false);
		ack.resolve({ type: "response", command: "rlm_ledger_mutate", success: true });
		await append;
		expect(rpc.close).toHaveBeenCalledOnce();

		rpc.request.mockRejectedValueOnce(new Error("socket disconnected after send"));
		await expect(
			worker.appendRlmLedgerRenameForState(
				{ runtime: { metadata: { rlmChildId: "child" }, session: { sessionFile: mutation.child } } },
				"renamed",
			),
		).rejects.toThrow("outcome may be unknown");
		expect(rpc.request).toHaveBeenCalledTimes(2); // No automatic replay after the lost ack.
		expect(rpc.close).toHaveBeenCalledTimes(2);
		await expect(worker.rlmSpawnLedgerFor(join(directory, "other-family")).appendSpawn(mutation)).rejects.toThrow(
			"read-only",
		);
		expect(rpc.request).toHaveBeenCalledTimes(2);
		await worker.closeRlmJournal();
	});

	it("opens a standalone external actor and drains admitted facade writes before actor close", async () => {
		const owner = mode(false);
		const ack = deferred<void>();
		const order: string[] = [];
		const actor = {
			mutate: vi.fn(() => {
				order.push("mutate");
				return ack.promise;
			}),
			close: vi.fn(async () => {
				order.push("close");
			}),
		};
		vi.mocked(RlmJournalOwner.open).mockResolvedValue(actor as unknown as RlmJournalOwner);
		await owner.openRlmJournalOwner();
		expect(RlmJournalOwner.open).toHaveBeenCalledWith({
			agentDir,
			sessionsDir,
			journalPath: rlmLedgerPath(agentDir, sessionsDir),
		});
		const ledger = owner.rlmSpawnLedger();
		const append = ledger.appendRename({
			childId: "child",
			child: join(sessionsDir, "child.jsonl"),
			name: "renamed",
		});
		const closed = owner.closeRlmJournal();
		await expect(
			ledger.appendRename({ childId: "later", child: join(sessionsDir, "later.jsonl"), name: "later" }),
		).rejects.toThrow("closed");
		await vi.waitFor(() => expect(actor.mutate).toHaveBeenCalledOnce());
		expect(actor.close).not.toHaveBeenCalled();
		ack.resolve();
		await append;
		await closed;
		await owner.closeRlmJournal();
		expect(order).toEqual(["mutate", "close"]);
		expect(rpc.request).not.toHaveBeenCalled();
	});
});
