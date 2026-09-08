import { open } from "node:fs/promises";
import { TextDecoder } from "node:util";
import type { SessionHistoryReadLimits } from "../session-history-index.js";
import {
	CURRENT_SESSION_VERSION,
	type FileEntry,
	migrateSessionEntries,
	parseSessionEntries,
	resolveSessionRlmDepth,
	type SessionEntry,
	type SessionHeader,
} from "../session-manager.js";
import { cloneUsage } from "../usage.js";

export interface ExportHistory {
	header: SessionHeader;
	entries: SessionEntry[];
	leafId: string | null;
}

export function exportHistoryLimits(options: Partial<SessionHistoryReadLimits>): SessionHistoryReadLimits {
	const limits = {
		maxEntries: options.maxEntries ?? 16_384,
		maxSourceBytes: options.maxSourceBytes ?? 64 * 1024 * 1024,
	};
	if (!Object.values(limits).every((value) => Number.isSafeInteger(value) && value > 0)) {
		throw new Error("Invalid HTML export history limits");
	}
	return limits;
}

/** Match the Manager's resolved assistant usage, without changing canonical payloads. */
export function applyExportUsage(entries: SessionEntry[]): void {
	const assistants = new Map(
		entries
			.filter((entry) => entry.type === "message" && entry.message.role === "assistant")
			.map((entry) => [entry.id, entry]),
	);
	for (const entry of entries) {
		if (entry.type !== "child_usage_attributed") continue;
		const target = assistants.get(entry.targetId);
		if (target?.type === "message" && target.message.role === "assistant") {
			target.message.usage = cloneUsage(entry.aggregateUsage);
		}
	}
}

/** Read one fixed, capped source image. A growing path never becomes an uncapped read. */
export async function readSessionHistoryImage(
	inputPath: string,
	maxSourceBytes: number,
	errorContext = "HTML export",
): Promise<Buffer> {
	const file = await open(inputPath, "r");
	let captured: Buffer;
	try {
		const before = await file.stat({ bigint: true });
		if (before.size > BigInt(maxSourceBytes)) throw new Error(`${errorContext} source byte budget exceeded`);
		captured = Buffer.alloc(Number(before.size));
		let offset = 0;
		while (offset < captured.length) {
			const { bytesRead: count } = await file.read(
				captured,
				offset,
				Math.min(64 * 1024, captured.length - offset),
				offset,
			);
			if (count === 0) throw new Error(`${errorContext} source changed during capture`);
			offset += count;
		}
		const after = await file.stat({ bigint: true });
		if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
			throw new Error(`${errorContext} source changed during capture`);
		}
	} catch (error) {
		try {
			await file.close();
		} catch (closeError) {
			throw new AggregateError([error, closeError], `${errorContext} source read and close failed`, {
				cause: error,
			});
		}
		throw error;
	}
	await file.close();
	return captured;
}

function parseBoundedSessionEntries(text: string, maxEntries: number): FileEntry[] {
	// Count complete records on this immutable bounded string BEFORE allocating
	// parsed entries. Keep the reader's existing incomplete-tail behavior.
	let records = 0;
	let start = 0;
	for (let end = text.indexOf("\n"); end !== -1; end = text.indexOf("\n", start)) {
		if (text.slice(start, end).trim() && ++records > maxEntries + 1) {
			throw new Error("HTML export entry budget exceeded");
		}
		start = end + 1;
	}
	return parseSessionEntries(text);
}

/** Complete bounded entries with the disk loader's unchanged incomplete-record convention. */
export async function readSessionHistoryFile(
	inputPath: string,
	limits: SessionHistoryReadLimits,
): Promise<FileEntry[]> {
	limits = { ...limits };
	const captured = await readSessionHistoryImage(inputPath, limits.maxSourceBytes);
	const complete = captured.subarray(0, captured.lastIndexOf(0x0a) + 1);
	const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(complete);
	return parseBoundedSessionEntries(text, limits.maxEntries);
}

export async function readExportHistory(inputPath: string, limits: SessionHistoryReadLimits): Promise<ExportHistory> {
	limits = { ...limits };
	const captured = await readSessionHistoryImage(inputPath, limits.maxSourceBytes);
	const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(captured);
	const loaded = parseBoundedSessionEntries(text, limits.maxEntries);
	const header = loaded[0];
	if (!header || header.type !== "session" || typeof header.id !== "string") {
		throw new Error(`Session source has no valid header: ${inputPath}`);
	}
	const version = header.version ?? 1;
	if (version > CURRENT_SESSION_VERSION) throw new Error(`Unsupported session version: ${version}`);
	migrateSessionEntries(loaded);
	if (header.parentSession && !(Number.isSafeInteger(header.rlmDepth) && header.rlmDepth! >= 0)) {
		header.rlmDepth = resolveSessionRlmDepth(header, inputPath);
	}
	const entries = loaded.filter((entry): entry is SessionEntry => entry.type !== "session");
	let leafId: string | null = null;
	for (const entry of entries) if (entry.type !== "request") leafId = entry.id;
	return { header, entries, leafId };
}
