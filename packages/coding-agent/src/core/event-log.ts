import {
	constants,
	fstatSync,
	fsyncSync,
	ftruncateSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	renameSync,
	rmSync,
} from "node:fs";
import { dirname } from "node:path";
import { stringifyBoundedJson } from "./bounded-json.js";
import {
	decodeJournalFrame,
	encodeJournalFrame,
	encodeJournalFrameJson,
	INITIAL_JOURNAL_CURSOR,
	type JournalCursor,
} from "./journal-frame.js";
import { syncJournalDirectory, withJournalDescriptorSync, writeFullySync } from "./journal-io.js";

/** Bounded JSONL I/O. The caller must supply exclusive ownership; this class does not acquire it. */
export interface EventLogOptions {
	maxBytes?: number;
	maxRecords?: number;
	maxRecordBytes?: number;
	maxBatchBytes?: number;
	assertOwner?: () => void;
	validateRecord?: (line: string, index: number) => void;
	log?: (message: string) => void;
}

function readAllSync(fd: number, maxBytes: number, path: string): Buffer {
	const size = fstatSync(fd).size;
	if (size > maxBytes) throw new Error(`event log ${path} exceeds ${maxBytes} bytes (${size}); refusing to read`);
	const buffer = Buffer.alloc(size);
	let offset = 0;
	while (offset < size) {
		const bytesRead = readSync(fd, buffer, offset, size - offset, offset);
		if (bytesRead === 0) throw new Error(`event log ${path} changed during read`);
		offset += bytesRead;
	}
	return buffer;
}

export class EventLog {
	private poisoned = false;
	private readonly maxBytes: number;
	private readonly maxRecords: number;
	private readonly maxRecordBytes: number;
	private readonly maxBatchBytes: number;

	constructor(
		readonly path: string,
		private readonly options: EventLogOptions = {},
	) {
		this.maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
		this.maxRecords = options.maxRecords ?? 100_000;
		this.maxRecordBytes = options.maxRecordBytes ?? 64 * 1024;
		this.maxBatchBytes = options.maxBatchBytes ?? 256 * 1024;
	}

	get requiresRepair(): boolean {
		return this.poisoned;
	}

	private assertOwner(): void {
		if (!this.options.assertOwner) throw new Error("Event log is read-only; an exclusive owner is required");
		this.options.assertOwner();
	}

	private scan<T>(
		contents: Buffer,
		parse: (line: string, index: number) => T | undefined,
		requireCompleteTail = false,
	): { events: T[]; keep: number; records: number; cursor: JournalCursor; format: "empty" | "legacy" | "framed" } {
		const events: T[] = [];
		let start = 0;
		let index = 0;
		let records = 0;
		let cursor = INITIAL_JOURNAL_CURSOR;
		let format: "empty" | "legacy" | "framed" = "empty";
		while (start < contents.length) {
			const end = contents.indexOf(0x0a, start);
			if ((end < 0 ? contents.length : end + 1) - start > this.maxRecordBytes)
				throw new Error("Event log record byte limit exceeded");
			if (end < 0) {
				if (requireCompleteTail) throw new Error("Event log has an incomplete final record");
				this.options.log?.("ignored torn final line");
				break;
			}
			const bytes = contents.subarray(start, end + 1);
			let line = bytes.toString("utf8").trim();
			if (!line && format === "framed") throw new Error("Invalid empty journal frame");
			if (line) {
				if (++records > this.maxRecords)
					throw new Error(`event log ${this.path} exceeds ${this.maxRecords} records; refusing to read`);
				let parsed: unknown;
				try {
					parsed = JSON.parse(line);
				} catch {
					/* Legacy parsing remains the caller's policy. */
				}
				const framed = Boolean(
					parsed &&
						typeof parsed === "object" &&
						(Object.hasOwn(parsed, "journalFrame") || Object.hasOwn(parsed, "previousChecksum")),
				);
				if (format === "empty") format = framed ? "framed" : "legacy";
				if (format === "legacy" && framed) throw new Error("Mixed legacy and framed event log");
				if (format === "framed") {
					const decoded = decodeJournalFrame(bytes, cursor, this.maxRecordBytes);
					cursor = decoded.next;
					line = decoded.json;
				}
				const event = parse(line, index);
				if (event !== undefined) events.push(event);
			}
			start = end + 1;
			index++;
		}
		return { events, keep: start, records, cursor, format };
	}

