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

/** Read-only validation. No loader removes a tail or changes a source generation. */
export class SessionJournalDecoder {
	private format: "legacy" | "framed" | undefined;
	private cursor: JournalCursor = INITIAL_JOURNAL_CURSOR;
	private utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

	decode(line: Buffer):
		| {
				json: string;
				entry: unknown;
				retention?: JournalFrameRetention;
				qualification?: NativeEntryQualification;
		  }
		| undefined {
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

export function readSessionJournalHeader(filePath: string): unknown {
	const line = readFirstLineBufferSync(filePath);
	if (line === undefined) return undefined;
	return new SessionJournalDecoder().decode(line)?.entry;
}
