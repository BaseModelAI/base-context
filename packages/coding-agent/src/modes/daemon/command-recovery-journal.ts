import { fchmodSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { writeFullySync } from "../../core/journal-io.js";
import type { DaemonClientId, DaemonCommandId, DaemonResponse } from "./daemon-protocol.js";
import { syncRecoveryDirectory, withRecoveryDescriptor } from "./recovery-journal-io.js";

interface ReceivedRecord {
	version: 1;
	type: "received";
	key: string;
	clientId: DaemonClientId;
	commandId: DaemonCommandId;
	commandType: string;
	recordedAt: string;
}

interface ResultRecord {
	version: 1;
	type: "result";
	key: string;
	response: DaemonResponse;
	recordedAt: string;
}

interface AcknowledgedRecord {
	version: 1;
	type: "acknowledged";
	key: string;
	recordedAt: string;
}

type JournalRecord = ReceivedRecord | ResultRecord | AcknowledgedRecord;

interface JournalEntry {
	received: ReceivedRecord;
	response?: DaemonResponse;
}

export type CommandJournalBeginResult =
	| { status: "new" }
	| { status: "pending" }
	| { status: "complete"; response: DaemonResponse };

const COMPACT_AFTER_RECORDS = 4096;

export function createCommandIdempotencyKey(clientId: DaemonClientId, commandId: DaemonCommandId): string {
	return JSON.stringify([clientId, commandId]);
}

/**
 * Append-only command journal used at the supervisor boundary. A received
 * record is durable before a mutating command is dispatched; a missing result
 * after a crash is therefore treated as uncertain and is never replayed.
 */
export class CommandRecoveryJournal {
	private readonly entries = new Map<string, JournalEntry>();
	private recordCount = 0;
	private incompleteTail = false;
	private writeFailure?: { error: unknown };

	constructor(private readonly path: string) {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.load();
	}

	lookup(
		clientId: DaemonClientId,
		commandId: DaemonCommandId,
	): Exclude<CommandJournalBeginResult, { status: "new" }> | undefined {
		const existing = this.entries.get(createCommandIdempotencyKey(clientId, commandId));
		if (existing?.response) {
			return { status: "complete", response: existing.response };
		}
		return existing ? { status: "pending" } : undefined;
	}

	begin(clientId: DaemonClientId, commandId: DaemonCommandId, commandType: string): CommandJournalBeginResult {
		const key = createCommandIdempotencyKey(clientId, commandId);
		const existing = this.lookup(clientId, commandId);
		if (existing) return existing;
		this.assertWritable();
		const received: ReceivedRecord = {
			version: 1,
			type: "received",
			key,
			clientId,
			commandId,
			commandType,
			recordedAt: new Date().toISOString(),
		};
		this.append(received);
		this.entries.set(key, { received });
		return { status: "new" };
	}

	recordResult(clientId: DaemonClientId, commandId: DaemonCommandId, response: DaemonResponse): void {
		this.assertWritable();
		const key = createCommandIdempotencyKey(clientId, commandId);
		const entry = this.entries.get(key);
		if (!entry) {
			throw new Error(`Cannot record a result before command receipt: ${key}`);
		}
		const record: ResultRecord = {
			version: 1,
			type: "result",
			key,
			response,
			recordedAt: new Date().toISOString(),
		};
		this.append(record);
		entry.response = response;
		if (this.recordCount >= COMPACT_AFTER_RECORDS) {
			this.compact();
		}
	}

	acknowledge(clientId: DaemonClientId, commandId: DaemonCommandId): void {
		this.assertWritable();
		const key = createCommandIdempotencyKey(clientId, commandId);
		if (!this.entries.has(key)) {
			return;
		}
		this.append({
			version: 1,
			type: "acknowledged",
			key,
			recordedAt: new Date().toISOString(),
		});
		this.entries.delete(key);
		if (this.entries.size === 0 || this.recordCount >= COMPACT_AFTER_RECORDS) {
			this.compact();
		}
	}

	private load(): void {
		let contents: string;
		try {
			contents = readFileSync(this.path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return;
			}
			throw error;
		}
		const lines = contents.split("\n");
		this.incompleteTail = lines.pop() !== "";
		for (const [index, line] of lines.entries()) {
			if (!line) continue;
			let record: JournalRecord;
			try {
				record = JSON.parse(line) as JournalRecord;
			} catch (error) {
				throw new Error(`Corrupt command recovery journal record at line ${index + 1}`, { cause: error });
			}
			if (
				!record ||
				typeof record !== "object" ||
				record.version !== 1 ||
				typeof record.key !== "string" ||
				typeof record.recordedAt !== "string"
			) {
				throw new Error(`Invalid command recovery journal record at line ${index + 1}`);
			}
			if (record.type === "received") {
				if (
					typeof record.clientId !== "string" ||
					typeof record.commandId !== "string" ||
					typeof record.commandType !== "string" ||
					this.entries.has(record.key) ||
					record.key !== createCommandIdempotencyKey(record.clientId, record.commandId)
				) {
					throw new Error(`Invalid command receipt at line ${index + 1}`);
				}
				this.entries.set(record.key, { received: record });
			} else if (record.type === "acknowledged") {
				if (!this.entries.delete(record.key))
					throw new Error(`Unknown command acknowledgement at line ${index + 1}`);
			} else if (record.type === "result") {
				const entry = this.entries.get(record.key);
				if (
					!entry ||
					record.response?.type !== "response" ||
					typeof record.response.success !== "boolean" ||
					record.response.id !== entry.received.commandId ||
					typeof record.response.command !== "string"
				) {
					throw new Error(`Invalid command result at line ${index + 1}`);
				}
				entry.response = record.response;
			} else throw new Error(`Unknown command recovery record at line ${index + 1}`);
			this.recordCount++;
		}
	}

	private assertWritable(): void {
		if (this.writeFailure) throw this.writeFailure.error;
		if (this.incompleteTail)
			throw new Error("Command recovery journal tail requires external recovery before another write");
	}

	private append(record: JournalRecord): void {
		const payload = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
		try {
			let created = false;
			withRecoveryDescriptor(openSync(this.path, "a+", 0o600), (fd) => {
				const size = fstatSync(fd).size;
				created = size === 0;
				const last = Buffer.alloc(1);
				if (size > 0 && (readSync(fd, last, 0, 1, size - 1) !== 1 || last[0] !== 0x0a)) {
					throw new Error("Command recovery journal tail requires external recovery before another write");
				}
				fchmodSync(fd, 0o600);
				writeFullySync(fd, payload);
				fsyncSync(fd);
			});
			if (created) syncRecoveryDirectory(dirname(this.path));
		} catch (error) {
			this.writeFailure = { error };
			throw error;
		}
		this.recordCount++;
	}

	private compact(): void {
		const tempPath = `${this.path}.${process.pid}.tmp`;
		const records: JournalRecord[] = [];
		for (const [key, entry] of this.entries) {
			records.push(entry.received);
			if (entry.response) {
				records.push({
					version: 1,
					type: "result",
					key,
					response: entry.response,
					recordedAt: new Date().toISOString(),
				});
			}
		}
		const payload = Buffer.from(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
		try {
			withRecoveryDescriptor(openSync(tempPath, "w", 0o600), (fd) => {
				fchmodSync(fd, 0o600);
				writeFullySync(fd, payload);
				fsyncSync(fd);
			});
			renameSync(tempPath, this.path);
			syncRecoveryDirectory(dirname(this.path));
		} catch (error) {
			this.writeFailure = { error };
			throw error;
		}
		this.recordCount = records.length;
	}
}
