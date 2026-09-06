import { createHash } from "node:crypto";
import { existsSync, fsyncSync, linkSync, mkdirSync, openSync, realpathSync, rmSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { stringifyBoundedJson } from "../../core/bounded-json.js";
import { EventLog } from "../../core/event-log.js";
import { encodeJournalFrame, INITIAL_JOURNAL_CURSOR } from "../../core/journal-frame.js";
import { syncJournalDirectory, withJournalDescriptorSync, writeFullySync } from "../../core/journal-io.js";
import { canonicalSessionPath } from "../../core/session-lease.js";
import { getSessionArtifactPathForFile, readSessionInfo, type SessionInfo } from "../../core/session-manager.js";
import { readFirstLineSync } from "../../utils/file-lines.js";
import {
	RLM_LEDGER_MAX_MUTATION_BYTES,
	RLM_LEDGER_MAX_PENDING_BYTES,
	RLM_LEDGER_MAX_PENDING_OPERATIONS,
	type RlmLedgerAccess,
	type RlmLedgerDeleteReason,
	type RlmLedgerMutation,
} from "./rlm-ledger-mutations.js";

export type { RlmLedgerAccess, RlmLedgerDeleteReason, RlmLedgerMutation } from "./rlm-ledger-mutations.js";

/** Family topology journal. Only its supplied lifetime owner may seed, repair, or append. */
export const RLM_LEDGER_DIR = "rlm-ledger";

/** Bounded read: a ledger beyond these limits fails closed loudly. */
export const RLM_LEDGER_MAX_BYTES = 32 * 1024 * 1024;
export const RLM_LEDGER_MAX_RECORDS = 100_000;

interface RlmLedgerMetaRecord {
	v: 1;
	op: "meta";
	at: string;
	sessionsDir: string;
}

export interface RlmLedgerSpawnRecord {
	v: 1;
	op: "spawn";
	at: string;
	childId: string;
	parent: string;
	child: string;
	depth: number;
	name: string;
}

export interface RlmLedgerRenameRecord {
	v: 1;
	op: "rename";
	at: string;
	childId: string;
	child: string;
	name: string;
}

export interface RlmLedgerDeleteRecord {
	v: 1;
	op: "delete";
	at: string;
	childId: string;
	child: string;
	reason: RlmLedgerDeleteReason;
}

export type RlmLedgerRecord = RlmLedgerSpawnRecord | RlmLedgerRenameRecord | RlmLedgerDeleteRecord;

/** A live edge after replaying the ledger (last-writer-wins per childId+child). */
export interface RlmLedgerEdge {
	childId: string;
	parent: string;
	child: string;
	depth: number;
	name: string;
	deleted?: RlmLedgerDeleteReason;
}

/** Minimal registry-entry shape the seeder consumes (matches the daemon writer). */
export interface RlmLedgerSeedRegistryEntry {
	childId: string;
	sessionName: string;
	sessionFile: string;
	rlmDepth?: number;
	status: "running" | "completed" | "deleted";
}

export interface LegacyRlmSubagentRegistryEntry extends RlmLedgerSeedRegistryEntry {
	type: "rlm_subagent";
	sessionDir: string;
	parentSessionId: string;
	parentSessionFile?: string;
	rlmMaxDepth?: number;
	rlmParentNodeId?: string;
	prompt?: string;
	spawnCode?: string;
	model?: { provider: string; modelId: string };
	createdAt: number;
	updatedAt: string;
}

export interface RlmLedgerSeedSource {
	readRegistryForSessionFile(sessionFile: string): Promise<RlmLedgerSeedRegistryEntry[]>;
}

export async function readLegacyRlmSubagentRegistry(
	path: string,
	options: { throwOnReadError?: boolean; log?: (message: string) => void } = {},
): Promise<LegacyRlmSubagentRegistryEntry[]> {
	const latest = new Map<string, LegacyRlmSubagentRegistryEntry>();
	try {
		new EventLog(path, {
			maxBytes: RLM_LEDGER_MAX_BYTES,
			maxRecords: RLM_LEDGER_MAX_RECORDS,
			log: options.log,
		}).replaySync((line) => {
			try {
				const entry = JSON.parse(line) as Partial<LegacyRlmSubagentRegistryEntry>;
				if (
					entry.type !== "rlm_subagent" ||
					typeof entry.childId !== "string" ||
					typeof entry.sessionName !== "string" ||
					typeof entry.sessionFile !== "string" ||
					(entry.status !== "running" && entry.status !== "completed" && entry.status !== "deleted") ||
					(entry.rlmDepth !== undefined && (!Number.isSafeInteger(entry.rlmDepth) || entry.rlmDepth < 0))
				) {
					return undefined;
				}
				latest.set(entry.childId, {
					...entry,
					sessionDir: typeof entry.sessionDir === "string" ? entry.sessionDir : dirname(entry.sessionFile),
					// rlmMaxDepth is optional hydration metadata the ledger seeder never
					// reads; a damaged value must not discard the child's topology edge,
					// so it is dropped instead of rejecting the whole entry.
					rlmMaxDepth:
						entry.rlmMaxDepth !== undefined && Number.isSafeInteger(entry.rlmMaxDepth) && entry.rlmMaxDepth >= 0
							? entry.rlmMaxDepth
							: undefined,
				} as LegacyRlmSubagentRegistryEntry);
			} catch (error) {
				options.log?.(
					`ignored malformed RLM subagent registry entry: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			return undefined;
		});
	} catch (error) {
		options.log?.(`failed to read RLM subagent registry: ${error instanceof Error ? error.message : String(error)}`);
		if (options.throwOnReadError) throw error;
		return [];
	}
	return [...latest.values()];
}

export function createRlmLedgerRegistrySeedSource(): RlmLedgerSeedSource {
	return {
		readRegistryForSessionFile: async (sessionFile) => {
			let headerId: string | undefined;
			try {
				const firstLine = readFirstLineSync(sessionFile);
				if (firstLine) {
					const header = JSON.parse(firstLine) as { id?: unknown };
					if (typeof header.id === "string") headerId = header.id;
				}
			} catch {
				return [];
			}
			if (!headerId) return [];
			return readLegacyRlmSubagentRegistry(
				join(getSessionArtifactPathForFile(sessionFile, headerId), "rlm-subagents.jsonl"),
			);
		},
	};
}

/** Canonicalize a directory: realpath when it exists, plain resolve otherwise. */
function canonicalizeDirPath(dir: string): string {
	const resolved = resolve(dir);
	try {
		return realpathSync(resolved);
	} catch {
		return resolved;
	}
}

export function rlmLedgerPath(agentDir: string, sessionsDir: string): string {
	const canonical = canonicalizeDirPath(sessionsDir);
	const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
	return join(agentDir, RLM_LEDGER_DIR, `${hash}.jsonl`);
}

function nowIso(): string {
	return new Date().toISOString();
}

function isDeleteReason(value: unknown): value is RlmLedgerDeleteReason {
	return value === "user" || value === "parent-teardown" || value === "revoked" || value === "gc";
}

/**
 * Parse one ledger line. Returns undefined for a well-formed v:1 record with
 * an unknown op (forward-compat: newer writers may add ops; readers skip
 * them). Any other violation throws. Version policy: v !== 1 fails loudly —
 * a future v2 must move to a new file/hash (or accept breaking old readers),
 * because silently skipping records a reader cannot understand would corrupt
 * topology.
 */
function parseLedgerLine(line: string, index: number): RlmLedgerRecord | RlmLedgerMetaRecord | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		throw new Error(
			`Malformed RLM ledger line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const record = parsed as {
		v?: unknown;
		op?: unknown;
		at?: unknown;
		sessionsDir?: unknown;
		childId?: unknown;
		parent?: unknown;
		child?: unknown;
		depth?: unknown;
		name?: unknown;
		reason?: unknown;
	};
	if (record.v !== 1 || typeof record.at !== "string") {
		throw new Error(`Malformed RLM ledger line ${index + 1}: missing v/at`);
	}
	switch (record.op) {
		case "meta":
			if (typeof record.sessionsDir !== "string") {
				throw new Error(`Malformed RLM ledger line ${index + 1}: meta without sessionsDir`);
			}
			return record as unknown as RlmLedgerMetaRecord;
		case "spawn":
			if (
				typeof record.childId !== "string" ||
				typeof record.parent !== "string" ||
				typeof record.child !== "string" ||
				typeof record.name !== "string" ||
				typeof record.depth !== "number" ||
				!Number.isSafeInteger(record.depth) ||
				record.depth < 1
			) {
				throw new Error(`Malformed RLM ledger line ${index + 1}: invalid spawn record`);
			}
			return record as unknown as RlmLedgerSpawnRecord;
		case "rename":
			if (
				typeof record.childId !== "string" ||
				typeof record.child !== "string" ||
				typeof record.name !== "string"
			) {
				throw new Error(`Malformed RLM ledger line ${index + 1}: invalid rename record`);
			}
			return record as unknown as RlmLedgerRenameRecord;
		case "delete":
			if (typeof record.childId !== "string" || typeof record.child !== "string" || !isDeleteReason(record.reason)) {
				throw new Error(`Malformed RLM ledger line ${index + 1}: invalid delete record`);
			}
			return record as unknown as RlmLedgerDeleteRecord;
		default:
			return undefined;
	}
}

function edgeKey(childId: string, child: string): string {
	return `${childId}\u0000${canonicalSessionPath(child)}`;
}

/** One bounded queue per instance; the caller supplies the actual journal ownership or remote acknowledgement. */
export class RlmSpawnLedger {
	private readonly path: string;
	private readonly eventLog: EventLog;
	private readonly canonicalSessionsDir: string;
	private queue: Promise<unknown> = Promise.resolve();
	private seedAttempted = false;
	private pendingCount = 0;
	private pendingBytes = 0;
	private ownerPoisoned = false;
	private mutationAdmissionClosed = false;

	constructor(
		agentDir: string,
		sessionsDir: string,
		private readonly seedSource?: RlmLedgerSeedSource,
		private readonly log: (message: string) => void = () => {},
		private readonly access: RlmLedgerAccess = { mode: "reader" },
	) {
		this.canonicalSessionsDir = canonicalizeDirPath(sessionsDir);
		this.path = rlmLedgerPath(agentDir, sessionsDir);
		this.eventLog = new EventLog(this.path, {
			maxBytes: RLM_LEDGER_MAX_BYTES,
			maxRecords: RLM_LEDGER_MAX_RECORDS,
			assertOwner: access.mode === "owner" ? () => this.assertOwner() : undefined,
			validateRecord: (line, index) => {
				parseLedgerLine(line, index);
			},
			log: (message) => this.log(`RLM ledger: ${message}`),
		});
	}

	get ledgerPath(): string {
		return this.path;
	}

	appendSpawn(input: Omit<Extract<RlmLedgerMutation, { op: "spawn" }>, "op">): Promise<void> {
		return this.mutate({ op: "spawn", ...input });
	}

	appendRename(input: Omit<Extract<RlmLedgerMutation, { op: "rename" }>, "op">): Promise<void> {
		return this.mutate({ op: "rename", ...input });
	}

	appendRenameByChildPath(child: string, name: string): Promise<void> {
		return this.mutate({ op: "rename_by_path", child, name });
	}

	appendDelete(input: Omit<Extract<RlmLedgerMutation, { op: "delete" }>, "op">): Promise<void> {
		return this.mutate({ op: "delete", ...input });
	}

	appendDeleteByChildPath(child: string, reason: RlmLedgerDeleteReason = "user"): Promise<void> {
		return this.mutate({ op: "delete_by_path", child, reason });
	}

	/** Resolves only after an owner write or the remote owner's durable acknowledgement. */
	async mutate(input: RlmLedgerMutation): Promise<void> {
		if (this.mutationAdmissionClosed) throw new Error("RLM ledger mutation admission is closed");
		if (this.access.mode === "reader") throw new Error("RLM ledger is read-only; mutations require an owner");
		const serialized = stringifyBoundedJson(input, RLM_LEDGER_MAX_MUTATION_BYTES);
		const mutation = JSON.parse(serialized) as RlmLedgerMutation;
		this.validateMutation(mutation);
		return this.enqueue(async () => {
			if (this.access.mode === "remote") return this.access.mutate(mutation);
			this.assertOwner();
			if (this.ownerPoisoned || this.eventLog.requiresRepair)
				throw new Error("RLM ledger requires owner recovery before another mutation");
			if (mutation.op === "spawn") return this.appendSpawnUnlocked(mutation);
			if (mutation.op === "rename_by_path" || mutation.op === "delete_by_path") {
				const child = canonicalSessionPath(mutation.child);
				for (const edge of this.replaySync().values()) {
					if (edge.deleted || canonicalSessionPath(edge.child) !== child) continue;
					if (mutation.op === "rename_by_path")
						this.appendRecord({
							v: 1,
							op: "rename",
							at: nowIso(),
							childId: edge.childId,
							child,
							name: mutation.name,
						});
					else
						this.appendRecord({
							v: 1,
							op: "delete",
							at: nowIso(),
							childId: edge.childId,
							child,
							reason: mutation.reason,
						});
				}
				return;
			}
			if (mutation.op === "rename")
				this.appendRecord({
					v: 1,
					op: "rename",
					at: nowIso(),
					childId: mutation.childId,
					child: canonicalSessionPath(mutation.child),
					name: mutation.name,
				});
			else
				this.appendRecord({
					v: 1,
					op: "delete",
					at: nowIso(),
					childId: mutation.childId,
					child: canonicalSessionPath(mutation.child),
					reason: mutation.reason,
				});
		}, Buffer.byteLength(serialized));
	}

	/** Explicit retained-input migration; neither startup nor ordinary mutation requests it implicitly. */
	migrateLegacy(): Promise<void> {
		if (this.mutationAdmissionClosed) return Promise.reject(new Error("RLM ledger mutation admission is closed"));
		return this.enqueue(
			() => {
				this.assertOwner();
				this.eventLog.migrateLegacySync();
			},
			128,
			false,
		);
	}

	/** No automatic retry behind an uncertain append. The actual owner must request recovery. */
	recover(): Promise<void> {
		if (this.mutationAdmissionClosed) return Promise.reject(new Error("RLM ledger mutation admission is closed"));
		return this.enqueue(
			() => {
				this.assertOwner();
				this.eventLog.recoverSync();
				this.ownerPoisoned = false;
			},
			128,
			false,
		);
	}

	private assertOwner(): void {
		if (this.access.mode !== "owner") throw new Error("RLM ledger is read-only; exclusive ownership is required");
		this.access.assertOwner();
	}

	private validateMutation(mutation: RlmLedgerMutation): void {
		const field = (value: unknown, max: number): boolean =>
			typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= max;
		if (!mutation || !field(mutation.child, 4096)) throw new Error("Invalid RLM ledger child path");
		switch (mutation.op) {
			case "spawn":
				if (!field(mutation.parent, 4096) || !Number.isSafeInteger(mutation.depth) || mutation.depth < 1)
					throw new Error("Invalid RLM ledger spawn");
				if (!field(mutation.childId, 512) || !field(mutation.name, 1024))
					throw new Error("Invalid RLM ledger spawn identity");
				break;
			case "rename":
				if (!field(mutation.childId, 512) || !field(mutation.name, 1024))
					throw new Error("Invalid RLM ledger rename");
				break;
			case "delete":
				if (!field(mutation.childId, 512) || !isDeleteReason(mutation.reason))
					throw new Error("Invalid RLM ledger delete");
				break;
			case "rename_by_path":
				if (!field(mutation.name, 1024)) throw new Error("Invalid RLM ledger rename");
				break;
			case "delete_by_path":
				if (!isDeleteReason(mutation.reason)) throw new Error("Invalid RLM ledger delete");
				break;
			default:
				throw new Error("Unknown RLM ledger mutation");
		}
	}

	/** Stop new mutations without cancelling operations already admitted to the owner queue. */
	stopAdmission(): void {
		this.mutationAdmissionClosed = true;
	}

	/** Wait for admitted operations to settle; each mutation promise carries its own failure. */
	flush(): Promise<void> {
		return this.queue.then(() => undefined);
	}

	/**
	 * Replay edges without liveness reconciliation. Deleted edges are filtered
	 * by default; `includeDeleted` keeps the tombstones (marked with their
	 * delete reason) for consumers that need a deleted child's identity, such
	 * as cleanup retries.
	 */
	edges(includeDeleted = false): Promise<RlmLedgerEdge[]> {
		return this.enqueue(() => [...this.replaySync().values()].filter((edge) => includeDeleted || !edge.deleted));
	}

	/**
	 * Family of every session rooted in this ledger's sessions dir: bounded
	 * readdir of *.jsonl roots as depth-0 rows plus live ledger edges, both
	 * reconciled by stat (a dead parent or child drops the edge). Depths are
	 * verified parent+1 between ledger-known depths; a contradictory edge is
	 * dropped and logged, never fails the whole family.
	 */
	family(): Promise<SessionInfo[]> {
		return this.enqueue(() => this.familyUnlocked());
	}

	/** Same-parent rows for a child session path, including the child itself. */
	siblings(sessionPath: string): Promise<SessionInfo[]> {
		return this.enqueue(async () => {
			const target = canonicalSessionPath(sessionPath);
			const family = await this.familyUnlocked();
			const edges = [...this.replaySync().values()].filter((edge) => !edge.deleted);
			const parentByChild = new Map(
				edges.map((edge) => [canonicalSessionPath(edge.child), canonicalSessionPath(edge.parent)]),
			);
			const parent = parentByChild.get(target);
			if (parent !== undefined) {
				const rows = family.filter((row) => parentByChild.get(canonicalSessionPath(row.path)) === parent);
				// The target's edge can be reconciliation-dropped (parent file
				// gone) while its own file still exists: fall back to presenting
				// the survivor alone rather than an empty set the callers would
				// read as "session not found".
				if (!rows.some((row) => canonicalSessionPath(row.path) === target)) {
					try {
						if ((await stat(target)).isFile()) {
							return [await this.sessionRow(target, 0, undefined, undefined)];
						}
					} catch {
						// fall through to the (possibly empty) sibling rows
					}
				}
				return rows;
			}
			// Roots are siblings of the other roots. A session outside both the
			// ledger and the sessions dir is presented alone (matching the
			// registry-walking reader's behavior for parentless sessions).
			const roots = family.filter((row) => row.rlmDepth === 0);
			if (roots.some((row) => canonicalSessionPath(row.path) === target)) {
				return roots;
			}
			try {
				if (!(await stat(target)).isFile()) return [];
			} catch {
				return [];
			}
			return [await this.sessionRow(target, 0, undefined, undefined)];
		});
	}

	private enqueue<T>(fn: () => Promise<T> | T, bytes = 128, seed = true): Promise<T> {
		if (
			this.pendingCount >= RLM_LEDGER_MAX_PENDING_OPERATIONS ||
			this.pendingBytes + bytes > RLM_LEDGER_MAX_PENDING_BYTES
		) {
			return Promise.reject(new Error("RLM ledger queue limit reached; await pending operations"));
		}
		this.pendingCount++;
		this.pendingBytes += bytes;
		const shouldSeed = seed && !this.mutationAdmissionClosed;
		const next = this.queue
			.then(async () => {
				if (shouldSeed && this.access.mode === "owner" && !this.seedAttempted) {
					this.assertOwner();
					if (this.ownerPoisoned) throw new Error("RLM ledger requires owner recovery");
					this.seedAttempted = true;
					await this.seed();
				}
				return fn();
			})
			.finally(() => {
				this.pendingCount--;
				this.pendingBytes -= bytes;
			});
		this.queue = next.catch(() => undefined);
		return next;
	}

	private appendSpawnUnlocked(input: {
		childId: string;
		parent: string;
		child: string;
		depth: number;
		name: string;
	}): void {
		// Enforce the same invariants parseLedgerLine checks: never write a
		// record this reader would refuse to read back.
		if (!input.childId || !input.parent || !input.child || !Number.isSafeInteger(input.depth) || input.depth < 1) {
			throw new Error(
				`RLM ledger: invalid spawn for ${input.childId || "<missing childId>"} (depth ${input.depth})`,
			);
		}
		const childPath = canonicalSessionPath(input.child);
		// The supplied lifetime owner keeps this replay and append in one writer queue.
		for (const edge of this.replaySync().values()) {
			if (!edge.deleted && canonicalSessionPath(edge.child) === childPath && edge.childId !== input.childId) {
				throw new Error(`RLM ledger: duplicate child session path ${childPath} (already ${edge.childId})`);
			}
		}
		this.appendRecord({
			v: 1,
			op: "spawn",
			at: nowIso(),
			childId: input.childId,
			parent: canonicalSessionPath(input.parent),
			child: childPath,
			depth: input.depth,
			name: input.name,
		});
	}

	/** Live edges reconciled by stat, exactly like family(): a dead parent or child drops the edge. */
	liveEdges(): Promise<RlmLedgerEdge[]> {
		return this.enqueue(() => this.liveEdgesUnlocked());
	}

	private async liveEdgesUnlocked(
		edges = [...this.replaySync().values()].filter((edge) => !edge.deleted),
	): Promise<RlmLedgerEdge[]> {
		const statCache = new Map<string, boolean>();
		const exists = async (path: string): Promise<boolean> => {
			const cached = statCache.get(path);
			if (cached !== undefined) return cached;
			let ok = false;
			try {
				ok = (await stat(path)).isFile();
			} catch {
				ok = false;
			}
			statCache.set(path, ok);
			return ok;
		};
		const alive: RlmLedgerEdge[] = [];
		for (const edge of edges) {
			if ((await exists(canonicalSessionPath(edge.child))) && (await exists(canonicalSessionPath(edge.parent)))) {
				alive.push(edge);
			}
		}
		return alive;
	}

	private async familyUnlocked(): Promise<SessionInfo[]> {
		// One replay, one stat snapshot: byChild comes from the same alive set that emits child rows,
		// so a child whose dead edge was reconciled away degrades to a root row instead of vanishing.
		let alive: RlmLedgerEdge[] = await this.liveEdgesUnlocked(
			[...this.replaySync().values()].filter((candidate) => !candidate.deleted),
		);
		const byChild = new Map<string, RlmLedgerEdge>();
		for (const edge of alive) {
			byChild.set(canonicalSessionPath(edge.child), edge);
		}
		const rootPaths: string[] = [];
		let rootEntries: string[] = [];
		try {
			rootEntries = await readdir(this.canonicalSessionsDir);
		} catch {
			rootEntries = [];
		}
		for (const entry of rootEntries.filter((name) => name.endsWith(".jsonl")).sort()) {
			const path = canonicalSessionPath(join(this.canonicalSessionsDir, entry));
			// Ledger children that live directly in the sessions dir are not roots.
			if (byChild.has(path)) continue;
			rootPaths.push(path);
		}
		// Verify depth monotonicity between ledger-known depths only: a root's
		// presented depth of 0 is a display convention, not an assertion (a
		// nested daemon's roots legitimately carry env-derived depths > 0). A
		// contradictory edge is dropped and logged; one bad edge must not fail
		// the whole family.
		const depthByPath = new Map<string, number>();
		for (const edge of alive) {
			depthByPath.set(canonicalSessionPath(edge.child), edge.depth);
		}
		alive = alive.filter((edge) => {
			const parentDepth = depthByPath.get(canonicalSessionPath(edge.parent));
			if (parentDepth !== undefined && edge.depth !== parentDepth + 1) {
				this.log(
					`RLM ledger: dropped edge ${edge.childId} with contradictory depth (parent ${parentDepth}, child ${edge.depth})`,
				);
				return false;
			}
			return true;
		});
		const rows: SessionInfo[] = [];
		for (const rootPath of rootPaths) {
			rows.push(await this.sessionRow(rootPath, 0, undefined, undefined));
		}
		for (const edge of alive) {
			rows.push(
				await this.sessionRow(
					canonicalSessionPath(edge.child),
					edge.depth,
					canonicalSessionPath(edge.parent),
					edge.name,
				),
			);
		}
		return rows;
	}

	private async sessionRow(
		path: string,
		depth: number,
		parentPath: string | undefined,
		name: string | undefined,
	): Promise<SessionInfo> {
		// Display-grade fields are best-effort from the ordinary session-info
		// read; topology (path, depth, parent) comes EXCLUSIVELY from the
		// ledger: header-claimed parentSessionPath/rlmDepth (e.g. fork headers)
		// are stripped, never passed through. For roots the ledger carries no
		// name, so the name comes from this read — writer-owned display data,
		// not authority.
		const info = await readSessionInfo(path).catch(() => null);
		if (info) {
			const { parentSessionPath: _headerParent, rlmDepth: _headerDepth, ...display } = info;
			return {
				...display,
				rlmDepth: depth,
				...(parentPath ? { parentSessionPath: parentPath } : {}),
				...(name ? { name } : {}),
			};
		}
		return {
			path,
			id: basename(path, ".jsonl"),
			cwd: "",
			...(name ? { name } : {}),
			...(parentPath ? { parentSessionPath: parentPath } : {}),
			rlmDepth: depth,
			created: new Date(0),
			modified: new Date(0),
			messageCount: 0,
			firstMessage: "",
			allMessagesText: "",
		};
	}

	private async seed(): Promise<void> {
		this.assertOwner();
		if (!this.seedSource || existsSync(this.path)) return;
		let rootEntries: string[];
		try {
			rootEntries = await readdir(this.canonicalSessionsDir);
		} catch {
			return;
		}
		const skipBounds = () => this.log("RLM ledger: seed exceeds read bounds; skipping seeding");
		if (rootEntries.length > RLM_LEDGER_MAX_RECORDS) {
			skipBounds();
			return;
		}
		const meta: RlmLedgerMetaRecord = { v: 1, op: "meta", at: nowIso(), sessionsDir: this.canonicalSessionsDir };
		const first = encodeJournalFrame(meta, INITIAL_JOURNAL_CURSOR, RLM_LEDGER_MAX_MUTATION_BYTES);
		const lines = [first.line];
		let frameCursor = first.next;
		let bytes = Buffer.byteLength(first.line);
		const queue: Array<{ sessionFile: string; depth: number }> = rootEntries
			.filter((name) => name.endsWith(".jsonl"))
			.sort()
			.map((name) => ({ sessionFile: join(this.canonicalSessionsDir, name), depth: 0 }));
		const visited = new Set<string>(queue.map((item) => canonicalSessionPath(item.sessionFile)));
		for (let cursor = 0; cursor < queue.length; cursor++) {
			const { sessionFile, depth } = queue[cursor];
			let entries: RlmLedgerSeedRegistryEntry[];
			try {
				entries = await this.seedSource.readRegistryForSessionFile(sessionFile);
			} catch (error) {
				this.log(`RLM ledger seeding failed: ${error instanceof Error ? error.message : String(error)}`);
				return;
			}
			if (entries.length > RLM_LEDGER_MAX_RECORDS) {
				skipBounds();
				return;
			}
			for (const entry of entries) {
				if (entry.status === "deleted") continue;
				const childPath = canonicalSessionPath(entry.sessionFile);
				if (visited.has(childPath)) continue;
				if (!entry.childId) {
					this.log("RLM ledger: skipped seeding a registry entry without a childId");
					continue;
				}
				const childDepth = entry.rlmDepth !== undefined && entry.rlmDepth >= 1 ? entry.rlmDepth : depth + 1;
				const record: RlmLedgerSpawnRecord = {
					v: 1,
					op: "spawn",
					at: nowIso(),
					childId: entry.childId,
					parent: canonicalSessionPath(sessionFile),
					child: childPath,
					depth: childDepth,
					name: entry.sessionName,
				};
				let line: string;
				try {
					parseLedgerLine(stringifyBoundedJson(record, RLM_LEDGER_MAX_MUTATION_BYTES), lines.length);
					const encoded = encodeJournalFrame(record, frameCursor, RLM_LEDGER_MAX_MUTATION_BYTES);
					line = encoded.line;
					frameCursor = encoded.next;
				} catch {
					skipBounds();
					return;
				}
				if (
					lines.length >= RLM_LEDGER_MAX_RECORDS ||
					bytes + Buffer.byteLength(line) > RLM_LEDGER_MAX_BYTES ||
					queue.length >= RLM_LEDGER_MAX_RECORDS
				) {
					skipBounds();
					return;
				}
				bytes += Buffer.byteLength(line);
				lines.push(line);
				visited.add(childPath);
				queue.push({ sessionFile: entry.sessionFile, depth: childDepth });
			}
		}
		if (lines.length === 1) return;
		const payload = Buffer.from(lines.join(""), "utf8");
		const dir = dirname(this.path);
		this.assertOwner();
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const tempPath = `${this.path}.seed-${process.pid}-${Date.now()}`;
		let created = false;
		try {
			const handle = openSync(tempPath, "wx", 0o600);
			created = true;
			withJournalDescriptorSync(handle, () => {
				writeFullySync(handle, payload);
				fsyncSync(handle);
			});
			this.assertOwner();
			this.publishSeedFile(tempPath);
		} catch (error) {
			this.ownerPoisoned = true;
			throw error;
		} finally {
			if (created) rmSync(tempPath, { force: true });
		}
	}

	private publishSeedFile(tempPath: string): void {
		// Atomic no-clobber publish: link() fails with EEXIST if a live append
		// created the real file meanwhile — that append wins (its data is
		// fresher than the registries) and the seed is discarded. No-clobber
		// publication is a hard requirement for seeding: post-consolidation,
		// deletes live only in the ledger, so any clobber window can lose live
		// appends and resurrect deleted edges. Filesystems that cannot provide
		// link() therefore get flat pre-ledger history (the documented
		// degradation mode) rather than a check-then-rename race.
		this.assertOwner();
		try {
			linkSync(tempPath, this.path);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EEXIST") {
				return;
			}
			this.log(`RLM ledger: link publish unavailable (${code ?? "unknown"}); skipping seeding`);
			return;
		}
		syncJournalDirectory(dirname(this.path));
		this.assertOwner();
	}

	private appendRecord(record: RlmLedgerRecord): void {
		this.eventLog.appendSync([record], {
			durable: true,
			onCreate: () => [
				{ v: 1, op: "meta", at: nowIso(), sessionsDir: this.canonicalSessionsDir } satisfies RlmLedgerMetaRecord,
			],
		});
	}

	private replaySync(): Map<string, RlmLedgerEdge> {
		const edges = new Map<string, RlmLedgerEdge>();
		const records = this.eventLog.replaySync((line, index) => {
			const record = parseLedgerLine(line, index);
			if (record === undefined) {
				this.log(`RLM ledger: skipped record with unknown op on line ${index + 1}`);
			}
			return record;
		});
		for (const record of records) {
			if (record.op === "meta") continue;
			const key = edgeKey(record.childId, record.child);
			switch (record.op) {
				case "spawn":
					edges.set(key, {
						childId: record.childId,
						parent: record.parent,
						child: record.child,
						depth: record.depth,
						name: record.name,
					});
					break;
				case "rename": {
					const existing = edges.get(key);
					if (existing) existing.name = record.name;
					break;
				}
				case "delete": {
					const existing = edges.get(key);
					if (existing) existing.deleted = record.reason;
					break;
				}
			}
		}
		return edges;
	}
}

// The catalog scan never visits session-artifacts, where RLM children persist:
// without this merge a passivated descendant's row (and its spend) survives only
// as long as some resident roster remembers it.
export async function withPassiveRlmDescendantInfos(
	savedSessions: SessionInfo[],
	ledger: RlmSpawnLedger,
	options: { cwd?: string; onSession?: (info: SessionInfo) => void; log?: (message: string) => void } = {},
): Promise<SessionInfo[]> {
	const sessions = [...savedSessions];
	const seen = new Set(savedSessions.map((info) => canonicalSessionPath(info.path)));
	let edges: RlmLedgerEdge[];
	try {
		edges = await ledger.liveEdges();
	} catch (error) {
		// A broken ledger must not take the whole catalog down with it.
		options.log?.(`Could not merge passive RLM descendants: ${String(error)}`);
		return sessions;
	}
	for (const edge of edges) {
		const childPath = canonicalSessionPath(edge.child);
		if (seen.has(childPath)) continue;
		seen.add(childPath);
		const info = await readSessionInfo(childPath);
		if (!info) continue;
		if (options.cwd !== undefined && (!info.cwd || resolve(info.cwd) !== resolve(options.cwd))) continue;
		// The ledger edge is the authoritative topology (family() semantics); a fork
		// can leave the transcript header pointing at a dead ancestor path.
		const merged: SessionInfo = {
			...info,
			parentSessionPath: edge.parent,
			rlmDepth: edge.depth,
		};
		sessions.push(merged);
		options.onSession?.(merged);
	}
	return sessions;
}

// Shared user-delete policy: only a readable no-parent transcript is positively top-level; children and
// unknown targets tombstone via the ledger BEFORE the file delete (a tombstoned-but-undeleted file is
// the accepted orphan of a failed delete).
export async function tombstoneSavedSessionDelete(
	ledger: RlmSpawnLedger,
	sessionPath: string,
	knownSummary: { runtimeKind?: "top-level" | "subagent" } | undefined,
): Promise<{ deletedInfo: SessionInfo | undefined; ledgerEdge: RlmLedgerEdge | undefined }> {
	const deletedPath = canonicalSessionPath(sessionPath);
	const deletedInfo = (await readSessionInfo(sessionPath).catch(() => null)) ?? undefined;
	const knownChild =
		knownSummary?.runtimeKind === "subagent" ||
		deletedInfo?.parentSessionPath !== undefined ||
		(deletedInfo?.rlmDepth ?? 0) > 0;
	const positivelyTopLevel = !knownChild && (knownSummary !== undefined || deletedInfo !== undefined);
	if (positivelyTopLevel) return { deletedInfo, ledgerEdge: undefined };
	const edges = await ledger.edges();
	// Tombstone every matching edge: a duplicate edge for the path (corrupt or raced appends) left
	// live would resurrect a later recreation at that path as a subagent.
	const matching = edges.filter((edge) => canonicalSessionPath(edge.child) === deletedPath);
	await ledger.appendDeleteByChildPath(sessionPath, "user");
	return { deletedInfo, ledgerEdge: matching[0] };
}
