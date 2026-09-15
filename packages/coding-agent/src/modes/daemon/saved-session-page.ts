import { resolve } from "node:path";
import { getAgentDir, getSessionsDir } from "../../config.js";
import { stringifyBoundedJson } from "../../core/bounded-json.js";
import { canonicalSessionPath } from "../../core/session-lease.js";
import {
	getDefaultSessionDir,
	isSessionCatalogFile,
	iterateSessionCatalogFiles,
	readSessionInfo,
	type SessionInfo,
} from "../../core/session-manager.js";
import type { AgentConnectionSavedSessionScope } from "../agent-connection/types.js";
import {
	type AgentsViewOrderRow,
	type AgentsViewScopeKey,
	buildUnifiedSessionIndex,
	compareAgentsViewRows,
	getAgentsViewSessionTitle,
	getParentKeys,
	isSubagentDescendantRecord,
	isSubagentSummary,
	reconcileUnifiedSessions,
	summaryForUnifiedRecord,
	type UnifiedSessionRecord,
} from "../agents-view/agents-view-state.js";
import { matchSearchText, parseSearchQuery } from "../agents-view/session-view-search.js";
import type { DaemonSavedSessionInfo } from "./daemon-protocol.js";
import type { SessionSummary } from "./daemon-session-list.js";
import { type RlmLedgerEdge, RlmSpawnLedger } from "./rlm-ledger.js";
import { serializeSavedSessionInfo } from "./saved-session-info.js";

export const SAVED_SESSION_PAGE_MAX_ROWS = 64;
export const SAVED_SESSION_PAGE_MAX_BYTES = 1024 * 1024;

/** Captured display context, not source authority or an archive snapshot. */
export interface SavedSessionPageQuery {
	text?: string;
	limit?: number;
	cursor?: { identity: string; direction: "next" | "previous" };
	live?: SessionSummary[];
	anchorSessionId?: string;
	subtree?: AgentsViewScopeKey;
}

export interface SavedSessionPageHints {
	/** Live rows retained by global search plus its ancestor closure. */
	liveMatches: string[];
	liveEnrichment: Array<{
		identity: string;
		sessionName?: string;
		firstMessage?: string;
		created?: string;
		modified?: string;
		lastActivityAt?: string;
	}>;
	/** Only presence is used for the existing busy-descendant rank; not a count. */
	busyAncestors: string[];
	/** A loaded parent has matching saved children outside the loaded page. */
	moreChildren: string[];
	/** Unfiltered child presence for opening/scoping a row; never a descendant total. */
	allChildren: string[];
	/** Global spawn-group order for loaded parents; groups still use their existing code keys. */
	groups: Array<{ parent: string; codes: Array<string | null> }>;
}

export type SavedSessionPage =
	| {
			status: "page";
			sessions: DaemonSavedSessionInfo[];
			primary: string[];
			/** Preserve explicit generic array callers' catalog-then-passive order, not UI ranking. */
			sourceOrder: Array<{ path: string; source: "catalog" | "passive"; ordinal: number }>;
			before?: string;
			after?: string;
			moreBefore: boolean;
			moreAfter: boolean;
			limited: true;
			hints: SavedSessionPageHints;
	  }
	| { status: "refused"; reason: string; message: string };

class SavedSessionPageRefusal extends Error {
	constructor(
		readonly reason: string,
		message: string,
	) {
		super(message);
	}
}

