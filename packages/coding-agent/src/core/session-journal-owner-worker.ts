import {
	closeSync,
	constants,
	existsSync,
	fchmodSync,
	fchownSync,
	fstatSync,
	fsyncSync,
	ftruncateSync,
	linkSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	renameSync,
	rmSync,
	type Stats,
	statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TextDecoder } from "node:util";
import { assertProductStatePath } from "../runtime-paths.js";
import { stringifyBoundedJson } from "./bounded-json.js";
import {
	decodeJournalFrame,
	encodeJournalFrameJson,
	INITIAL_JOURNAL_CURSOR,
	type JournalCursor,
} from "./journal-frame.js";
import { syncJournalDirectory, withJournalDescriptorSync, writeFullySync } from "./journal-io.js";
import { removeSessionFile } from "./session-file-removal.js";
import {
	SESSION_JOURNAL_CHUNK_BYTES,
	SESSION_JOURNAL_MAX_FRAME_BYTES,
	SESSION_JOURNAL_MAX_IPC_BYTES,
	SESSION_JOURNAL_MAX_RECORD_BYTES,
	type SessionJournalRequest,
	type SessionJournalResponse,
	type SessionJournalState,
	sessionJournalUtf8Chunks,
} from "./session-journal-owner.js";

interface ScanResult {
	format: "legacy" | "framed";
	cursor: JournalCursor;
	nextSequence: number;
	keep: number;
	size: number;
}
interface Upload {
	fd: number;
	expected: number;
	received: number;
}

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