	/** Readers never repair or expose an unterminated record, even when its JSON parses. */
	replaySync<T>(
		parse: (line: string, index: number) => T | undefined,
		options: { requireCompleteTail?: boolean } = {},
	): T[] {
		let fd: number;
		try {
			fd = openSync(this.path, "r");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		return withJournalDescriptorSync(
			fd,
			() => this.scan(readAllSync(fd, this.maxBytes, this.path), parse, options.requireCompleteTail).events,
		);
	}

	private validate = (line: string, index: number): undefined => {
		if (this.options.validateRecord) this.options.validateRecord(line, index);
		else JSON.parse(line);
		return undefined;
	};

	/** Checked framed append. Retained unframed journals need explicit migration before writing. */
	appendSync(events: unknown[], options?: { durable?: boolean; onCreate?: () => unknown[] }): void {
		this.assertOwner();
		if (this.poisoned) throw new Error("Event log requires owner recovery before another append");
		if (events.length > 128) throw new Error("Event log batch record limit exceeded");
		let normalizedBytes = 0;
		const normalize = (event: unknown): unknown => {
			const json = stringifyBoundedJson(event, this.maxRecordBytes);
			normalizedBytes += Buffer.byteLength(json);
			if (normalizedBytes > this.maxBatchBytes) throw new Error("Event log batch byte limit exceeded");
			return JSON.parse(json) as unknown;
		};
		const normalized = events.map(normalize);
		const prepare = (contents: Buffer): { keep: number; payload: Buffer } => {
			const scan = this.scan(contents, this.validate);
			if (scan.format === "legacy") throw new Error("Legacy event log requires explicit migration before append");
			const lead = scan.records === 0 ? (options?.onCreate?.() ?? []).map(normalize) : [];
			if (lead.length + normalized.length > 128) throw new Error("Event log batch record limit exceeded");
			let cursor = scan.cursor;
			let bytes = 0;
			const lines: string[] = [];
			for (const event of [...lead, ...normalized]) {
				const encoded = encodeJournalFrame(event, cursor, this.maxRecordBytes);
				cursor = encoded.next;
				bytes += Buffer.byteLength(encoded.line);
				if (bytes > this.maxBatchBytes) throw new Error("Event log batch byte limit exceeded");
				lines.push(encoded.line);
			}
			if (scan.keep + bytes > this.maxBytes) throw new Error("Event log append exceeds journal byte limit");
			if (scan.records + lines.length > this.maxRecords)
				throw new Error("Event log append exceeds journal record limit");
			return { keep: scan.keep, payload: Buffer.from(lines.join(""), "utf8") };
		};
		let mutated = false;
		const append = (fd: number, prepared: { keep: number; payload: Buffer }): void => {
			this.assertOwner();
			mutated = true;
			if (prepared.keep !== fstatSync(fd).size) ftruncateSync(fd, prepared.keep);
			writeFullySync(fd, prepared.payload);
			if (options?.durable) fsyncSync(fd);
			this.assertOwner();
		};
		let existing: number | undefined;
		try {
			existing = openSync(this.path, constants.O_RDWR | constants.O_APPEND);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		try {
			if (existing !== undefined) {
				withJournalDescriptorSync(existing, (fd) => append(fd, prepare(readAllSync(fd, this.maxBytes, this.path))));
			} else {
				const prepared = prepare(Buffer.alloc(0));
				mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
				this.assertOwner();
				const fd = openSync(
					this.path,
					constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL,
					0o600,
				);
				mutated = true;
				withJournalDescriptorSync(fd, () => append(fd, prepared));
				if (options?.durable) syncJournalDirectory(dirname(this.path));
			}
		} catch (error) {
			if (mutated) this.poisoned = true;
			throw error;
		}
	}

	/** Explicit migration under the lifetime owner. The exact old inode stays at .legacy-v1. */
	migrateLegacySync(): void {
		this.assertOwner();
		if (this.poisoned) throw new Error("Event log requires owner recovery before migration");
		const retainedPath = `${this.path}.legacy-v1`;
		const stagedPath = `${this.path}.migration-v1.tmp`;
		let staged = false;
		let published = false;
		try {
			withJournalDescriptorSync(openSync(this.path, "r+"), (source) => {
				const contents = readAllSync(source, this.maxBytes, this.path);
				const scan = this.scan(contents, (line, index) => {
					this.validate(line, index);
					return line;
				});
				if (scan.format !== "legacy") return;
				const complete = contents.subarray(0, scan.keep);
				if (!Buffer.from(complete.toString("utf8"), "utf8").equals(complete)) {
					throw new Error("Invalid legacy journal UTF8");
				}
				this.assertOwner();
				// This reserved staging path is never published as a source locator.
				rmSync(stagedPath, { force: true });
				const target = openSync(stagedPath, "wx", 0o600);
				staged = true;
				withJournalDescriptorSync(target, () => {
					let cursor = INITIAL_JOURNAL_CURSOR;
					let bytes = 0;
					for (const line of scan.events) {
						const encoded = encodeJournalFrameJson(line, cursor, this.maxRecordBytes);
						cursor = encoded.next;
						bytes += Buffer.byteLength(encoded.line);
						if (bytes > this.maxBytes) throw new Error("Migrated journal exceeds byte limit");
						this.assertOwner();
						writeFullySync(target, Buffer.from(encoded.line));
					}
					fsyncSync(target);
				});
				fsyncSync(source);
				this.assertOwner();
				try {
					linkSync(this.path, retainedPath);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
					const retained = lstatSync(retainedPath);
					const original = fstatSync(source);
					if (!retained.isFile() || retained.ino !== original.ino || retained.dev !== original.dev) {
						throw new Error("Retained legacy journal path already belongs to another source");
					}
				}
				syncJournalDirectory(dirname(this.path));
				this.assertOwner();
				renameSync(stagedPath, this.path);
				published = true;
				staged = false;
				syncJournalDirectory(dirname(this.path));
				this.assertOwner();
			});
		} catch (error) {
			if (published) this.poisoned = true;
			if (staged) {
				try {
					rmSync(stagedPath, { force: true });
				} catch {
					this.poisoned = true;
				}
			}
			throw error;
		}
	}

	/** Explicit owner-only recovery. Complete interior records must validate before tail removal. */
	recoverSync(): void {
		this.assertOwner();
		let fd: number;
		try {
			fd = openSync(this.path, "r+");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			this.poisoned = false;
			return;
		}
		try {
			withJournalDescriptorSync(fd, () => {
				const contents = readAllSync(fd, this.maxBytes, this.path);
				const { keep } = this.scan(contents, this.validate);
				this.assertOwner();
				if (keep !== contents.length) ftruncateSync(fd, keep);
				fsyncSync(fd);
				this.assertOwner();
			});
			syncJournalDirectory(dirname(this.path));
			this.poisoned = false;
		} catch (error) {
			this.poisoned = true;
			throw error;
		}
	}
}
