import { createHash } from "node:crypto";
import { fstatSync, readSync } from "node:fs";
import { TextDecoder } from "node:util";
import { SESSION_JOURNAL_MAX_RECORD_BYTES } from "./session-journal-owner.js";

export const MAX_CANONICAL_PAYLOAD_PART_BYTES = 64 * 1024;

export interface CanonicalPayloadSource {
	readonly dev: number;
	readonly ino: number;
}

export interface CanonicalPayloadAnchor {
	readonly source: CanonicalPayloadSource;
	readonly frameOffset: number;
	readonly frameChecksum: string;
	readonly payloadOffset: number;
}

export interface CanonicalPayloadPart {
	readonly byteOffset: number;
	readonly byteLength: number;
	readonly checksum: string;
}

export interface CanonicalPayloadParts extends CanonicalPayloadAnchor {
	readonly byteLength: number;
	readonly parts: readonly CanonicalPayloadPart[];
}

export interface CanonicalPayloadCursor {
	readonly frameChecksum: string;
	readonly payloadOffset: number;
	readonly byteOffset: number;
}

export interface CanonicalPayloadFragment {
	readonly format: "canonical-json-fragment";
	readonly text: string;
	readonly byteOffset: number;
	readonly byteLength: number;
	readonly nextCursor: CanonicalPayloadCursor | null;
}

function isContinuation(byte: number): boolean {
	return (byte & 0xc0) === 0x80;
}

/** Derived metadata only. Pass exact payload bytes from an already-verified canonical frame.
 * File offsets are absolute; part and cursor byte offsets are relative to the payload.
 */
export function indexCanonicalPayloadParts(
	verifiedPayload: Buffer,
	anchor: CanonicalPayloadAnchor,
): CanonicalPayloadParts {
	if (verifiedPayload.length === 0 || verifiedPayload.length > SESSION_JOURNAL_MAX_RECORD_BYTES) {
		throw new Error("Canonical payload record byte limit exceeded");
	}
	const parts: CanonicalPayloadPart[] = [];
	for (let start = 0; start < verifiedPayload.length; ) {
		let end = Math.min(start + MAX_CANONICAL_PAYLOAD_PART_BYTES, verifiedPayload.length);
		while (end < verifiedPayload.length && isContinuation(verifiedPayload[end])) end--;
		if (end <= start) throw new Error("Invalid canonical payload UTF8 boundary");
		parts.push({
			byteOffset: start,
			byteLength: end - start,
			checksum: createHash("sha256").update(verifiedPayload.subarray(start, end)).digest("hex"),
		});
		start = end;
	}
	return { ...anchor, byteLength: verifiedPayload.length, parts };
}

/** Worker-only synchronous read of at most one indexed part (64KiB), never the frame.
 * The index must come from a verified frame. maxBytes is an upper bound; continuation can stop at a part or UTF8 boundary. Text is not standalone JSON.
 */
export function readCanonicalPayloadFragment(
	fd: number,
	index: CanonicalPayloadParts,
	cursor?: CanonicalPayloadCursor,
	maxBytes = MAX_CANONICAL_PAYLOAD_PART_BYTES,
): CanonicalPayloadFragment {
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_CANONICAL_PAYLOAD_PART_BYTES) {
		throw new Error("Invalid canonical payload read byte limit");
	}
	if (cursor && (cursor.frameChecksum !== index.frameChecksum || cursor.payloadOffset !== index.payloadOffset)) {
		throw new Error("Canonical payload cursor mismatch");
	}
	const byteOffset = cursor?.byteOffset ?? 0;
	if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 || byteOffset >= index.byteLength) {
		throw new Error("Invalid canonical payload cursor byte offset");
	}
	const source = fstatSync(fd);
	if (source.dev !== index.source.dev || source.ino !== index.source.ino) {
		throw new Error("Canonical payload source identity mismatch");
	}
	let low = 0;
	let high = index.parts.length;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		if (index.parts[middle].byteOffset <= byteOffset) low = middle + 1;
		else high = middle;
	}
	const part = index.parts[low - 1];
	if (
		!part ||
		!Number.isSafeInteger(part.byteOffset) ||
		part.byteOffset < 0 ||
		!Number.isSafeInteger(part.byteLength) ||
		part.byteLength <= 0 ||
		part.byteLength > MAX_CANONICAL_PAYLOAD_PART_BYTES ||
		part.byteOffset + part.byteLength > index.byteLength ||
		byteOffset >= part.byteOffset + part.byteLength ||
		!Number.isSafeInteger(index.payloadOffset) ||
		index.payloadOffset < index.frameOffset ||
		!Number.isSafeInteger(index.payloadOffset + part.byteOffset + part.byteLength)
	) {
		throw new Error("Invalid canonical payload part locator");
	}
	const bytes = Buffer.allocUnsafe(part.byteLength);
	let read = 0;
	while (read < bytes.length) {
		let count: number;
		try {
			count = readSync(fd, bytes, read, bytes.length - read, index.payloadOffset + part.byteOffset + read);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EINTR") continue;
			throw error;
		}
		if (count <= 0) throw new Error("Incomplete canonical payload part");
		read += count;
	}
	if (createHash("sha256").update(bytes).digest("hex") !== part.checksum) {
		throw new Error("Canonical payload part checksum mismatch");
	}
	const start = byteOffset - part.byteOffset;
	let end = Math.min(start + maxBytes, bytes.length);
	while (end < bytes.length && isContinuation(bytes[end])) end--;
	if (end <= start) throw new Error("Canonical payload byte limit cannot fit the next UTF8 character");
	const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(start, end));
	const nextByteOffset = part.byteOffset + end;
	return {
		format: "canonical-json-fragment",
		text,
		byteOffset,
		byteLength: end - start,
		nextCursor:
			nextByteOffset === index.byteLength
				? null
				: { frameChecksum: index.frameChecksum, payloadOffset: index.payloadOffset, byteOffset: nextByteOffset },
	};
}
