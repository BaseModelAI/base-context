import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
	type CanonicalPayloadCursor,
	indexCanonicalPayloadParts,
	MAX_CANONICAL_PAYLOAD_PART_BYTES,
	readCanonicalPayloadFragment,
} from "../src/core/canonical-payload-parts.js";
import { decodeJournalFrame, encodeJournalFrameJson, INITIAL_JOURNAL_CURSOR } from "../src/core/journal-frame.js";

vi.mock("node:fs", async (importOriginal) => {
	const original = await importOriginal<typeof fs>();
	return { ...original, readSync: vi.fn(original.readSync) };
});

function fixture(json: string) {
	const previous = encodeJournalFrameJson('{"before":true}', INITIAL_JOURNAL_CURSOR);
	const encoded = encodeJournalFrameJson(json, previous.next, Buffer.byteLength(json) + 512);
	const frame = Buffer.from(encoded.line);
	const decoded = decodeJournalFrame(frame, previous.next, frame.length);
	const payloadLength = Buffer.byteLength(decoded.json);
	const payloadStart = frame.length - Buffer.byteLength(`,"checksum":"${decoded.next.checksum}"}\n`) - payloadLength;
	const directory = fs.mkdtempSync(join(tmpdir(), "canonical-payload-parts-"));
	const path = join(directory, "session.journal");
	fs.writeFileSync(path, Buffer.concat([Buffer.from(previous.line), frame]));
	const fd = fs.openSync(path, "r+");
	const source = fs.fstatSync(fd);
	const frameOffset = Buffer.byteLength(previous.line);
	const index = indexCanonicalPayloadParts(frame.subarray(payloadStart, payloadStart + payloadLength), {
		source: { dev: source.dev, ino: source.ino },
		frameOffset,
		frameChecksum: decoded.next.checksum!,
		payloadOffset: frameOffset + payloadStart,
	});
	return {
		fd,
		index,
		close: () => {
			fs.closeSync(fd);
			fs.rmSync(directory, { recursive: true, force: true });
		},
	};
}

it("reads exact JSON fragments with bounded seeks and stable UTF8 byte cursors", () => {
	const prefix = '{"raw":9007199254740993,"escape":"\\u0061","text":"';
	const json = `${prefix}${"a".repeat(MAX_CANONICAL_PAYLOAD_PART_BYTES - Buffer.byteLength(prefix) - 1)}😀\uFEFFżółć${"b".repeat(MAX_CANONICAL_PAYLOAD_PART_BYTES)}"}`;
	const { fd, index, close } = fixture(json);
	try {
		expect(index.parts).toHaveLength(3);
		expect(index.parts[0].byteLength).toBe(MAX_CANONICAL_PAYLOAD_PART_BYTES - 1);
		let cursor: CanonicalPayloadCursor | undefined;
		const fragments: string[] = [];
		for (const part of index.parts) {
			vi.mocked(fs.readSync).mockClear();
			const fragment = readCanonicalPayloadFragment(fd, index, cursor);
			expect(fragment.format).toBe("canonical-json-fragment");
			expect(fragment.byteOffset).toBe(part.byteOffset);
			expect(fragment.byteLength).toBe(part.byteLength);
			expect(fragment.byteLength).toBeLessThanOrEqual(MAX_CANONICAL_PAYLOAD_PART_BYTES);
			expect(fs.readSync).toHaveBeenCalledExactlyOnceWith(
				fd,
				expect.any(Buffer),
				0,
				part.byteLength,
				index.payloadOffset + part.byteOffset,
			);
			fragments.push(fragment.text);
			cursor = fragment.nextCursor ?? undefined;
		}
		expect(cursor).toBeUndefined();
		expect(fragments.join("")).toBe(json);
		const boundaryCursor = {
			frameChecksum: index.frameChecksum,
			payloadOffset: index.payloadOffset,
			byteOffset: index.parts[1].byteOffset,
		};
		expect(() => readCanonicalPayloadFragment(fd, index, boundaryCursor, 3)).toThrow(
			"byte limit cannot fit the next UTF8 character",
		);
		const small = readCanonicalPayloadFragment(fd, index, boundaryCursor, 5);
		expect(small.text).toBe("😀");
		expect(small.byteLength).toBe(4);
		expect(small.nextCursor).toEqual({ ...boundaryCursor, byteOffset: boundaryCursor.byteOffset + 4 });
		expect(readCanonicalPayloadFragment(fd, index, small.nextCursor!, 3).text).toBe("\uFEFF");
		expect(() =>
			readCanonicalPayloadFragment(fd, index, { ...boundaryCursor, byteOffset: boundaryCursor.byteOffset + 1 }),
		).toThrow();
	} finally {
		close();
	}
});

it("checks the selected canonical part without reading an unrequested damaged part", () => {
	const json = `{"text":"${"x".repeat(MAX_CANONICAL_PAYLOAD_PART_BYTES * 2)}"}`;
	const { fd, index, close } = fixture(json);
	try {
		const damaged = index.parts[1];
		fs.writeSync(fd, Buffer.from("y"), 0, 1, index.payloadOffset + damaged.byteOffset);
		vi.mocked(fs.readSync).mockClear();
		const first = readCanonicalPayloadFragment(fd, index);
		expect(first.text).toBe(json.slice(0, index.parts[0].byteLength));
		expect(fs.readSync).toHaveBeenCalledTimes(1);
		vi.mocked(fs.readSync).mockClear();
		expect(() => readCanonicalPayloadFragment(fd, index, first.nextCursor!)).toThrow("part checksum mismatch");
		expect(fs.readSync).toHaveBeenCalledExactlyOnceWith(
			fd,
			expect.any(Buffer),
			0,
			damaged.byteLength,
			index.payloadOffset + damaged.byteOffset,
		);
	} finally {
		close();
	}
});
