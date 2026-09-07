import { type FileHandle, open, stat } from "node:fs/promises";
import { type CanonicalPayloadParts, indexCanonicalPayloadParts } from "./canonical-payload-parts.js";
import type { HistoryIndexFrontier, IndexedSourceEvent } from "./history-index.js";
import { decodeJournalFrame, INITIAL_JOURNAL_CURSOR, type JournalCursor } from "./journal-frame.js";
import { SESSION_JOURNAL_MAX_FRAME_BYTES, type SessionJournalState } from "./session-journal-owner.js";

export interface SessionSourceEntry {
	id: string;
	parentId: string | null;
	type: string;
	[key: string]: unknown;
}
export interface SourceIndexCursor {
	frontier: HistoryIndexFrontier;
	headerByteLength: number;
	headerChecksum: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Walk only the selected content, with bounded work and UTF8 preview bytes. */
function sourceText(value: unknown): { text: string; textComplete: boolean } {
	function* values(item: unknown): Generator<unknown> {
		if (Array.isArray(item)) yield* item;
		else if (record(item))
			for (const key in item as Record<string, unknown>) {
				if (key !== "type") yield (item as Record<string, unknown>)[key];
			}
	}
	const stack: Iterator<unknown>[] = [[value][Symbol.iterator]()];
	let text = "";
	let bytes = 0;
	let visited = 0;
	let textComplete = true;
	while (stack.length) {
		if (++visited > 4096) return { text, textComplete: false };
		const next = stack[stack.length - 1].next();
		if (next.done) {
			stack.pop();
			continue;
		}
		if (typeof next.value === "string") {
			const separator = text && next.value ? "\n" : "";
			if (bytes + separator.length > 8192) return { text, textComplete: false };
			text += separator;
			bytes += separator.length;
			for (const char of next.value) {
				const size = Buffer.byteLength(char);
				if (bytes + size > 8192) return { text, textComplete: false };
				text += char;
				bytes += size;
			}
		} else if (next.value && typeof next.value === "object") {
			const kind = record(next.value)?.type;
			if (kind === "image" || kind === "audio" || kind === "video") {
				textComplete = false;
				continue;
			}
			stack.push(values(next.value));
		}
	}
	return { text, textComplete };
}

/** Plain canonical entry envelope; task-state projection can consume it separately. */
export function projectSessionSourceEvent(
	entry: SessionSourceEntry,
	sequence: number,
	locator: IndexedSourceEvent["locator"],
	revision: string,
): IndexedSourceEvent {
	const message = record(entry.message);
	const role = message?.role;
	const content =
		message?.content ??
		entry.content ??
		entry.summary ??
		entry.data ??
		entry.status ??
		entry.label ??
		entry.name ??
		entry.request ??
		entry.invocation;
	return {
		id: entry.id,
		parentId: entry.parentId,
		kind: entry.type,
		sequence,
		locator,
		revision,
		// Expanded message text is not native submitted input. Its authority is projected separately.
		authority:
			entry.type === "message" && role === "user"
				? "unrecorded"
				: entry.type === "message" && role === "assistant"
					? "assistant"
					: "runtime",
		...sourceText(content),
	};
}

async function* frames(file: FileHandle, start: number, end: number, initial: JournalCursor) {
	let position = start;
	let offset = start;
	let cursor = initial;
	let pieces: Buffer[] = [];
	let length = 0;
	while (position < end) {
		const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, end - position));
		const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
		if (!bytesRead) throw new Error("Canonical source ended before its acknowledged prefix");
		position += bytesRead;
		let from = 0;
		while (from < bytesRead) {
			const newline = buffer.indexOf(0x0a, from);
			const to = newline >= 0 && newline < bytesRead ? newline + 1 : bytesRead;
			const piece = buffer.subarray(from, to);
			pieces.push(piece);
			length += piece.length;
			if (length > SESSION_JOURNAL_MAX_FRAME_BYTES) throw new Error("Session source frame byte limit exceeded");
			if (newline >= 0 && newline < bytesRead) {
				const frameBytes = pieces.length === 1 ? pieces[0] : Buffer.concat(pieces, length);
				const decoded = decodeJournalFrame(frameBytes, cursor, SESSION_JOURNAL_MAX_FRAME_BYTES);
				const payloadLength = Buffer.byteLength(decoded.json);
				const payloadStart =
					frameBytes.length - Buffer.byteLength(`,"checksum":"${decoded.next.checksum}"}\n`) - payloadLength;
				yield {
					payload: decoded.payload,
					payloadBytes: frameBytes.subarray(payloadStart, payloadStart + payloadLength),
					payloadOffset: offset + payloadStart,
					sequence: cursor.sequence,
					checksum: decoded.next.checksum!,
					offset,
					length,
				};
				cursor = decoded.next;
				offset += length;
				pieces = [];
				length = 0;
			}
			from = to;
		}
	}
	if (length) throw new Error("Acknowledged source prefix ends inside a frame");
}

