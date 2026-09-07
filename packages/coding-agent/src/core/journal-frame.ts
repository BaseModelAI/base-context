import { createHash } from "node:crypto";
import { stringifyBoundedJson } from "./bounded-json.js";

export interface JournalCursor {
	readonly sequence: number;
	readonly checksum: string | null;
}

export const INITIAL_JOURNAL_CURSOR: JournalCursor = Object.freeze({ sequence: 0, checksum: null });
export const MAX_JOURNAL_FRAME_BYTES = 1024 * 1024;

function framePrefix(cursor: JournalCursor): string {
	return `{"journalFrame":1,"sequence":${cursor.sequence},"previousChecksum":${JSON.stringify(cursor.checksum)},"payload":`;
}

function assertCursor(cursor: JournalCursor): void {
	if (
		!Number.isSafeInteger(cursor.sequence) ||
		cursor.sequence < 0 ||
		cursor.sequence === Number.MAX_SAFE_INTEGER ||
		(cursor.sequence === 0 ? cursor.checksum !== null : !/^[a-f0-9]{64}$/.test(cursor.checksum ?? ""))
	)
		throw new Error("Invalid journal cursor");
}

/** One bounded payload per frame. The checksum covers the exact encoded prefix and payload bytes. */
export function encodeJournalFrame(
	payload: unknown,
	cursor: JournalCursor,
	maxBytes = MAX_JOURNAL_FRAME_BYTES,
): { line: string; next: JournalCursor } {
	return encodeJournalFrameJson(stringifyBoundedJson(payload, maxBytes), cursor, maxBytes);
}

/** Preserve validated retained JSON text, including numeric lexemes that a parse/stringify would change. */
export function encodeJournalFrameJson(
	json: string,
	cursor: JournalCursor,
	maxBytes = MAX_JOURNAL_FRAME_BYTES,
): { line: string; next: JournalCursor } {
	assertCursor(cursor);
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Invalid journal frame byte limit");
	const prefix = framePrefix(cursor);
	const suffixBytes = Buffer.byteLength(`,"checksum":"${"0".repeat(64)}"}\n`);
	if (Buffer.byteLength(prefix) + Buffer.byteLength(json) + suffixBytes > maxBytes) {
		throw new Error("Journal frame byte limit exceeded");
	}
	if (json.includes("\n")) throw new Error("Journal payload must be one JSON line");
	JSON.parse(json);
	const body = `${prefix}${json}}`;
	const checksum = createHash("sha256").update(body).digest("hex");
	return {
		line: `${prefix}${json},"checksum":"${checksum}"}\n`,
		next: { sequence: cursor.sequence + 1, checksum },
	};
}

/** Verified bytes are not a durability acknowledgement; only the writer's successful sync publishes them. */
export function decodeJournalFrame(
	bytes: Buffer,
	cursor: JournalCursor,
	maxBytes = MAX_JOURNAL_FRAME_BYTES,
): { payload: unknown; json: string; next: JournalCursor } {
	assertCursor(cursor);
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || bytes.length > maxBytes) {
		throw new Error("Journal frame byte limit exceeded");
	}
	if (bytes.length === 0 || bytes[bytes.length - 1] !== 0x0a) throw new Error("Incomplete journal frame");
	const line = bytes.toString("utf8");
	if (!Buffer.from(line, "utf8").equals(bytes)) throw new Error("Invalid journal frame UTF8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		throw new Error(`Malformed journal frame: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid journal frame");
	const frame = parsed as Record<string, unknown>;
	if (frame.journalFrame !== 1 || !Object.hasOwn(frame, "payload")) throw new Error("Unsupported journal frame");
	if (frame.sequence !== cursor.sequence || frame.previousChecksum !== cursor.checksum) {
		throw new Error("Journal frame sequence or predecessor mismatch");
	}
	if (typeof frame.checksum !== "string" || !/^[a-f0-9]{64}$/.test(frame.checksum)) {
		throw new Error("Invalid journal frame checksum");
	}
	const suffix = `,"checksum":"${frame.checksum}"}\n`;
	if (!line.endsWith(suffix)) throw new Error("Invalid journal frame encoding");
	const body = `${line.slice(0, -suffix.length)}}`;
	if (createHash("sha256").update(body).digest("hex") !== frame.checksum) {
		throw new Error("Journal frame checksum mismatch");
	}
	const prefix = framePrefix(cursor);
	if (!body.startsWith(prefix)) throw new Error("Invalid journal frame encoding");
	const json = body.slice(prefix.length, -1);
	JSON.parse(json);
	return { payload: frame.payload, json, next: { sequence: cursor.sequence + 1, checksum: frame.checksum } };
}
