import { expect, it } from "vitest";
import {
	decodeJournalFrame,
	encodeJournalFrame,
	encodeJournalFrameJson,
	INITIAL_JOURNAL_CURSOR,
} from "../src/core/journal-frame.js";

it("encodes bounded UTF8 frames with one payload and a verified sequence", () => {
	const payload = { type: "message", text: 'żółć\n"' };
	const first = encodeJournalFrame(payload, INITIAL_JOURNAL_CURSOR, 256);
	expect(Buffer.byteLength(first.line)).toBeLessThanOrEqual(256);
	const decoded = decodeJournalFrame(Buffer.from(first.line), INITIAL_JOURNAL_CURSOR, 256);
	expect(decoded).toEqual({ payload, json: JSON.stringify(payload), next: first.next });
	const second = encodeJournalFrame({ type: "done" }, decoded.next, 256);
	expect(decodeJournalFrame(Buffer.from(second.line), decoded.next, 256)).toEqual({
		payload: { type: "done" },
		json: '{"type":"done"}',
		next: second.next,
	});
	expect(second.next.sequence).toBe(2);

	const retainedJson = '{ "value":1e+03, "negativeZero":-0, "escaped":"\\u0061" }';
	const retained = encodeJournalFrameJson(retainedJson, INITIAL_JOURNAL_CURSOR, 256, "retained-import");
	expect(decodeJournalFrame(Buffer.from(retained.line), INITIAL_JOURNAL_CURSOR, 256)).toEqual({
		payload: { value: 1000, negativeZero: -0, escaped: "a" },
		json: retainedJson,
		next: retained.next,
		retention: "retained-import",
	});
	expect(retained.next.checksum).not.toBe(
		encodeJournalFrameJson(retainedJson, INITIAL_JOURNAL_CURSOR, 256).next.checksum,
	);
});

it("rejects corrupt, missing, duplicated, reordered, incomplete and oversized frames", () => {
	expect(() => encodeJournalFrameJson('{\n"text":"original"}', INITIAL_JOURNAL_CURSOR)).toThrow("one JSON line");
	const first = encodeJournalFrame({ text: "original" }, INITIAL_JOURNAL_CURSOR);
	const second = encodeJournalFrame({ text: "next" }, first.next);
	expect(() =>
		decodeJournalFrame(Buffer.from(first.line.replace("original", "modified")), INITIAL_JOURNAL_CURSOR),
	).toThrow("checksum mismatch");
	expect(() => decodeJournalFrame(Buffer.from(second.line), INITIAL_JOURNAL_CURSOR)).toThrow(
		"sequence or predecessor",
	);
	expect(() => decodeJournalFrame(Buffer.from(first.line), first.next)).toThrow("sequence or predecessor");
	expect(() => decodeJournalFrame(Buffer.from(second.line), { ...first.next, checksum: "0".repeat(64) })).toThrow(
		"sequence or predecessor",
	);
	expect(() => decodeJournalFrame(Buffer.from(first.line.slice(0, -1)), INITIAL_JOURNAL_CURSOR)).toThrow("Incomplete");
	expect(() => decodeJournalFrame(Buffer.from(first.line), INITIAL_JOURNAL_CURSOR, 32)).toThrow("byte limit");
	expect(() => encodeJournalFrame({ text: "x".repeat(1024) }, INITIAL_JOURNAL_CURSOR, 256)).toThrow("byte limit");
	const retained = encodeJournalFrame({ text: "original" }, INITIAL_JOURNAL_CURSOR, 256, "retained-import");
	expect(() =>
		decodeJournalFrame(
			Buffer.from(retained.line.replace(',"retention":"retained-import"', "")),
			INITIAL_JOURNAL_CURSOR,
		),
	).toThrow("checksum mismatch");
	expect(() =>
		decodeJournalFrame(Buffer.from(retained.line.replace('"retained-import"', '"native"')), INITIAL_JOURNAL_CURSOR),
	).toThrow("Unsupported journal frame retention");
});
