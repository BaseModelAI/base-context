import { fchmodSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { writeFullySync } from "../../core/journal-io.js";
import { syncRecoveryDirectory, withRecoveryDescriptor } from "./recovery-journal-io.js";

export interface WorkerRecoveryRecord {
	version: 1;
	activeSessionId: string;
	sessionId: string;
	sessionFile?: string;
	busy: boolean;
	operation: string;
	recordedAt: string;
}

function parseRecords(path: string): { latest: Map<string, WorkerRecoveryRecord>; incompleteTail: boolean } {
	const latest = new Map<string, WorkerRecoveryRecord>();
	let contents: string;
	try {
		contents = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { latest, incompleteTail: false };
		throw error;
	}
	const lines = contents.split("\n");
	const incompleteTail = lines.pop() !== "";
	for (const [index, line] of lines.entries()) {
		if (!line) continue;
		let record: WorkerRecoveryRecord;
		try {
			record = JSON.parse(line) as WorkerRecoveryRecord;
		} catch (error) {
			throw new Error(`Corrupt worker recovery journal record at line ${index + 1}`, { cause: error });
		}
		if (
			!record ||
			typeof record !== "object" ||
			record.version !== 1 ||
			typeof record.activeSessionId !== "string" ||
			typeof record.sessionId !== "string" ||
			typeof record.busy !== "boolean" ||
			typeof record.operation !== "string" ||
			typeof record.recordedAt !== "string" ||
			(record.sessionFile !== undefined && typeof record.sessionFile !== "string")
		) {
			throw new Error(`Invalid worker recovery journal record at line ${index + 1}`);
		}
		latest.set(record.activeSessionId, record);
	}
	return { latest, incompleteTail };
}

export class WorkerRecoveryJournal {
	private readonly latest: Map<string, WorkerRecoveryRecord>;
	private readonly incompleteTail: boolean;
	private writeFailure?: { error: unknown };

	constructor(private readonly path: string) {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const restored = parseRecords(path);
		this.latest = restored.latest;
		this.incompleteTail = restored.incompleteTail;
	}

	record(input: Omit<WorkerRecoveryRecord, "version" | "recordedAt">): void {
		if (this.writeFailure) throw this.writeFailure.error;
		if (this.incompleteTail)
			throw new Error("Worker recovery journal tail requires external recovery before another write");
		const previous = this.latest.get(input.activeSessionId);
		if (
			previous?.busy === input.busy &&
			previous.operation === input.operation &&
			previous.sessionFile === input.sessionFile
		) {
			return;
		}
		const record: WorkerRecoveryRecord = {
			version: 1,
			...input,
			recordedAt: new Date().toISOString(),
		};
		this.append(record);
		this.latest.set(record.activeSessionId, record);
		if ([...this.latest.values()].every((entry) => !entry.busy)) {
			this.compact();
		}
	}

	getLatest(): WorkerRecoveryRecord[] {
		return [...this.latest.values()];
	}

	static readLatest(path: string): WorkerRecoveryRecord[] {
		return [...parseRecords(path).latest.values()];
	}

	private append(record: WorkerRecoveryRecord): void {
		const payload = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
		try {
			let created = false;
			withRecoveryDescriptor(openSync(this.path, "a+", 0o600), (fd) => {
				const size = fstatSync(fd).size;
				created = size === 0;
				const last = Buffer.alloc(1);
				if (size > 0 && (readSync(fd, last, 0, 1, size - 1) !== 1 || last[0] !== 0x0a)) {
					throw new Error("Worker recovery journal tail requires external recovery before another write");
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
	}

	private compact(): void {
		const tempPath = `${this.path}.${process.pid}.tmp`;
		const payload = Buffer.from(
			`${[...this.latest.values()].map((record) => JSON.stringify(record)).join("\n")}\n`,
			"utf8",
		);
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
	}
}
