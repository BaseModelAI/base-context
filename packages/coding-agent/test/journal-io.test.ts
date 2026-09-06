import { fstatSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { appendJournalRecord, withJournalDescriptorSync, writeFullySync } from "../src/core/journal-io.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "base-context-journal-io-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it("writes every UTF8 byte across interruptions and partial progress", () => {
	const payload = Buffer.from('{"text":"żółć"}\n');
	const chunks: Buffer[] = [];
	let interrupted = false;
	writeFullySync(1, payload, (_fd, buffer, offset, length) => {
		if (!interrupted) {
			interrupted = true;
			throw Object.assign(new Error("interrupted"), { code: "EINTR" });
		}
		const written = Math.min(3, length);
		chunks.push(Buffer.from(buffer.subarray(offset, offset + written)));
		return written;
	});
	expect(Buffer.concat(chunks)).toEqual(payload);
	const path = join(dir, "complete.jsonl");
	const fd = openSync(path, "w");
	withJournalDescriptorSync(fd, (descriptor) => writeFullySync(descriptor, payload));
	expect(() => fstatSync(fd)).toThrow();
	expect(readFileSync(path)).toEqual(payload);
});

it("rejects zero progress and disk full, and never appends behind a torn tail", () => {
	expect(() => writeFullySync(1, Buffer.from("record"), () => 0)).toThrow("byte progress");
	const full = Object.assign(new Error("disk full"), { code: "ENOSPC" });
	expect(() =>
		writeFullySync(1, Buffer.from("record"), () => {
			throw full;
		}),
	).toThrow(full);
	expect(() => withJournalDescriptorSync(-1, () => {})).toThrow();
	expect(() =>
		withJournalDescriptorSync(-1, () => {
			throw full;
		}),
	).toThrow(full);
	const path = join(dir, "session.jsonl");
	writeFileSync(path, '{"type":"session"}\n{"torn":');
	const before = readFileSync(path);
	expect(() => appendJournalRecord(path, '{"new":true}\n')).toThrow("requires repair");
	expect(readFileSync(path)).toEqual(before);
});
