import * as fs from "node:fs";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandRecoveryJournal } from "../src/modes/daemon/command-recovery-journal.js";

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

describe("CommandRecoveryJournal", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	function createPath(): string {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-command-journal-"));
		roots.push(root);
		return join(root, "commands.jsonl");
	}

	it("marks received commands uncertain instead of replaying them", () => {
		const journal = new CommandRecoveryJournal(createPath());
		expect(journal.begin("client-a", "command-a", "prompt")).toEqual({ status: "new" });
		expect(journal.begin("client-a", "command-a", "prompt")).toEqual({ status: "pending" });
	});

	it("looks up prior commands without inserting new receipts", () => {
		const journal = new CommandRecoveryJournal(createPath());
		expect(journal.lookup("client-a", "missing")).toBeUndefined();
		expect(journal.begin("client-a", "pending", "prompt")).toEqual({ status: "new" });
		expect(journal.lookup("client-a", "pending")).toEqual({ status: "pending" });
	});

	it("does not collide when client and command ids contain separators", () => {
		const journal = new CommandRecoveryJournal(createPath());
		expect(journal.begin("client:a", "command", "prompt")).toEqual({ status: "new" });
		expect(journal.begin("client", "a:command", "prompt")).toEqual({ status: "new" });
	});

	it("returns a durable stored result for a repeated idempotency key", () => {
		const path = createPath();
		const journal = new CommandRecoveryJournal(path);
		journal.begin("client-a", "command-a", "prompt");
		journal.recordResult("client-a", "command-a", {
			id: "command-a",
			type: "response",
			command: "prompt",
			success: true,
		});

		const restored = new CommandRecoveryJournal(path);
		expect(restored.begin("client-a", "command-a", "prompt")).toEqual({
			status: "complete",
			response: {
				id: "command-a",
				type: "response",
				command: "prompt",
				success: true,
			},
		});
		const write = vi.mocked(fs.writeSync);
		const actualWrite = write.getMockImplementation()! as typeof fs.writeSync;
		write.mockImplementationOnce(() => {
			throw Object.assign(new Error("interrupted"), { code: "EINTR" });
		});
		write.mockImplementation(((fd: number, payload: Buffer, offset: number, length: number, position: null) =>
			actualWrite(fd, payload, offset, Math.min(3, length), position)) as typeof fs.writeSync);
		try {
			expect(journal.begin("żółć", "utf8-command", "prompt")).toEqual({ status: "new" });
			expect(new CommandRecoveryJournal(path).lookup("żółć", "utf8-command")).toEqual({ status: "pending" });
			journal.acknowledge("client-a", "command-a");
			journal.acknowledge("żółć", "utf8-command");
			expect(new CommandRecoveryJournal(path).lookup("client-a", "command-a")).toBeUndefined();
		} finally {
			write.mockImplementation(actualWrite);
		}
	});

	it("ignores a truncated final append", () => {
		const path = createPath();
		const journal = new CommandRecoveryJournal(path);
		journal.begin("client-a", "command-a", "prompt");
		appendFileSync(path, '{"version":1,"type":"result"');

		const restored = new CommandRecoveryJournal(path);
		expect(restored.begin("client-a", "command-a", "prompt")).toEqual({ status: "pending" });
		const incomplete = readFileSync(path);
		expect(() => restored.begin("client-b", "command-b", "prompt")).toThrow("external recovery");
		expect(readFileSync(path)).toEqual(incomplete);
		const followingPath = createPath();
		new CommandRecoveryJournal(followingPath).begin("client-b", "command-b", "prompt");
		appendFileSync(path, `\n${readFileSync(followingPath, "utf8")}`);
		const corrupt = readFileSync(path);
		expect(() => new CommandRecoveryJournal(path)).toThrow("Corrupt command recovery journal record at line 2");
		expect(readFileSync(path)).toEqual(corrupt);
	});

	it("durably removes acknowledged results", () => {
		const path = createPath();
		const journal = new CommandRecoveryJournal(path);
		journal.begin("client-a", "command-a", "prompt");
		journal.recordResult("client-a", "command-a", {
			id: "command-a",
			type: "response",
			command: "prompt",
			success: true,
		});
		journal.acknowledge("client-a", "command-a");

		const restored = new CommandRecoveryJournal(path);
		expect(restored.begin("client-a", "command-a", "prompt")).toEqual({ status: "new" });
	});
});
