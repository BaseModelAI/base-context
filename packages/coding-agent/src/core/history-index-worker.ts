import { fstatSync, mkdirSync, openSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { stringifyBoundedJson } from "./bounded-json.js";
import { type CanonicalPayloadParts, readCanonicalPayloadFragment } from "./canonical-payload-parts.js";
import type {
	HistoryIndexRequest,
	IndexedSourceEvent,
	IndexedTaskEvidence,
	TaskEvidencePage,
} from "./history-index.js";
import { projectSessionSourceEvent, readSessionSource, type SourceIndexCursor } from "./history-source.js";
import { withJournalDescriptorSync } from "./journal-io.js";
import type { SessionJournalState } from "./session-journal-owner.js";
import { getTaskStateImportCoverage, projectTaskStateSource } from "./task-state.js";

process.umask(0o077);
mkdirSync(dirname(process.argv[2]), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(process.argv[2]);
const applicationId = Number(db.prepare("PRAGMA application_id").get()?.application_id ?? 0);
const schemaVersion = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
const hasTables = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' LIMIT 1").get();
if (
	(applicationId !== 0x42435458 && (applicationId !== 0 || hasTables)) ||
	(schemaVersion !== 0 && schemaVersion !== 2 && schemaVersion !== 3 && schemaVersion !== 4 && schemaVersion !== 5)
) {
	throw new Error("Not a supported Base Context history index");
}
db.exec(`
	PRAGMA application_id=1111708760;
	PRAGMA journal_mode=WAL;
	PRAGMA synchronous=FULL;
	PRAGMA busy_timeout=5000;
	PRAGMA cache_size=-2048;
	CREATE TABLE IF NOT EXISTS source_event (
		session TEXT NOT NULL, id TEXT NOT NULL, sequence INTEGER NOT NULL,
		parent_id TEXT, kind TEXT NOT NULL, authority TEXT NOT NULL,
		locator TEXT NOT NULL, revision TEXT NOT NULL, text TEXT NOT NULL, text_complete INTEGER NOT NULL,
		PRIMARY KEY(session,id), UNIQUE(session,sequence)
	);
	CREATE TABLE IF NOT EXISTS coverage(session TEXT PRIMARY KEY, sequence INTEGER NOT NULL);
	CREATE TABLE IF NOT EXISTS source_cursor (
		session TEXT PRIMARY KEY, frontier TEXT NOT NULL, header_bytes INTEGER NOT NULL, header_checksum TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS source_term (
		session TEXT NOT NULL, term TEXT NOT NULL, sequence INTEGER NOT NULL,
		PRIMARY KEY(session,term,sequence DESC)
	);
	CREATE TABLE IF NOT EXISTS term_count (
		session TEXT NOT NULL, term TEXT NOT NULL, count INTEGER NOT NULL,
		PRIMARY KEY(session,term)
	);
`);

const TASK_PAGE_BYTES = 1024 * 1024 - 1024;
const DERIVED_TABLES = [
	"source_term",
	"term_count",
	"task_import_loss",
	"task_evidence",
	"source_event",
	"source_payload",
	"coverage",
	"source_cursor",
];
transaction(() => {
	db.exec(`CREATE TABLE IF NOT EXISTS task_evidence (
  session TEXT NOT NULL, sequence INTEGER NOT NULL, ordinal INTEGER NOT NULL,
  task_key TEXT, item_id TEXT, source_ref TEXT NOT NULL, projection TEXT,
  PRIMARY KEY(session,sequence,ordinal)
 );
 CREATE INDEX IF NOT EXISTS task_item ON task_evidence(session,task_key,item_id,sequence,ordinal);
 CREATE TABLE IF NOT EXISTS source_payload (
  session TEXT NOT NULL, sequence INTEGER NOT NULL, parts TEXT NOT NULL, PRIMARY KEY(session,sequence)
 );
 CREATE TABLE IF NOT EXISTS task_import_loss (
  session TEXT NOT NULL, sequence INTEGER NOT NULL, task_key TEXT, PRIMARY KEY(session,sequence)
 );`);
	// Old labels/projections cannot survive unchanged source identities across this upgrade.
	if (schemaVersion !== 5) for (const table of DERIVED_TABLES) db.exec(`DELETE FROM ${table}`);
	db.exec("PRAGMA user_version=5");
});

// Node22.8 ships SQLite without FTS5. A normal SQLite posting index keeps the
// declared floor and bounded lookups without loading a platform extension.
function terms(text: string): string[] {
	return [
		...new Set(
			text
				.normalize("NFC")
				.toLowerCase()
				.match(/[\p{L}\p{M}\p{N}_]+/gu) ?? [],
		),
	];
}
const insertTerm = db.prepare("INSERT INTO source_term VALUES (?,?,?)");
const countTerm = db.prepare(
	"INSERT INTO term_count VALUES (?,?,1) ON CONFLICT(session,term) DO UPDATE SET count=count+1",
);

type Row = {
	id: string;
	sequence: number;
	parent_id: string | null;
	kind: string;
	authority: IndexedSourceEvent["authority"];
	locator: string;
	revision: string;
	text: string;
	text_complete: number;
};
function event(row: Row): IndexedSourceEvent {
	return {
		id: row.id,
		sequence: row.sequence,
		parentId: row.parent_id,
		kind: row.kind,
		authority: row.authority,
		locator: JSON.parse(row.locator) as IndexedSourceEvent["locator"],
		revision: row.revision,
		text: row.text,
		textComplete: row.text_complete === 1,
	};
}
function transaction(action: () => void): void {
	db.exec("BEGIN IMMEDIATE");
	try {
		action();
		db.exec("COMMIT");
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {
			/* SQLite may already have rolled back a failed write. */
		}
		throw error;
	}
}
function insertEvent(sessionId: string, item: IndexedSourceEvent): void {
	db.prepare("INSERT INTO source_event VALUES (?,?,?,?,?,?,?,?,?,?)").run(
		sessionId,
		item.id,
		item.sequence,
		item.parentId,
		item.kind,
		item.authority,
		JSON.stringify(item.locator),
		item.revision,
		item.text,
		item.textComplete ? 1 : 0,
	);
	for (const term of terms(item.text)) {
		insertTerm.run(sessionId, term, item.sequence);
		countTerm.run(sessionId, term);
	}
}
function clearSession(sessionId: string): void {
	for (const table of DERIVED_TABLES) db.prepare(`DELETE FROM ${table} WHERE session=?`).run(sessionId);
}
async function syncSource(sessionId: string, snapshot: SessionJournalState) {
	const row = db.prepare("SELECT * FROM source_cursor WHERE session=?").get(sessionId);
	let previous: SourceIndexCursor | undefined = row
		? {
				frontier: JSON.parse(String(row.frontier)),
				headerByteLength: Number(row.header_bytes),
				headerChecksum: String(row.header_checksum),
			}
		: undefined;
	if (
		previous &&
		(previous.frontier.journalPath !== snapshot.journalPath ||
			previous.frontier.dev !== snapshot.dev ||
			previous.frontier.ino !== snapshot.ino ||
			previous.frontier.byteLength > snapshot.byteLength ||
			previous.frontier.nextSequence > snapshot.nextSequence)
	)
		previous = undefined;
	db.exec("BEGIN IMMEDIATE");
	try {
		if (!previous) clearSession(sessionId);
		const indexed = await readSessionSource(
			sessionId,
			snapshot,
			previous,
			(entry, sequence, locator, revision, parts) => {
				insertEvent(sessionId, projectSessionSourceEvent(entry, sequence, locator, revision));
				db.prepare("INSERT INTO source_payload VALUES (?,?,?)").run(sessionId, sequence, JSON.stringify(parts));
				const imported = getTaskStateImportCoverage({ sessionId, sequence, entry, locator, revision });
				if (imported)
					db.prepare("INSERT INTO task_import_loss VALUES (?,?,?)").run(
						sessionId,
						sequence,
						imported.taskKey ?? null,
					);
				let ordinal = 0;
				for (const projection of projectTaskStateSource({ sessionId, sequence, entry, locator, revision })) {
					let payload: string | null;
					try {
						payload = stringifyBoundedJson(projection, TASK_PAGE_BYTES);
					} catch (error) {
						if (!(error instanceof Error) || error.message !== "JSON byte limit exceeded") throw error;
						// The original canonical field is recoverable; never clip its item or text.
						payload = null;
					}
					db.prepare("INSERT INTO task_evidence VALUES (?,?,?,?,?,?,?)").run(
						sessionId,
						sequence,
						ordinal++,
						projection.taskKey ?? null,
						projection.itemId ?? null,
						JSON.stringify(projection.source),
						payload,
					);
				}
			},
		);
		db.prepare("INSERT INTO coverage VALUES (?,?) ON CONFLICT(session) DO UPDATE SET sequence=excluded.sequence").run(
			sessionId,
			indexed.frontier.indexedThrough,
		);
		db.prepare(
			"INSERT INTO source_cursor VALUES (?,?,?,?) ON CONFLICT(session) DO UPDATE SET frontier=excluded.frontier,header_bytes=excluded.header_bytes,header_checksum=excluded.header_checksum",
		).run(sessionId, JSON.stringify(indexed.frontier), indexed.headerByteLength, indexed.headerChecksum);
		db.exec("COMMIT");
		return indexed.frontier;
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {
			/* Preserve the failed derived-index operation. */
		}
		throw error;
	}
}
function apply(sessionId: string, events: IndexedSourceEvent[], committedThrough: number): void {
	if (events.length > 128 || !Number.isSafeInteger(committedThrough) || committedThrough < 0)
		throw new Error("Invalid bounded index batch");
	transaction(() => {
		db.prepare("DELETE FROM source_cursor WHERE session=?").run(sessionId);
		const current = db.prepare("SELECT sequence FROM coverage WHERE session=?").get(sessionId)?.sequence ?? 0;
		if (committedThrough < Number(current)) throw new Error("Index coverage cannot move backwards");
		let expected = Number(current) + 1;
		for (const item of events) {
			if (Buffer.byteLength(item.text) > 8192 || Buffer.byteLength(JSON.stringify(item.locator)) > 8192)
				throw new Error("Index text/locator limit exceeded; use bounded source parts");
			if (!Number.isSafeInteger(item.sequence) || item.sequence <= 0 || item.sequence > committedThrough)
				throw new Error("Invalid committed source sequence");
			const existing = db
				.prepare("SELECT revision,sequence FROM source_event WHERE session=? AND id=?")
				.get(sessionId, item.id);
			if (existing) {
				if (existing.revision !== item.revision || existing.sequence !== item.sequence)
					throw new Error("Conflicting immutable source identity");
				continue;
			}
			if (item.sequence !== expected) throw new Error("Missing source sequence before index publication");
			expected++;
			insertEvent(sessionId, item);
		}
		if (expected - 1 !== committedThrough) throw new Error("Index cannot advertise unindexed source coverage");
		db.prepare("INSERT INTO coverage VALUES (?,?) ON CONFLICT(session) DO UPDATE SET sequence=excluded.sequence").run(
			sessionId,
			committedThrough,
		);
	});
}
function branchQuery(sessionId: string, through: number, scope?: { leafId: string | null }) {
	if (!scope) return { prefix: "", condition: "", values: [] as (string | number | null)[] };
	if (
		!(scope.leafId === null || (typeof scope.leafId === "string" && scope.leafId.length <= 512)) ||
		!Number.isSafeInteger(through) ||
		through < 0
	)
		throw new Error("Invalid history branch scope");
	if (
		scope.leafId !== null &&
		!db
			.prepare("SELECT 1 FROM source_event WHERE session=? AND id=? AND sequence<=?")
			.get(sessionId, scope.leafId, through)
	)
		throw new Error("History branch leaf is outside the indexed prefix");
	return {
		prefix: `WITH RECURSIVE branch(id,parent_id) AS (
   SELECT id,parent_id FROM source_event WHERE session=? AND id=? AND sequence<=?
   UNION
   SELECT p.id,p.parent_id FROM source_event p JOIN branch b ON p.id=b.parent_id WHERE p.session=? AND p.sequence<=?
  ) `,
		condition:
			" AND (e.id IN (SELECT id FROM branch) OR (e.kind='request' AND e.parent_id IN (SELECT id FROM branch)))",
		values: [sessionId, scope.leafId, through, sessionId, through],
	};
}
function query(request: Extract<HistoryIndexRequest, { action: "page" | "search" }>) {
	if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 128)
		throw new Error("Index page limit must be between1 and128");
	const indexedThrough = Number(
		db.prepare("SELECT sequence FROM coverage WHERE session=?").get(request.sessionId)?.sequence ?? 0,
	);
	const branch = branchQuery(request.sessionId, request.through, request.scope);
	let rows: Row[];
	if (request.action === "page") {
		rows = db
			.prepare(
				`${branch.prefix}SELECT e.* FROM source_event e WHERE e.session=? AND e.sequence>? AND e.sequence<=?${branch.condition} ORDER BY e.sequence LIMIT ?`,
			)
			.all(...branch.values, request.sessionId, request.after, request.through, request.limit + 1) as Row[];
	} else {
		if (Buffer.byteLength(request.query) > 8192) throw new Error("Index query limit exceeded");
		const queryTerms = terms(request.query);
		if (queryTerms.length > 32) throw new Error("Index query term limit exceeded");
		queryTerms.sort((left, right) => {
			const count = (term: string) =>
				Number(
					db.prepare("SELECT count FROM term_count WHERE session=? AND term=?").get(request.sessionId, term)
						?.count ?? 0,
				);
			return count(left) - count(right);
		});
		const [first, ...rest] = queryTerms;
		const required = rest
			.map(
				() =>
					"AND EXISTS (SELECT 1 FROM source_term required WHERE required.session=t.session AND required.sequence=t.sequence AND required.term=?)",
			)
			.join(" ");
		rows = first
			? (db
					.prepare(
						`${branch.prefix}SELECT e.* FROM source_term t JOIN source_event e ON e.session=t.session AND e.sequence=t.sequence WHERE t.session=? AND t.term=? AND t.sequence<=? ${required}${branch.condition} ORDER BY t.sequence DESC LIMIT ?`,
					)
					.all(...branch.values, request.sessionId, first, request.through, ...rest, request.limit + 1) as Row[])
			: [];
	}
	const incompleteText =
		request.action === "search" &&
		!!db
			.prepare(
				`${branch.prefix}SELECT 1 FROM source_event e WHERE e.session=? AND e.text_complete=0 AND e.sequence<=?${branch.condition} LIMIT 1`,
			)
			.get(...branch.values, request.sessionId, request.through);
	const events: IndexedSourceEvent[] = [];
	let bytes = 0;
	for (const row of rows.slice(0, request.limit)) {
		const indexed = event(row);
		bytes += Buffer.byteLength(JSON.stringify(indexed));
		if (bytes > 1024 * 1024) break;
		events.push(indexed);
	}
	const truncated = events.length < rows.length;
	return {
		events,
		indexedThrough,
		coverage: indexedThrough < request.through || incompleteText ? "partial" : "complete",
		truncated,
		nextAfter: request.action === "page" && truncated ? (events[events.length - 1]?.sequence ?? request.after) : null,
	};
}
function taskEvidence(request: Extract<HistoryIndexRequest, { action: "task_evidence" }>): TaskEvidencePage {
	const { sessionId, scope, options } = request;
	const limit = options.limit ?? 64;
	const after = options.after ?? { sequence: 0, ordinal: -1 };
	if (
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		limit > 128 ||
		!Number.isSafeInteger(after.sequence) ||
		after.sequence < 0 ||
		!Number.isSafeInteger(after.ordinal) ||
		after.ordinal < -1 ||
		(options.itemId !== undefined && typeof options.itemId !== "string") ||
		(options.taskKey !== undefined && typeof options.taskKey !== "string")
	)
		throw new Error("Invalid bounded task-evidence selection");
	const cursor = db.prepare("SELECT frontier FROM source_cursor WHERE session=?").get(sessionId);
	const page: TaskEvidencePage = {
		entries: [],
		indexedThrough: cursor ? Number(JSON.parse(String(cursor.frontier)).indexedThrough) : 0,
		coverage: "partial",
		structuredOnly: true,
		selective: true,
		truncated: false,
		nextAfter: null,
	};
	if (!cursor) return page;
	const branch = branchQuery(sessionId, scope.through, scope);
	const task = options.taskKey === undefined ? "" : " AND t.task_key=?";
	const taskValues = options.taskKey === undefined ? [] : [options.taskKey];
	const lossTask = options.taskKey === undefined ? "" : " AND (t.task_key=? OR t.task_key IS NULL)";
	const importedLoss = !!db
		.prepare(
			`${branch.prefix}SELECT 1 FROM task_import_loss t JOIN source_event e ON e.session=t.session AND e.sequence=t.sequence WHERE t.session=? AND t.sequence<=?${branch.condition}${lossTask} LIMIT 1`,
		)
		.get(...branch.values, sessionId, scope.through, ...taskValues);
	page.coverage = page.indexedThrough >= scope.through && !importedLoss ? "complete" : "partial";
	const item = options.itemId === undefined ? "" : " AND t.item_id=?";
	// Fetch bounded keys first, not up to128 potentially large projection bodies.
	const rows = db
		.prepare(
			`${branch.prefix}SELECT t.sequence,t.ordinal FROM task_evidence t JOIN source_event e ON e.session=t.session AND e.sequence=t.sequence WHERE t.session=? AND t.sequence<=?${branch.condition}${task}${item} AND (t.sequence>? OR (t.sequence=? AND t.ordinal>?)) ORDER BY t.sequence,t.ordinal LIMIT ?`,
		)
		.all(
			...branch.values,
			sessionId,
			scope.through,
			...taskValues,
			...(options.itemId === undefined ? [] : [options.itemId]),
			after.sequence,
			after.sequence,
			after.ordinal,
			limit + 1,
		);
	const content = db.prepare(
		"SELECT source_ref,projection FROM task_evidence WHERE session=? AND sequence=? AND ordinal=?",
	);
	const itemIdentity = db.prepare(
		"SELECT CASE WHEN length(CAST(item_id AS BLOB))<=? THEN item_id END AS item_id,item_id IS NOT NULL AS has_item FROM task_evidence WHERE session=? AND sequence=? AND ordinal=?",
	);
	const fits = (entry: IndexedTaskEvidence, entries = page.entries) =>
		Buffer.byteLength(
			JSON.stringify({
				...page,
				entries: [...entries, entry],
				nextAfter: { sequence: entry.sequence, ordinal: entry.ordinal },
			}),
		) <= TASK_PAGE_BYTES;
	for (const row of rows.slice(0, limit)) {
		const position = { sequence: Number(row.sequence), ordinal: Number(row.ordinal) };
		const stored = content.get(sessionId, position.sequence, position.ordinal)!;
		const sourceReference = (): Extract<IndexedTaskEvidence, { truncated: true }> => {
			const identity = itemIdentity.get(TASK_PAGE_BYTES, sessionId, position.sequence, position.ordinal)!;
			const reference: Extract<IndexedTaskEvidence, { truncated: true }> = {
				...position,
				source: JSON.parse(String(stored.source_ref)),
				truncated: true,
				...(identity.item_id !== null
					? { itemId: String(identity.item_id) }
					: identity.has_item
						? { itemIdOmitted: true as const }
						: {}),
			};
			if (!fits(reference, []) && reference.itemId !== undefined) {
				delete reference.itemId;
				reference.itemIdOmitted = true;
			}
			return reference;
		};
		let entry: IndexedTaskEvidence =
			stored.projection === null
				? sourceReference()
				: {
						...position,
						projection: JSON.parse(String(stored.projection)),
						truncated: false,
					};
		if (!fits(entry)) {
			if (page.entries.length) break;
			entry = sourceReference();
		}
		page.entries.push(entry);
	}
	const more = page.entries.length < rows.length;
	page.truncated = more || page.entries.some((entry) => entry.truncated);
	if (more && page.entries.length) {
		const last = page.entries[page.entries.length - 1];
		page.nextAfter = { sequence: last.sequence, ordinal: last.ordinal };
	}
	return page;
}

function readPayload(request: Extract<HistoryIndexRequest, { action: "read_payload" }>) {
	const saved = db.prepare("SELECT frontier FROM source_cursor WHERE session=?").get(request.sessionId);
	if (!saved) throw new Error("Canonical payload index is unavailable; synchronize the source first");
	const snapshot = JSON.parse(String(saved.frontier)) as SessionJournalState & { indexedThrough: number };
	if (snapshot.format !== "framed" || snapshot.indexedThrough < request.scope.through)
		throw new Error("Canonical payload index has not reached the requested source prefix");
	const branch = branchQuery(request.sessionId, request.scope.through, request.scope);
	const row = db
		.prepare(
			`${branch.prefix}SELECT e.* FROM source_event e WHERE e.session=? AND e.id=? AND e.sequence<=?${branch.condition}`,
		)
		.get(...branch.values, request.sessionId, request.eventId, request.scope.through) as Row | undefined;
	if (!row) return undefined;
	const savedParts = db
		.prepare("SELECT parts FROM source_payload WHERE session=? AND sequence=?")
		.get(request.sessionId, row.sequence);
	if (!savedParts) throw new Error("Canonical payload parts are unavailable; rebuild the derived index");
	const parts = JSON.parse(String(savedParts.parts)) as CanonicalPayloadParts;
	const locator = JSON.parse(row.locator) as IndexedSourceEvent["locator"];
	if (
		locator.path !== snapshot.journalPath ||
		parts.source.dev !== snapshot.dev ||
		parts.source.ino !== snapshot.ino ||
		parts.frameOffset !== locator.offset ||
		parts.frameChecksum !== row.revision ||
		parts.payloadOffset < locator.offset ||
		parts.payloadOffset + parts.byteLength > locator.offset + locator.length
	)
		throw new Error("Canonical payload metadata does not match the verified source frame");
	const identity = (current: { dev: number; ino: number; size: number }) => {
		if (current.dev !== snapshot.dev || current.ino !== snapshot.ino || current.size < snapshot.byteLength)
			throw new Error("Canonical payload source identity or acknowledged length changed");
	};
	return withJournalDescriptorSync(openSync(snapshot.journalPath, "r"), (fd) => {
		identity(fstatSync(fd));
		const fragment = readCanonicalPayloadFragment(fd, parts, request.options.cursor, request.options.maxBytes);
		identity(statSync(snapshot.journalPath));
		return fragment;
	});
}

async function dispatch(request: HistoryIndexRequest): Promise<unknown> {
	switch (request.action) {
		case "sync_source":
			return syncSource(request.sessionId, request.snapshot);
		case "task_evidence":
			return taskEvidence(request);
		case "read_payload":
			return readPayload(request);
		case "apply":
			apply(request.sessionId, request.events, request.committedThrough);
			return;
		case "get": {
			const branch = branchQuery(request.sessionId, request.scope?.through ?? 0, request.scope);
			const through = request.scope ? " AND e.sequence<=?" : "";
			const row = db
				.prepare(
					`${branch.prefix}SELECT e.* FROM source_event e WHERE e.session=? AND e.id=?${through}${branch.condition}`,
				)
				.get(
					...branch.values,
					request.sessionId,
					request.eventId,
					...(request.scope ? [request.scope.through] : []),
				) as Row | undefined;
			return row ? event(row) : undefined;
		}
		case "page":
		case "search":
			return query(request);
		case "clear":
			transaction(() => clearSession(request.sessionId));
			return;
		case "close":
			db.close();
			return;
	}
}
let queue: Promise<void> = Promise.resolve();
let accepting = true;
let pendingBytes = 0;
let pendingOperations = 0;
process.on("message", (input: HistoryIndexRequest) => {
	let bytes: number;
	try {
		bytes = Buffer.byteLength(stringifyBoundedJson(input, 2 * 1024 * 1024));
	} catch (error) {
		process.send?.({ id: input.id, error: String(error) });
		return;
	}
	if (!accepting || pendingOperations >= 32 || pendingBytes + bytes > 4 * 1024 * 1024) {
		process.send?.({ id: input.id, error: "History-index queue is closing or full" });
		return;
	}
	if (input.action === "close") accepting = false;
	pendingOperations++;
	pendingBytes += bytes;
	const operation = queue.then(() => dispatch(input));
	queue = operation.then(
		() => undefined,
		() => undefined,
	);
	void operation
		.then(
			(result) => {
				if (process.connected)
					process.send?.({ id: input.id, result }, () => {
						if (input.action === "close") process.disconnect();
					});
			},
			(error) => {
				if (process.connected)
					process.send?.({ id: input.id, error: error instanceof Error ? error.message : String(error) });
			},
		)
		.finally(() => {
			pendingOperations--;
			pendingBytes -= bytes;
		});
});
process.on("disconnect", () => {
	accepting = false;
	void queue.finally(() => {
		try {
			db.close();
		} catch {}
	});
});
process.send?.({ ready: true });
