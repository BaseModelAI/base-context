import { type FileHandle, mkdir, open, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { stringifyBoundedJson } from "./bounded-json.js";
import { MAX_CANONICAL_PAYLOAD_PART_BYTES } from "./canonical-payload-parts.js";
import type { ContextUpdateRef, ContextUpdateTarget, ParentPathCursor } from "./history-index.js";
import type { SessionHistoryReadLimits, SessionHistoryReadScope } from "./session-history-index.js";
import { SESSION_JOURNAL_MAX_FRAME_BYTES, SESSION_JOURNAL_MAX_RECORD_BYTES } from "./session-journal-owner.js";
import {
	CURRENT_SESSION_VERSION,
	type SessionEntry,
	type SessionHeader,
	type SessionManager,
} from "./session-manager.js";
import { cloneUsage } from "./usage.js";

export interface JsonlExportOptions {
	/** Non-indexed views are resident already; refuse an oversized detached copy. */
	residentLimits?: SessionHistoryReadLimits;
	/** Bound each serialized record, not the total streamed native branch. */
	maxRecordBytes?: number;
}

const DEFAULT_RESIDENT_LIMITS: SessionHistoryReadLimits = { maxEntries: 16_384, maxSourceBytes: 64 * 1024 * 1024 };

async function readUsageUpdate(
	view: SessionHistoryReadScope,
	ref: ContextUpdateRef,
	target: ContextUpdateTarget,
	maxSourceBytes: number,
): Promise<SessionEntry> {
	if (ref.locator.length > maxSourceBytes) throw new Error("JSONL export record byte budget exceeded");
	const fragments: string[] = [];
	let offset = 0;
	let part = await view.branchContext.readContextUpdatePayload(ref.entryId, target, {
		maxBytes: MAX_CANONICAL_PAYLOAD_PART_BYTES,
	});
	for (;;) {
		if (!part || part.byteOffset !== offset || part.byteLength <= 0)
			throw new Error("JSONL export usage payload is unavailable");
		offset += part.byteLength;
		if (offset > ref.locator.length) throw new Error("JSONL export usage payload exceeds its source locator");
		fragments.push(part.text);
		if (!part.nextCursor) break;
		part = await view.branchContext.readContextUpdatePayload(ref.entryId, target, {
			cursor: part.nextCursor,
			maxBytes: MAX_CANONICAL_PAYLOAD_PART_BYTES,
		});
	}
	const entry = JSON.parse(fragments.join("")) as SessionEntry;
	if (entry.id !== ref.entryId || entry.type !== "child_usage_attributed")
		throw new Error("JSONL export usage source mismatch");
	return entry;
}

async function* nativeParentPath(view: SessionHistoryReadScope, maxSourceBytes: number): AsyncGenerator<SessionEntry> {
	let cursor: ParentPathCursor | undefined;
	do {
		const page = await view.parentPath({ cursor, limit: 64 });
		for (const metadata of page.events) {
			const hydrated = await view.hydrateEntry(metadata.id, maxSourceBytes);
			if (!hydrated) throw new Error("JSONL export parent-path entry is unavailable");
			const entry = hydrated.entry;
			if (entry.type === "message" && entry.message.role === "assistant") {
				const target: ContextUpdateTarget = { kind: "assistant-usage", targetId: entry.id };
				for (const ref of (await view.branchContext.contextUpdates(target)).refs) {
					const update = await readUsageUpdate(view, ref, target, maxSourceBytes);
					if (update.type !== "child_usage_attributed" || update.targetId !== entry.id)
						throw new Error("JSONL export usage target mismatch");
					entry.message.usage = cloneUsage(update.aggregateUsage);
				}
			}
			yield entry;
		}
		cursor = page.nextCursor ?? undefined;
	} while (cursor);
}

function* residentParentPath(entries: readonly SessionEntry[], leafId: string | null): Generator<SessionEntry> {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const path: SessionEntry[] = [];
	let current = leafId ? byId.get(leafId) : undefined;
	while (current) {
		if (path.length >= entries.length) throw new Error("JSONL export resident parent path is cyclic");
		path.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	for (let index = path.length - 1; index >= 0; index--) yield path[index];
}

/** Raw JSONL transport of one branch; this does not import, replay, or change source authority. */
export async function exportSessionBranchToJsonl(
	manager: SessionManager,
	outputPath: string,
	options: JsonlExportOptions = {},
): Promise<string> {
	const filePath = resolve(outputPath);
	const residentLimits = { ...(options.residentLimits ?? DEFAULT_RESIDENT_LIMITS) };
	const maxRecordBytes = options.maxRecordBytes ?? SESSION_JOURNAL_MAX_RECORD_BYTES;
	if (
		![maxRecordBytes, residentLimits.maxEntries, residentLimits.maxSourceBytes].every(
			(value) => Number.isSafeInteger(value) && value > 0,
		)
	) {
		throw new Error("Invalid JSONL export limits");
	}
	const maxSourceBytes = Math.min(SESSION_JOURNAL_MAX_FRAME_BYTES, maxRecordBytes + 256);
	const sourceId = manager.getSessionId();
	const sourceFile = manager.getSessionFile();
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: sourceId,
		timestamp: new Date().toISOString(),
		cwd: manager.getCwd(),
	};
	const output: { file?: FileHandle } = {};
	const errors: unknown[] = [];
	const writeBranch = async (entries: AsyncIterable<SessionEntry> | Iterable<SessionEntry>) => {
		await mkdir(dirname(filePath), { recursive: true });
		let file: FileHandle;
		try {
			file = await open(filePath, "wx");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "EEXIST") {
				throw new Error(`Export output already exists; choose a new filename: ${filePath}`);
			}
			throw error;
		}
		output.file = file;
		const writeRecord = (record: SessionHeader | SessionEntry) =>
			file.writeFile(Buffer.from(`${stringifyBoundedJson(record, maxRecordBytes)}\n`, "utf8"));
		await writeRecord(header);
		let previousId: string | null = null;
		for await (const entry of entries) {
			await writeRecord({ ...entry, parentId: previousId });
			previousId = entry.id;
		}
	};
	try {
		// Capture before mkdir/open can yield, so output I/O cannot move the selected view.
		if (manager.supportsCapturedHistoryReads()) {
			await manager.readBranchHistory(async (view) => {
				if (view.source.sessionId !== sourceId || view.source.sessionFile !== sourceFile)
					throw new Error("Session source changed during export");
				await writeBranch(nativeParentPath(view, maxSourceBytes));
			});
		} else {
			const snapshot = manager.materializeResidentHistory(residentLimits);
			await writeBranch(residentParentPath(snapshot.entries, snapshot.leafId));
		}
	} catch (error) {
		errors.push(error);
	}
	if (output.file) {
		try {
			await output.file.close();
		} catch (error) {
			errors.push(error);
		}
		if (errors.length > 0) {
			try {
				await unlink(filePath);
			} catch (error) {
				errors.push(error);
			}
		}
	}
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, "JSONL export or cleanup failed", { cause: errors[0] });
	return filePath;
}
