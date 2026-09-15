import type * as NodeFs from "node:fs";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventLog } from "../src/core/event-log.js";

const writeFailure = vi.hoisted(() => ({ interrupt: false }));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof NodeFs>();
	return {
		...actual,
		writeSync: (fd: number, data: string | Buffer) => {
			const bytes = typeof data === "string" ? Buffer.from(data) : data;
			if (writeFailure.interrupt) {
				writeFailure.interrupt = false;
				actual.writeSync(fd, bytes.subarray(0, 5));
				throw new Error("interrupted append");
			}
			return actual.writeSync(fd, bytes);
		},
	};
});

const owner = { assertOwner: () => {} };

describe("event log substrate", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prime-event-log-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("throws for an unserializable event before any byte reaches the log", () => {
		const log = new EventLog(join(dir, "log.jsonl"), owner);
		log.appendSync([{ ok: 1 }]);
		const before = readFileSync(log.path, "utf8");
		expect(() => log.appendSync([{ ok: 2 }, undefined])).toThrow(Error);
		expect(readFileSync(log.path, "utf8")).toBe(before);
		expect(JSON.parse(before)).toMatchObject({ journalFrame: 1, sequence: 0, payload: { ok: 1 } });
		const corrupt = before.replace('"ok":1', '"ok":2');
		writeFileSync(log.path, corrupt);
		expect(() => log.replaySync((line) => JSON.parse(line))).toThrow("checksum mismatch");
		expect(() => log.recoverSync()).toThrow("checksum mismatch");
		expect(readFileSync(log.path, "utf8")).toBe(corrupt);
	});

	it("truncates an unterminated tail even when it parses as JSON, keeping strict replays clean", () => {
		const path = join(dir, "log.jsonl");
		const log = new EventLog(path, owner);
		log.appendSync([{ v: 1, keep: true }]);
		// A newline-completion here would hand this line to strict parsers as
		// permanent fail-closed interior poison; truncation must win.
		writeFileSync(path, `${readFileSync(path, "utf8")}{"not":"a valid record"}`);
		const reader = new EventLog(path);
		const torn = readFileSync(path, "utf8");
		expect(reader.replaySync((line) => JSON.parse(line))).toEqual([{ v: 1, keep: true }]);
		expect(() => reader.appendSync([{ v: 1 }])).toThrow(/owner|read.only/i);
		expect(() => reader.recoverSync()).toThrow(/owner|read.only/i);
		expect(readFileSync(path, "utf8")).toBe(torn);
		log.appendSync([{ v: 1, second: true }]);
		const strict = new EventLog(path).replaySync((line, index) => {
			const value = JSON.parse(line) as { v?: number };
			if (value.v !== 1) throw new Error(`invalid record on line ${index + 1}`);
			return value;
		});
		expect(strict).toEqual([
			{ v: 1, keep: true },
			{ v: 1, second: true },
		]);
		const legacyPath = join(dir, "legacy.jsonl");
		const legacyBytes = '{"v":1,"retained":true}\n';
		writeFileSync(legacyPath, legacyBytes);
		const legacy = new EventLog(legacyPath, owner);
		expect(legacy.replaySync((line) => JSON.parse(line))).toEqual([{ v: 1, retained: true }]);
		expect(() => legacy.appendSync([{ v: 1 }])).toThrow("explicit migration");
		expect(readFileSync(legacyPath, "utf8")).toBe(legacyBytes);
	});

	it("poisons an interrupted writer until owner recovery repairs the tail", () => {
		const log = new EventLog(join(dir, "interrupted.jsonl"), owner);
		log.appendSync([{ ok: 1 }], { durable: true });
		writeFailure.interrupt = true;
		expect(() => log.appendSync([{ ok: 2 }], { durable: true })).toThrow("interrupted append");
		expect(log.requiresRepair).toBe(true);
		const interrupted = readFileSync(log.path, "utf8");
		expect(() => log.appendSync([{ ok: 3 }])).toThrow(/poison|recover/i);
		expect(readFileSync(log.path, "utf8")).toBe(interrupted);
		log.recoverSync();
		expect(log.requiresRepair).toBe(false);
		log.appendSync([{ ok: 3 }], { durable: true });
		expect(log.replaySync((line) => JSON.parse(line))).toEqual([{ ok: 1 }, { ok: 3 }]);
	});

	it("explicitly migrates valid legacy records and retains every original byte", () => {
		const path = join(dir, "migrate.jsonl");
		const original = '{"v":1,"id":9007199254740993}\n{"v":1,"next":true}\n{"torn":';
		writeFileSync(path, original);
		expect(() => new EventLog(path).migrateLegacySync()).toThrow(/owner|read.only/i);
		const log = new EventLog(path, owner);
		log.migrateLegacySync();
		expect(readFileSync(`${path}.legacy-v1`, "utf8")).toBe(original);
		const migrated = readFileSync(path, "utf8");
		expect(migrated).toContain('"id":9007199254740993');
		expect(migrated).not.toContain('"torn"');
		expect(log.replaySync((line) => line)[0]).toBe('{"v":1,"id":9007199254740993}');
		expect(log.replaySync((line) => JSON.parse(line))).toHaveLength(2);
		log.migrateLegacySync();
		expect(readFileSync(path, "utf8")).toBe(migrated);
		log.appendSync([{ v: 1, appended: true }], { durable: true });
		expect(log.replaySync((line) => JSON.parse(line))).toHaveLength(3);
		expect(readFileSync(`${path}.legacy-v1`, "utf8")).toBe(original);
	});

	it("does not publish interrupted migration or replace a different retained source", () => {
		const path = join(dir, "migration-error.jsonl");
		const original = '{"v":1,"keep":true}\n';
		writeFileSync(path, original);
		const log = new EventLog(path, owner);
		writeFailure.interrupt = true;
		expect(() => log.migrateLegacySync()).toThrow("interrupted append");
		expect(readFileSync(path, "utf8")).toBe(original);
		expect(existsSync(`${path}.migration-v1.tmp`)).toBe(false);
		writeFileSync(`${path}.legacy-v1`, "another retained source");
		expect(() => log.migrateLegacySync()).toThrow("already belongs to another source");
		expect(readFileSync(path, "utf8")).toBe(original);
		expect(readFileSync(`${path}.legacy-v1`, "utf8")).toBe("another retained source");
		writeFileSync(path, `${original}not-json\n`);
		expect(() => log.migrateLegacySync()).toThrow();
		expect(readFileSync(path, "utf8")).toBe(`${original}not-json\n`);
	});

	it("fails closed on an oversized log through the descriptor without a full allocation", () => {
		const path = join(dir, "log.jsonl");
		writeFileSync(path, `${"x".repeat(64)}\n`.repeat(4));
		const log = new EventLog(path, { ...owner, maxBytes: 100 });
		expect(() => log.replaySync((line) => line)).toThrow("bytes");
		expect(() => log.appendSync([{ v: 1 }])).toThrow("bytes");
	});
});
