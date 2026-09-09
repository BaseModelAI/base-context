import * as fs from "node:fs";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerRecoveryJournal } from "../src/modes/daemon/worker-recovery-journal.js";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return {
		...actual,
		writeSync: vi.fn(actual.writeSync),
		closeSync: vi.fn(actual.closeSync),
		fsyncSync: vi.fn(actual.fsyncSync),
		openSync: vi.fn(actual.openSync),
		renameSync: vi.fn(actual.renameSync),
	};
});

describe("WorkerRecoveryJournal", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	function createPath(): string {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-worker-recovery-"));
		roots.push(root);
		return join(root, "worker.recovery.jsonl");
	}

	it("restores the latest operation state per session", () => {
		const path = createPath();
		const journal = new WorkerRecoveryJournal(path);
		const write = vi.mocked(fs.writeSync);
		const actualWrite = write.getMockImplementation()! as typeof fs.writeSync;
		write.mockImplementation(((fd: number, payload: Buffer, offset: number, length: number, position: null) =>
			actualWrite(fd, payload, offset, Math.min(3, length), position)) as typeof fs.writeSync);
		try {
			journal.record({
				activeSessionId: "active-1",
				sessionId: "session-1",
				sessionFile: "/tmp/session-1.jsonl",
				busy: true,
				operation: "prompt_accepted",
			});
		} finally {
			write.mockImplementation(actualWrite);
		}
		journal.record({
			activeSessionId: "active-2",
			sessionId: "session-2",
			busy: false,
			operation: "ready",
		});

		expect(WorkerRecoveryJournal.readLatest(path)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ activeSessionId: "active-1", busy: true, operation: "prompt_accepted" }),
				expect.objectContaining({ activeSessionId: "active-2", busy: false, operation: "ready" }),
			]),
		);
		const openedBefore = vi.mocked(fs.openSync).mock.calls.length;
		journal.record({ activeSessionId: "active-1", sessionId: "session-1", busy: false, operation: "idle" });
		const opened = vi.mocked(fs.openSync);
		const tempIndex = opened.mock.calls.findIndex(
			([file], index) => index >= openedBefore && file === `${path}.${process.pid}.tmp`,
		);
		expect(tempIndex).toBeGreaterThanOrEqual(0);
		const tempOrder = opened.mock.invocationCallOrder[tempIndex];
		const renameOrder = vi.mocked(fs.renameSync).mock.invocationCallOrder.at(-1)!;
		const synced = vi.mocked(fs.fsyncSync).mock.invocationCallOrder;
		expect(synced.some((order) => order > tempOrder && order < renameOrder)).toBe(true);
		expect(synced.some((order) => order > renameOrder)).toBe(true);
		expect(WorkerRecoveryJournal.readLatest(path).every((record) => !record.busy)).toBe(true);
	});

	it("compacts stable checkpoints and ignores a truncated final record", () => {
		const path = createPath();
		const journal = new WorkerRecoveryJournal(path);
		journal.record({
			activeSessionId: "active-1",
			sessionId: "session-1",
			busy: true,
			operation: "bash_start",
		});
		journal.record({
			activeSessionId: "active-1",
			sessionId: "session-1",
			busy: false,
			operation: "bash_end",
		});
		appendFileSync(path, "{truncated");

		expect(WorkerRecoveryJournal.readLatest(path)).toEqual([
			expect.objectContaining({ activeSessionId: "active-1", busy: false, operation: "bash_end" }),
		]);
		const incomplete = readFileSync(path);
		const restored = new WorkerRecoveryJournal(path);
		expect(() =>
			restored.record({ activeSessionId: "active-1", sessionId: "session-1", busy: false, operation: "bash_end" }),
		).toThrow("external recovery");
		expect(readFileSync(path)).toEqual(incomplete);
		const followingPath = createPath();
		new WorkerRecoveryJournal(followingPath).record({
			activeSessionId: "active-2",
			sessionId: "session-2",
			busy: true,
			operation: "accepted",
		});
		appendFileSync(path, `\n${readFileSync(followingPath, "utf8")}`);
		const corrupt = readFileSync(path);
		expect(() => WorkerRecoveryJournal.readLatest(path)).toThrow("Corrupt worker recovery journal record at line 2");
		expect(readFileSync(path)).toEqual(corrupt);

		const uncertainPath = createPath();
		const uncertain = new WorkerRecoveryJournal(uncertainPath);
		const write = vi.mocked(fs.writeSync);
		const actualWrite = write.getMockImplementation()! as typeof fs.writeSync;
		const close = vi.mocked(fs.closeSync);
		const actualClose = close.getMockImplementation()!;
		const primary = Object.assign(new Error("disk full"), { code: "ENOSPC" });
		const cleanup = new Error("close failed after partial write");
		write.mockImplementationOnce(((fd: number, payload: Buffer, offset: number, length: number, position: null) =>
			actualWrite(fd, payload, offset, Math.min(3, length), position)) as typeof fs.writeSync);
		write.mockImplementationOnce(() => {
			throw primary;
		});
		close.mockImplementationOnce((fd) => {
			actualClose(fd);
			throw cleanup;
		});
		const input = { activeSessionId: "uncertain", sessionId: "session-unknown", busy: true, operation: "accepted" };
		let failure: unknown;
		try {
			uncertain.record(input);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(AggregateError);
		expect((failure as AggregateError).errors).toEqual([primary, cleanup]);
		expect(uncertain.getLatest()).toEqual([]);
		const partial = readFileSync(uncertainPath);
		expect(partial.length).toBe(3);
		const writes = write.mock.calls.length;
		expect(() => uncertain.record(input)).toThrow(failure as AggregateError);
		expect(write).toHaveBeenCalledTimes(writes);
		expect(readFileSync(uncertainPath)).toEqual(partial);
	});
});
