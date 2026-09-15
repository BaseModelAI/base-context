import { mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRlmLedgerRegistrySeedSource, RlmSpawnLedger, rlmLedgerPath } from "../modes/daemon/rlm-ledger.js";
import {
	RLM_LEDGER_MAX_MUTATION_BYTES,
	RLM_LEDGER_MAX_PENDING_BYTES,
	RLM_LEDGER_MAX_PENDING_OPERATIONS,
} from "../modes/daemon/rlm-ledger-mutations.js";
import { assertProductStatePath } from "../runtime-paths.js";
import { stringifyBoundedJson } from "./bounded-json.js";
import type { RlmJournalOwnerRequest, RlmJournalOwnerResponse } from "./rlm-journal-owner.js";

function errorText(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 8192);
}

function canonicalJournal(path: string): string {
	try {
		return realpathSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return join(realpathSync(dirname(path)), basename(path));
	}
}

let database: DatabaseSync | undefined;

async function start(): Promise<void> {
	if ("bun" in process.versions) throw new Error("RLM journal ownership requires external Node22.8 or newer, not Bun");
	const serialized = process.argv[2] ?? "";
	if (Buffer.byteLength(serialized) > RLM_LEDGER_MAX_MUTATION_BYTES)
		throw new Error("RLM journal owner options exceed byte limit");
	const options = JSON.parse(serialized) as {
		agentDir: string;
		sessionsDir: string;
		journalPath: string;
		parentPid: number;
	};
	if (!process.connected || process.ppid !== options.parentPid)
		throw new Error("RLM journal owner has no current parent");
	const agentDir = assertProductStatePath(options.agentDir);
	const sessionsDir = assertProductStatePath(options.sessionsDir);
	const requested = assertProductStatePath(options.journalPath);
	const expected = rlmLedgerPath(agentDir, sessionsDir);
	mkdirSync(dirname(expected), { recursive: true, mode: 0o700 });
	const journalPath = canonicalJournal(expected);
	if (canonicalJournal(requested) !== journalPath)
		throw new Error("RLM journal owner path does not match its ledger scope");
	assertProductStatePath(journalPath);
	const lockPath = assertProductStatePath(`${journalPath}.owner.sqlite`);
	database = new DatabaseSync(lockPath);
	const db = database;
	// Keep this connection and its EXCLUSIVE lock until admission and all accepted work have stopped.
	// The lock DB stores no canonical payload. Never unlink or replace it during ownership.
	db.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; PRAGMA user_version=1; COMMIT;");
	let lockHeld = true;
	let databaseClosed = false;
	let accepting = true;
	let parentGone = false;
	let shuttingDown = false;
	let pendingBytes = 0;
	let pendingOperations = 0;
	let tail: Promise<void> = Promise.resolve();
	const assertOwner = () => {
		if (!lockHeld || parentGone || !process.connected || process.ppid !== options.parentPid) {
			throw new Error("RLM journal ownership is no longer current");
		}
		if (canonicalJournal(expected) !== journalPath)
			throw new Error("RLM journal canonical path changed during ownership");
	};
	const ledger = new RlmSpawnLedger(agentDir, sessionsDir, createRlmLedgerRegistrySeedSource(), undefined, {
		mode: "owner",
		assertOwner,
	});
	const release = () => {
		lockHeld = false;
		if (databaseClosed) return;
		db.close();
		databaseClosed = true;
	};
	const shutdown = () => {
		accepting = false;
		parentGone = true;
		ledger.stopAdmission();
		if (shuttingDown) return;
		shuttingDown = true;
		void tail
			.then(async () => {
				await ledger.flush();
				release();
			})
			.then(
				() => process.exit(0),
				(error: unknown) => {
					console.error(errorText(error));
					process.exit(1);
				},
			);
	};
	const reply = (message: RlmJournalOwnerResponse, closing = false) => {
		if (!process.connected) {
			shutdown();
			return;
		}
		process.send?.(message, (error: Error | null) => {
			if (error) {
				shutdown();
				return;
			}
			if (closing) process.disconnect();
		});
	};
	process.on("disconnect", shutdown);
	process.on("message", (input: unknown) => {
		let request: RlmJournalOwnerRequest;
		let bytes: number;
		try {
			const encoded = stringifyBoundedJson(input, RLM_LEDGER_MAX_MUTATION_BYTES + 256);
			request = JSON.parse(encoded) as RlmJournalOwnerRequest;
			if (
				!request ||
				!Number.isSafeInteger(request.id) ||
				request.id < 1 ||
				!["mutate", "recover", "migrate_legacy", "close"].includes(request.action)
			) {
				throw new Error("Invalid RLM journal owner request");
			}
			bytes = Buffer.byteLength(encoded);
		} catch (error) {
			console.error(errorText(error));
			shutdown();
			return;
		}
		if (!accepting) {
			reply({ id: request.id, error: "RLM journal owner is closing" });
			return;
		}
		if (
			pendingOperations >= RLM_LEDGER_MAX_PENDING_OPERATIONS ||
			pendingBytes + bytes > RLM_LEDGER_MAX_PENDING_BYTES
		) {
			reply({ id: request.id, error: "RLM journal owner queue limit reached" });
			return;
		}
		if (request.action === "close") accepting = false;
		pendingOperations++;
		pendingBytes += bytes;
		const operation = tail.then(async () => {
			assertOwner();
			if (request.action === "mutate") await ledger.mutate(request.mutation);
			else if (request.action === "recover") await ledger.recover();
			else if (request.action === "migrate_legacy") await ledger.migrateLegacy();
			else {
				ledger.stopAdmission();
				await ledger.flush();
				release();
			}
		});
		tail = operation.then(
			() => {},
			() => {},
		);
		void operation
			.then(
				() => reply({ id: request.id }, request.action === "close"),
				(error: unknown) => reply({ id: request.id, error: errorText(error) }, request.action === "close"),
			)
			.finally(() => {
				pendingOperations--;
				pendingBytes -= bytes;
			});
	});
	try {
		// Seed before publishing readiness; retained legacy journals remain unchanged.
		await ledger.edges();
		assertOwner();
	} catch (error) {
		accepting = false;
		parentGone = true;
		ledger.stopAdmission();
		release();
		throw error;
	}
	reply({ ready: true, journalPath });
}

try {
	await start();
} catch (error) {
	try {
		database?.close();
	} catch {
		/* Process exit releases any remaining SQLite handle. */
	}
	const message = { startupError: errorText(error) };
	if (process.connected) process.send?.(message, () => process.exit(1));
	else {
		console.error(message.startupError);
		process.exit(1);
	}
}
