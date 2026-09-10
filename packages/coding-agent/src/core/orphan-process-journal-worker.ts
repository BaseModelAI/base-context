// One append owner for the existing orphan JSONL. No process state is stored in SQLite.
// Kept out of the host bundle: native Bun hosts use external Node, like the journal owners.
import { closeSync, fstatSync, fsyncSync, openSync, readSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { assertProductStatePath } from "../runtime-paths.js";
import { writeFullySync } from "./journal-io.js";

const failures: unknown[] = [];
let database: DatabaseSync | undefined;
let descriptor: number | undefined;
try {
	if ("bun" in process.versions) throw new Error("Orphan journal ownership requires external Node22.12 or newer");
	const input = JSON.parse(process.argv[2] ?? "") as { path: string; parentPid: number; record: string };
	if (process.ppid !== input.parentPid) throw new Error("Orphan journal writer has no original parent");
	const path = assertProductStatePath(input.path);
	database = new DatabaseSync(assertProductStatePath(`${path}.owner.sqlite`));
	// Same lock file and SQLite locking protocol as Python. Do not remove or replace it.
	// SQLite's bounded lock wait is not an append retry: a failed append is never replayed.
	database.exec(
		"PRAGMA busy_timeout=5000; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; PRAGMA user_version=1; COMMIT;",
	);
	if (process.ppid !== input.parentPid) throw new Error("Orphan journal writer lost its original parent");
	descriptor = openSync(path, "a+", 0o600);
	const size = fstatSync(descriptor).size;
	const tail = Buffer.alloc(1);
	if (size > 0 && (readSync(descriptor, tail, 0, 1, size - 1) !== 1 || tail[0] !== 0x0a)) {
		throw new Error("Incomplete orphan process journal tail; tracking is unknown");
	}
	writeFullySync(descriptor, Buffer.from(input.record, "utf8"));
	fsyncSync(descriptor);
} catch (error) {
	failures.push(error);
} finally {
	if (descriptor !== undefined) {
		try {
			closeSync(descriptor);
		} catch (error) {
			failures.push(error);
		}
	}
	try {
		database?.close();
	} catch (error) {
		failures.push(error);
	}
}
// Preserve the append error first, then distinct descriptor/owner cleanup errors.
process.stdout.write(
	JSON.stringify(
		failures.map((error) => ({
			name: error instanceof Error ? error.name : "Error",
			message: error instanceof Error ? error.message : String(error),
			code: (error as NodeJS.ErrnoException | undefined)?.code,
		})),
	),
);
process.exitCode = failures.length > 0 ? 1 : 0;
