import { existsSync, opendirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { AssistantMessage, Usage } from "@ponythewhite/base-context-ai";
import type { RlmChildAgentStatus } from "./agent-session.js";
import { stringifyBoundedJson } from "./bounded-json.js";
import { calculateContextTokens, estimateContextTokens } from "./compaction/index.js";
import { exportHistoryLimits, readSessionHistoryFile } from "./export-html/history.js";
import type { ContextUsage } from "./extensions/index.js";
import type { ParentPathCursor } from "./history-index.js";
import type { SourceSnapshotRef } from "./request-events.js";
import type { SessionHistoryReadLimits } from "./session-history-index.js";
import {
	applyChildUsageAttributions,
	buildSessionContext,
	type SessionEntry,
	type SessionManager,
} from "./session-manager.js";
import { addAssistantUsage, cloneUsage, emptyUsage, subtractAssistantUsage } from "./usage.js";

/** Resolves a model's context window so disk-only nodes can report utilization. */
export type ContextWindowResolver = (provider: string, modelId: string) => number | undefined;

/**
 * One agent in the context overview: the main session or an RLM (sub-)agent.
 * `ownUsage` excludes descendants; `totalUsage` includes completed descendants, matching /usage.
 */
export interface ContextTreeNode {
	/** "root" for the session itself; sub-xxxx for an RLM child. */
	id: string;
	label: string;
	status: "active" | RlmChildAgentStatus;
	model?: { provider: string; id: string };
	ownUsage: Usage;
	totalUsage: Usage;
	contextUsage?: ContextUsage;
	children: ContextTreeNode[];
}

/** Shared by one overview request, not by concurrent requests or the process. */
export interface ContextTreeRequestLimits extends SessionHistoryReadLimits {
	maxNodes: number;
	maxMetadataBytes: number;
	maxDirectoryEntries: number;
}

class ContextTreeLimitError extends Error {}

/** Small request-local counters and one full-history reduction tail. */
export class ContextTreeRequest {
	readonly limits: Readonly<ContextTreeRequestLimits>;
	private nodes = 0;
	private metadataBytes = 0;
	private directoryEntries = 0;
	private readTail: Promise<void> = Promise.resolve();

	constructor(limits: Partial<ContextTreeRequestLimits> = {}) {
		this.limits = Object.freeze({
			...exportHistoryLimits(limits),
			maxNodes: limits.maxNodes ?? 256,
			maxMetadataBytes: limits.maxMetadataBytes ?? 4 * 1024 * 1024,
			maxDirectoryEntries: limits.maxDirectoryEntries ?? 16_384,
		});
		if (!Object.values(this.limits).every((value) => Number.isSafeInteger(value) && value > 0))
			throw new Error("Invalid context tree request limits");
	}

	admitNode(): void {
		if (this.nodes >= this.limits.maxNodes) throw new ContextTreeLimitError("Context tree node budget exceeded");
		this.nodes++;
	}

	retainMetadata(value: unknown): number {
		let json: string;
		try {
			json = stringifyBoundedJson(value, this.limits.maxMetadataBytes - this.metadataBytes);
		} catch (error) {
			if (error instanceof Error && error.message === "JSON byte limit exceeded")
				throw new ContextTreeLimitError("Context tree metadata byte budget exceeded", { cause: error });
			throw error;
		}
		const bytes = Buffer.byteLength(json);
		this.metadataBytes += bytes;
		return bytes;
	}

	releaseMetadata(bytes: number): void {
		this.metadataBytes -= bytes;
	}

	directoryEntry(): void {
		if (this.directoryEntries >= this.limits.maxDirectoryEntries)
			throw new ContextTreeLimitError("Context tree directory entry budget exceeded");
		this.directoryEntries++;
	}

	read<T>(read: () => Promise<T>): Promise<T> {
		const result = this.readTail.then(read);
		this.readTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}

function treeRequest(limits: Partial<ContextTreeRequestLimits> | ContextTreeRequest): ContextTreeRequest {
	return limits instanceof ContextTreeRequest ? limits : new ContextTreeRequest(limits);
}

function isAssistantEntry(entry: SessionEntry): entry is SessionEntry & {
	type: "message";
	message: AssistantMessage;
} {
	return entry.type === "message" && entry.message.role === "assistant";
}

function readUserMessageText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				typeof block === "object" &&
				block !== null &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}

function compactLabel(text: string, maxLength = 80): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= maxLength) {
		return compact;
	}
	return `${compact.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

/**
 * Usage totals for one agent: `totalUsage` sums the branch's assistant usage
 * (attributed aggregates, so descendants are included), `ownUsage` removes the
 * attributions targeting those assistants. Attribution entries are matched by
 * target across ALL entries, not just the branch: attributions rewrite the
 * target assistant's usage no matter which branch they were appended on, so a
 * fork that keeps the assistant but drops the attribution entry must still
 * subtract it.
 *
 * Totals are deliberately cumulative across compactions: compaction shrinks
 * the model-facing context, not what the session has spent, so assistants
 * dropped from the resolved context still count here.
 */
export function computeOwnAndTotalUsage(
	branch: SessionEntry[],
	allEntries: SessionEntry[],
): { ownUsage: Usage; totalUsage: Usage } {
	const totalUsage = emptyUsage();
	const branchAssistantIds = new Set<string>();
	for (const entry of branch) {
		if (isAssistantEntry(entry)) {
			branchAssistantIds.add(entry.id);
			addAssistantUsage(totalUsage, entry.message.usage);
		} else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
			addAssistantUsage(totalUsage, entry.usage);
		}
	}
	const ownUsage = cloneUsage(totalUsage);
	for (const entry of allEntries) {
		if (entry.type === "child_usage_attributed" && branchAssistantIds.has(entry.targetId)) {
			subtractAssistantUsage(ownUsage, entry.childUsage);
		}
	}
	return { ownUsage, totalUsage };
}

/** Complete bounded snapshot of an explicitly resident Manager, never an index-error fallback.
 * This synchronous reduction runs in the pre-await live-tree capture walk. It never
 * retains a decoded resident snapshot while native/disk work waits for a slot.
 */
export function readResidentContextTreeUsage(
	manager: SessionManager,
	limits: SessionHistoryReadLimits = { maxEntries: 16_384, maxSourceBytes: 64 * 1024 * 1024 },
	availabilityMaxSourceBytes?: number,
): { ownUsage: Usage; totalUsage: Usage; hasPostCompactionUsage?: boolean } {
	const snapshot = manager.materializeResidentHistory(limits);
	const branch = branchEntries(snapshot.entries, snapshot.leafId, availabilityMaxSourceBytes !== undefined);
	if (availabilityMaxSourceBytes !== undefined) {
		if (!Number.isSafeInteger(availabilityMaxSourceBytes) || availabilityMaxSourceBytes <= 0)
			throw new Error("Invalid parent-path materialization limits");
		if (branch.length > 16_384) throw new Error("Parent-path entry budget exceeded");
		let bytes = 0;
		for (const entry of branch) {
			bytes += Buffer.byteLength(stringifyBoundedJson(entry, availabilityMaxSourceBytes - bytes));
		}
	}
	return {
		...computeOwnAndTotalUsage(branch, snapshot.entries),
		...(availabilityMaxSourceBytes === undefined ? {} : { hasPostCompactionUsage: hasPostCompactionUsage(branch) }),
	};
}

/** Detached, complete source usage and its exact captured parent branch. */
export async function readContextTreeUsage(
	manager: SessionManager,
	limits: SessionHistoryReadLimits = { maxEntries: 16_384, maxSourceBytes: 64 * 1024 * 1024 },
	request?: ContextTreeRequest,
	availabilityMaxSourceBytes?: number,
): Promise<
	{ source: SourceSnapshotRef; ownUsage: Usage; totalUsage: Usage; hasPostCompactionUsage?: boolean } | undefined
> {
	if (!manager.supportsCapturedHistoryReads()) return undefined;
	const sourceLimits = request?.limits ?? limits;
	const capturedLimits = { maxEntries: sourceLimits.maxEntries, maxSourceBytes: sourceLimits.maxSourceBytes };
	// The actual source frontier binds NOW, never after waiting for the reduction slot.
	return manager.readSourceHistory((history) => {
		request?.retainMetadata(history.source);
		const reduce = async () => {
			const materialized = await history.materialize(capturedLimits);
			const allEntries = materialized.entries.map(({ entry }) => entry);
			applyChildUsageAttributions(allEntries);
			const byId = new Map(allEntries.map((entry) => [entry.id, entry]));
			const branch: SessionEntry[] = [];
			let cursor: ParentPathCursor | undefined;
			do {
				const page = await history.parentPath({ cursor });
				for (const reference of page.events) {
					const entry = byId.get(reference.id);
					if (!entry) throw new Error("Context-tree parent-path entry source is unavailable");
					branch.push(entry);
				}
				cursor = page.nextCursor ?? undefined;
			} while (cursor);
			let available: boolean | undefined;
			if (availabilityMaxSourceBytes !== undefined) {
				const bootstrap = await history.branchBootstrap();
				available = !bootstrap.latestCompaction;
				const reference = bootstrap.contextUsageAssistant;
				if (bootstrap.latestCompaction && reference) {
					const updates = await history.branchContext.contextUpdates({
						kind: "assistant-usage",
						targetId: reference.id,
					});
					const bytes =
						reference.locator.length + updates.refs.reduce((sum, update) => sum + update.locator.length, 0);
					if (bytes > availabilityMaxSourceBytes) throw new Error("Context usage source byte budget exceeded");
					const assistant = byId.get(reference.id);
					if (!assistant || !isAssistantEntry(assistant))
						throw new Error("Context usage assistant source is unavailable");
					// Full-source ordered projection above includes off-branch attributions.
					available = calculateContextTokens(assistant.message.usage) > 0;
				}
			}
			const usage = {
				...computeOwnAndTotalUsage(branch, allEntries),
				...(available === undefined ? {} : { hasPostCompactionUsage: available }),
			};
			request?.retainMetadata(usage);
			return { source: history.source, ...usage };
		};
		return request ? request.read(reduce) : reduce();
	});
}

function hasPostCompactionUsage(branch: SessionEntry[]): boolean {
	let boundary = -1;
	for (let index = branch.length - 1; index >= 0; index--) {
		if (branch[index].type === "compaction") {
			boundary = index;
			break;
		}
	}
	if (boundary < 0) return true;
	for (let index = branch.length - 1; index > boundary; index--) {
		const entry = branch[index];
		if (!isAssistantEntry(entry)) continue;
		if (entry.message.stopReason !== "aborted" && entry.message.stopReason !== "error")
			return calculateContextTokens(entry.message.usage) > 0;
	}
	return false;
}

/**
 * Current context utilization from persisted entries, mirroring
 * AgentSession.getContextUsage(): unknown right after a compaction until the
 * next assistant response, otherwise the last assistant usage plus an
 * estimate for trailing messages (tool results, queued user input) that have
 * not hit the model yet.
 */
function computeContextUsageFromEntries(
	allEntries: SessionEntry[],
	branch: SessionEntry[],
	contextWindow: number | undefined,
): ContextUsage | undefined {
	if (!contextWindow || contextWindow <= 0) {
		return undefined;
	}

	if (!hasPostCompactionUsage(branch)) {
		return { tokens: null, contextWindow, percent: null };
	}

	const estimate = estimateContextTokens(buildSessionContext(allEntries).messages);
	if (estimate.tokens <= 0) {
		return undefined;
	}
	return { tokens: estimate.tokens, contextWindow, percent: (estimate.tokens / contextWindow) * 100 };
}

/**
 * Entries on the current branch, root to leaf, mirroring
 * SessionManager.getBranch(): the leaf is the last appended entry and the
 * branch is its parentId chain. Keeps forked/abandoned paths out of usage
 * sums so disk nodes match what a live session would report.
 */
function branchEntries(entries: SessionEntry[], leafId?: string | null, strict = false): SessionEntry[] {
	if (entries.length === 0) {
		if (strict && leafId !== undefined && leafId !== null) throw new Error("Parent path lineage is unresolved");
		return [];
	}
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const branch: SessionEntry[] = [];
	const seen = new Set<string>();
	let current: SessionEntry | undefined =
		leafId === undefined ? entries[entries.length - 1] : leafId === null ? undefined : byId.get(leafId);
	if (strict && leafId !== undefined && leafId !== null && !current)
		throw new Error("Parent path lineage is unresolved");
	while (current && !seen.has(current.id)) {
		seen.add(current.id);
		branch.push(current);
		const parentId = current.parentId;
		const hasParent = strict ? parentId !== null : !!parentId;
		current = hasParent ? byId.get(parentId!) : undefined;
		if (strict && hasParent && !current) throw new Error("Parent path lineage is unresolved");
	}
	if (strict && current) throw new Error("Parent path lineage is unresolved");
	return branch.reverse();
}

/**
 * Terminal status for a persisted child, inferred from how its last assistant
 * turn ended: errored and aborted runs should not render as successful.
 */
function statusFromBranch(entries: SessionEntry[]): "done" | "error" | "cancelled" {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!isAssistantEntry(entry)) {
			continue;
		}
		if (entry.message.stopReason === "error") {
			return "error";
		}
		if (entry.message.stopReason === "aborted") {
			return "cancelled";
		}
		return "done";
	}
	return "done";
}

/** Stream names; opening/reading errors keep the caller's existing policy. */
function visitDirectory(dirPath: string, request: ContextTreeRequest, visit: (name: string) => void): void {
	const dir = opendirSync(dirPath);
	try {
		for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) {
			request.directoryEntry();
			visit(entry.name);
		}
	} catch (error) {
		try {
			dir.closeSync();
		} catch (closeError) {
			throw new AggregateError([error, closeError], "Context tree directory read and close failed");
		}
		throw error;
	}
	dir.closeSync();
}

// readdirSync used UTF8 lexical order; retain its stable mtime-tie ordering.
function comparePaths(a: string, b: string): number {
	return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

function findSessionFile(dir: string, request: ContextTreeRequest): { path: string; bytes: number } | undefined {
	let newest: { path: string; mtime: number; bytes: number } | undefined;
	try {
		visitDirectory(dir, request, (name) => {
			if (!name.endsWith(".jsonl")) return;
			const path = join(dir, name);
			let mtime: number;
			try {
				mtime = statSync(path).mtime.getTime();
			} catch {
				return; // Skip unreadable files.
			}
			if (!newest || mtime > newest.mtime || (mtime === newest.mtime && comparePaths(path, newest.path) < 0)) {
				if (newest) request.releaseMetadata(newest.bytes);
				newest = undefined;
				const bytes = request.retainMetadata(path);
				newest = { path, mtime, bytes };
			}
		});
		return newest;
	} catch (error) {
		if (newest) request.releaseMetadata(newest.bytes);
		throw error;
	}
}

function listChildSessionDirs(rlmSessionDir: string, request: ContextTreeRequest): { paths: string[]; bytes: number } {
	const paths: string[] = [];
	let bytes = 0;
	try {
		visitDirectory(rlmSessionDir, request, (name) => {
			if (!name.startsWith("sub-")) return;
			const path = join(rlmSessionDir, name);
			try {
				if (!statSync(path).isDirectory()) return;
			} catch {
				return;
			}
			bytes += request.retainMetadata(path);
			paths.push(path);
		});
	} catch (error) {
		request.releaseMetadata(bytes);
		if (error instanceof ContextTreeLimitError || error instanceof AggregateError) throw error;
		return { paths: [], bytes: 0 };
	}
	paths.sort(comparePaths).sort((a, b) => {
		try {
			return statSync(a).mtime.getTime() - statSync(b).mtime.getTime();
		} catch {
			return 0;
		}
	});
	return { paths, bytes };
}

/**
 * Build a context node for a completed RLM child from its persisted session
 * dir (sub-xxxx/). Children that already attributed grandchild usage carry the
 * aggregate on their assistant messages (applyChildUsageAttributions), so own
 * usage is recovered by subtracting the attribution entries. Returns undefined
 * when the dir holds no readable session.
 */
async function readContextTreeChildNodeFromDisk(
	childSessionDir: string,
	sessionFile: string,
	resolveContextWindow: ContextWindowResolver,
	request: ContextTreeRequest,
	identity?: Pick<ContextTreeNode, "id" | "label" | "status">,
): Promise<ContextTreeNode | undefined> {
	const allEntries = (await readSessionHistoryFile(sessionFile, request.limits)).filter(
		(entry): entry is SessionEntry => entry.type !== "session",
	);
	const branch = branchEntries(allEntries);
	if (branch.length === 0) {
		return undefined;
	}

	const { ownUsage, totalUsage } = computeOwnAndTotalUsage(branch, allEntries);

	let model: { provider: string; id: string } | undefined;
	for (const entry of branch) {
		if (entry.type === "model_change") {
			model = { provider: entry.provider, id: entry.modelId };
		}
	}

	let label = "";
	for (const entry of branch) {
		if (entry.type === "message" && entry.message.role === "user") {
			label = compactLabel(readUserMessageText(entry.message.content));
			if (label) {
				break;
			}
		}
	}

	const contextWindow = model ? resolveContextWindow(model.provider, model.id) : undefined;

	const metadata = {
		...(identity ?? {
			id: basename(childSessionDir),
			label: label || "child agent",
			status: statusFromBranch(branch),
		}),
		model,
		ownUsage,
		totalUsage,
		contextUsage: computeContextUsageFromEntries(allEntries, branch, contextWindow),
	};
	// A registered run's identity was already admitted by its live parent.
	request.retainMetadata(identity ? { model, ownUsage, totalUsage, contextUsage: metadata.contextUsage } : metadata);
	return { ...metadata, children: [] };
}

/** Complete or refuse, sharing the request's slot and counters with descendants.
 * Internal identity is an already-admitted registered run, including its empty placeholder.
 */
export async function loadContextTreeChildFromDisk(
	childSessionDir: string,
	resolveContextWindow: ContextWindowResolver,
	limits: Partial<ContextTreeRequestLimits> | ContextTreeRequest = {},
	identity?: Pick<ContextTreeNode, "id" | "label" | "status">,
): Promise<ContextTreeNode | undefined> {
	const request = treeRequest(limits);
	const directoryBytes = request.retainMetadata(childSessionDir);
	let sessionFile: { path: string; bytes: number } | undefined;
	let node: ContextTreeNode | undefined;
	try {
		sessionFile = findSessionFile(childSessionDir, request);
		if (sessionFile && existsSync(sessionFile.path)) {
			// A header-only history still consumes one bounded source admission.
			if (!identity) request.admitNode();
			node = await request.read(() =>
				readContextTreeChildNodeFromDisk(
					childSessionDir,
					sessionFile!.path,
					resolveContextWindow,
					request,
					identity,
				),
			);
		}
	} finally {
		if (sessionFile) request.releaseMetadata(sessionFile.bytes);
		request.releaseMetadata(directoryBytes);
	}
	if (node) {
		// The full source has been reduced and the serial slot released before recursion.
		node.children = await loadContextTreeChildrenFromDisk(childSessionDir, resolveContextWindow, undefined, request);
	} else if (identity) {
		const usage = { ownUsage: emptyUsage(), totalUsage: emptyUsage() };
		request.retainMetadata(usage);
		node = { ...identity, ...usage, children: [] };
	}
	return node;
}

/** Persisted children, in existing directory order, excluding already represented live IDs. */
export async function loadContextTreeChildrenFromDisk(
	rlmSessionDir: string | undefined,
	resolveContextWindow: ContextWindowResolver,
	skipIds?: ReadonlySet<string>,
	limits: Partial<ContextTreeRequestLimits> | ContextTreeRequest = {},
): Promise<ContextTreeNode[]> {
	const request = treeRequest(limits);
	const skippedIds = new Set<string>();
	let metadataBytes = 0;
	try {
		// A caller-provided skip set is bounded before copying, too.
		if (skipIds && skipIds.size > request.limits.maxDirectoryEntries)
			throw new ContextTreeLimitError("Context tree directory entry budget exceeded");
		for (const id of skipIds ?? []) {
			metadataBytes += request.retainMetadata(id);
			skippedIds.add(id);
		}
		if (!rlmSessionDir || !existsSync(rlmSessionDir)) return [];
		metadataBytes += request.retainMetadata(rlmSessionDir);
		const directories = listChildSessionDirs(rlmSessionDir, request);
		metadataBytes += directories.bytes;
		const nodes: ContextTreeNode[] = [];
		for (const childDir of directories.paths) {
			if (skippedIds.has(basename(childDir))) continue;
			const node = await loadContextTreeChildFromDisk(childDir, resolveContextWindow, request);
			if (node) nodes.push(node);
		}
		return nodes;
	} finally {
		request.releaseMetadata(metadataBytes);
	}
}