export function captureSavedSessionPageQuery(query: SavedSessionPageQuery = {}): SavedSessionPageQuery {
	const captured = JSON.parse(stringifyBoundedJson(query, SAVED_SESSION_PAGE_MAX_BYTES)) as SavedSessionPageQuery;
	if (!captured || typeof captured !== "object" || Array.isArray(captured))
		throw new SavedSessionPageRefusal("invalid_query", "Saved-session query must be an object");
	if (
		(captured.text !== undefined && typeof captured.text !== "string") ||
		(captured.limit !== undefined &&
			(!Number.isInteger(captured.limit) || captured.limit < 1 || captured.limit > SAVED_SESSION_PAGE_MAX_ROWS)) ||
		(captured.cursor !== undefined &&
			(!captured.cursor ||
				typeof captured.cursor.identity !== "string" ||
				!["next", "previous"].includes(captured.cursor.direction))) ||
		(captured.subtree !== undefined &&
			(!captured.subtree ||
				typeof captured.subtree.sessionId !== "string" ||
				(captured.subtree.activeSessionId !== undefined &&
					typeof captured.subtree.activeSessionId !== "string"))) ||
		(captured.live !== undefined && !Array.isArray(captured.live))
	)
		throw new SavedSessionPageRefusal("invalid_query", "Invalid bounded saved-session query");
	for (const row of captured.live ?? []) {
		if (
			!row ||
			typeof row.id !== "string" ||
			typeof row.sessionId !== "string" ||
			typeof row.cwd !== "string" ||
			!Number.isSafeInteger(row.messageCount) ||
			row.messageCount < 0 ||
			(row.rosterStatus !== undefined && !["running", "idle", "inactive"].includes(row.rosterStatus)) ||
			(row.rlmDepth !== undefined && (!Number.isSafeInteger(row.rlmDepth) || row.rlmDepth < 0))
		)
			throw new SavedSessionPageRefusal("invalid_query", "Invalid captured live ordering context");
		for (const value of [
			row.activeSessionId,
			row.sessionFile,
			row.sessionName,
			row.firstMessage,
			row.summary,
			row.created,
			row.modified,
			row.lastActivityAt,
			row.parentActiveSessionId,
			row.parentSessionId,
			row.parentSessionPath,
			row.spawnCode,
		])
			if (value !== undefined && typeof value !== "string")
				throw new SavedSessionPageRefusal("invalid_query", "Invalid captured ordering field");
	}
	return captured;
}

interface PageNode {
	info?: SessionInfo;
	record: UnifiedSessionRecord;
	summary: SessionSummary;
	identity: string;
}

interface SavedAliasTarget {
	aliases: string[];
	file?: string;
	required: boolean;
	seen?: boolean;
}

function boundSavedAliasTargets(targets: readonly SavedAliasTarget[]): void {
	try {
		stringifyBoundedJson(targets, SAVED_SESSION_PAGE_MAX_BYTES);
	} catch {
		throw new SavedSessionPageRefusal("ambiguous_source", "Relevant saved aliases exceed the bounded page lookup");
	}
}

interface Candidate {
	identity: string;
	path: string;
	/** Required source rows, including the node and non-matching ancestors. */
	closure: string[];
	order: AgentsViewOrderRow[];
}

const fileKey = (path: string) => `file:${resolve(path)}`;
const codeKey = (summary: SessionSummary): string | null => (summary.spawnCode?.trim() ? summary.spawnCode : null);

/** Keep only the live fields consumed by the existing search, rank and lineage rules. */
export function captureSavedSessionOrderingContext(records: readonly UnifiedSessionRecord[]): SessionSummary[] {
	return records.flatMap(({ daemon: row, section, heartbeat }) =>
		row
			? [
					{
						id: row.id,
						sessionId: row.sessionId,
						activeSessionId: row.activeSessionId,
						sessionFile: row.sessionFile,
						lifecycle: row.lifecycle,
						activity: row.activity,
						isSessionActive: row.isSessionActive,
						rosterStatus: section,
						hasActiveHeartbeat: (heartbeat?.activeCount ?? 0) > 0 || row.hasActiveHeartbeat,
						messageCount: row.messageCount,
						created: row.created,
						lastActivityAt: section === "running" ? undefined : row.lastActivityAt,
						modified: section === "running" ? undefined : row.modified,
						sessionName: row.sessionName,
						firstMessage: row.firstMessage,
						summary: row.summary,
						cwd: row.cwd,
						runtimeKind: row.runtimeKind,
						rlmDepth: row.rlmDepth,
						rlmChildId: row.rlmChildId,
						parentActiveSessionId: row.parentActiveSessionId,
						parentSessionId: row.parentSessionId,
						parentSessionPath: row.parentSessionPath,
						rlmParentNodeId: row.rlmParentNodeId,
						spawnCode: row.spawnCode,
						isStreaming: false,
						isCompacting: false,
						attachedClients: 0,
						sessionActions: { queuedCount: 0, steering: [], followUps: [] },
					},
				]
			: [],
	);
}

