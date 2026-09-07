import { fstatSync, mkdirSync, openSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { stringifyBoundedJson } from "./bounded-json.js";
import { type CanonicalPayloadParts, readCanonicalPayloadFragment } from "./canonical-payload-parts.js";
import { GOAL_STATE_CUSTOM_TYPE, isPersistedGoalState } from "./goals.js";
import type {
	BranchBootstrapState,
	ContextManifestCursor,
	ContextManifestPage,
	ContextRef,
	ContextUpdateRef,
	ContextUpdates,
	ContextUpdateTarget,
	HistoryIndexRequest,
	HistoryPayloadReadOptions,
	IndexedSourceEvent,
	IndexedTaskEvidence,
	ParentPathCursor,
	ParentPathPage,
	TaskEvidencePage,
} from "./history-index.js";
import {
	projectSessionSourceEvent,
	readSessionSource,
	type SessionSourceEntry,
	type SourceIndexCursor,
} from "./history-source.js";
import { withJournalDescriptorSync } from "./journal-io.js";
import {
	IPYTHON_SENT_AGENT_MESSAGE_CUSTOM_ENTRY,
	parsePersistedIpythonSentAgentMessage,
} from "./session-context-updates.js";
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
	(schemaVersion !== 0 &&
		schemaVersion !== 2 &&
		schemaVersion !== 3 &&
		schemaVersion !== 4 &&
		schemaVersion !== 5 &&
		schemaVersion !== 6 &&
		schemaVersion !== 7 &&
		schemaVersion !== 8 &&
		schemaVersion !== 9 &&
		schemaVersion !== 10 &&
		schemaVersion !== 11)
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
		locator TEXT NOT NULL, revision TEXT NOT NULL, text TEXT NOT NULL, text_complete INTEGER NOT NULL, retention TEXT,
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
const MAX_JUMP_LEVELS = 53;
const MAX_PARENT_LOOKUPS = 128;
const DERIVED_TABLES = [
	"context_update",
	"context_node",
	"source_ancestry",
	"source_jump",
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
 );
 CREATE TABLE IF NOT EXISTS source_ancestry (
  session TEXT NOT NULL, id TEXT NOT NULL, depth INTEGER, PRIMARY KEY(session,id)
 );
 CREATE TABLE IF NOT EXISTS source_jump (
  session TEXT NOT NULL, id TEXT NOT NULL, level INTEGER NOT NULL, ancestor_id TEXT NOT NULL,
  PRIMARY KEY(session,id,level)
 );
 CREATE TABLE IF NOT EXISTS context_node (
 session TEXT NOT NULL,id TEXT NOT NULL,visible_head TEXT,previous_visible TEXT,visible_count INTEGER,latest_compaction TEXT,first_kept_id TEXT,
 latest_model TEXT,latest_thinking TEXT,latest_service_tier TEXT,latest_goal TEXT,has_session_message INTEGER,goal_seedable INTEGER,PRIMARY KEY(session,id)
 );
 CREATE TABLE IF NOT EXISTS context_update (
  session TEXT NOT NULL,event_id TEXT NOT NULL,update_kind TEXT NOT NULL,target_key TEXT NOT NULL,sequence INTEGER NOT NULL,
  PRIMARY KEY(session,update_kind,event_id)
 );
 CREATE INDEX IF NOT EXISTS context_update_target ON context_update(session,update_kind,target_key,sequence);`);
	// Old labels/projections cannot survive unchanged source identities across this upgrade.
	if (schemaVersion !== 11) {
		if (
			!db
				.prepare("PRAGMA table_info(source_event)")
				.all()
				.some((column) => column.name === "retention")
		)
			db.exec("ALTER TABLE source_event ADD COLUMN retention TEXT");
		if (
			!db
				.prepare("PRAGMA table_info(context_node)")
				.all()
				.some((column) => column.name === "latest_model")
		)
			db.exec(`
 ALTER TABLE context_node ADD COLUMN latest_model TEXT;
 ALTER TABLE context_node ADD COLUMN latest_thinking TEXT;
 ALTER TABLE context_node ADD COLUMN latest_service_tier TEXT;
 ALTER TABLE context_node ADD COLUMN latest_goal TEXT;
 ALTER TABLE context_node ADD COLUMN has_session_message INTEGER;
 ALTER TABLE context_node ADD COLUMN goal_seedable INTEGER;
 `);
		for (const table of DERIVED_TABLES) db.exec(`DELETE FROM ${table}`);
	}
	db.exec(`
 CREATE INDEX IF NOT EXISTS source_incomplete ON source_event(session,sequence) WHERE text_complete=0;
 CREATE INDEX IF NOT EXISTS task_sequence ON task_evidence(session,task_key,sequence,ordinal);
 CREATE INDEX IF NOT EXISTS task_item_sequence ON task_evidence(session,item_id,sequence,ordinal);
 CREATE INDEX IF NOT EXISTS task_loss_key ON task_import_loss(session,task_key,sequence);
 `);
	db.exec("PRAGMA user_version=11");
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
	retention: IndexedSourceEvent["retention"] | null;
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
		...(row.retention === null ? {} : { retention: row.retention }),
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
	if (item.retention !== undefined && item.retention !== "retained-import")
		throw new Error("Unsupported indexed source retention");
	db.prepare("INSERT INTO source_event VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
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
		item.retention ?? null,
	);
	for (const term of terms(item.text)) {
		insertTerm.run(sessionId, term, item.sequence);
		countTerm.run(sessionId, term);
	}
}
const sourceParent = db.prepare(
	"SELECT a.depth FROM source_event e JOIN source_ancestry a ON a.session=e.session AND a.id=e.id WHERE e.session=? AND e.id=? AND e.sequence<?",
);
const insertDepth = db.prepare("INSERT INTO source_ancestry VALUES (?,?,?)");
const insertJump = db.prepare("INSERT INTO source_jump VALUES (?,?,?,?)");
const ancestorJump = db.prepare("SELECT ancestor_id FROM source_jump WHERE session=? AND id=? AND level=?");
function insertAncestry(sessionId: string, item: IndexedSourceEvent): number | null {
	const parent = item.parentId === null ? undefined : sourceParent.get(sessionId, item.parentId, item.sequence);
	const depth = item.parentId === null ? 0 : parent?.depth == null ? null : Number(parent.depth) + 1;
	insertDepth.run(sessionId, item.id, depth);
	if (depth === null || depth === 0) return depth;
	let ancestorId = item.parentId!;
	for (let level = 0; level < MAX_JUMP_LEVELS && 2 ** level <= depth; level++) {
		if (level > 0) ancestorId = String(ancestorJump.get(sessionId, ancestorId, level - 1)!.ancestor_id);
		insertJump.run(sessionId, item.id, level, ancestorId);
	}
	return depth;
}
type ContextState = {
	visible_head: string | null;
	previous_visible: string | null;
	visible_count: number | null;
	latest_compaction: string | null;
	first_kept_id: string | null;
};
type BootstrapColumns = {
	latest_model: string | null;
	latest_thinking: string | null;
	latest_service_tier: string | null;
	latest_goal: string | null;
	has_session_message: number;
	goal_seedable: number;
};
const contextParent = db.prepare("SELECT * FROM context_node WHERE session=? AND id=?");
const insertContextNode = db.prepare("INSERT INTO context_node VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
function insertContext(
	sessionId: string,
	item: IndexedSourceEvent,
	entry: SessionSourceEntry,
	depth: number | null,
): void {
	const parent =
		item.parentId === null
			? undefined
			: (contextParent.get(sessionId, item.parentId) as (ContextState & BootstrapColumns) | undefined);
	if (depth !== null && item.parentId !== null && parent?.visible_count == null)
		throw new Error("Context ancestry metadata is incomplete");
	// Match buildSessionContext before provider filtering: !! bash/UI-only messages remain ordering barriers.
	const visible =
		entry.type === "message" ||
		entry.type === "custom_message" ||
		(entry.type === "branch_summary" && !!entry.summary);
	const head = parent?.visible_head ?? null;
	const count = depth === null ? null : Number(parent?.visible_count ?? 0) + (visible ? 1 : 0);
	const compaction = entry.type === "compaction";
	const firstKept =
		compaction &&
		typeof entry.firstKeptEntryId === "string" &&
		entry.firstKeptEntryId.length > 0 &&
		entry.firstKeptEntryId.length <= 512
			? entry.firstKeptEntryId
			: null;
	const modelProducer =
		entry.type === "model_change" ||
		(entry.type === "message" && (entry.message as { role?: unknown } | null)?.role === "assistant");
	const eligibleGoal =
		entry.type === "custom" &&
		entry.customType === GOAL_STATE_CUSTOM_TYPE &&
		item.retention !== "retained-import" &&
		isPersistedGoalState(entry.data);
	const seedControl =
		entry.type === "model_change" || entry.type === "thinking_level_change" || entry.type === "service_tier_change";
	// A manifest ref exists for a message envelope even when its message value is falsy.
	const hasSessionMessage = entry.type === "message" ? !!entry.message : visible;
	insertContextNode.run(
		sessionId,
		item.id,
		visible ? item.id : head,
		visible ? head : null,
		count,
		compaction ? item.id : (parent?.latest_compaction ?? null),
		firstKept,
		modelProducer ? item.id : (parent?.latest_model ?? null),
		entry.type === "thinking_level_change" ? item.id : (parent?.latest_thinking ?? null),
		entry.type === "service_tier_change" ? item.id : (parent?.latest_service_tier ?? null),
		eligibleGoal ? item.id : (parent?.latest_goal ?? null),
		parent?.has_session_message === 1 || hasSessionMessage ? 1 : 0,
		seedControl && (item.parentId === null || parent?.goal_seedable === 1) ? 1 : 0,
	);
}
// Only bounded relation keys and source refs live here; never usage or sent-message bodies.
const MAX_CONTEXT_UPDATE_KEY = 8192;
const MAX_CONTEXT_UPDATE_CANDIDATES = 128;
const insertUpdate = db.prepare("INSERT INTO context_update VALUES (?,?,?,?,?)");
function insertContextUpdates(sessionId: string, item: IndexedSourceEvent, entry: SessionSourceEntry): void {
	if (entry.type === "message" && (entry.message as { role?: unknown } | null)?.role === "assistant") {
		insertUpdate.run(sessionId, item.id, "assistant-target", item.id, item.sequence);
	} else if (
		entry.type === "child_usage_attributed" &&
		typeof entry.targetId === "string" &&
		entry.targetId.length <= 512
	) {
		// The source aggregate is intentionally not validated or replaced by an older value.
		insertUpdate.run(sessionId, item.id, "assistant-usage", entry.targetId, item.sequence);
	} else if (entry.type === "custom" && entry.customType === IPYTHON_SENT_AGENT_MESSAGE_CUSTOM_ENTRY) {
		const parsed = parsePersistedIpythonSentAgentMessage(entry.data);
		if (parsed && parsed.toolCallId.length <= MAX_CONTEXT_UPDATE_KEY)
			insertUpdate.run(sessionId, item.id, "ipython-sent-message", parsed.toolCallId, item.sequence);
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
			(entry, sequence, locator, revision, parts, retention) => {
				const item = projectSessionSourceEvent(entry, sequence, locator, revision);
				if (retention !== undefined) item.retention = retention;
				insertEvent(sessionId, item);
				const depth = insertAncestry(sessionId, item);
				insertContext(sessionId, item, entry, depth);
				insertContextUpdates(sessionId, item, entry);
				db.prepare("INSERT INTO source_payload VALUES (?,?,?)").run(sessionId, sequence, JSON.stringify(parts));
				const source = { sessionId, sequence, entry, locator, revision, retention };
				const imported = getTaskStateImportCoverage(source);
				if (imported)
					db.prepare("INSERT INTO task_import_loss VALUES (?,?,?)").run(
						sessionId,
						sequence,
						imported.taskKey ?? null,
					);
				let ordinal = 0;
				for (const projection of projectTaskStateSource(source)) {
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
		db.prepare("DELETE FROM source_ancestry WHERE session=?").run(sessionId);
		db.prepare("DELETE FROM source_jump WHERE session=?").run(sessionId);
		db.prepare("DELETE FROM context_node WHERE session=?").run(sessionId);
		db.prepare("DELETE FROM context_update WHERE session=?").run(sessionId);
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
type BranchNode = Pick<Row, "id" | "parent_id"> & { depth: number | null };
const branchNode = db.prepare(
	"SELECT e.id,e.parent_id,a.depth FROM source_event e LEFT JOIN source_ancestry a ON a.session=e.session AND a.id=e.id WHERE e.session=? AND e.id=? AND e.sequence<=?",
);
function validateBranchScope(
	sessionId: string,
	through: number,
	scope: { leafId: string | null },
): BranchNode | undefined {
	if (
		!(scope.leafId === null || (typeof scope.leafId === "string" && scope.leafId.length <= 512)) ||
		!Number.isSafeInteger(through) ||
		through < 0
	)
		throw new Error("Invalid history branch scope");
	const leaf =
		scope.leafId === null ? undefined : (branchNode.get(sessionId, scope.leafId, through) as BranchNode | undefined);
	if (scope.leafId !== null && !leaf) throw new Error("History branch leaf is outside the indexed prefix");
	return leaf;
}
function resolvedAncestor(sessionId: string, leaf: BranchNode, target: BranchNode): boolean {
	let difference = leaf.depth! - target.depth!;
	if (difference < 0) return false;
	let ancestorId = leaf.id;
	for (let level = 0; difference > 0 && level < MAX_JUMP_LEVELS; level++) {
		if (difference % 2 === 1) {
			const jump = ancestorJump.get(sessionId, ancestorId, level);
			if (!jump) throw new Error("History branch ancestry metadata is incomplete");
			ancestorId = String(jump.ancestor_id);
		}
		difference = Math.floor(difference / 2);
	}
	return ancestorId === target.id;
}
function pointEvent(
	sessionId: string,
	eventId: string,
	scope?: { leafId: string | null; through: number },
): Row | undefined {
	if (!scope)
		return db.prepare("SELECT * FROM source_event WHERE session=? AND id=?").get(sessionId, eventId) as
			| Row
			| undefined;
	const leaf = validateBranchScope(sessionId, scope.through, scope);
	const row = db
		.prepare("SELECT * FROM source_event WHERE session=? AND id=? AND sequence<=?")
		.get(sessionId, eventId, scope.through) as Row | undefined;
	if (!row || !leaf) return undefined;
	const targets = row.kind === "request" && row.parent_id !== null ? [row.id, row.parent_id] : [row.id];
	if (targets.includes(leaf.id)) return row;
	if (leaf.depth !== null) {
		let unknown = false;
		for (const id of targets) {
			const target = branchNode.get(sessionId, id, scope.through) as BranchNode | undefined;
			if (target?.depth == null) unknown = true;
			else if (resolvedAncestor(sessionId, leaf, target)) return row;
		}
		if (!unknown) return undefined;
	}
	// Arbitrary SDK/legacy links stay intact; unknown ancestry is never reported as absence.
	const visited = new Set<string>();
	let current = leaf;
	let lookups = 0;
	for (;;) {
		if (targets.includes(current.id)) return row;
		visited.add(current.id);
		if (current.parent_id === null) return undefined;
		if (visited.has(current.parent_id)) throw new Error("History branch ancestry contains a cycle");
		if (lookups === MAX_PARENT_LOOKUPS) throw new Error("History branch ancestry parent lookup budget exceeded");
		lookups++;
		const parent = branchNode.get(sessionId, current.parent_id, scope.through) as BranchNode | undefined;
		if (!parent) throw new Error("History branch ancestry has a missing parent in the indexed prefix");
		current = parent;
	}
}
type QueryCandidate = Pick<Row, "id" | "parent_id" | "kind" | "sequence">;
const MAX_QUERY_CANDIDATES = 256;
const queryCandidate = db.prepare("SELECT id,parent_id,kind,sequence FROM source_event WHERE session=? AND sequence=?");
function sourceCandidate(sessionId: string, sequence: number): QueryCandidate {
	const row = queryCandidate.get(sessionId, sequence) as QueryCandidate | undefined;
	if (!row) throw new Error("History query source metadata is unavailable");
	return row;
}
function branchFilter(sessionId: string, through: number, scope?: { leafId: string | null }) {
	if (!scope) return { empty: false, matches: (_row: QueryCandidate) => true };
	const leaf = validateBranchScope(sessionId, through, scope);
	if (!leaf) return { empty: true, matches: (_row: QueryCandidate) => false };
	if (leaf.depth !== null)
		return {
			empty: false,
			matches: (row: QueryCandidate) => pointEvent(sessionId, row.id, { ...scope, through }) !== undefined,
		};
	// A short arbitrary SDK/apply branch can be proved, but an unfinished walk is never empty ancestry.
	const ancestors = new Set<string>([leaf.id]);
	let current = leaf;
	let lookups = 0;
	while (current.parent_id !== null) {
		if (ancestors.has(current.parent_id)) throw new Error("History branch ancestry contains a cycle");
		if (lookups++ === MAX_PARENT_LOOKUPS) throw new Error("History branch ancestry parent lookup budget exceeded");
		const parent = branchNode.get(sessionId, current.parent_id, through) as BranchNode | undefined;
		if (!parent) throw new Error("History branch ancestry has a missing parent in the indexed prefix");
		ancestors.add(parent.id);
		current = parent;
	}
	return {
		empty: false,
		matches: (row: QueryCandidate) =>
			ancestors.has(row.id) || (row.kind === "request" && row.parent_id !== null && ancestors.has(row.parent_id)),
	};
}
function selectCandidates<T>(
	rows: T[],
	matches: (row: T) => boolean,
	limit: number,
	label: string,
	budget = { remaining: MAX_QUERY_CANDIDATES },
): T[] {
	const selected: T[] = [];
	for (const row of rows) {
		if (budget.remaining === 0) throw new Error(`${label} candidate budget exceeded`);
		budget.remaining--;
		if (matches(row)) selected.push(row);
		if (selected.length === limit + 1) break;
	}
	return selected;
}
function query(request: Extract<HistoryIndexRequest, { action: "page" | "search" }>) {
	if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 128)
		throw new Error("Index page limit must be between1 and128");
	if (
		!Number.isSafeInteger(request.through) ||
		request.through < 0 ||
		(request.action === "page" && (!Number.isSafeInteger(request.after) || request.after < 0))
	)
		throw new Error("Invalid history query source range");
	const indexedThrough = Number(
		db.prepare("SELECT sequence FROM coverage WHERE session=?").get(request.sessionId)?.sequence ?? 0,
	);
	const branch = branchFilter(request.sessionId, request.through, request.scope);
	let rows: QueryCandidate[];
	if (request.action === "page") {
		const candidates = branch.empty
			? []
			: (db
					.prepare(
						"SELECT id,parent_id,kind,sequence FROM source_event INDEXED BY sqlite_autoindex_source_event_2 WHERE session=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?",
					)
					.all(request.sessionId, request.after, request.through, MAX_QUERY_CANDIDATES + 1) as QueryCandidate[]);
		rows = selectCandidates(candidates, branch.matches, request.limit, "History page selection");
	} else {
		if (Buffer.byteLength(request.query) > 8192) throw new Error("Index query limit exceeded");
		const queryTerms = terms(request.query);
		if (queryTerms.length > 32) throw new Error("Index query term limit exceeded");
		const queryTermCount = db.prepare("SELECT count FROM term_count WHERE session=? AND term=?");
		const counted = queryTerms.map((term) => ({
			term,
			count: Number(queryTermCount.get(request.sessionId, term)?.count ?? 0),
		}));
		counted.sort((left, right) => left.count - right.count);
		const [first, ...rest] = counted.map(({ term }) => term);
		const postings =
			first && !branch.empty
				? db
						.prepare(
							"SELECT sequence FROM source_term INDEXED BY sqlite_autoindex_source_term_1 WHERE session=? AND term=? AND sequence<=? ORDER BY sequence DESC LIMIT ?",
						)
						.all(request.sessionId, first, request.through, MAX_QUERY_CANDIDATES + 1)
				: [];
		const requiredTerm = db.prepare("SELECT 1 FROM source_term WHERE session=? AND term=? AND sequence=?");
		const selected = selectCandidates(
			postings,
			(posting) => {
				const sequence = Number(posting.sequence);
				return (
					rest.every((term) => !!requiredTerm.get(request.sessionId, term, sequence)) &&
					branch.matches(sourceCandidate(request.sessionId, sequence))
				);
			},
			request.limit,
			"History search selection",
		);
		rows = selected.map((posting) => sourceCandidate(request.sessionId, Number(posting.sequence)));
	}
	let incompleteText = false;
	if (request.action === "search" && !branch.empty) {
		const candidates = db
			.prepare(
				"SELECT id,parent_id,kind,sequence FROM source_event INDEXED BY source_incomplete WHERE session=? AND text_complete=0 AND sequence<=? ORDER BY sequence LIMIT ?",
			)
			.all(request.sessionId, request.through, MAX_QUERY_CANDIDATES + 1) as QueryCandidate[];
		incompleteText = selectCandidates(candidates, branch.matches, 0, "History search coverage").length > 0;
	}
	const events: IndexedSourceEvent[] = [];
	let bytes = 0;
	const content = db.prepare("SELECT * FROM source_event WHERE session=? AND sequence=?");
	for (const row of rows.slice(0, request.limit)) {
		const indexed = event(content.get(request.sessionId, row.sequence) as Row);
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
	const branch = branchFilter(sessionId, scope.through, scope);
	const coverageBudget = { remaining: MAX_QUERY_CANDIDATES };
	const lossKeys = options.taskKey === undefined ? [undefined] : [null, options.taskKey];
	let importedLoss = false;
	if (!branch.empty)
		for (const key of lossKeys) {
			const keyed = key !== undefined;
			const loss = db
				.prepare(
					`SELECT sequence FROM task_import_loss ${keyed ? "INDEXED BY task_loss_key" : "INDEXED BY sqlite_autoindex_task_import_loss_1"} WHERE session=? AND sequence<=?${keyed ? " AND task_key IS ?" : ""} ORDER BY sequence LIMIT ?`,
				)
				.all(sessionId, scope.through, ...(key === undefined ? [] : [key]), coverageBudget.remaining + 1);
			if (
				selectCandidates(
					loss,
					(row) => branch.matches(sourceCandidate(sessionId, Number(row.sequence))),
					0,
					"Task evidence coverage",
					coverageBudget,
				).length
			) {
				importedLoss = true;
				break;
			}
		}
	page.coverage = page.indexedThrough >= scope.through && !importedLoss ? "complete" : "partial";
	const task = options.taskKey === undefined ? "" : " AND task_key=?";
	const item = options.itemId === undefined ? "" : " AND item_id=?";
	const indexName =
		options.taskKey !== undefined
			? options.itemId !== undefined
				? "task_item"
				: "task_sequence"
			: options.itemId !== undefined
				? "task_item_sequence"
				: "sqlite_autoindex_task_evidence_1";
	// Each filter shape has an ordered index seek; SQL LIMIT is before branch filtering.
	const candidates = branch.empty
		? []
		: db
				.prepare(
					`SELECT sequence,ordinal FROM task_evidence INDEXED BY ${indexName} WHERE session=?${task}${item} AND (sequence,ordinal)>(?,?) AND sequence<=? ORDER BY sequence,ordinal LIMIT ?`,
				)
				.all(
					sessionId,
					...(options.taskKey === undefined ? [] : [options.taskKey]),
					...(options.itemId === undefined ? [] : [options.itemId]),
					after.sequence,
					after.ordinal,
					scope.through,
					MAX_QUERY_CANDIDATES + 1,
				);
	const rows = selectCandidates(
		candidates,
		(row) => branch.matches(sourceCandidate(sessionId, Number(row.sequence))),
		limit,
		"Task evidence selection",
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

type ContextNode = BranchNode & ContextState & Pick<Row, "sequence" | "kind" | "locator" | "revision">;
const manifestNode =
	db.prepare(`SELECT e.id,e.parent_id,e.sequence,e.kind,e.locator,e.revision,a.depth,c.visible_head,c.previous_visible,c.visible_count,c.latest_compaction,c.first_kept_id
 FROM source_event e JOIN context_node c ON c.session=e.session AND c.id=e.id
 LEFT JOIN source_ancestry a ON a.session=e.session AND a.id=e.id
 WHERE e.session=? AND e.id=? AND e.sequence<=?`);
const visibleJump = db.prepare(`SELECT j.ancestor_id,c.visible_count FROM source_jump j
 JOIN context_node c ON c.session=j.session AND c.id=j.ancestor_id
 WHERE j.session=? AND j.id=? AND j.level=?`);
function contextRef(node: ContextNode): ContextRef {
	return {
		entryId: node.id,
		sequence: node.sequence,
		kind: node.kind as ContextRef["kind"],
		locator: JSON.parse(node.locator) as ContextRef["locator"],
		revision: node.revision,
	};
}
function parentPath(request: Extract<HistoryIndexRequest, { action: "parent_path" }>): ParentPathPage {
	const { sessionId, scope, options } = request;
	const limit = options.limit ?? 64;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128)
		throw new Error("Parent path limit must be between1 and128");
	const saved = db.prepare("SELECT * FROM source_cursor WHERE session=?").get(sessionId);
	if (!saved) throw new Error("Parent path index is unavailable; synchronize the source first");
	const snapshot = JSON.parse(String(saved.frontier)) as SessionJournalState & { indexedThrough: number };
	if (snapshot.format !== "framed" || snapshot.indexedThrough < scope.through)
		throw new Error("Parent path index has not reached the requested source prefix");
	const leaf = validateBranchScope(sessionId, scope.through, scope);
	if (leaf?.depth === null) throw new Error("Parent path lineage is unresolved");
	const revision =
		scope.through === 0
			? saved.header_checksum
			: db.prepare("SELECT revision FROM source_event WHERE session=? AND sequence=?").get(sessionId, scope.through)
					?.revision;
	if (typeof revision !== "string") throw new Error("Parent path source prefix is unavailable");
	const anchor: Omit<ParentPathCursor, "nextDepth"> = {
		version: 1,
		sessionId,
		journalPath: snapshot.journalPath,
		dev: snapshot.dev,
		ino: snapshot.ino,
		leafId: scope.leafId,
		through: scope.through,
		throughRevision: revision,
	};
	const cursor = options.cursor;
	if (
		cursor &&
		(cursor.version !== 1 ||
			cursor.sessionId !== sessionId ||
			cursor.journalPath !== snapshot.journalPath ||
			cursor.dev !== snapshot.dev ||
			cursor.ino !== snapshot.ino ||
			cursor.leafId !== scope.leafId ||
			cursor.through !== scope.through ||
			cursor.throughRevision !== revision)
	)
		throw new Error("Parent path cursor mismatch");
	const count = leaf ? leaf.depth! + 1 : 0;
	const start = cursor ? cursor.nextDepth : 0;
	if (!Number.isSafeInteger(start) || start < 0 || start > count)
		throw new Error("Invalid parent path cursor position");
	const page: ParentPathPage = { events: [], nextCursor: null, totalEntries: count };
	if (start === count) return page;
	const end = Math.min(start + limit - 1, count - 1);
	let id = leaf!.id;
	let difference = leaf!.depth! - end;
	for (let level = 0; difference > 0 && level < MAX_JUMP_LEVELS; level++) {
		if (difference % 2 === 1) {
			const jump = ancestorJump.get(sessionId, id, level);
			if (!jump) throw new Error("Parent path ancestry metadata is incomplete");
			id = String(jump.ancestor_id);
		}
		difference = Math.floor(difference / 2);
	}
	// Reverse only this bounded page of IDs, then load metadata in chronological order.
	const ids: string[] = [];
	for (let depth = end; depth >= start; depth--) {
		const node = branchNode.get(sessionId, id, scope.through) as BranchNode | undefined;
		if (!node || node.depth !== depth) throw new Error("Parent path ancestry metadata is incomplete");
		ids.push(node.id);
		if (depth > start) {
			if (node.parent_id === null) throw new Error("Parent path parent reference is missing");
			id = node.parent_id;
		}
	}
	ids.reverse();
	const content = db.prepare("SELECT * FROM source_event WHERE session=? AND id=? AND sequence<=?");
	let bytes = Buffer.byteLength(
		JSON.stringify({ ...page, nextCursor: { ...anchor, nextDepth: Number.MAX_SAFE_INTEGER } }),
	);
	for (const entryId of ids) {
		const row = content.get(sessionId, entryId, scope.through) as Row | undefined;
		if (!row) throw new Error("Parent path source metadata is unavailable; rebuild the derived index");
		const item = event(row);
		const addition = Buffer.byteLength(JSON.stringify(item)) + (page.events.length ? 1 : 0);
		if (bytes + addition > 1024 * 1024 - 1024) break;
		page.events.push(item);
		bytes += addition;
	}
	if (page.events.length === 0) throw new Error("Parent path metadata exceeds the page byte limit");
	const next = start + page.events.length;
	page.nextCursor = next < count ? { ...anchor, nextDepth: next } : null;
	return page;
}
function branchBootstrap(request: Extract<HistoryIndexRequest, { action: "branch_bootstrap" }>): BranchBootstrapState {
	const { sessionId, scope } = request;
	const saved = db.prepare("SELECT frontier FROM source_cursor WHERE session=?").get(sessionId);
	if (!saved) throw new Error("Branch bootstrap index is unavailable; synchronize the source first");
	const snapshot = JSON.parse(String(saved.frontier)) as SessionJournalState & { indexedThrough: number };
	if (snapshot.format !== "framed" || snapshot.indexedThrough < scope.through)
		throw new Error("Branch bootstrap index has not reached the requested source prefix");
	const leaf = validateBranchScope(sessionId, scope.through, scope);
	if (leaf?.depth === null) throw new Error("Branch bootstrap branch lineage is unresolved");
	if (
		scope.through > 0 &&
		!db.prepare("SELECT 1 FROM source_event WHERE session=? AND sequence=?").get(sessionId, scope.through)
	)
		throw new Error("Branch bootstrap source prefix is unavailable");
	const state = leaf
		? (contextParent.get(sessionId, leaf.id) as (ContextState & BootstrapColumns) | undefined)
		: undefined;
	if (leaf && !state) throw new Error("Branch bootstrap metadata is unavailable; rebuild the derived index");
	const reference = (id: string | null | undefined): IndexedSourceEvent | null => {
		if (id == null) return null;
		const row = db
			.prepare("SELECT * FROM source_event WHERE session=? AND id=? AND sequence<=?")
			.get(sessionId, id, scope.through) as Row | undefined;
		if (!row) throw new Error("Branch bootstrap source metadata is unavailable; rebuild the derived index");
		return event(row);
	};
	return {
		model: reference(state?.latest_model),
		thinkingLevel: reference(state?.latest_thinking),
		serviceTier: reference(state?.latest_service_tier),
		goalState: reference(state?.latest_goal),
		hasContextMessages: !!state && (state.has_session_message === 1 || state.latest_compaction !== null),
		goalSeedable: !state || state.goal_seedable === 1,
	};
}
function contextManifest(request: Extract<HistoryIndexRequest, { action: "context_manifest" }>): ContextManifestPage {
	const { sessionId, scope, options } = request;
	const limit = options.limit ?? 64;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128)
		throw new Error("Context manifest limit must be between1 and128");
	const saved = db.prepare("SELECT * FROM source_cursor WHERE session=?").get(sessionId);
	if (!saved) throw new Error("Context manifest index is unavailable; synchronize the source first");
	const snapshot = JSON.parse(String(saved.frontier)) as SessionJournalState & { indexedThrough: number };
	if (snapshot.format !== "framed" || snapshot.indexedThrough < scope.through)
		throw new Error("Context manifest index has not reached the requested source prefix");
	validateBranchScope(sessionId, scope.through, scope);
	const revision =
		scope.through === 0
			? saved.header_checksum
			: db.prepare("SELECT revision FROM source_event WHERE session=? AND sequence=?").get(sessionId, scope.through)
					?.revision;
	if (typeof revision !== "string") throw new Error("Context manifest source prefix is unavailable");
	const anchor: Omit<ContextManifestCursor, "nextOrdinal"> = {
		version: 1,
		sessionId,
		journalPath: snapshot.journalPath,
		dev: snapshot.dev,
		ino: snapshot.ino,
		leafId: scope.leafId,
		through: scope.through,
		throughRevision: revision,
	};
	const cursor = options.cursor;
	if (
		cursor &&
		(cursor.version !== 1 ||
			cursor.sessionId !== sessionId ||
			cursor.journalPath !== snapshot.journalPath ||
			cursor.dev !== snapshot.dev ||
			cursor.ino !== snapshot.ino ||
			cursor.leafId !== scope.leafId ||
			cursor.through !== scope.through ||
			cursor.throughRevision !== revision)
	)
		throw new Error("Context manifest cursor mismatch");
	if (cursor && (!Number.isSafeInteger(cursor.nextOrdinal) || cursor.nextOrdinal < 1))
		throw new Error("Invalid context manifest cursor ordinal");
	const result: Extract<ContextManifestPage, { selection: "known" }> = {
		selection: "known",
		summaryRef: null,
		activeBase: 0,
		retainedMessageCount: 0,
		activeMessageCount: 0,
		refs: [],
		order: "source",
		nextCursor: null,
	};
	const node = (id: string): ContextNode => {
		const value = manifestNode.get(sessionId, id, scope.through) as ContextNode | undefined;
		if (!value) throw new Error("Context manifest metadata is unavailable; rebuild the derived index");
		return value;
	};
	const qualified = (selection: "unresolved-lineage" | "invalid-first-kept"): ContextManifestPage => ({
		selection,
		summaryRef: result.summaryRef,
		refs: [],
		order: "source",
		nextCursor: null,
	});
	const leaf = scope.leafId === null ? undefined : node(scope.leafId);
	if (leaf && (leaf.depth === null || leaf.visible_count === null)) return qualified("unresolved-lineage");
	const total = leaf?.visible_count ?? 0;
	if (leaf?.latest_compaction) {
		const compaction = node(leaf.latest_compaction);
		if (compaction.kind !== "compaction" || compaction.depth === null || compaction.visible_count === null)
			throw new Error("Context manifest compaction metadata is incomplete");
		result.summaryRef = contextRef(compaction);
		if (!compaction.first_kept_id) return qualified("invalid-first-kept");
		const first = manifestNode.get(sessionId, compaction.first_kept_id, scope.through) as ContextNode | undefined;
		// Exact parent-chain membership, never the broader evidence/request-parent scope rule.
		if (
			!first ||
			first.depth === null ||
			first.visible_count === null ||
			first.depth >= compaction.depth ||
			!resolvedAncestor(sessionId, compaction, first)
		)
			return qualified("invalid-first-kept");
		result.activeBase = first.visible_count - (first.visible_head === first.id ? 1 : 0);
		result.retainedMessageCount = compaction.visible_count - result.activeBase;
	}
	result.activeMessageCount = total - result.activeBase;
	const start = cursor?.nextOrdinal ?? result.activeBase + 1;
	if (start < result.activeBase + 1 || start > total + 1)
		throw new Error("Context manifest cursor ordinal is outside active selection");
	if (start === total + 1) return result;
	const end = Math.min(start + limit - 1, total);
	let seekId = leaf!.id;
	// Locate page END using physical ancestry jumps and monotonic visible counts, then reverse only this bounded page.
	for (let level = MAX_JUMP_LEVELS - 1; level >= 0; level--) {
		const jump = visibleJump.get(sessionId, seekId, level);
		if (jump && jump.visible_count !== null && Number(jump.visible_count) >= end) seekId = String(jump.ancestor_id);
	}
	const seek = node(seekId);
	if (seek.visible_head === null) throw new Error("Context manifest visible metadata is incomplete");
	let current = seek.visible_head === seek.id ? seek : node(seek.visible_head);
	const refs: (ContextRef & { ordinal: number })[] = [];
	for (let ordinal = end; ordinal >= start; ordinal--) {
		if (current.visible_count !== ordinal || current.visible_head !== current.id)
			throw new Error("Context manifest visible ordinal metadata is incomplete");
		refs.push({ ...contextRef(current), ordinal });
		if (ordinal > start) {
			if (current.previous_visible === null) throw new Error("Context manifest previous visible ref is missing");
			current = node(current.previous_visible);
		}
	}
	refs.reverse();
	// Include the largest continuation envelope in the byte count; never advance over an unreturned ref.
	const pageBytes = 1024 * 1024 - 1024;
	let bytes = Buffer.byteLength(
		JSON.stringify({ ...result, nextCursor: { ...anchor, nextOrdinal: Number.MAX_SAFE_INTEGER } }),
	);
	for (const ref of refs) {
		const addition = Buffer.byteLength(JSON.stringify(ref)) + (result.refs.length ? 1 : 0);
		if (bytes + addition > pageBytes) break;
		result.refs.push(ref);
		bytes += addition;
	}
	if (result.refs.length === 0) throw new Error("Context manifest metadata exceeds the page byte limit");
	const next = result.refs[result.refs.length - 1].ordinal + 1;
	result.nextCursor = next <= total ? { ...anchor, nextOrdinal: next } : null;
	return result;
}

type SourceRefRow = Pick<Row, "id" | "sequence" | "kind" | "locator" | "revision">;
type ContextUpdateScope = { leafId: string | null; through: number };
const latestUsageUpdate = db.prepare(`SELECT e.id,e.sequence,e.kind,e.locator,e.revision FROM context_update u
 JOIN source_event e ON e.session=u.session AND e.id=u.event_id
 WHERE u.session=? AND u.update_kind='assistant-usage' AND u.target_key=? AND u.sequence<=?
 ORDER BY u.sequence DESC LIMIT 1`);
const ipythonUpdates = db.prepare(`SELECT e.id,e.sequence,e.kind,e.locator,e.revision FROM context_update u
 JOIN source_event e ON e.session=u.session AND e.id=u.event_id
 WHERE u.session=? AND u.update_kind='ipython-sent-message' AND u.target_key=? AND u.sequence<=?
 ORDER BY u.sequence LIMIT ?`);
function contextUpdateSource(sessionId: string, scope: ContextUpdateScope) {
	const saved = db.prepare("SELECT * FROM source_cursor WHERE session=?").get(sessionId);
	if (!saved) throw new Error("Context update index is unavailable; synchronize the source first");
	const snapshot = JSON.parse(String(saved.frontier)) as SessionJournalState & { indexedThrough: number };
	if (snapshot.format !== "framed" || snapshot.indexedThrough < scope.through)
		throw new Error("Context update index has not reached the requested source prefix");
	const leaf = validateBranchScope(sessionId, scope.through, scope);
	if (leaf?.depth === null) throw new Error("Context update branch lineage is unresolved");
	if (
		scope.through > 0 &&
		!db.prepare("SELECT 1 FROM source_event WHERE session=? AND sequence=?").get(sessionId, scope.through)
	)
		throw new Error("Context update source prefix is unavailable");
	return snapshot;
}
function contextUpdateKey(sessionId: string, scope: ContextUpdateScope, target: ContextUpdateTarget): string {
	if (target.kind !== "assistant-usage" && target.kind !== "ipython-sent-message")
		throw new Error("Invalid context update target");
	const key = target.kind === "assistant-usage" ? target.targetId : target.toolCallId;
	if (typeof key !== "string" || key.length > (target.kind === "assistant-usage" ? 512 : MAX_CONTEXT_UPDATE_KEY))
		throw new Error("Context update target key limit exceeded");
	if (target.kind === "assistant-usage") {
		const assistant = db
			.prepare(
				"SELECT 1 FROM context_update WHERE session=? AND update_kind='assistant-target' AND target_key=? AND sequence<=?",
			)
			.get(sessionId, key, scope.through);
		if (!assistant || !pointEvent(sessionId, key, scope))
			throw new Error("Context update target is not an assistant message on the captured branch");
	}
	return key;
}
function contextUpdateRef(row: SourceRefRow): ContextUpdateRef {
	return {
		entryId: row.id,
		sequence: row.sequence,
		kind: row.kind as ContextUpdateRef["kind"],
		locator: JSON.parse(row.locator) as ContextUpdateRef["locator"],
		revision: row.revision,
	};
}
function contextUpdates(request: Extract<HistoryIndexRequest, { action: "context_updates" }>): ContextUpdates {
	const { sessionId, scope, target } = request;
	contextUpdateSource(sessionId, scope);
	const key = contextUpdateKey(sessionId, scope, target);
	let rows: SourceRefRow[];
	if (target.kind === "assistant-usage") {
		const latest = latestUsageUpdate.get(sessionId, key, scope.through) as SourceRefRow | undefined;
		rows = latest ? [latest] : [];
	} else {
		rows =
			scope.leafId === null
				? []
				: (ipythonUpdates.all(sessionId, key, scope.through, MAX_CONTEXT_UPDATE_CANDIDATES + 1) as SourceRefRow[]);
		if (rows.length > MAX_CONTEXT_UPDATE_CANDIDATES) throw new Error("Context update candidate budget exceeded");
		rows = rows.filter((row) => pointEvent(sessionId, row.id, scope) !== undefined);
	}
	const result: ContextUpdates = { refs: rows.map(contextUpdateRef), order: "source" };
	try {
		stringifyBoundedJson(result, TASK_PAGE_BYTES);
	} catch (error) {
		if (!(error instanceof Error) || error.message !== "JSON byte limit exceeded") throw error;
		throw new Error("Context update refs exceed the byte budget");
	}
	return result;
}
function readContextUpdatePayload(request: Extract<HistoryIndexRequest, { action: "read_context_update_payload" }>) {
	const { sessionId, eventId, scope, target, options } = request;
	const snapshot = contextUpdateSource(sessionId, scope);
	const key = contextUpdateKey(sessionId, scope, target);
	let row: SourceRefRow | undefined;
	if (target.kind === "assistant-usage") {
		row = latestUsageUpdate.get(sessionId, key, scope.through) as SourceRefRow | undefined;
		if (row?.id !== eventId) return undefined;
	} else {
		const related = db
			.prepare(
				"SELECT 1 FROM context_update WHERE session=? AND update_kind='ipython-sent-message' AND event_id=? AND target_key=? AND sequence<=?",
			)
			.get(sessionId, eventId, key, scope.through);
		if (!related) return undefined;
		row = pointEvent(sessionId, eventId, scope);
	}
	return row ? readPayloadRow(sessionId, row, snapshot, options) : undefined;
}

function readPayload(request: Extract<HistoryIndexRequest, { action: "read_payload" }>) {
	const saved = db.prepare("SELECT frontier FROM source_cursor WHERE session=?").get(request.sessionId);
	if (!saved) throw new Error("Canonical payload index is unavailable; synchronize the source first");
	const snapshot = JSON.parse(String(saved.frontier)) as SessionJournalState & { indexedThrough: number };
	if (snapshot.format !== "framed" || snapshot.indexedThrough < request.scope.through)
		throw new Error("Canonical payload index has not reached the requested source prefix");
	const row = pointEvent(request.sessionId, request.eventId, request.scope);
	if (!row) return undefined;
	return readPayloadRow(request.sessionId, row, snapshot, request.options);
}
function selectSourceEvent(request: Extract<HistoryIndexRequest, { action: "get_source" | "read_source_payload" }>) {
	const { sessionId, eventId, through } = request;
	if (!Number.isSafeInteger(through) || through < 0) throw new Error("Invalid history source prefix");
	const saved = db.prepare("SELECT frontier FROM source_cursor WHERE session=?").get(sessionId);
	if (!saved) throw new Error("Canonical source index is unavailable; synchronize the source first");
	const snapshot = JSON.parse(String(saved.frontier)) as SessionJournalState & { indexedThrough: number };
	if (snapshot.format !== "framed" || snapshot.indexedThrough < through)
		throw new Error("Canonical source index has not reached the requested source prefix");
	const row = db
		.prepare("SELECT * FROM source_event WHERE session=? AND id=? AND sequence<=?")
		.get(sessionId, eventId, through) as Row | undefined;
	return { row, snapshot };
}
function readPayloadRow(
	sessionId: string,
	row: SourceRefRow,
	snapshot: SessionJournalState,
	options: HistoryPayloadReadOptions,
) {
	const savedParts = db
		.prepare("SELECT parts FROM source_payload WHERE session=? AND sequence=?")
		.get(sessionId, row.sequence);
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
		const fragment = readCanonicalPayloadFragment(fd, parts, options.cursor, options.maxBytes);
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
		case "parent_path":
			return parentPath(request);
		case "branch_bootstrap":
			return branchBootstrap(request);
		case "context_manifest":
			return contextManifest(request);
		case "context_updates":
			return contextUpdates(request);
		case "read_context_update_payload":
			return readContextUpdatePayload(request);
		case "apply":
			apply(request.sessionId, request.events, request.committedThrough);
			return;
		case "get": {
			const row = pointEvent(request.sessionId, request.eventId, request.scope);
			return row ? event(row) : undefined;
		}
		case "get_source": {
			const { row } = selectSourceEvent(request);
			return row ? event(row) : undefined;
		}
		case "read_source_payload": {
			const { row, snapshot } = selectSourceEvent(request);
			return row ? readPayloadRow(request.sessionId, row, snapshot, request.options) : undefined;
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