async function withDescriptor<T>(fd: number, action: (fd: number) => Promise<T>): Promise<T> {
	let result: T;
	try {
		result = await action(fd);
	} catch (error) {
		try {
			closeSync(fd);
		} catch {
			/* Preserve the first read/write failure. */
		}
		throw error;
	}
	closeSync(fd);
	return result;
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
let database: DatabaseSync | undefined;
let startupRelease = () => {};

async function start(): Promise<void> {
	if ("bun" in process.versions)
		throw new Error("Session journal ownership requires external Node22.8 or newer, not Bun");
	const serialized = process.argv[2] ?? "";
	if (Buffer.byteLength(serialized) > SESSION_JOURNAL_CHUNK_BYTES)
		throw new Error("Session journal options exceed byte limit");
	const options = JSON.parse(serialized) as { journalPath: string; create: boolean; parentPid: number; remove?: true };
	if (!process.connected || process.ppid !== options.parentPid)
		throw new Error("Session journal owner has no current parent");
	const requestedPath = assertProductStatePath(options.journalPath);
	mkdirSync(dirname(requestedPath), { recursive: true, mode: 0o700 });
	const journalPath = assertProductStatePath(canonicalJournal(requestedPath));
	const lockPath = assertProductStatePath(`${journalPath}.owner.sqlite`);
	database = new DatabaseSync(lockPath);
	const db = database;
	// The database stores no canonical payload, and is never removed or replaced by an owner.
	db.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; PRAGMA user_version=1; COMMIT;");
	if (options.remove) {
		if (!process.connected || process.ppid !== options.parentPid || canonicalJournal(requestedPath) !== journalPath)
			throw new Error("Session journal ownership is no longer current");
		// Deletion needs the lifetime fence, not a readable journal or a writer-ready state.
		const removed = await removeSessionFile(journalPath);
		if (removed.ok) syncJournalDirectory(dirname(journalPath));
		db.close();
		database = undefined;
		if (process.connected) process.send?.({ removed }, () => process.exit(0));
		else process.exit(0);
		return;
	}
	let lockHeld = true;
	let databaseClosed = false;
	let accepting = true;
	let parentGone = false;
	let stopping = false;
	let poisoned = false;
	let queue: Promise<void> = Promise.resolve();
	let pendingOperations = 0;
	let pendingBytes = 0;
	let upload: Upload | undefined;
	const uploadPath = assertProductStatePath(`${journalPath}.incoming`);
	const migrationPath = assertProductStatePath(`${journalPath}.migrate-tmp`);
	const retainedPath = assertProductStatePath(`${journalPath}.legacy-v3`);
	let state: ScanResult = { format: "framed", cursor: INITIAL_JOURNAL_CURSOR, nextSequence: 0, keep: 0, size: 0 };
	let fileIdentity: Pick<Stats, "dev" | "ino"> | undefined;
	const snapshot = (): SessionJournalState => ({
		journalPath,
		nextSequence: state.nextSequence,
		format: state.format,
	});
	const assertOwner = () => {
		if (!lockHeld || parentGone || !process.connected || process.ppid !== options.parentPid) {
			throw new Error("Session journal ownership is no longer current");
		}
		if (canonicalJournal(requestedPath) !== journalPath)
			throw new Error("Session journal canonical path changed during ownership");
	};
	const abortUpload = () => {
		const current = upload;
		upload = undefined;
		if (current) closeSync(current.fd);
		rmSync(uploadPath, { force: true });
	};
	const release = () => {
		accepting = false;
		lockHeld = false;
		try {
			abortUpload();
		} finally {
			if (!databaseClosed) {
				db.close();
				databaseClosed = true;
			}
		}
	};
	startupRelease = release;
	const requireFileIdentity = (current: Pick<Stats, "dev" | "ino">) => {
		if (fileIdentity && (current.dev !== fileIdentity.dev || current.ino !== fileIdentity.ino)) {
			poisoned = true;
			throw new Error("Session journal file identity changed outside its owner");
		}
		fileIdentity ??= current;
	};
	const requireStable = () => {
		assertOwner();
		const current = statSync(journalPath);
		requireFileIdentity(current);
		if (current.size !== state.size) {
			poisoned = true;
			throw new Error("Session journal changed outside its owner; recovery is required");
		}
	};
	const requireAppendable = () => {
		assertOwner();
		if (poisoned) throw new Error("Session journal requires owner recovery before another append");
		if (state.format === "legacy")
			throw new Error("Legacy session journal requires explicit retained migration before append");
		if (state.keep !== state.size)
			throw new Error("Session journal has an incomplete tail; owner recovery is required");
		requireStable();
	};

	/** One bounded physical record at a time; yield while scanning a long source. */
	const scan = async (onLegacy?: (json: string) => void): Promise<ScanResult> => {
		assertOwner();
		return withDescriptor(openSync(journalPath, "r"), async (fd) => {
			const current = fstatSync(fd);
			requireFileIdentity(current);
			const size = current.size;
			let position = 0;
			let keep = 0;
			let nextSequence = 0;
			let cursor = INITIAL_JOURNAL_CURSOR;
			let format: "legacy" | "framed" | undefined;
			let leadingBlank = false;
			let parts: Buffer[] = [];
			let partBytes = 0;
			let sinceYield = 0;
			const chunk = Buffer.alloc(SESSION_JOURNAL_CHUNK_BYTES);
			while (position < size) {
				assertOwner();
				const count = readSync(fd, chunk, 0, Math.min(chunk.length, size - position), position);
				if (count === 0) throw new Error("Session journal changed while reading");
				let startOffset = 0;
				while (startOffset < count) {
					const found = chunk.indexOf(0x0a, startOffset);
					const end = found >= 0 && found < count ? found + 1 : count;
					const part = Buffer.from(chunk.subarray(startOffset, end));
					partBytes += part.length;
					if (partBytes > SESSION_JOURNAL_MAX_FRAME_BYTES)
						throw new Error("Session journal record byte limit exceeded");
					parts.push(part);
					if (found >= 0 && found < count) {
						const bytes = Buffer.concat(parts, partBytes);
						parts = [];
						partBytes = 0;
						const json = decoder.decode(bytes).slice(0, -1);
						if (!json.trim()) {
							if (format === "framed") throw new Error("Invalid blank journal frame");
							leadingBlank = true;
						} else {
							let parsed: unknown;
							try {
								parsed = JSON.parse(json);
							} catch (error) {
								throw new Error(`Malformed session journal record ${nextSequence}: ${errorText(error)}`);
							}
							const framed =
								parsed !== null && typeof parsed === "object" && Object.hasOwn(parsed, "journalFrame");
							const recordFormat = framed ? "framed" : "legacy";
							if (format !== undefined && format !== recordFormat)
								throw new Error("Mixed framed and legacy session journal");
							format = recordFormat;
							if (framed) {
								if (leadingBlank) throw new Error("Invalid blank record before journal frames");
								if (onLegacy) throw new Error("Retained migration requires a legacy journal");
								cursor = decodeJournalFrame(bytes, cursor, SESSION_JOURNAL_MAX_FRAME_BYTES).next;
							} else {
								if (Buffer.byteLength(json) > SESSION_JOURNAL_MAX_RECORD_BYTES)
									throw new Error("Session JSON record byte limit exceeded");
								onLegacy?.(json);
							}
							nextSequence++;
						}
						keep = position + end;
					}
					startOffset = end;
				}
				position += count;
				sinceYield += count;
				if (sinceYield >= 4 * 1024 * 1024) {
					sinceYield = 0;
					await new Promise<void>((resolveYield) => setImmediate(resolveYield));
				}
			}
			assertOwner();
			requireFileIdentity(statSync(journalPath));
			if (fstatSync(fd).size !== size) throw new Error("Session journal changed while reading");
			if (format === undefined && size > 0) {
				const prefix = parts[0]?.toString("utf8").trimStart() ?? "";
				format = !leadingBlank && prefix.startsWith('{"journalFrame":') ? "framed" : "legacy";
			}
			return { format: format ?? "framed", cursor, nextSequence, keep, size };
		});
	};

	const writeText = (fd: number, text: string) => {
		for (const bytes of sessionJournalUtf8Chunks(text)) {
			assertOwner();
			writeFullySync(fd, bytes);
		}
	};

	const commit = (): number => {
		requireAppendable();
		const current = upload;
		if (!current || current.received !== current.expected || fstatSync(current.fd).size !== current.expected) {
			throw new Error("Incomplete session journal upload");
		}
		upload = undefined;
		closeSync(current.fd);
		const json = decoder.decode(readFileSync(uploadPath));
		if (json.includes("\n")) throw new Error("Session JSON must be a single logical line");
		const encoded = encodeJournalFrameJson(json, state.cursor, SESSION_JOURNAL_MAX_FRAME_BYTES);
		const sequence = state.cursor.sequence;
		const bytes = Buffer.byteLength(encoded.line);
		rmSync(uploadPath, { force: true });
		try {
			withJournalDescriptorSync(openSync(journalPath, constants.O_RDWR | constants.O_APPEND), (fd) => {
				const current = fstatSync(fd);
				requireFileIdentity(current);
				if (current.size !== state.size) throw new Error("Session journal changed before append");
				writeText(fd, encoded.line);
				fsyncSync(fd);
			});
			assertOwner();
			requireFileIdentity(statSync(journalPath));
		} catch (error) {
			poisoned = true;
			throw error;
		}
		state = {
			format: "framed",
			cursor: encoded.next,
			nextSequence: encoded.next.sequence,
			keep: state.size + bytes,
			size: state.size + bytes,
		};
		return sequence;
	};

	const recover = async () => {
		assertOwner();
		poisoned = true;
		abortUpload();
		const recovered = await scan();
		if (recovered.format === "legacy" && recovered.keep !== recovered.size) {
			throw new Error("Use retained migration to recover a legacy tail without changing its original bytes");
		}
		try {
			withJournalDescriptorSync(openSync(journalPath, "r+"), (fd) => {
				assertOwner();
				const current = fstatSync(fd);
				requireFileIdentity(current);
				if (current.size !== recovered.size) throw new Error("Session journal changed before recovery");
				if (recovered.keep !== recovered.size) ftruncateSync(fd, recovered.keep);
				fsyncSync(fd);
			});
			syncJournalDirectory(dirname(journalPath));
			assertOwner();
			requireFileIdentity(statSync(journalPath));
		} catch (error) {
			poisoned = true;
			throw error;
		}
		state = { ...recovered, size: recovered.keep };
		poisoned = false;
	};

	const migrate = async () => {
		assertOwner();
		if (state.format !== "legacy") return;
		if (upload) throw new Error("Cannot migrate during a session upload");
		requireStable();
		const original = statSync(journalPath);
		if (existsSync(retainedPath)) {
			const retained = statSync(retainedPath);
			if (retained.ino !== original.ino || retained.dev !== original.dev)
				throw new Error("Retained legacy source path already exists");
		}
		rmSync(migrationPath, { force: true });
		let next = INITIAL_JOURNAL_CURSOR;
		let bytes = 0;
		try {
			const { source, identity } = await withDescriptor(
				openSync(migrationPath, "wx", original.mode & 0o777),
				async (fd) => {
					fchownSync(fd, original.uid, original.gid);
					fchmodSync(fd, original.mode & 0o777);
					const scanned = await scan((json) => {
						const encoded = encodeJournalFrameJson(json, next, SESSION_JOURNAL_MAX_FRAME_BYTES);
						writeText(fd, encoded.line);
						next = encoded.next;
						bytes += Buffer.byteLength(encoded.line);
					});
					fsyncSync(fd);
					return { source: scanned, identity: fstatSync(fd) };
				},
			);
			if (source.format !== "legacy") throw new Error("Session journal migration source changed format");
			requireStable();
			// A prior interrupted migration may have published this same original inode already.
			if (!existsSync(retainedPath)) linkSync(journalPath, retainedPath);
			withJournalDescriptorSync(openSync(retainedPath, "r"), (fd) => fsyncSync(fd));
			syncJournalDirectory(dirname(journalPath));
			assertOwner();
			poisoned = true;
			renameSync(migrationPath, journalPath);
			fileIdentity = identity;
			syncJournalDirectory(dirname(journalPath));
			assertOwner();
			requireFileIdentity(statSync(journalPath));
			state = { format: "framed", cursor: next, nextSequence: next.sequence, keep: bytes, size: bytes };
			poisoned = false;
		} catch (error) {
			try {
				rmSync(migrationPath, { force: true });
			} catch {
				/* Preserve the first migration failure. */
			}
			throw error;
		}
		rmSync(migrationPath, { force: true });
	};

	const shutdown = () => {
		accepting = false;
		parentGone = true;
		if (stopping) return;
		stopping = true;
		void queue.then(
			() => {
				release();
				process.exit(0);
			},
			(error: unknown) => {
				console.error(errorText(error));
				release();
				process.exit(1);
			},
		);
	};
	const reply = (message: SessionJournalResponse, closing = false) => {
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

	// Only after obtaining the lifetime lock may this actor create or clean its unpublished stages.
	if (options.create) {
		withJournalDescriptorSync(openSync(journalPath, "wx", 0o600), (fd) => fsyncSync(fd));
		syncJournalDirectory(dirname(journalPath));
	} else if (!statSync(journalPath).isFile()) throw new Error("Session journal must be a regular file");
	rmSync(uploadPath, { force: true });
	rmSync(migrationPath, { force: true });
	const initializing = scan().then((result) => {
		state = result;
	});
	queue = initializing.then(
		() => {},
		() => {},
	);
	await initializing;
	assertOwner();

	process.on("message", (input: unknown) => {
		let request: SessionJournalRequest;
		let bytes: number;
		try {
			const encoded = stringifyBoundedJson(input, SESSION_JOURNAL_MAX_IPC_BYTES);
			request = JSON.parse(encoded) as SessionJournalRequest;
			if (
				!request ||
				!Number.isSafeInteger(request.id) ||
				request.id < 1 ||
				!["begin", "chunk", "commit", "abort", "flush", "recover", "migrate", "close"].includes(request.action)
			)
				throw new Error("Invalid session journal request");
			bytes = Buffer.byteLength(encoded);
		} catch (error) {
			console.error(errorText(error));
			shutdown();
			return;
		}
		if (!accepting) {
			reply({ id: request.id, error: "Session journal owner is closing" });
			return;
		}
		if (pendingOperations >= 32 || pendingBytes + bytes > 1024 * 1024) {
			reply({ id: request.id, error: "Session journal IPC queue limit reached" });
			return;
		}
		if (request.action === "close") accepting = false;
		pendingOperations++;
		pendingBytes += bytes;
		const operation = queue.then(async (): Promise<number | undefined> => {
			assertOwner();
			switch (request.action) {
				case "begin":
					requireAppendable();
					if (upload) throw new Error("Session journal upload already active");
					if (
						!Number.isSafeInteger(request.bytes) ||
						request.bytes < 1 ||
						request.bytes > SESSION_JOURNAL_MAX_RECORD_BYTES
					)
						throw new Error("Session journal record byte limit exceeded");
					upload = { fd: openSync(uploadPath, "wx", 0o600), expected: request.bytes, received: 0 };
					return;
				case "chunk": {
					if (!upload || typeof request.data !== "string") throw new Error("Session journal upload is not active");
					const chunk = Buffer.from(request.data, "base64");
					if (
						chunk.length === 0 ||
						chunk.length > SESSION_JOURNAL_CHUNK_BYTES ||
						chunk.toString("base64") !== request.data ||
						upload.received + chunk.length > upload.expected
					)
						throw new Error("Invalid session journal upload chunk");
					writeFullySync(upload.fd, chunk);
					upload.received += chunk.length;
					return;
				}
				case "commit":
					return commit();
				case "abort":
					abortUpload();
					return;
				case "flush":
					if (upload) throw new Error("Cannot flush an incomplete session upload");
					if (poisoned) throw new Error("Session journal requires owner recovery");
					requireStable();
					withJournalDescriptorSync(openSync(journalPath, "r+"), (fd) => {
						requireFileIdentity(fstatSync(fd));
						fsyncSync(fd);
					});
					return;
				case "recover":
					await recover();
					return;
				case "migrate":
					await migrate();
					return;
				case "close":
					release();
					return;
			}
		});
		queue = operation.then(
			() => {},
			() => {},
		);
		void operation
			.then(
				(sequence) =>
					reply(
						{ id: request.id, state: snapshot(), ...(sequence === undefined ? {} : { sequence }) },
						request.action === "close",
					),
				(error: unknown) => {
					try {
						if (request.action === "begin" || request.action === "chunk" || request.action === "commit")
							abortUpload();
					} catch {
						/* Keep the failed request's original error. */
					}
					reply({ id: request.id, error: errorText(error) }, request.action === "close");
				},
			)
			.finally(() => {
				pendingOperations--;
				pendingBytes -= bytes;
			});
	});
	reply({ ready: snapshot() });
}

try {
	await start();
} catch (error) {
	try {
		startupRelease();
	} catch {
		/* Process exit releases any remaining ownership handle. */
	}
	try {
		database?.close();
	} catch {
		/* Preserve startup's first failure. */
	}
	const message = { startupError: errorText(error) };
	if (process.connected) process.send?.(message, () => process.exit(1));
	else {
		console.error(message.startupError);
		process.exit(1);
	}
}