class SavedPageSource {
	readonly live: UnifiedSessionRecord[];
	readonly liveIndex: ReturnType<typeof buildUnifiedSessionIndex>;
	constructor(
		readonly directory: string,
		readonly cwd: string | undefined,
		readonly edges: readonly RlmLedgerEdge[],
		readonly query: SavedSessionPageQuery,
	) {
		this.live = reconcileUnifiedSessions(query.live ?? [], []);
		this.liveIndex = buildUnifiedSessionIndex(this.live);
	}
	private liveFor(info: SessionInfo): SessionSummary | undefined {
		return (this.liveIndex.byKey.get(fileKey(info.path)) ?? this.liveIndex.byKey.get(`session:${info.id}`))?.daemon;
	}
	async read(path: string, suppliedEdge?: RlmLedgerEdge): Promise<PageNode | undefined> {
		const inDirectory = isSessionCatalogFile(path, this.directory);
		const canonical = canonicalSessionPath(path);
		const edge = inDirectory ? undefined : (suppliedEdge ?? this.edges.find((item) => item.child === canonical));
		if (!inDirectory && !edge) return;
		let info = await readSessionInfo(path);
		if (!info || (this.cwd !== undefined && (!info.cwd || resolve(info.cwd) !== resolve(this.cwd)))) return;
		if (edge) info = { ...info, parentSessionPath: edge.parent, rlmDepth: edge.depth };
		const live = this.liveFor(info);
		const record = reconcileUnifiedSessions(live ? [live] : [], [info])[0]!;
		return { info, record, summary: summaryForUnifiedRecord(record), identity: record.identity };
	}
	async *nodes(): AsyncGenerator<PageNode> {
		// This set is bounded by the captured live request, never by the saved archive.
		const seenLive = new Set<string>();
		for await (const path of iterateSessionCatalogFiles(this.directory)) {
			const node = await this.read(path);
			if (!node) continue;
			if (node.record.daemon) seenLive.add(node.identity);
			yield node;
		}
		for (const edge of this.edges) {
			if (isSessionCatalogFile(edge.child, this.directory)) continue;
			// Preserve the existing first-live-edge/path dedup without a full saved-path set.
			if (this.edges.find((item) => item.child === edge.child) !== edge) continue;
			const node = await this.read(edge.child, edge);
			if (!node) continue;
			if (node.record.daemon) seenLive.add(node.identity);
			yield node;
		}
		for (const record of this.live)
			if (!seenLive.has(record.identity))
				yield { record, summary: summaryForUnifiedRecord(record), identity: record.identity };
	}
	async find(key: string): Promise<PageNode | undefined> {
		const live = this.liveIndex.byKey.get(key);
		if (live) {
			const summary = summaryForUnifiedRecord(live);
			return (
				(summary.sessionFile ? await this.read(summary.sessionFile) : undefined) ?? {
					record: live,
					summary,
					identity: live.identity,
				}
			);
		}
		if (key.startsWith("file:")) return this.read(key.slice(5));
		// Saved-only rows have file/session aliases, never an absent live active/agent alias.
		if (key.startsWith("active:") || key.startsWith("agent:")) return;
		for await (const node of this.nodes()) if (node.record.identityAliases.includes(key)) return node;
	}
	async assertUnambiguous(targets: SavedAliasTarget[]): Promise<void> {
		if (targets.length === 0) return;
		// Only retained rows, their required/cursor closure and bounded display facts are targets.
		// One first-source path per target is enough to refuse a second physical saved row.
		for (let pass = 0; pass < 2; pass++) {
			for await (const node of this.nodes()) {
				if (!node.info) continue;
				const file = fileKey(node.info.path);
				for (const target of targets) {
					if (!node.record.identityAliases.some((alias) => target.aliases.includes(alias))) continue;
					const conflictsWithLive = [file, `session:${node.info.id}`].some((alias) => {
						const live = this.liveIndex.byKey.get(alias);
						return live !== undefined && live.identity !== node.identity;
					});
					if ((target.file !== undefined && target.file !== file) || conflictsWithLive)
						throw new SavedSessionPageRefusal(
							"ambiguous_source",
							"Relevant saved-session aliases are ambiguous in this catalog scope",
						);
					target.file = file;
					target.seen = true;
					const added = node.record.identityAliases.filter((alias) => !target.aliases.includes(alias));
					// A single source may attach its saved ID to a captured live file alias.
					// The second pass also sees peers that preceded that attachment in source order.
					if (pass === 1 && added.length > 0)
						throw new SavedSessionPageRefusal(
							"source_changed",
							"Relevant saved aliases changed during the page read",
						);
					target.aliases.push(...added);
					boundSavedAliasTargets(targets);
				}
			}
		}
		if (targets.some((target) => target.required && !target.seen))
			throw new SavedSessionPageRefusal("required_row_unavailable", "A required saved-session alias is unavailable");
	}
	async arrayOrder(path: string): Promise<{ path: string; source: "catalog" | "passive"; ordinal: number }> {
		if (isSessionCatalogFile(path, this.directory)) {
			let ordinal = 0;
			for await (const item of iterateSessionCatalogFiles(this.directory)) {
				if (resolve(item) === resolve(path)) return { path, source: "catalog", ordinal };
				ordinal++;
			}
		} else {
			const ordinal = this.edges.findIndex((edge) => edge.child === canonicalSessionPath(path));
			if (ordinal >= 0) return { path, source: "passive", ordinal };
		}
		throw new SavedSessionPageRefusal("source_changed", "A selected catalog path changed during the page read");
	}
	async parent(node: PageNode): Promise<PageNode | undefined> {
		const keys = getParentKeys(node.summary);
		if (node.info?.parentSessionPath) keys.push(fileKey(node.info.parentSessionPath));
		let fileParent: PageNode | undefined;
		const file = keys.find((key) => key.startsWith("file:"));
		for (const key of keys) {
			if (key.startsWith("session:") && !this.liveIndex.byKey.has(key) && file) {
				fileParent ??= await this.find(file);
				if (fileParent?.record.identityAliases.includes(key)) return fileParent;
			}
			const parent = key === file && fileParent ? fileParent : await this.find(key);
			if (parent) return parent;
		}
		const referencedHere = keys.some(
			(key) =>
				key.startsWith("file:") &&
				(isSessionCatalogFile(key.slice(5), this.directory) ||
					this.edges.some((edge) => canonicalSessionPath(edge.child) === canonicalSessionPath(key.slice(5)))),
		);
		if (this.cwd === undefined && referencedHere)
			throw new SavedSessionPageRefusal(
				"required_parent_unavailable",
				"A referenced parent is unavailable in this catalog scope",
			);
	}
	inScope(node: PageNode): boolean {
		const scope = this.query.subtree;
		return (
			!!scope &&
			(node.summary.sessionId === scope.sessionId ||
				(scope.activeSessionId !== undefined && node.summary.activeSessionId === scope.activeSessionId))
		);
	}
	async chain(node: PageNode): Promise<PageNode[] | undefined> {
		const chain: PageNode[] = [];
		const seen = new Set<string>();
		let current: PageNode | undefined = node;
		let saved = 0;
		while (current) {
			if (seen.has(current.identity))
				throw new SavedSessionPageRefusal("ancestry_cycle", "Saved page ancestry is cyclic");
			seen.add(current.identity);
			chain.unshift(current);
			if (current.info && ++saved > (this.query.limit ?? SAVED_SESSION_PAGE_MAX_ROWS))
				throw new SavedSessionPageRefusal(
					"closure_limit",
					"One required saved-session closure exceeds this page's row budget",
				);
			try {
				stringifyBoundedJson(
					chain.flatMap((item) => (item.info ? [serializeSavedSessionInfo(item.info)] : [])),
					SAVED_SESSION_PAGE_MAX_BYTES,
				);
			} catch {
				throw new SavedSessionPageRefusal(
					"closure_bytes",
					"One required saved-session closure exceeds the encoded page budget",
				);
			}
			// Live context has its own existing request-byte bound; chains still cannot grow without it.
			stringifyBoundedJson(
				chain.map((item) => ({ identity: item.identity, path: item.info?.path })),
				SAVED_SESSION_PAGE_MAX_BYTES,
			);
			if (this.inScope(current)) return chain;
			current = await this.parent(current);
		}
		return this.query.subtree ? undefined : chain;
	}
	nested(child: PageNode, parent: PageNode): boolean {
		return (
			!this.inScope(parent) &&
			isSubagentSummary(child.summary) &&
			isSubagentDescendantRecord(child.record, parent.record)
		);
	}
}

