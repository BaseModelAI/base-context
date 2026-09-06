import { closeSync, constants, fstatSync, fsyncSync, openSync, readSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { assertProductStatePath } from "../runtime-paths.js";

type Write = (fd: number, buffer: Buffer, offset: number, length: number, position: null) => number;

/** Checked byte progress. This is not a cross-process transaction or writer lease. */
export function writeFullySync(fd: number, payload: Buffer, write: Write = writeSync): void {
	let offset = 0;
	while (offset < payload.length) {
		let written: number;
		try {
			written = write(fd, payload, offset, payload.length - offset, null);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EINTR") continue;
			throw error;
		}
		if (written <= 0 || written > payload.length - offset)
			throw new Error("Journal write made invalid byte progress");
		offset += written;
	}
}

/** Always close the descriptor, preserving an earlier write/sync failure if close also fails. */
export function withJournalDescriptorSync<T>(fd: number, action: (fd: number) => T): T {
	let result: T;
	try {
		result = action(fd);
	} catch (error) {
		try {
			closeSync(fd);
		} catch {
			// The first I/O error remains the reason this operation was not acknowledged.
		}
		throw error;
	}
	closeSync(fd);
	return result;
}

/** Windows directory persistence still requires its platform-specific release validation. */
export function syncJournalDirectory(path: string): void {
	if (process.platform === "win32") return;
	withJournalDescriptorSync(openSync(path, constants.O_RDONLY), (fd) => fsyncSync(fd));
}

/** Append only to an existing complete source file; never create a headerless replacement. */
export function appendJournalRecord(path: string, serialized: string): void {
	assertProductStatePath(path);
	const payload = Buffer.from(serialized, "utf8");
	withJournalDescriptorSync(openSync(path, constants.O_RDWR | constants.O_APPEND), (fd) => {
		const size = fstatSync(fd).size;
		const last = Buffer.alloc(1);
		if (size === 0 || readSync(fd, last, 0, 1, size - 1) !== 1 || last[0] !== 0x0a) {
			throw new Error("Journal tail requires repair before another append");
		}
		writeFullySync(fd, payload);
		fsyncSync(fd);
	});
}

export function syncJournalFile(path: string): void {
	assertProductStatePath(path);
	withJournalDescriptorSync(openSync(path, constants.O_RDWR), (fd) => fsyncSync(fd));
	syncJournalDirectory(dirname(path));
}
