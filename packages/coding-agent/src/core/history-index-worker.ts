import { DatabaseSync } from "node:sqlite";
import type { HistoryIndexRequest, IndexedSourceEvent } from "./history-index.js";

process.umask(0o077);
const db = new DatabaseSync(process.argv[2]);
const applicationId = Number(db.prepare("PRAGMA application_id").get()?.application_id ?? 0);
const schemaVersion = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
const hasTables = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' LIMIT 1").get();
if (
	(applicationId !== 0x42435458 && (applicationId !== 0 || hasTables)) ||
	(schemaVersion !== 0 && schemaVersion !== 2)
) {
	throw new Error("Not a supported Base Context history index");
}
db.exec(`
	PRAGMA application_id=1111708760;
	PRAGMA user_version=2;
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
	CREATE TABLE IF NOT EXISTS source_term (
		session TEXT NOT NULL, term TEXT NOT NULL, sequence INTEGER NOT NULL,
		PRIMARY KEY(session,term,sequence DESC)
	);
	CREATE TABLE IF NOT EXISTS term_count (
		session TEXT NOT NULL, term TEXT NOT NULL, count INTEGER NOT NULL,
		PRIMARY KEY(session,term)
	);
`);

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
function apply(sessionId: string, events: IndexedSourceEvent[], committedThrough: number): void {
	if (events.length > 128 || !Number.isSafeInteger(committedThrough) || committedThrough < 0)
		throw new Error("Invalid bounded index batch");
	transaction(() => {
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
		if (expected - 1 !== committedThrough) throw new Error("Index cannot advertise unindexed source coverage");
		db.prepare("INSERT INTO coverage VALUES (?,?) ON CONFLICT(session) DO UPDATE SET sequence=excluded.sequence").run(
			sessionId,
			committedThrough,
		);
	});
}
function query(request: Extract<HistoryIndexRequest, { action: "page" | "search" }>) {
	if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 128)
		throw new Error("Index page limit must be between1 and128");
	const indexedThrough = Number(
		db.prepare("SELECT sequence FROM coverage WHERE session=?").get(request.sessionId)?.sequence ?? 0,
	);
	let rows: Row[];
	if (request.action === "page") {
		rows = db
			.prepare("SELECT * FROM source_event WHERE session=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?")
			.all(request.sessionId, request.after, request.through, request.limit + 1) as Row[];
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
						`SELECT e.* FROM source_term t JOIN source_event e ON e.session=t.session AND e.sequence=t.sequence WHERE t.session=? AND t.term=? AND t.sequence<=? ${required} ORDER BY t.sequence DESC LIMIT ?`,
					)
					.all(request.sessionId, first, request.through, ...rest, request.limit + 1) as Row[])
			: [];
	}
	const incompleteText =
		request.action === "search" &&
		!!db
			.prepare("SELECT 1 FROM source_event WHERE session=? AND text_complete=0 AND sequence<=? LIMIT 1")
			.get(request.sessionId, request.through);
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
function dispatch(request: HistoryIndexRequest): unknown {
	switch (request.action) {
		case "apply":
			apply(request.sessionId, request.events, request.committedThrough);
			return;
		case "get": {
			const row = db
				.prepare("SELECT * FROM source_event WHERE session=? AND id=?")
				.get(request.sessionId, request.eventId) as Row | undefined;
			return row ? event(row) : undefined;
		}
		case "page":
		case "search":
			return query(request);
		case "clear":
			transaction(() => {
				db.prepare("DELETE FROM source_term WHERE session=?").run(request.sessionId);
				db.prepare("DELETE FROM term_count WHERE session=?").run(request.sessionId);
				db.prepare("DELETE FROM source_event WHERE session=?").run(request.sessionId);
				db.prepare("DELETE FROM coverage WHERE session=?").run(request.sessionId);
			});
			return;
		case "close":
			db.close();
			return;
	}
}
process.on("message", (request: HistoryIndexRequest) => {
	try {
		const result = dispatch(request);
		process.send?.({ id: request.id, result }, () => {
			if (request.action === "close") process.disconnect();
		});
	} catch (error) {
		process.send?.({ id: request.id, error: error instanceof Error ? error.message : String(error) });
	}
});
process.on("disconnect", () => {
	try {
		db.close();
	} catch {}
});
process.send?.({ ready: true });