interface OrderStep {
	identity: string;
	row: AgentsViewOrderRow;
	group?: AgentsViewOrderRow;
}
interface OrderedCandidate extends Omit<Candidate, "order"> {
	order: OrderStep[];
}

function rank(node: PageNode, busy: ReadonlySet<string>): AgentsViewOrderRow {
	const row = node.summary;
	return {
		section: node.record.section,
		title: getAgentsViewSessionTitle(row),
		runningSubagentCount: busy.has(node.identity) ? 1 : 0,
		summary: {
			messageCount: row.messageCount,
			sessionId: row.sessionId,
			hasActiveHeartbeat: row.hasActiveHeartbeat,
			lastActivityAt: row.lastActivityAt,
			created: row.created,
		},
	};
}

function compareOrder(a: readonly OrderStep[], b: readonly OrderStep[], anchor?: string): number {
	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		if (a[i]!.identity === b[i]!.identity) continue;
		const group = a[i]!.group && b[i]!.group ? compareAgentsViewRows(a[i]!.group!, b[i]!.group!, anchor) : 0;
		return group || compareAgentsViewRows(a[i]!.row, b[i]!.row, anchor);
	}
	return a.length - b.length;
}

export async function readSavedSessionPage(
	context: {
		cwd?: string;
		sessionDir?: string;
		agentDir?: string;
		ledgerSessionDir?: string;
		scope: AgentConnectionSavedSessionScope;
	},
	input: SavedSessionPageQuery = {},
): Promise<SavedSessionPage> {
	try {
		const query = captureSavedSessionPageQuery(input);
		if (
			!["all", "current"].includes(context.scope) ||
			(context.scope === "current" && typeof context.cwd !== "string")
		)
			throw new SavedSessionPageRefusal("invalid_scope", "Invalid saved-session catalog scope");
		const limit = query.limit ?? SAVED_SESSION_PAGE_MAX_ROWS;
		const cwd = context.scope === "current" ? context.cwd : undefined;
		const directory = context.sessionDir ?? (cwd ? getDefaultSessionDir(cwd) : getSessionsDir());
		const ledger = new RlmSpawnLedger(
			context.agentDir ?? getAgentDir(),
			context.ledgerSessionDir ?? context.sessionDir ?? getSessionsDir(context.agentDir),
		);
		// Existing per-ledger read limits remain authoritative; no all-SessionInfo merge or new path index.
		const edges = await ledger.liveEdges({ strict: true });
		for (const edge of edges) {
			edge.child = canonicalSessionPath(edge.child);
			edge.parent = canonicalSessionPath(edge.parent);
		}
		const source = new SavedPageSource(directory, cwd, edges, query);
		const parsed = parseSearchQuery(query.text ?? "");
		if (parsed.error) throw new SavedSessionPageRefusal("invalid_search", parsed.error);
		const matched = async (visit: (chain: PageNode[]) => void | Promise<void>) => {
			for await (const node of source.nodes()) {
				if (!matchSearchText(node.record.searchableText, parsed).matches) continue;
				const chain = await source.chain(node);
				if (!chain) continue;
				for (let i = 0; i < chain.length; i++) await visit(chain.slice(0, i + 1));
			}
		};
		const liveMatches = new Set<string>();
		const liveEnrichment = new Map<string, SavedSessionPageHints["liveEnrichment"][number]>();
		const busy = new Set<string>();
		const required = new Set<string>();
		if (query.subtree) {
			const root =
				(query.subtree.activeSessionId
					? await source.find(`active:${query.subtree.activeSessionId}`)
					: undefined) ?? (await source.find(`session:${query.subtree.sessionId}`));
			if (!root)
				throw new SavedSessionPageRefusal("scope_unavailable", "The requested saved-session scope is unavailable");
			if (root.info) required.add(root.info.path);
		}
		await matched((chain) => {
			const node = chain.at(-1)!;
			if (node.record.daemon) {
				liveMatches.add(node.identity);
				const row = node.summary;
				liveEnrichment.set(node.identity, {
					identity: node.identity,
					sessionName: row.sessionName,
					firstMessage: row.firstMessage,
					created: row.created,
					modified: row.modified,
					lastActivityAt: row.lastActivityAt,
				});
				stringifyBoundedJson([...liveEnrichment.values()], SAVED_SESSION_PAGE_MAX_BYTES);
			}
		});
		const groups = new Map<string, Map<string | null, AgentsViewOrderRow>>();
		for (const key of liveMatches) {
			const node = await source.find(key);
			if (!node)
				throw new SavedSessionPageRefusal(
					"ordering_context_changed",
					"A captured live ordering row is unavailable",
				);
			const chain = await source.chain(node);
			if (!chain) continue;
			for (const item of chain) if (item.info && !item.record.daemon) required.add(item.info.path);
			if (required.size > limit)
				throw new SavedSessionPageRefusal(
					"closure_limit",
					"Live rows require more saved ancestors than this page can retain",
				);
			if (node.record.section === "running") {
				for (let i = chain.length - 1; i > 0 && source.nested(chain[i]!, chain[i - 1]!); i--)
					busy.add(chain[i - 1]!.identity);
			}
			const parent = chain.at(-2);
			if (parent && source.nested(node, parent) && codeKey(node.summary) !== null && !groups.has(parent.identity))
				groups.set(parent.identity, new Map());
		}
		const checkFacts = () =>
			stringifyBoundedJson(
				{
					liveMatches: [...liveMatches],
					busy: [...busy],
					groups: [...groups].map(([parent, items]) => ({ parent, items: [...items] })),
				},
				SAVED_SESSION_PAGE_MAX_BYTES,
			);
		checkFacts();
		// Group insertion order is set by each group's first ranked child in the existing UI.
		await matched((chain) => {
			const node = chain.at(-1)!;
			const parent = chain.at(-2);
			const entries = parent && source.nested(node, parent) ? groups.get(parent.identity) : undefined;
			if (!entries) return;
			const code = codeKey(node.summary);
			const order = rank(node, busy);
			const prior = entries.get(code);
			if (!prior || compareAgentsViewRows(order, prior, query.anchorSessionId) < 0) entries.set(code, order);
			checkFacts();
		});
		const makeCandidate = (chain: PageNode[]): OrderedCandidate | undefined => {
			const node = chain.at(-1)!;
			if (!node.info || source.inScope(node)) return;
			let root = 0;
			for (let i = 1; i < chain.length; i++) if (!source.nested(chain[i]!, chain[i - 1]!)) root = i;
			return {
				identity: node.identity,
				path: node.info.path,
				closure: chain.flatMap((item) => (item.info ? [item.info.path] : [])),
				order: chain.slice(root).map((item, i) => ({
					identity: item.identity,
					row: rank(item, busy),
					...(i > 0 && groups.get(chain[root + i - 1]!.identity)?.get(codeKey(item.summary))
						? { group: groups.get(chain[root + i - 1]!.identity)!.get(codeKey(item.summary))! }
						: {}),
				})),
			};
		};
		let cursor: OrderedCandidate | undefined;
		if (query.cursor) {
			const node = await source.find(query.cursor.identity);
			const chain = node ? await source.chain(node) : undefined;
			cursor = chain ? makeCandidate(chain) : undefined;
			if (!cursor)
				throw new SavedSessionPageRefusal(
					"cursor_unavailable",
					"Saved page continuation changed; refresh the list",
				);
		}
		const direction = query.cursor?.direction === "previous" ? -1 : 1;
		const candidates: OrderedCandidate[] = [];
		let omittedBefore = false;
		let omittedAfter = false;
		const pathsFor = (items: readonly OrderedCandidate[]) =>
			new Set([...required, ...items.flatMap((item) => item.closure)]);
		await matched((chain) => {
			const candidate = makeCandidate(chain);
			if (!candidate) return;
			if (cursor) {
				const comparison = compareOrder(candidate.order, cursor.order, query.anchorSessionId);
				if (comparison * direction <= 0) {
					if (comparison < 0) omittedBefore = true;
					if (comparison > 0) omittedAfter = true;
					return;
				}
			}
			if (candidates.some((item) => item.identity === candidate.identity)) return;
			candidates.push(candidate);
			candidates.sort((a, b) => direction * compareOrder(a.order, b.order, query.anchorSessionId));
			while (pathsFor(candidates).size > limit || candidates.length > limit) {
				if (candidates.length === 1)
					throw new SavedSessionPageRefusal(
						"closure_limit",
						"One required saved-session closure cannot fit this page",
					);
				candidates.pop();
				if (direction > 0) omittedAfter = true;
				else omittedBefore = true;
			}
			// Share the retained closure ranks rather than copying an ancestor's title into every candidate.
			// This is only the current bounded candidate closure, not an archive-wide lookup/cache.
			const retainedOrder = new Map<string, OrderStep>();
			for (const item of candidates)
				item.order = item.order.map((step) => {
					const retained = retainedOrder.get(step.identity);
					if (retained) return retained;
					retainedOrder.set(step.identity, step);
					return step;
				});
		});
		const aliasTargets: SavedAliasTarget[] = [];
		const rememberAliases = (aliases: readonly string[], file?: string, required = file !== undefined) => {
			if (
				aliasTargets.some(
					(target) =>
						aliases.every((alias) => target.aliases.includes(alias)) &&
						(file === undefined || target.file === file) &&
						(!required || target.required),
				)
			)
				return;
			aliasTargets.push({ aliases: [...aliases], file, required });
			boundSavedAliasTargets(aliasTargets);
		};
		for (const path of pathsFor(candidates)) rememberAliases([fileKey(path)], fileKey(path));
		for (const path of cursor?.closure ?? []) rememberAliases([fileKey(path)], fileKey(path));
		for (const record of source.live) rememberAliases(record.identityAliases);
		for (const items of groups.values())
			for (const row of items.values()) {
				const key = `session:${row.summary.sessionId}`;
				rememberAliases([key], undefined, !source.liveIndex.byKey.has(key));
			}
		const hints: SavedSessionPageHints = {
			liveMatches: [...liveMatches],
			liveEnrichment: [...liveEnrichment.values()],
			busyAncestors: [...busy],
			moreChildren: [],
			allChildren: [],
			groups: [],
		};
		const page: Extract<SavedSessionPage, { status: "page" }> = {
			status: "page",
			sessions: [],
			primary: [],
			sourceOrder: [],
			moreBefore: omittedBefore || query.cursor?.direction === "next",
			moreAfter: omittedAfter || query.cursor?.direction === "previous",
			limited: true,
			hints,
		};
		const loaded = new Set<string>();
		const add = async (path: string) => {
			if (loaded.has(path)) return;
			const node = await source.read(path);
			if (!node?.info)
				throw new SavedSessionPageRefusal(
					"required_row_unavailable",
					"A required saved-session row is unavailable",
				);
			page.sessions.push(serializeSavedSessionInfo(node.info));
			page.sourceOrder.push(await source.arrayOrder(path));
			loaded.add(path);
		};
		for (const path of required) await add(path);
		const accepted: OrderedCandidate[] = [];
		for (const candidate of candidates) {
			const before = page.sessions.length;
			const priorPaths = new Set(loaded);
			for (const path of candidate.closure) await add(path);
			page.primary.push(candidate.identity);
			try {
				stringifyBoundedJson(page, SAVED_SESSION_PAGE_MAX_BYTES);
			} catch {
				if (accepted.length === 0)
					throw new SavedSessionPageRefusal(
						"page_bytes",
						"One required closure exceeds the encoded saved-page byte budget",
					);
				page.sessions.length = before;
				page.sourceOrder.length = before;
				page.primary.pop();
				for (const path of loaded) if (!priorPaths.has(path)) loaded.delete(path);
				if (direction > 0) page.moreAfter = true;
				else page.moreBefore = true;
				break;
			}
			accepted.push(candidate);
		}
		accepted.sort((a, b) => compareOrder(a.order, b.order, query.anchorSessionId));
		page.primary = accepted.map((item) => item.identity);
		page.before = accepted[0]?.identity;
		page.after = accepted.at(-1)?.identity;
		const visibleParents = new Set([
			...page.sessions.map((row) => fileKey(row.path)),
			...source.live.map((row) => row.identity),
		]);
		const moreChildren = new Set<string>();
		await matched((chain) => {
			const node = chain.at(-1)!;
			const parent = chain.at(-2);
			if (
				parent &&
				visibleParents.has(parent.identity) &&
				node.info &&
				!loaded.has(node.info.path) &&
				!node.record.daemon &&
				source.nested(node, parent) &&
				!moreChildren.has(parent.identity)
			) {
				rememberAliases([fileKey(node.info.path)], fileKey(node.info.path));
				moreChildren.add(parent.identity);
			}
		});
		hints.moreChildren = [...moreChildren];
		const childPresence = new Set<string>();
		const parentAliases = new Set([
			...visibleParents,
			...page.sessions.map((row) => `session:${row.id}`),
			...source.live.flatMap((row) => row.identityAliases),
		]);
		for await (const node of source.nodes()) {
			if (!getParentKeys(node.summary).some((key) => parentAliases.has(key))) continue;
			const parent = await source.parent(node);
			if (parent && visibleParents.has(parent.identity) && !childPresence.has(parent.identity)) {
				if (node.info) rememberAliases([fileKey(node.info.path)], fileKey(node.info.path));
				childPresence.add(parent.identity);
			}
		}
		hints.allChildren = [...childPresence];
		hints.groups = [...groups]
			.filter(([parent]) => visibleParents.has(parent))
			.map(([parent, items]) => ({
				parent,
				codes: [...items]
					.sort((a, b) => compareAgentsViewRows(a[1], b[1], query.anchorSessionId))
					.map(([code]) => code),
			}));
		await source.assertUnambiguous(aliasTargets);
		// Budget the complete page, including topology hints/cursors, before final IPC/JSONL serialization.
		while (true) {
			try {
				stringifyBoundedJson(page, SAVED_SESSION_PAGE_MAX_BYTES);
				return page;
			} catch {
				if (accepted.length <= 1)
					throw new SavedSessionPageRefusal(
						"page_bytes",
						"One required page closure and its context exceed the encoded byte budget",
					);
				if (direction > 0) {
					accepted.pop();
					page.moreAfter = true;
				} else {
					accepted.shift();
					page.moreBefore = true;
				}
				const keep = pathsFor(accepted);
				const removed = page.sessions.filter((row) => !keep.has(row.path));
				page.sessions = page.sessions.filter((row) => keep.has(row.path));
				page.sourceOrder = page.sourceOrder.filter((row) => keep.has(row.path));
				page.primary = accepted.map((item) => item.identity);
				page.before = accepted[0]?.identity;
				page.after = accepted.at(-1)?.identity;
				const parents = new Set([
					...page.sessions.map((row) => fileKey(row.path)),
					...source.live.map((row) => row.identity),
				]);
				const more = new Set(hints.moreChildren.filter((identity) => parents.has(identity)));
				for (const row of removed) {
					const node = await source.read(row.path);
					const parent = node ? await source.parent(node) : undefined;
					if (node && parent && parents.has(parent.identity) && source.nested(node, parent))
						more.add(parent.identity);
				}
				hints.moreChildren = [...more];
				hints.allChildren = hints.allChildren.filter((identity) => parents.has(identity));
				hints.groups = hints.groups.filter((group) => parents.has(group.parent));
			}
		}
	} catch (error) {
		const refusal: SavedSessionPage = {
			status: "refused",
			reason: error instanceof SavedSessionPageRefusal ? error.reason : "source_unavailable",
			message: error instanceof Error ? error.message : String(error),
		};
		try {
			stringifyBoundedJson(refusal, SAVED_SESSION_PAGE_MAX_BYTES);
			return refusal;
		} catch {
			return {
				status: "refused",
				reason: refusal.reason,
				message: "Saved-session page data exceeds its encoded byte budget",
			};
		}
	}
}
