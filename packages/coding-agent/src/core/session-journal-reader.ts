import { open } from "node:fs/promises";
import { TextDecoder } from "node:util";
import { readFirstLineBufferSync, readLinesAsBuffers } from "../utils/file-lines.js";
import {
	decodeJournalFrame,
	INITIAL_JOURNAL_CURSOR,
	type JournalCursor,
	type JournalFrameRetention,
	type NativeEntryQualification,
} from "./journal-frame.js";
import { SESSION_JOURNAL_MAX_FRAME_BYTES } from "./session-journal-owner.js";

export interface CapturedSessionJournalRecord {
	json: string;
	entry: unknown;
	retention?: JournalFrameRetention;
	qualification?: NativeEntryQualification;
	source?: {
		sequence: number;
		revision: string;
		locator: { path: string; offset: number; length: number };
	};
}

/** Read-only validation. No loader removes a tail or changes a source generation. */
export class SessionJournalDecoder {
	private format: "legacy" | "framed" | undefined;
	private cursor: JournalCursor = INITIAL_JOURNAL_CURSOR;
	private utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

	decode(
		line: Buffer,
		locator?: { path: string; offset: number; length: number },
	): CapturedSessionJournalRecord | undefined {
		if (line.length > SESSION_JOURNAL_MAX_FRAME_BYTES) throw new Error("Session journal frame byte limit exceeded");
		if (line[line.length - 1] !== 0x0a) throw new Error("Incomplete session journal record");
		const text = this.utf8.decode(line);
		if (!text.trim()) {
			if (this.format === "framed") throw new Error("Blank record inside a framed session journal");
			return undefined;
		}
		const raw: unknown = JSON.parse(text);
		const framed =
			raw !== null &&
			typeof raw === "object" &&
			(Object.hasOwn(raw, "journalFrame") || Object.hasOwn(raw, "previousChecksum"));
		const format = framed ? "framed" : "legacy";
		if (this.format !== undefined && this.format !== format) throw new Error("Mixed session journal formats");
		this.format = format;
		if (!framed) return { json: text.trimEnd(), entry: raw, retention: "retained-import" };
		const decoded = decodeJournalFrame(line, this.cursor, SESSION_JOURNAL_MAX_FRAME_BYTES);
		this.cursor = decoded.next;
		return {
			json: decoded.json,
			entry: decoded.payload,
			...(decoded.retention === undefined ? {} : { retention: decoded.retention }),
			...(decoded.qualification === undefined ? {} : { qualification: decoded.qualification }),
			...(locator
				? {
						source: {
							// The decoder returns the existing frame checksum and its one-past sequence.
							sequence: decoded.next.sequence - 1,
							revision: decoded.next.checksum!,
							locator,
						},
					}
				: {}),
		};
	}
}

export async function* readSessionJournal(filePath: string): AsyncGenerator<{
	json: string;
	entry: unknown;
	retention?: JournalFrameRetention;
	qualification?: NativeEntryQualification;
}> {
	const decoder = new SessionJournalDecoder();
	for await (const line of readLinesAsBuffers(filePath, {
		maxLineBytes: SESSION_JOURNAL_MAX_FRAME_BYTES,
		includeNewline: true,
		completeOnly: true,
	})) {
		const record = decoder.decode(line);
		if (record) yield record;
	}
}

/** Explicit-copy reader: one descriptor and one size capture, without claiming a writer ACK. */
export async function readCapturedSessionJournal(
	filePath: string,
	consume: (record: CapturedSessionJournalRecord) => void,
): Promise<void> {
	const file = await open(filePath, "r");
	try {
		const { size } = await file.stat();
		const decoder = new SessionJournalDecoder();
		const chunk = Buffer.alloc(64 * 1024);
		let line = Buffer.alloc(64 * 1024);
		let position = 0;
		let lineOffset = 0;
		let lineBytes = 0;
		while (position < size) {
			const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, size - position), position);
			if (bytesRead === 0) throw new Error("Captured session source changed before its prefix was read");
			position += bytesRead;
			let start = 0;
			while (start < bytesRead) {
				const newline = chunk.subarray(0, bytesRead).indexOf(0x0a, start);
				const stop = newline === -1 ? bytesRead : newline + 1;
				const required = lineBytes + stop - start;
				if (required > SESSION_JOURNAL_MAX_FRAME_BYTES) throw new Error("Line byte limit exceeded");
				if (required > line.length) {
					const grown = Buffer.alloc(
						Math.min(SESSION_JOURNAL_MAX_FRAME_BYTES, Math.max(required, line.length * 2)),
					);
					line.copy(grown, 0, 0, lineBytes);
					line = grown;
				}
				lineBytes += chunk.copy(line, lineBytes, start, stop);
				start = stop;
				if (newline === -1) continue;
				const record = decoder.decode(line.subarray(0, lineBytes), {
					path: filePath,
					offset: lineOffset,
					length: lineBytes,
				});
				if (record) consume(record);
				lineOffset += lineBytes;
				lineBytes = 0;
			}
		}
		// An incomplete final record is not consumed, matching readSessionJournal.
	} catch (error) {
		try {
			await file.close();
		} catch (cleanup) {
			throw new AggregateError([error, cleanup], "Captured session read and close failed");
		}
		throw error;
	}
	await file.close();
}

export function readSessionJournalHeader(filePath: string): unknown {
	const line = readFirstLineBufferSync(filePath);
	if (line === undefined) return undefined;
	return new SessionJournalDecoder().decode(line)?.entry;
}