/** Read-only canonical scan. No unacknowledged tail is read or repaired. */
export async function readSessionSource(
	sessionId: string,
	snapshot: SessionJournalState,
	previous: SourceIndexCursor | undefined,
	consume: (
		entry: SessionSourceEntry,
		sequence: number,
		locator: IndexedSourceEvent["locator"],
		revision: string,
		parts: CanonicalPayloadParts,
	) => void,
): Promise<SourceIndexCursor> {
	if (
		snapshot.format !== "framed" ||
		!Number.isSafeInteger(snapshot.byteLength) ||
		snapshot.byteLength <= 0 ||
		!Number.isSafeInteger(snapshot.nextSequence) ||
		snapshot.nextSequence <= 0 ||
		!/^[a-f0-9]{64}$/.test(snapshot.checksum ?? "") ||
		!Number.isSafeInteger(snapshot.dev) ||
		!Number.isSafeInteger(snapshot.ino) ||
		snapshot.journalPath.length > 4096
	) {
		throw new Error("Source indexing requires a framed acknowledged session snapshot");
	}
	const file = await open(snapshot.journalPath, "r");
	const identity = (current: { dev: number; ino: number; size: number }) => {
		if (current.dev !== snapshot.dev || current.ino !== snapshot.ino || current.size < snapshot.byteLength)
			throw new Error("Canonical source physical identity or acknowledged length changed");
	};
	try {
		identity(await file.stat());
		const checkHeader = (payload: unknown) => {
			const header = record(payload);
			if (header?.type !== "session" || header.id !== sessionId)
				throw new Error("Canonical source session identity mismatch");
		};
		let cursor: JournalCursor = INITIAL_JOURNAL_CURSOR;
		let offset = 0;
		let headerByteLength = 0;
		let headerChecksum = "";
		if (previous) {
			for await (const header of frames(file, 0, previous.headerByteLength, INITIAL_JOURNAL_CURSOR)) {
				checkHeader(header.payload);
				if (header.sequence !== 0 || header.checksum !== previous.headerChecksum)
					throw new Error("Canonical source header changed");
			}
			({ headerByteLength, headerChecksum } = previous);
			cursor = { sequence: previous.frontier.nextSequence, checksum: previous.frontier.checksum };
			offset = previous.frontier.byteLength;
		}
		for await (const frame of frames(file, offset, snapshot.byteLength, cursor)) {
			if (frame.sequence === 0) {
				checkHeader(frame.payload);
				headerByteLength = frame.length;
				headerChecksum = frame.checksum;
			} else {
				const value = record(frame.payload);
				if (
					!value ||
					typeof value.id !== "string" ||
					!value.id ||
					value.id.length > 512 ||
					typeof value.type !== "string" ||
					!value.type ||
					value.type.length > 128 ||
					!(value.parentId === null || (typeof value.parentId === "string" && value.parentId.length <= 512))
				) {
					throw new Error("Invalid canonical session entry identity");
				}
				consume(
					value as SessionSourceEntry,
					frame.sequence,
					{ path: snapshot.journalPath, offset: frame.offset, length: frame.length },
					frame.checksum,
					indexCanonicalPayloadParts(frame.payloadBytes, {
						source: { dev: snapshot.dev, ino: snapshot.ino },
						frameOffset: frame.offset,
						frameChecksum: frame.checksum,
						payloadOffset: frame.payloadOffset,
					}),
				);
			}
			cursor = { sequence: frame.sequence + 1, checksum: frame.checksum };
		}
		if (!headerChecksum || cursor.sequence !== snapshot.nextSequence || cursor.checksum !== snapshot.checksum)
			throw new Error("Canonical source does not match the acknowledged sequence/checksum");
		identity(await file.stat());
		identity(await stat(snapshot.journalPath));
		return {
			frontier: { ...snapshot, format: "framed", indexedThrough: snapshot.nextSequence - 1 },
			headerByteLength,
			headerChecksum,
		};
	} finally {
		await file.close();
	}
}
