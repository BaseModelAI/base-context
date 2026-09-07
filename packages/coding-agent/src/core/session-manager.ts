import { isDeepStrictEqual } from "node:util";
import type { AgentMessage, FinalizedToolExchange, ToolInvocation } from "@ponythewhite/base-context-agent";
import type {
	AssistantMessage,
	ImageContent,
	Message,
	ServiceTier,
	TextContent,
	Usage,
} from "@ponythewhite/base-context-ai";
import { randomUUID } from "crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "fs";
import { stat } from "fs/promises";
import { basename, dirname, join, resolve } from "path";
import { v7 as uuidv7 } from "uuid";
import { getAgentDir as getDefaultAgentDir, getSessionsDir } from "../config.js";
import { assertProductStatePath } from "../runtime-paths.js";
import { captureGitContext, type GitContext, gitContextsEqual } from "../utils/git.js";
import { stringifyBoundedJson } from "./bounded-json.js";
import type { CanonicalPayloadFragment } from "./canonical-payload-parts.js";
import type {
	ContextManifestOptions,
	ContextManifestPage,
	HistoryIndex,
	HistoryIndexPage,
	HistoryPayloadReadOptions,
	IndexedSourceEvent,
	TaskEvidenceOptions,
	TaskEvidencePage,
} from "./history-index.js";
import type { JournalFrameRetention } from "./journal-frame.js";
import { type BashExecutionMessage, type CustomMessage, createCompactionSummaryMessage } from "./messages.js";
import type { NativeRequestEvent, SourceSnapshotRef } from "./request-events.js";
import { orderContextToolResults, sessionEntryMessage } from "./session-context-messages.js";
import type { NativeEntryOrigin } from "./session-entry-origin.js";
import {
	type BoundHistoryReadSink,
	type BoundSessionRequestSink,
	createBranchHistoryReadView,
	createSessionHistoryReadScope,
	type HistoryReadQuery,
	type MaterializedSessionHistory,
	SessionHistoryIndex,
	type SessionHistoryReadLimits,
	type SessionHistoryReadScope,
	type SessionHistoryReadView,
} from "./session-history-index.js";
import {
	SESSION_JOURNAL_MAX_RECORD_BYTES as MAX_SESSION_RECORD_BYTES,
	SessionJournalOwner,
} from "./session-journal-owner.js";
import { readSessionJournal, readSessionJournalHeader, SessionJournalDecoder } from "./session-journal-reader.js";
import {
	addAssistantUsage,
	cloneUsage,
	emptyUsage,
	type SessionUsageSummary,
	sessionUsageSummaryFrom,
	subtractAssistantUsage,
} from "./usage.js";

export const CURRENT_SESSION_VERSION = 3;
const SESSION_LIST_SEARCH_TEXT_MAX_CHARS = 64 * 1024;
const SESSION_LIST_PARSE_MAX_LINE_CHARS = 1024 * 1024;
const SESSION_LIST_LARGE_MESSAGE_PREVIEW_MAX_CHARS = 256;
const SESSION_ASYNC_PARSE_YIELD_BYTES = 4 * 1024 * 1024;

// Entry types that can represent user intent (vs. daemon bookkeeping like
// session_state/agent_status/git_state/child_usage_attributed). Used by
// hasUserContent to decide whether a message-less draft is safe to discard.
const CONTENT_ENTRY_TYPES = new Set([
	"message",
	"custom_message",
	"custom",
	"model_change",
	"thinking_level_change",
	"service_tier_change",
	"session_info",
	"label",
	"compaction",
	"branch_summary",
	// Effect/accounting facts must not disappear with a message-less draft.
	"tool_intent",
	"request",
]);

function realpathIfPresent(path: string): string {
	try {
		return realpathSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return path;
		throw error;
	}
}

export interface SessionHeader {
	type: "session";
	version?: number; // v1 sessions don't have this
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
	rlmDepth?: number;
	git?: GitContext;
}

export interface NewSessionOptions {
	id?: string;
	parentSession?: string;
	rlmDepth?: number;
}

export type SessionPersistListener = (sessionFile: string) => void;

export interface SessionEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
	/** Native admission/control metadata, never read from the entry's arbitrary data payload. */
	nativeOrigin?: NativeEntryOrigin;
}

export type SessionExecutionEvidence = Omit<FinalizedToolExchange, "result" | "originalInput" | "executedInput"> &
	({ invocationId: string } | { originalInput: unknown; executedInput?: unknown });

export interface SessionMessageEntry extends SessionEntryBase {
	type: "message";
	message: AgentMessage;
	/** Native execution evidence belongs to this result, not a second transcript. */
	execution?: SessionExecutionEvidence;
}

export interface ToolIntentEntry extends SessionEntryBase {
	type: "tool_intent";
	invocation: ToolInvocation;
}

export interface RequestJournalEntry extends SessionEntryBase {
	type: "request";
	request: NativeRequestEvent;
}

type PrivateSessionEntry = ToolIntentEntry | RequestJournalEntry;

type AssistantSessionMessageEntry = SessionMessageEntry & { message: AssistantMessage };

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
	type: "thinking_level_change";
	thinkingLevel: string;
}

export interface ServiceTierChangeEntry extends SessionEntryBase {
	type: "service_tier_change";
	serviceTier: ServiceTier;
}

export interface ModelChangeEntry extends SessionEntryBase {
	type: "model_change";
	provider: string;
	modelId: string;
}

export interface CompactionEntry<T = unknown> extends SessionEntryBase {
	type: "compaction";
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details?: T;
	fromHook?: boolean;
	customInstructions?: string;
	usage?: Usage;
}

export interface BranchSummaryEntry<T = unknown> extends SessionEntryBase {
	type: "branch_summary";
	fromId: string;
	summary: string;
	details?: T;
	fromHook?: boolean;
	usage?: Usage;
}

export interface CustomEntry<T = unknown> extends SessionEntryBase {
	type: "custom";
	customType: string;
	data?: T;
}

/**
 * Records usage folded into a parent assistant message after an RLM child run.
 * The child usage is kept separately so audit/UI code can explain why the
 * parent turn's aggregate usage exceeds the parent model response itself.
 */
export interface ChildUsageAttributionEntry extends SessionEntryBase {
	type: "child_usage_attributed";
	targetId: string;
	childUsage: Usage;
	aggregateUsage: Usage;
	origin?: "spawn_task" | "agent_message" | "direct_user";
}

export interface LabelEntry extends SessionEntryBase {
	type: "label";
	targetId: string;
	label: string | undefined;
}

export interface SessionInfoEntry extends SessionEntryBase {
	type: "session_info";
	name?: string;
}

export type SessionStateStatus = "active" | "archived" | "crash";

export interface SessionState {
	status: SessionStateStatus;
}

export interface SessionStateEntry extends SessionEntryBase {
	type: "session_state";
	state: SessionState;
}

export type AgentTaskState = "needs_input" | "completed";

export interface AgentStatus {
	summary: string;
	taskState?: AgentTaskState;
	basedOnMessageCount: number;
}

export interface AgentStatusEntry extends SessionEntryBase {
	type: "agent_status";
	status: AgentStatus;
}

export interface GitStateEntry extends SessionEntryBase {
	type: "git_state";
	git: GitContext;
}

export interface CustomMessageEntry<T = unknown> extends SessionEntryBase {
	type: "custom_message";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	details?: T;
	display: boolean;
}

export type SessionEntry =
	| SessionMessageEntry
	| ToolIntentEntry
	| RequestJournalEntry
	| ThinkingLevelChangeEntry
	| ServiceTierChangeEntry
	| ModelChangeEntry
	| CompactionEntry
	| BranchSummaryEntry
	| CustomEntry
	| ChildUsageAttributionEntry
	| CustomMessageEntry
	| LabelEntry
	| SessionInfoEntry
	| SessionStateEntry
	| AgentStatusEntry
	| GitStateEntry;

export type FileEntry = SessionHeader | SessionEntry;

export interface SessionTreeFlatNode {
	entry: Exclude<SessionEntry, PrivateSessionEntry>;
	label?: string;
	labelTimestamp?: string;
}

export interface SessionTreeNode extends SessionTreeFlatNode {
	children: SessionTreeNode[];
}

export interface ResidentSessionHistory {
	header: SessionHeader | null;
	entries: SessionEntry[];
	/** Per-row lowering metadata, outside the unchanged entry payloads. */
	retentions: (JournalFrameRetention | null)[];
	leafId: string | null;
	/** Serialized header/entry JSON bytes, not physical frame bytes or heap size. */
	sourceBytes: number;
}

export interface SessionContext {
	messages: AgentMessage[];
	thinkingLevel: string;
	serviceTier: ServiceTier;
	model: { provider: string; modelId: string } | null;
}

export interface SessionInfo {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	state?: SessionState;
	parentSessionPath?: string;
	rlmDepth: number;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
	agentStatus?: AgentStatus;
	usage?: SessionUsageSummary;
}

export type ReadonlySessionManager = Pick<
	SessionManager,
	| "getCwd"
	| "getSessionDir"
	| "getSessionId"
	| "getSessionFile"
	| "getLeafId"
	| "getLeafEntry"
	| "getEntry"
	| "getEntryRetention"
	| "supportsCapturedHistoryReads"
	| "materializeResidentHistory"
	| "readBranchHistory"
	| "readSourceHistory"
	| "materializeBranchHistory"
	| "materializeSourceHistory"
	| "getLabel"
	| "getBranch"
	| "getHeader"
	| "getEntries"
	| "getCompactionCount"
	| "getTree"
	| "getSessionName"
>;

function createSessionId(): string {
	return uuidv7();
}

function getSessionFilePath(sessionDir: string, sessionId: string): string {
	return join(sessionDir, `${sessionId}.jsonl`);
}

function createUniqueSessionFileTarget(sessionDir: string): { sessionId: string; sessionFile: string } {
	for (let i = 0; i < 100; i++) {
		const sessionId = createSessionId();
		const sessionFile = getSessionFilePath(sessionDir, sessionId);
		if (!existsSync(sessionFile)) {
			return { sessionId, sessionFile };
		}
	}
	throw new Error("Unable to create a unique session file");
}

export function getSessionArtifactsRoot(sessionDir: string): string {
	return join(dirname(sessionDir), "session-artifacts");
}

export function getSessionArtifactPath(sessionDir: string, sessionId: string): string {
	return join(getSessionArtifactsRoot(sessionDir), sessionId);
}

export function getSessionArtifactPathForFile(sessionFile: string, sessionId?: string): string {
	return getSessionArtifactPath(dirname(sessionFile), sessionId ?? basename(sessionFile).replace(/\.jsonl$/, ""));
}

function generateId(byId: { has(id: string): boolean }): string {
	for (let i = 0; i < 100; i++) {
		const id = randomUUID().slice(0, 8);
		if (!byId.has(id)) return id;
	}
	return randomUUID();
}

function migrateV1ToV2(entries: FileEntry[]): void {
	const ids = new Set<string>();
	let prevId: string | null = null;

	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 2;
			continue;
		}

		entry.id = generateId(ids);
		entry.parentId = prevId;
		prevId = entry.id;

		if (entry.type === "compaction") {
			const comp = entry as CompactionEntry & { firstKeptEntryIndex?: number };
			if (typeof comp.firstKeptEntryIndex === "number") {
				const targetEntry = entries[comp.firstKeptEntryIndex];
				if (targetEntry && targetEntry.type !== "session") {
					comp.firstKeptEntryId = targetEntry.id;
				}
				delete comp.firstKeptEntryIndex;
			}
		}
	}
}

function migrateV2ToV3(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 3;
			continue;
		}

		if (entry.type === "message") {
			const msgEntry = entry as SessionMessageEntry;
			if (msgEntry.message && (msgEntry.message as { role: string }).role === "hookMessage") {
				(msgEntry.message as { role: string }).role = "custom";
			}
		}
	}
}

function migrateToCurrentVersion(entries: FileEntry[]): boolean {
	const header = entries.find((e) => e.type === "session") as SessionHeader | undefined;
	const version = header?.version ?? 1;

	if (version >= CURRENT_SESSION_VERSION) return false;

	if (version < 2) migrateV1ToV2(entries);
	if (version < 3) migrateV2ToV3(entries);

	return true;
}

export function migrateSessionEntries(entries: FileEntry[]): void {
	migrateToCurrentVersion(entries);
}

export function parseSessionEntries(content: string): FileEntry[] {
	return finalizeLoadedEntries(parseEntriesFromBuffer(Buffer.from(content)));
}

function applyChildUsageAttributions(entries: FileEntry[]): void {
	const assistantEntriesById = new Map<string, AssistantSessionMessageEntry>();
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			assistantEntriesById.set(entry.id, entry as AssistantSessionMessageEntry);
		}
	}

	for (const entry of entries) {
		if (entry.type !== "child_usage_attributed") continue;
		const target = assistantEntriesById.get(entry.targetId);
		if (!target) continue;
		target.message.usage = cloneUsage(entry.aggregateUsage);
	}
}

export function getLatestCompactionEntry(entries: SessionEntry[]): CompactionEntry | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") {
			return entries[i] as CompactionEntry;
		}
	}
	return null;
}

export function buildSessionContext(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionContext {
	if (!byId) {
		byId = new Map<string, SessionEntry>();
		for (const entry of entries) {
			byId.set(entry.id, entry);
		}
	}

	let leaf: SessionEntry | undefined;
	if (leafId === null) {
		return { messages: [], thinkingLevel: "off", serviceTier: "default", model: null };
	}
	if (leafId) {
		leaf = byId.get(leafId);
	}
	if (!leaf) {
		leaf = entries[entries.length - 1];
	}

	if (!leaf) {
		return { messages: [], thinkingLevel: "off", serviceTier: "default", model: null };
	}

	// push+reverse, not unshift-per-entry: unshift is O(n), making this O(n^2) on long sessions.
	const path: SessionEntry[] = [];
	let current: SessionEntry | undefined = leaf;
	while (current) {
		path.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	path.reverse();

	let thinkingLevel = "off";
	let serviceTier: ServiceTier = "default";
	let model: { provider: string; modelId: string } | null = null;
	let compaction: CompactionEntry | null = null;

	for (const entry of path) {
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel;
		} else if (entry.type === "service_tier_change") {
			serviceTier = entry.serviceTier;
		} else if (entry.type === "model_change") {
			model = { provider: entry.provider, modelId: entry.modelId };
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			model = { provider: entry.message.provider, modelId: entry.message.model };
		} else if (entry.type === "compaction") {
			compaction = entry;
		}
	}

	// Build messages and collect corresponding entries
	// When there's a compaction, model context remains summary-first while the
	// summary records where clients should present it among retained messages.
	const messages: AgentMessage[] = [];

	const appendMessage = (entry: SessionEntry, target = messages) => {
		const message = sessionEntryMessage(entry);
		if (message) target.push(message);
	};

	if (compaction) {
		const compactionIdx = path.findIndex((e) => e.type === "compaction" && e.id === compaction.id);

		// Collect kept messages (before compaction, starting from firstKeptEntryId).
		// The context remains summary-first for the model; retainedMessageCount records
		// the exact chronological presentation boundary for clients.
		const retainedMessages: AgentMessage[] = [];
		let foundFirstKept = false;
		for (let i = 0; i < compactionIdx; i++) {
			const entry = path[i];
			if (entry.id === compaction.firstKeptEntryId) {
				foundFirstKept = true;
			}
			if (foundFirstKept) {
				appendMessage(entry, retainedMessages);
			}
		}

		messages.push(
			createCompactionSummaryMessage(
				compaction.summary,
				compaction.tokensBefore,
				compaction.timestamp,
				compaction.customInstructions,
				retainedMessages.length,
			),
			...retainedMessages,
		);

		for (let i = compactionIdx + 1; i < path.length; i++) {
			const entry = path[i];
			appendMessage(entry);
		}
	} else {
		for (const entry of path) {
			appendMessage(entry);
		}
	}

	orderContextToolResults(messages);
	return { messages, thinkingLevel, serviceTier, model };
}

export function getDefaultSessionDir(_cwd: string, agentDir: string = getDefaultAgentDir()): string {
	return getSessionsDir(agentDir);
}

// Actual reader/import control metadata, never a field in the entry payload.
const entryRetentions = new WeakMap<FileEntry, JournalFrameRetention>();

function withEntryRetention<T extends FileEntry>(entry: T, retention?: JournalFrameRetention): T {
	if (retention !== undefined) entryRetentions.set(entry, retention);
	return entry;
}

function sessionFileEntry(value: unknown, retention?: JournalFrameRetention): FileEntry {
	if (!value || typeof value !== "object" || !("type" in value) || typeof value.type !== "string")
		throw new Error("Invalid session journal entry");
	return withEntryRetention(value as FileEntry, retention);
}

function parseEntriesFromBuffer(buffer: Buffer): FileEntry[] {
	const decoder = new SessionJournalDecoder();
	const entries: FileEntry[] = [];
	let start = 0;
	while (start < buffer.length) {
		const end = buffer.indexOf(0x0a, start);
		if (end === -1) break; // Only exclusive recovery may change an incomplete tail.
		const record = decoder.decode(buffer.subarray(start, end + 1));
		if (record) entries.push(sessionFileEntry(record.entry, record.retention));
		start = end + 1;
	}
	return entries;
}

function finalizeLoadedEntries(entries: FileEntry[]): FileEntry[] {
	if (entries.length === 0) return entries;
	const header = entries[0];
	if (header.type !== "session" || typeof header.id !== "string")
		throw new Error("Session source has no valid header");
	applyChildUsageAttributions(entries);
	return entries;
}

export function loadEntriesFromFile(filePath: string): FileEntry[] {
	if (!existsSync(filePath)) return [];
	return finalizeLoadedEntries(parseEntriesFromBuffer(readFileSync(filePath)));
}

export async function loadEntriesFromFileAsync(
	filePath: string,
	_options: { streamThresholdBytes?: number } = {},
): Promise<FileEntry[]> {
	if (!existsSync(filePath)) return [];
	const entries: FileEntry[] = [];
	let bytesSinceYield = 0;
	for await (const record of readSessionJournal(filePath)) {
		entries.push(sessionFileEntry(record.entry, record.retention));
		bytesSinceYield += Buffer.byteLength(record.json);
		if (bytesSinceYield >= SESSION_ASYNC_PARSE_YIELD_BYTES) {
			bytesSinceYield = 0;
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
	}
	return finalizeLoadedEntries(entries);
}

function readSessionHeader(filePath: string): Partial<SessionHeader> | undefined {
	return readSessionJournalHeader(filePath) as Partial<SessionHeader> | undefined;
}

function isValidRlmDepth(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function resolveSessionRlmDepth(
	header: { rlmDepth?: number; parentSession?: string },
	sessionPath: string,
): number {
	return resolveLegacySessionRlmDepth(header, sessionPath, new Set()) ?? legacyChildDepthFromPath(sessionPath);
}

function resolveLegacySessionRlmDepth(
	header: { rlmDepth?: number; parentSession?: string },
	sessionPath: string,
	visitedPaths: Set<string>,
): number | undefined {
	if (isValidRlmDepth(header.rlmDepth)) {
		return header.rlmDepth;
	}
	if (!header.parentSession) {
		return 0;
	}

	const resolvedSessionPath = resolve(sessionPath);
	if (visitedPaths.has(resolvedSessionPath)) {
		return undefined;
	}
	visitedPaths.add(resolvedSessionPath);

	const pathDepth = legacyChildDepthFromPath(sessionPath);
	const parentSessionPath = resolve(dirname(sessionPath), header.parentSession);
	try {
		const parentHeader = readSessionHeader(parentSessionPath);
		if (parentHeader) {
			const parentDepth = resolveLegacySessionRlmDepth(parentHeader, parentSessionPath, visitedPaths);
			if (parentDepth !== undefined) {
				return pathDepth > 0 ? parentDepth + 1 : parentDepth;
			}
		}
	} catch {
		// Fall back to artifact ancestry for unavailable or invalid legacy parents.
	} finally {
		visitedPaths.delete(resolvedSessionPath);
	}
	return pathDepth;
}

function legacyChildDepthFromPath(sessionPath: string): number {
	let depth = 0;
	for (const segment of dirname(sessionPath)
		.split(/[\\/]+/)
		.reverse()) {
		if (!/^sub-[0-9a-f]{8}$/.test(segment)) {
			break;
		}
		depth += 1;
	}
	return depth;
}

function deriveChildRlmDepth(parentHeader: Partial<SessionHeader> | undefined): number | undefined {
	const depth = parentHeader?.rlmDepth;
	return isValidRlmDepth(depth) && depth < Number.MAX_SAFE_INTEGER ? depth + 1 : undefined;
}

function rootRlmDepthFromEnv(): number {
	const value = process.env.BASE_CONTEXT_RLM_DEPTH;
	if (value === undefined || value === "") {
		return 0;
	}
	const parsed = Number(value);
	if (!/^\d+$/.test(value) || !isValidRlmDepth(parsed)) {
		throw new Error("BASE_CONTEXT_RLM_DEPTH must be a non-negative integer");
	}
	return parsed;
}

function isValidSessionFile(filePath: string): boolean {
	try {
		const header = readSessionHeader(filePath);
		return header?.type === "session" && typeof header.id === "string";
	} catch {
		return false;
	}
}

function sessionCatalogDirectories(sessionDir: string): string[] {
	const directories = [sessionDir];
	if (existsSync(sessionDir)) {
		for (const entry of readdirSync(sessionDir, { withFileTypes: true })) {
			if (entry.isDirectory() && /^--.+--$/.test(entry.name)) directories.push(join(sessionDir, entry.name));
		}
	}
	// Older default installations also stored direct JSONLs beside the sessions directory.
	if (resolve(sessionDir) === resolve(getSessionsDir())) directories.push(getDefaultAgentDir());
	return directories;
}

function sessionCatalogFiles(sessionDir: string): string[] {
	const paths: string[] = [];
	for (const directory of sessionCatalogDirectories(sessionDir)) {
		if (!existsSync(directory)) continue;
		for (const entry of readdirSync(directory)) if (entry.endsWith(".jsonl")) paths.push(join(directory, entry));
	}
	return paths;
}

export function findMostRecentSession(sessionDir: string): string | null {
	try {
		const files = sessionCatalogFiles(sessionDir)
			.filter(isValidSessionFile)
			.map((path) => ({ path, mtime: statSync(path).mtime }))
			.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

		return files[0]?.path || null;
	} catch {
		return null;
	}
}

function normalizeCwd(cwd: string): string {
	return resolve(cwd);
}

function sessionInfoMatchesCwd(session: SessionInfo, cwd: string): boolean {
	return !!session.cwd && normalizeCwd(session.cwd) === normalizeCwd(cwd);
}

function sessionHeaderMatchesCwd(header: Partial<SessionHeader> | undefined, cwd: string): boolean {
	return (
		header?.type === "session" &&
		typeof header.id === "string" &&
		typeof header.cwd === "string" &&
		normalizeCwd(header.cwd) === normalizeCwd(cwd)
	);
}

export function findMostRecentSessionForCwd(sessionDir: string, cwd: string): string | null {
	try {
		const files = sessionCatalogFiles(sessionDir)
			.map((path) => {
				try {
					const header = readSessionHeader(path);
					if (!sessionHeaderMatchesCwd(header, cwd)) {
						return undefined;
					}
					return { path, mtime: statSync(path).mtime };
				} catch {
					return undefined;
				}
			})
			.filter((entry): entry is { path: string; mtime: Date } => entry !== undefined)
			.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

		return files[0]?.path || null;
	} catch {
		return null;
	}
}

function isMessageWithContent(message: AgentMessage): message is Message {
	return typeof (message as Message).role === "string" && "content" in message;
}

function extractTextContent(message: Message): string {
	const content = message.content;
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join(" ");
}

function normalizeSessionStateStatus(value: unknown): SessionStateStatus | undefined {
	if (value === "active" || value === "archived" || value === "crash") {
		return value;
	}
	if (value === "hidden" || value === "sleep") {
		return "archived";
	}
	return undefined;
}

function updateLastActivityTime(lastActivityTime: number | undefined, entry: FileEntry): number | undefined {
	if (entry.type !== "message") {
		return lastActivityTime;
	}

	const message = (entry as SessionMessageEntry).message;
	if (!isMessageWithContent(message)) {
		return lastActivityTime;
	}
	if (message.role !== "user" && message.role !== "assistant") {
		return lastActivityTime;
	}

	const msgTimestamp = (message as { timestamp?: number }).timestamp;
	if (typeof msgTimestamp === "number") {
		return Math.max(lastActivityTime ?? 0, msgTimestamp);
	}

	const entryTimestamp = (entry as SessionEntryBase).timestamp;
	if (typeof entryTimestamp === "string") {
		const t = new Date(entryTimestamp).getTime();
		if (!Number.isNaN(t)) {
			return Math.max(lastActivityTime ?? 0, t);
		}
	}

	return lastActivityTime;
}

function getSessionModifiedDateFromLastActivity(
	lastActivityTime: number | undefined,
	header: SessionHeader,
	statsMtime: Date,
): Date {
	if (typeof lastActivityTime === "number" && lastActivityTime > 0) {
		return new Date(lastActivityTime);
	}

	const headerTime = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : NaN;
	return !Number.isNaN(headerTime) ? new Date(headerTime) : statsMtime;
}

function appendCappedSearchText(current: string, text: string): string {
	if (!text || current.length >= SESSION_LIST_SEARCH_TEXT_MAX_CHARS) {
		return current;
	}
	const next = current ? ` ${text}` : text;
	return current + next.slice(0, SESSION_LIST_SEARCH_TEXT_MAX_CHARS - current.length);
}

function looksLikeMessageEntry(line: string): boolean {
	return line.includes('"type":"message"') || line.includes('"type": "message"');
}

function extractJsonStringPropertyPrefix(
	text: string,
	propertyName: string,
	maxChars: number,
	startIndex = 0,
): string | undefined {
	const propertyIndex = text.indexOf(`"${propertyName}"`, startIndex);
	if (propertyIndex < 0) {
		return undefined;
	}
	let index = propertyIndex + propertyName.length + 2;
	while (index < text.length && /\s/.test(text[index] ?? "")) index++;
	if (text[index] !== ":") {
		return undefined;
	}
	index++;
	while (index < text.length && /\s/.test(text[index] ?? "")) index++;
	if (text[index] !== '"') {
		return undefined;
	}
	index++;

	let result = "";
	let escaped = false;
	for (; index < text.length && result.length < maxChars; index++) {
		const char = text[index];
		if (escaped) {
			result += char;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (char === '"') {
			break;
		}
		result += char;
	}
	return result;
}

function extractOversizedMessageSummary(line: string): {
	role?: string;
	timestamp?: number;
	textPreview?: string;
} {
	const timestampText = extractJsonStringPropertyPrefix(line, "timestamp", 64);
	const timestamp = timestampText ? new Date(timestampText).getTime() : NaN;
	const messageIndex = line.indexOf('"message"');
	const role =
		messageIndex >= 0
			? extractJsonStringPropertyPrefix(line, "role", 64, messageIndex)
			: extractJsonStringPropertyPrefix(line, "role", 64);
	let textPreview: string | undefined;
	if (messageIndex >= 0) {
		textPreview =
			extractJsonStringPropertyPrefix(line, "content", SESSION_LIST_LARGE_MESSAGE_PREVIEW_MAX_CHARS, messageIndex) ??
			extractJsonStringPropertyPrefix(line, "text", SESSION_LIST_LARGE_MESSAGE_PREVIEW_MAX_CHARS, messageIndex);
	}
	return {
		role,
		...(Number.isNaN(timestamp) ? {} : { timestamp }),
		...(textPreview ? { textPreview } : {}),
	};
}

interface SessionInfoCacheEntry {
	size: number;
	mtimeMs: number;
	info: SessionInfo | null;
}

// Session files are append-only, so an unchanged (size, mtimeMs) means identical
// content: cache list metadata and rescan only files that changed.
const sessionInfoCache = new Map<string, SessionInfoCacheEntry>();

export async function readSessionInfo(filePath: string): Promise<SessionInfo | null> {
	let stats: Awaited<ReturnType<typeof stat>>;
	try {
		stats = await stat(filePath);
	} catch {
		return null;
	}
	const cached = sessionInfoCache.get(filePath);
	if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) {
		return cached.info;
	}
	const info = await scanSessionInfo(filePath, stats);
	sessionInfoCache.set(filePath, { size: stats.size, mtimeMs: stats.mtimeMs, info });
	return info;
}

async function scanSessionInfo(filePath: string, stats: Awaited<ReturnType<typeof stat>>): Promise<SessionInfo | null> {
	try {
		let header: SessionHeader | undefined;
		let messageCount = 0;
		let firstMessage = "";
		let allMessagesText = "";
		let name: string | undefined;
		let state: SessionState | undefined;
		let agentStatus: AgentStatus | undefined;
		let lastActivityTime: number | undefined;
		// Fold attribution aggregates like the loader: either disk representation cancels to the same own spend.
		const assistantUsageById = new Map<string, Usage>();
		const attributedChildUsages: Usage[] = [];
		const summarizationUsages: Usage[] = [];

		for await (const record of readSessionJournal(filePath)) {
			const line = record.json;

			// Large tool-result entries can be many MB. They do not carry the
			// session-list metadata we need, and parsing them during every refresh
			// can exhaust the daemon heap.
			if (line.length > SESSION_LIST_PARSE_MAX_LINE_CHARS) {
				if (looksLikeMessageEntry(line)) {
					messageCount++;
					const summary = extractOversizedMessageSummary(line);
					if (typeof summary.timestamp === "number" && (summary.role === "user" || summary.role === "assistant")) {
						lastActivityTime = Math.max(lastActivityTime ?? 0, summary.timestamp);
					}
					if (summary.role === "user" && !firstMessage) {
						firstMessage = summary.textPreview || "(large message)";
					}
				}
				continue;
			}

			const entry = sessionFileEntry(record.entry);

			if (entry.type === "session_info") {
				const infoEntry = entry as SessionInfoEntry;
				name = infoEntry.name?.trim() || undefined;
			}
			if (entry.type === "session_state") {
				const stateEntry = entry as SessionStateEntry;
				const status = normalizeSessionStateStatus(stateEntry.state?.status);
				if (status) {
					state = { status };
				}
			}
			// Keep the latest recap/verdict so off-daemon sessions don't all show as
			// unjudged in the agents view. Append-only, so last seen wins.
			if (entry.type === "agent_status") {
				agentStatus = (entry as AgentStatusEntry).status;
			}
			if (entry.type === "child_usage_attributed") {
				const attribution = entry as ChildUsageAttributionEntry;
				if (assistantUsageById.has(attribution.targetId)) {
					assistantUsageById.set(attribution.targetId, attribution.aggregateUsage);
					attributedChildUsages.push(attribution.childUsage);
				}
			}
			if (entry.type === "compaction" || entry.type === "branch_summary") {
				const summarizationUsage = (entry as CompactionEntry | BranchSummaryEntry).usage;
				if (summarizationUsage) summarizationUsages.push(summarizationUsage);
			}
			if (!header) {
				if (entry.type !== "session") {
					return null;
				}
				header = entry as SessionHeader;
			}

			lastActivityTime = updateLastActivityTime(lastActivityTime, entry);

			if (entry.type !== "message") continue;
			messageCount++;

			const message = (entry as SessionMessageEntry).message;
			if (message.role === "assistant" && (message as { usage?: Usage }).usage) {
				assistantUsageById.set(entry.id, (message as { usage: Usage }).usage);
			}
			if (!isMessageWithContent(message)) continue;
			if (message.role !== "user" && message.role !== "assistant") continue;

			const textContent = extractTextContent(message);
			if (!textContent) continue;

			allMessagesText = appendCappedSearchText(allMessagesText, textContent);
			if (!firstMessage && message.role === "user") {
				firstMessage = textContent;
			}
		}

		if (!header) return null;
		const usageTotal = emptyUsage();
		for (const usage of assistantUsageById.values()) {
			addAssistantUsage(usageTotal, usage);
		}
		for (const usage of summarizationUsages) {
			addAssistantUsage(usageTotal, usage);
		}
		for (const childUsage of attributedChildUsages) {
			subtractAssistantUsage(usageTotal, childUsage);
		}
		const cwd = typeof header.cwd === "string" ? header.cwd : "";
		const parentSessionPath = header.parentSession;
		const rlmDepth = resolveSessionRlmDepth(header, filePath);
		const modified = getSessionModifiedDateFromLastActivity(lastActivityTime, header, stats.mtime);

		return {
			path: filePath,
			id: header.id,
			cwd,
			name,
			state,
			parentSessionPath,
			rlmDepth,
			created: new Date(header.timestamp),
			modified,
			messageCount,
			firstMessage: firstMessage || "(no messages)",
			allMessagesText,
			agentStatus,
			usage: sessionUsageSummaryFrom(usageTotal),
		};
	} catch {
		return null;
	}
}

export type SessionListProgress = (loaded: number, total: number) => void;
export type SessionListItem = (session: SessionInfo) => void;

export interface SessionListCallbacks {
	onProgress?: SessionListProgress;
	onSession?: SessionListItem;
}

async function listSessionsFromDir(
	dir: string,
	callbacks?: SessionListCallbacks,
	progressOffset = 0,
	progressTotal?: number,
): Promise<SessionInfo[]> {
	const sessions: SessionInfo[] = [];
	try {
		const files = sessionCatalogFiles(dir);
		const total = progressTotal ?? files.length;

		const present = new Set(files);
		for (const key of sessionInfoCache.keys()) {
			const directory = dirname(key);
			const inScope =
				directory === dir ||
				(dirname(directory) === dir && /^--.+--$/.test(basename(directory))) ||
				(resolve(dir) === resolve(getSessionsDir()) && directory === getDefaultAgentDir());
			if (inScope && !present.has(key)) {
				sessionInfoCache.delete(key);
			}
		}

		let loaded = 0;
		for (const file of files) {
			const info = await readSessionInfo(file);
			loaded++;
			callbacks?.onProgress?.(progressOffset + loaded, total);
			if (info) {
				sessions.push(info);
				callbacks?.onSession?.(info);
			}
		}
	} catch {
		// Return no sessions when the directory cannot be read.
	}

	return sessions;
}

interface SessionWriteState {
	owner?: SessionJournalOwner;
	history?: SessionHistoryIndex;
	tail: Promise<void>;
	pending: number;
	bytes: number;
	reservedLeaf: string | null;
	leafId: string | null;
	pins: number;
	retired: boolean;
	closed: boolean;
	sequence: number;
	compactionCount: number;
	sessionName?: string;
	sourceVersion: number;
	pendingIds: Set<string>;
	failure?: Error;
	closing?: Promise<void>;
	unpinned?: Promise<void>;
	onUnpinned?: () => void;
}

function newSessionWriteState(): SessionWriteState {
	return {
		tail: Promise.resolve(),
		pending: 0,
		bytes: 0,
		reservedLeaf: null,
		leafId: null,
		pins: 0,
		retired: false,
		closed: false,
		sequence: -1,
		compactionCount: 0,
		sourceVersion: CURRENT_SESSION_VERSION,
		pendingIds: new Set(),
	};
}

const MAX_SESSION_PENDING_OPERATIONS = 32;
const MAX_SESSION_PENDING_BYTES = 64 * 1024 * 1024;

export class SessionManager {
	private sessionId: string = "";
	private sessionFile: string | undefined;
	private sessionDir: string;
	private cwd: string;
	private persist: boolean;
	private fileEntries: FileEntry[] = [];
	private byId: Map<string, SessionEntry> = new Map();
	private labelsById: Map<string, string> = new Map();
	private labelTimestampsById: Map<string, string> = new Map();
	private leafId: string | null = null;
	private persistListeners = new Set<SessionPersistListener>();
	private finalizedToolMessages = new WeakMap<AgentMessage, string>();
	private pendingToolExchanges = new Map<string, Promise<string>>();
	private writeState = newSessionWriteState();
	private retiredSources = new Set<SessionWriteState>();
	private switching = false;
	private closing?: Promise<void>;

	private readOnly = false;

	private constructor(cwd: string, sessionDir: string, persist: boolean, options?: NewSessionOptions) {
		this.cwd = cwd;
		this.sessionDir = sessionDir;
		this.persist = persist;
		if (persist) assertProductStatePath(sessionDir);
		this._stageNewSession(options);
	}

	private _stageNewSession(options?: NewSessionOptions): void {
		this.finalizedToolMessages = new WeakMap();
		let sessionId = options?.id ?? createSessionId();
		let sessionFile: string | undefined;
		const hasExplicitRlmDepth = options !== undefined && Object.hasOwn(options, "rlmDepth");
		let parentHeader: Partial<SessionHeader> | undefined;
		if (options?.parentSession && !hasExplicitRlmDepth) {
			try {
				parentHeader = readSessionHeader(options.parentSession);
			} catch {
				// Unavailable parent metadata leaves the child depth unknown.
			}
		}
		if (this.persist) {
			if (options?.id) {
				sessionFile = getSessionFilePath(this.getSessionDir(), sessionId);
				if (existsSync(sessionFile)) {
					throw new Error(`Session file already exists for id "${sessionId}": ${sessionFile}`);
				}
			} else {
				const target = createUniqueSessionFileTarget(this.getSessionDir());
				sessionId = target.sessionId;
				sessionFile = target.sessionFile;
			}
		}

		this.sessionId = sessionId;
		const timestamp = new Date().toISOString();
		const git = this.persist ? (captureGitContext(this.cwd) ?? undefined) : undefined;
		const rlmDepth = hasExplicitRlmDepth
			? options?.rlmDepth
			: options?.parentSession
				? deriveChildRlmDepth(parentHeader)
				: rootRlmDepthFromEnv();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionId,
			timestamp,
			cwd: this.cwd,
			parentSession: options?.parentSession,
			rlmDepth,
			git,
		};
		this.fileEntries = [header];
		this.byId = new Map();
		this.labelsById = new Map();
		this.labelTimestampsById = new Map();
		this.leafId = null;

		if (this.persist) {
			this.sessionFile = sessionFile ? assertProductStatePath(sessionFile) : undefined;
		}
		this.writeState.sequence = this.persist ? -1 : 0;
		this.writeState.compactionCount = 0;
	}

	private async _openNew(): Promise<void> {
		if (!this.persist || !this.sessionFile) return;
		const state = this.writeState;
		const owner = await SessionJournalOwner.open({
			journalPath: assertProductStatePath(this.sessionFile),
			create: true,
		});
		state.owner = owner;
		this.sessionFile = owner.journalPath;
		try {
			for (const entry of this.fileEntries) {
				const ack = await owner.appendJson(
					stringifyBoundedJson(entry, MAX_SESSION_RECORD_BYTES),
					entryRetentions.get(entry),
				);
				state.sequence = ack.sequence;
			}
		} catch (error) {
			await owner.close().catch(() => undefined);
			state.closed = true;
			throw error;
		}
	}

	private async _adopt(next: SessionManager): Promise<void> {
		const previous = this.writeState;
		try {
			await this._retire(previous);
		} catch (error) {
			await next.close().catch(() => undefined);
			throw error;
		}
		this.sessionId = next.sessionId;
		this.sessionFile = next.sessionFile;
		this.sessionDir = next.sessionDir;
		this.persist = next.persist;
		this.fileEntries = next.fileEntries;
		this.byId = next.byId;
		this.labelsById = next.labelsById;
		this.labelTimestampsById = next.labelTimestampsById;
		this.leafId = next.leafId;
		this.finalizedToolMessages = next.finalizedToolMessages;
		this.writeState = next.writeState;
	}

	private _assertMutable(): void {
		if (this.readOnly) throw new Error("Session view is read-only");
		if (this.persist && this.sessionFile) {
			assertProductStatePath(this.sessionFile);
			if (this.writeState.owner && realpathIfPresent(this.sessionFile) !== this.writeState.owner.journalPath)
				throw new Error("Session source target changed outside its owner");
		}
		if (this.switching || this.closing) throw new Error("Session source is switching or closing");
	}

	async setSessionFile(sessionFile: string): Promise<void> {
		this._assertMutable();
		const target = assertProductStatePath(sessionFile);
		if (realpathIfPresent(target) === this.sessionFile) {
			await this.flushNow();
			return;
		}
		this.switching = true;
		try {
			await this.flushNow();
			const next = await SessionManager.open(target, this.sessionDir, this.cwd);
			await this._adopt(next);
		} finally {
			this.switching = false;
		}
	}

	async newSession(options?: NewSessionOptions): Promise<string | undefined> {
		this._assertMutable();
		this.switching = true;
		try {
			await this.flushNow();
			const next = new SessionManager(this.cwd, this.sessionDir, this.persist, options);
			await next._openNew();
			await this._adopt(next);
			return this.sessionFile;
		} finally {
			this.switching = false;
		}
	}

	private _buildIndex(): void {
		this.byId = new Map();
		this.labelsById = new Map();
		this.labelTimestampsById = new Map();
		this.leafId = null;
		this.writeState.compactionCount = 0;
		this.writeState.sessionName = undefined;
		for (const entry of this.fileEntries) {
			if (entry.type === "session") continue;
			this.byId.set(entry.id, entry);
			if (entry.type === "compaction") this.writeState.compactionCount++;
			if (entry.type === "session_info") this.writeState.sessionName = entry.name;
			if (entry.type !== "request") this.leafId = entry.id;
			if (entry.type === "label") {
				if (entry.label) {
					this.labelsById.set(entry.targetId, entry.label);
					this.labelTimestampsById.set(entry.targetId, entry.timestamp);
				} else {
					this.labelsById.delete(entry.targetId);
					this.labelTimestampsById.delete(entry.targetId);
				}
			}
		}
		this.writeState.leafId = this.leafId;
		this.writeState.reservedLeaf = this.leafId;
	}

	private _notifyPersistListeners(): void {
		if (!this.sessionFile) {
			return;
		}
		for (const listener of this.persistListeners) {
			try {
				listener(this.sessionFile);
			} catch {
				// Persistence observers must not break session writes.
			}
		}
	}

	onPersist(listener: SessionPersistListener): () => void {
		this.persistListeners.add(listener);
		return () => {
			this.persistListeners.delete(listener);
		};
	}

	isPersisted(): boolean {
		return this.persist;
	}

	/** Captured indexed reads require this manager's owned, framed source. */
	supportsCapturedHistoryReads(): boolean {
		return this.persist && !this.readOnly && this.writeState.owner?.format === "framed";
	}

	getCwd(): string {
		return this.cwd;
	}

	getSessionDir(): string {
		return this.sessionDir;
	}

	getSessionId(): string {
		return this.sessionId;
	}

	getSessionFile(): string | undefined {
		return this.sessionFile;
	}

	async materializeSessionFile(sessionDir?: string): Promise<string> {
		this._assertMutable();
		if (this.sessionFile) return this.sessionFile;
		this.switching = true;
		try {
			await this.flushNow();
			const dir = sessionDir ?? (this.sessionDir || getDefaultSessionDir(this.cwd));
			const header = this.getHeader();
			const next = new SessionManager(this.cwd, dir, true, {
				parentSession: header?.parentSession,
				rlmDepth: resolveSessionRlmDepth(header ?? {}, dir),
			});
			next.fileEntries.push(...this.getEntries());
			next._buildIndex();
			await next._openNew();
			await this._adopt(next);
			return this.sessionFile!;
		} finally {
			this.switching = false;
		}
	}

	getSessionArtifactDir(): string | undefined {
		return this.persist && this.sessionFile
			? assertProductStatePath(getSessionArtifactPathForFile(this.sessionFile, this.sessionId))
			: undefined;
	}

	/** Exact source metadata within the captured current branch, not a scan of message arrays. */
	getHistoryEntry(id: string): Promise<IndexedSourceEvent | undefined> {
		return this._readHistory((view) => view.get(id));
	}

	/** Exact canonical JSON bytes as bounded UTF8 fragments, within the captured branch. */
	readHistoryPayload(
		id: string,
		options: HistoryPayloadReadOptions = {},
	): Promise<CanonicalPayloadFragment | undefined> {
		const captured = { ...options, ...(options.cursor ? { cursor: { ...options.cursor } } : {}) };
		return this._readHistory((view) => view.readPayload(id, captured));
	}

	pageHistory(after = 0, limit = 64): Promise<HistoryIndexPage> {
		return this._readHistory((view) => view.page(after, limit));
	}

	searchHistory(query: string, limit = 16): Promise<HistoryIndexPage> {
		return this._readHistory((view) => view.search(query, limit));
	}

	/** Source-order active-context references, not a last-N transcript. */
	contextManifest(options: ContextManifestOptions = {}): Promise<ContextManifestPage> {
		const captured = { ...options, ...(options.cursor ? { cursor: { ...options.cursor } } : {}) };
		return this._readHistory((view) => view.contextManifest(captured));
	}

	/** Structured descriptive evidence; selective output is not an exhaustive requirements list. */
	taskEvidence(options: TaskEvidenceOptions = {}): Promise<TaskEvidencePage> {
		const captured = { ...options, ...(options.after ? { after: { ...options.after } } : {}) };
		return this._readHistory((view) => view.taskEvidence(captured));
	}

	private async _readHistory<T>(read: (view: SessionHistoryReadView) => Promise<T>): Promise<T> {
		return this._runHistoryRead(this.bindRequestSink(), read);
	}

	/** Explicit branch read at one pinned canonical frontier. */
	readBranchHistory<T>(read: (view: SessionHistoryReadScope) => Promise<T>): Promise<T> {
		return this._runHistoryRead(
			this._bindHistorySource((index, source, query) =>
				createSessionHistoryReadScope(index, source, query, "branch"),
			),
			read,
		);
	}

	/** Explicit whole-source read, including branches outside the current leaf. */
	readSourceHistory<T>(read: (view: SessionHistoryReadScope) => Promise<T>): Promise<T> {
		return this._runHistoryRead(
			this._bindHistorySource((index, source, query) =>
				createSessionHistoryReadScope(index, source, query, "source"),
			),
			read,
		);
	}

	materializeBranchHistory(limits: SessionHistoryReadLimits): Promise<MaterializedSessionHistory> {
		const captured = { ...limits };
		return this.readBranchHistory((view) => view.materialize(captured));
	}

	materializeSourceHistory(limits: SessionHistoryReadLimits): Promise<MaterializedSessionHistory> {
		const captured = { ...limits };
		return this.readSourceHistory((view) => view.materialize(captured));
	}

	private async _runHistoryRead<View, T>(
		sink: BoundHistoryReadSink<View>,
		read: (view: View) => Promise<T>,
	): Promise<T> {
		const outcome = await sink.readHistory(read).then(
			(value) => ({ ok: true, value }) as const,
			(error: unknown) => ({ ok: false, error }) as const,
		);
		try {
			await sink.release();
		} catch (error) {
			if (!outcome.ok) throw new AggregateError([outcome.error, error], "History read and source release failed");
			throw error;
		}
		if (!outcome.ok) throw outcome.error;
		return outcome.value;
	}

	private _publishHistory(state: SessionWriteState): void {
		if (state.history && state.owner) state.history.publish(state.owner.getSnapshot());
	}

	private async _releaseSourcePin(state: SessionWriteState): Promise<void> {
		state.pins--;
		if (state.pins === 0) {
			state.onUnpinned?.();
			state.onUnpinned = undefined;
			state.unpinned = undefined;
		}
		await this._closeRetired(state);
	}

	private async _closeSourceActors(state: SessionWriteState): Promise<void> {
		const errors: unknown[] = [];
		try {
			await state.history?.close();
		} catch (error) {
			errors.push(error);
		}
		// Keep the canonical fence until the derived reader has exited, including failed shutdown.
		try {
			await state.owner?.close();
		} catch (error) {
			errors.push(error);
		}
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Session source actors failed to close");
	}

	/** Wait for all previously admitted writes and the writer's durability barrier. */
	async flushNow(): Promise<void> {
		const state = this.writeState;
		await this._enqueue(state, 0, async () => {
			await state.owner?.flush();
		});
	}

	async migrateLegacy(): Promise<void> {
		this._assertMutable();
		const state = this.writeState;
		await this._enqueue(state, 0, async () => {
			if (!state.owner) throw new Error("An owned persistent source is required for migration");
			if (state.sourceVersion !== CURRENT_SESSION_VERSION)
				throw new Error("Legacy session payload requires an explicit retained import before writing");
			await state.owner.migrateLegacy();
			state.sequence = state.owner.nextSequence - 1;
			this._publishHistory(state);
		});
	}

	/** Re-open and replay after explicit exclusive repair; never re-execute an effect. */
	async recover(): Promise<void> {
		this._assertMutable();
		const previous = this.writeState;
		if (!this.persist || !this.sessionFile || this.readOnly)
			throw new Error("An owned persistent source is required for recovery");
		if (previous.pins > 0 || previous.pending > 0)
			throw new Error("Drain captured requests and source writes before recovery");
		this.switching = true;
		try {
			await previous.tail;
			await this._closeSourceActors(previous);
			previous.closed = true;
			const owner = await SessionJournalOwner.open({ journalPath: this.sessionFile });
			try {
				await owner.recover();
				const entries = await loadEntriesFromFileAsync(this.sessionFile);
				const header = entries[0];
				if (!header || header.type !== "session" || header.id !== this.sessionId)
					throw new Error("Recovered source identity does not match this session");
				const state = newSessionWriteState();
				state.owner = owner;
				state.sequence = owner.nextSequence - 1;
				state.sourceVersion = header.version ?? 1;
				migrateToCurrentVersion(entries);
				this.fileEntries = entries;
				this.writeState = state;
				this.finalizedToolMessages = new WeakMap();
				this._buildIndex();
			} catch (error) {
				await owner.close().catch(() => undefined);
				throw error;
			}
		} finally {
			this.switching = false;
		}
	}

	private _enqueue<T>(state: SessionWriteState, bytes: number, action: () => Promise<T>): Promise<T> {
		if (state.closed) return Promise.reject(new Error("Session source owner is closed"));
		if (state.failure) return Promise.reject(state.failure);
		if (state.pending >= MAX_SESSION_PENDING_OPERATIONS || state.bytes + bytes > MAX_SESSION_PENDING_BYTES)
			return Promise.reject(new Error("Session source queue limit exceeded"));
		state.pending++;
		state.bytes += bytes;
		const result = state.tail.then(async () => {
			if (state.failure) throw state.failure;
			return action();
		});
		state.tail = result
			.then(
				() => undefined,
				() => undefined,
			)
			.finally(() => {
				state.pending--;
				state.bytes -= bytes;
			});
		return result;
	}

	private async _appendEntry(
		entry: SessionEntry,
		explicitParent = false,
		prepare?: (snapshot: SessionEntry) => void,
	): Promise<void> {
		this._assertMutable();
		const state = this.writeState;
		if (state.failure) throw state.failure;
		if (state.owner?.format === "legacy") throw new Error("Session journal requires explicit legacy migration");
		if (this.byId.has(entry.id) || state.pendingIds.has(entry.id))
			throw new Error(`Duplicate session entry: ${entry.id}`);
		if (!explicitParent) entry.parentId = state.pending ? state.reservedLeaf : this.leafId;
		let json = stringifyBoundedJson(entry, MAX_SESSION_RECORD_BYTES);
		const retention = entryRetentions.get(entry);
		const snapshot = withEntryRetention(JSON.parse(json) as SessionEntry, retention);
		// Queued usage projection only changes a fixed set of numeric fields.
		const admittedBytes = Buffer.byteLength(json) + (prepare ? 16 * 1024 : 0);
		const entries = this.fileEntries;
		const byId = this.byId;
		const labels = this.labelsById;
		const labelTimes = this.labelTimestampsById;
		if (state.pending >= MAX_SESSION_PENDING_OPERATIONS || state.bytes + admittedBytes > MAX_SESSION_PENDING_BYTES)
			throw new Error("Session source queue limit exceeded");
		state.reservedLeaf = snapshot.id;
		state.pendingIds.add(snapshot.id);
		try {
			await this._enqueue(state, admittedBytes, async () => {
				try {
					if (prepare) {
						prepare(snapshot);
						json = stringifyBoundedJson(snapshot, admittedBytes);
					}
					if (state.owner) {
						const ack = await state.owner.appendJson(json, retention);
						state.sequence = ack.sequence;
					} else {
						state.sequence++;
					}
				} catch (error) {
					state.failure = new Error("Session source append failed; outcome may be unknown", { cause: error });
					throw error;
				}
				this._publishHistory(state);
				entries.push(snapshot);
				byId.set(snapshot.id, snapshot);
				if (snapshot.type === "compaction") state.compactionCount++;
				if (snapshot.type === "session_info") state.sessionName = snapshot.name;
				if (snapshot.type === "label") {
					if (snapshot.label) {
						labels.set(snapshot.targetId, snapshot.label);
						labelTimes.set(snapshot.targetId, snapshot.timestamp);
					} else {
						labels.delete(snapshot.targetId);
						labelTimes.delete(snapshot.targetId);
					}
				}
				if (snapshot.type === "child_usage_attributed") {
					const target = byId.get(snapshot.targetId);
					if (target?.type === "message" && target.message.role === "assistant")
						target.message.usage = cloneUsage(snapshot.aggregateUsage);
				}
				state.leafId = snapshot.id;
				if (this.writeState === state) {
					this.leafId = snapshot.id;
					this._notifyPersistListeners();
				}
			});
		} finally {
			state.pendingIds.delete(snapshot.id);
		}
	}

	private async _closeRetired(state: SessionWriteState): Promise<void> {
		if (!state.retired || state.pins > 0) return;
		state.closing ??= (async () => {
			await state.tail;
			await this._closeSourceActors(state);
			state.closed = true;
			this.retiredSources.delete(state);
		})();
		await state.closing;
	}

	private async _retire(state: SessionWriteState): Promise<void> {
		state.retired = true;
		this.retiredSources.add(state);
		await this._closeRetired(state);
	}

	close(): Promise<void> {
		this.closing ??= (async () => {
			await this._retire(this.writeState);
			for (const state of [...this.retiredSources]) {
				if (state.pins > 0) {
					state.unpinned ??= new Promise<void>((resolve) => {
						state.onUnpinned = resolve;
					});
					await state.unpinned;
				}
				await this._closeRetired(state);
			}
		})();
		return this.closing;
	}

	/** Capture before waits; the barrier resolves only after this source's prior ACKs. */
	bindRequestSink(): BoundSessionRequestSink {
		return this._bindHistorySource(createBranchHistoryReadView);
	}

	private _bindHistorySource<View>(
		createView: (index: HistoryIndex, source: SourceSnapshotRef, query: HistoryReadQuery) => View,
	): BoundHistoryReadSink<View> {
		this._assertMutable();
		const state = this.writeState;
		const sourceFile =
			state.owner?.journalPath ?? (this.sessionFile ? realpathIfPresent(resolve(this.sessionFile)) : undefined);
		const sessionId = this.sessionId;
		const persistent = this.persist;
		const entries = this.fileEntries;
		const byId = this.byId;
		let held = false;
		const retain = () => {
			if (held) return;
			if (state.closed || state.closing) throw new Error("Captured session source owner is closed");
			held = true;
			state.pins++;
		};
		retain();
		const captured = this._enqueue(state, 0, async () => {
			await state.owner?.flush();
			const source: SourceSnapshotRef = Object.freeze({
				sessionId,
				...(sourceFile ? { sessionFile: sourceFile } : {}),
				leafId: state.leafId,
				sourceSequence: state.sequence,
				persistent,
			});
			return { source, snapshot: state.owner?.getSnapshot() };
		});
		const source = captured.then((value) => value.source);
		// A captured auxiliary operation can await UI work before consuming its barrier.
		void source.catch(() => undefined);
		return {
			source,
			readHistory: async <T>(read: (view: View) => Promise<T>): Promise<T> => {
				if (!held) throw new Error("Captured request sink is not retained");
				// A running read holds its own pin if request disposal happens concurrently.
				state.pins++;
				try {
					const { source: boundSource, snapshot } = await captured;
					if (!snapshot || snapshot.format !== "framed" || state.sourceVersion !== CURRENT_SESSION_VERSION)
						throw new Error(
							"Indexed history requires an owned canonical session; import or migrate legacy history explicitly",
						);
					state.history ??= new SessionHistoryIndex(
						sessionId,
						join(
							assertProductStatePath(getSessionArtifactPathForFile(snapshot.journalPath, sessionId)),
							"history.sqlite",
						),
					);
					const index = await state.history.synchronize(snapshot);
					let active = true;
					const query: HistoryReadQuery = (operation) => {
						if (!active) return Promise.reject(new Error("Captured history read has ended"));
						return operation();
					};
					const view = createView(index, boundSource, query);
					try {
						return await read(view);
					} finally {
						active = false;
					}
				} finally {
					await this._releaseSourcePin(state);
				}
			},
			retain,
			release: async () => {
				if (!held) return;
				held = false;
				await this._releaseSourcePin(state);
			},
			persist: async (event: NativeRequestEvent) => {
				if (!held) throw new Error("Captured request sink is not retained");
				if (state.owner) assertProductStatePath(state.owner.journalPath);
				if (state.owner?.format === "legacy") throw new Error("Session journal requires explicit legacy migration");
				const snapshot = await source;
				const request = JSON.parse(stringifyBoundedJson(event, 1024 * 1024)) as NativeRequestEvent;
				if (!isDeepStrictEqual(request.source, snapshot))
					throw new Error("Request event does not match its bound source");
				const id = `${request.attemptId}:${request.type}`;
				const entry: RequestJournalEntry = {
					type: "request",
					id,
					parentId: snapshot.leafId,
					timestamp: new Date(request.timestamp).toISOString(),
					request,
				};
				const json = stringifyBoundedJson(entry, 1024 * 1024 - 1);
				await this._enqueue(state, Buffer.byteLength(json), async () => {
					const existing = byId.get(id);
					if (existing) {
						if (existing.type !== "request" || !isDeepStrictEqual(existing.request, request))
							throw new Error(`Conflicting request event: ${id}`);
						return;
					}
					try {
						if (state.owner) state.sequence = (await state.owner.appendJson(json)).sequence;
						else state.sequence++;
					} catch (error) {
						state.failure = new Error("Session request append failed; outcome may be unknown", { cause: error });
						throw error;
					}
					this._publishHistory(state);
					entries.push(entry);
					byId.set(id, entry);
					if (this.writeState === state) this._notifyPersistListeners();
				});
			},
		};
	}

	async appendToolInvocation(invocation: ToolInvocation): Promise<string> {
		const id = `${invocation.executionId}:intent`;
		if (this.byId.has(id)) throw new Error(`Tool invocation already admitted: ${invocation.executionId}`);
		const entry: ToolIntentEntry = {
			type: "tool_intent",
			id,
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			invocation: structuredClone(invocation),
		};
		await this._appendEntry(entry);
		return entry.id;
	}

	appendToolExchange(exchange: FinalizedToolExchange): Promise<string> {
		const pending = this.pendingToolExchanges.get(exchange.executionId);
		if (pending) return pending;
		const result = this._appendToolExchange(exchange).finally(() => {
			this.pendingToolExchanges.delete(exchange.executionId);
		});
		this.pendingToolExchanges.set(exchange.executionId, result);
		return result;
	}

	private async _appendToolExchange(exchange: FinalizedToolExchange): Promise<string> {
		const existing = this.byId.get(exchange.executionId);
		if (existing?.type === "message" && existing.execution?.executionId === exchange.executionId) {
			this.finalizedToolMessages.set(exchange.result, existing.id);
			return existing.id;
		}
		if (existing) throw new Error(`Conflicting tool execution ID: ${exchange.executionId}`);
		const { result, originalInput, executedInput, ...outcome } = exchange;
		const invocationId = `${exchange.executionId}:intent`;
		const execution: SessionExecutionEvidence = this.byId.has(invocationId)
			? { ...outcome, invocationId }
			: { ...outcome, originalInput, ...(exchange.executionOutcome === "not_started" ? {} : { executedInput }) };
		const entry: SessionMessageEntry = {
			type: "message",
			id: exchange.executionId,
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			message: structuredClone(result),
			execution: structuredClone(execution),
		};
		const finalized = this.finalizedToolMessages;
		await this._appendEntry(entry);
		finalized.set(result, entry.id);
		return entry.id;
	}

	getToolExchange(executionId: string): FinalizedToolExchange | undefined {
		const entry = this.byId.get(executionId);
		if (entry?.type !== "message" || entry.message.role !== "toolResult" || !entry.execution) return undefined;
		if ("invocationId" in entry.execution) {
			const intent = this.byId.get(entry.execution.invocationId);
			if (intent?.type !== "tool_intent") throw new Error(`Missing invocation for tool execution ${executionId}`);
			const { invocationId: _invocationId, ...outcome } = entry.execution;
			const { executedInput, ...invocation } = intent.invocation;
			return {
				...invocation,
				...outcome,
				...(outcome.executionOutcome === "not_started" ? {} : { executedInput }),
				result: entry.message,
			};
		}
		return { ...entry.execution, result: entry.message };
	}

	async appendMessage(
		message: Message | CustomMessage | BashExecutionMessage,
		nativeOrigin?: NativeEntryOrigin,
	): Promise<string> {
		const finalized = this.finalizedToolMessages.get(message);
		if (finalized) return finalized;
		const entry: SessionMessageEntry = {
			type: "message",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			message,
			...(nativeOrigin ? { nativeOrigin } : {}),
		};
		await this._appendEntry(entry);
		return entry.id;
	}

	async appendThinkingLevelChange(thinkingLevel: string): Promise<string> {
		const entry: ThinkingLevelChangeEntry = {
			type: "thinking_level_change",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			thinkingLevel,
		};
		await this._appendEntry(entry);
		return entry.id;
	}

	async appendServiceTierChange(serviceTier: ServiceTier): Promise<string> {
		const entry: ServiceTierChangeEntry = {
			type: "service_tier_change",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			serviceTier,
		};
		await this._appendEntry(entry);
		return entry.id;
	}

	async appendModelChange(provider: string, modelId: string): Promise<string> {
		const entry: ModelChangeEntry = {
			type: "model_change",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			provider,
			modelId,
		};
		await this._appendEntry(entry);
		return entry.id;
	}

	async appendCompaction<T = unknown>(
		summary: string,
		firstKeptEntryId: string,
		tokensBefore: number,
		details?: T,
		fromHook?: boolean,
		customInstructions?: string,
		usage?: Usage,
	): Promise<string> {
		const entry: CompactionEntry<T> = {
			type: "compaction",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			summary,
			firstKeptEntryId,
			tokensBefore,
			details,
			fromHook,
			customInstructions,
			usage,
		};
		await this._appendEntry(entry);
		return entry.id;
	}

	async appendCustomEntry(customType: string, data?: unknown, nativeOrigin?: NativeEntryOrigin): Promise<string> {
		const entry: CustomEntry = {
			type: "custom",
			customType,
			data,
			...(nativeOrigin ? { nativeOrigin } : {}),
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
		};
		await this._appendEntry(entry);
		return entry.id;
	}

	async appendCustomEntryWithRollback(customType: string, data?: unknown): Promise<string> {
		return this.appendCustomEntry(customType, data);
	}

	async appendChildUsageAttribution(
		targetId: string,
		childUsage: Usage,
		aggregateUsage?: Usage,
		origin?: ChildUsageAttributionEntry["origin"],
	): Promise<string> {
		const target = this.byId.get(targetId);
		if (target?.type !== "message" || target.message.role !== "assistant") {
			throw new Error(`Assistant message entry ${targetId} not found`);
		}

		const targetMessage = target.message;
		const entry: ChildUsageAttributionEntry = {
			type: "child_usage_attributed",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			targetId,
			childUsage: cloneUsage(childUsage),
			aggregateUsage: cloneUsage(aggregateUsage ?? targetMessage.usage),
			...(origin ? { origin } : {}),
		};
		await this._appendEntry(
			entry,
			false,
			aggregateUsage === undefined
				? (snapshot) => {
						if (snapshot.type !== "child_usage_attributed") throw new Error("Expected child usage projection");
						const total = cloneUsage(targetMessage.usage);
						const contextTokens =
							total.totalTokens || total.input + total.output + total.cacheRead + total.cacheWrite;
						addAssistantUsage(total, snapshot.childUsage);
						total.totalTokens = contextTokens;
						snapshot.aggregateUsage = total;
					}
				: undefined,
		);
		return entry.id;
	}

	async appendSessionInfo(name: string): Promise<string> {
		const entry: SessionInfoEntry = {
			type: "session_info",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			name: name.trim(),
		};
		await this._appendEntry(entry);
		return entry.id;
	}

	async appendSessionState(state: SessionState): Promise<string> {
		const entry: SessionStateEntry = {
			type: "session_state",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			state: { status: state.status },
		};
		await this._appendEntry(entry);
		return entry.id;
	}

	getSessionName(): string | undefined {
		return this.writeState.sessionName?.trim() || undefined;
	}

	getSessionState(): SessionState | undefined {
		const entries = this.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type === "session_state") {
				const status = normalizeSessionStateStatus(entry.state.status);
				if (status) {
					return { status };
				}
			}
		}
		return undefined;
	}

	/**
	 * True when the session holds user-meaningful persisted content, as opposed to
	 * only daemon-written bookkeeping (session_state, agent_status, git_state) or
	 * the default model/thinking entries every new session is created with. Used by
	 * the daemon discard guard to decide whether a message-less draft is safe to
	 * delete (that guard always also requires zero messages).
	 *
	 * createAgentSession opens a new session with an optional leading `model_change`
	 * followed by `thinking_level_change` and `service_tier_change`. That creation
	 * prefix is skipped; anything beyond it is user content.
	 */
	hasUserContent(): boolean {
		const contentEntries = this.getEntries().filter((entry) => CONTENT_ENTRY_TYPES.has(entry.type));
		let start = 0;
		if (contentEntries[start]?.type === "model_change") {
			start++;
		}
		if (contentEntries[start]?.type === "thinking_level_change") {
			start++;
		}
		if (contentEntries[start]?.type === "service_tier_change") {
			start++;
		}
		return contentEntries.length > start;
	}

	async appendAgentStatus(status: AgentStatus): Promise<string> {
		const entry: AgentStatusEntry = {
			type: "agent_status",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			status: {
				summary: status.summary,
				taskState: status.taskState,
				basedOnMessageCount: status.basedOnMessageCount,
			},
		};
		await this._appendEntry(entry);
		return entry.id;
	}

	async appendGitState(git: GitContext): Promise<string> {
		const entry: GitStateEntry = {
			type: "git_state",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			git,
		};
		await this._appendEntry(entry);
		return entry.id;
	}

	async recordGitStateIfChanged(): Promise<string | undefined> {
		if (!this.persist) return undefined;
		const git = captureGitContext(this.cwd);
		if (!git) return undefined;
		const last = this.getActiveGitContext();
		if (last && gitContextsEqual(last, git)) return undefined;
		return this.appendGitState(git);
	}

	private getActiveGitContext(): GitContext | undefined {
		let current = this.leafId ? this.byId.get(this.leafId) : undefined;
		while (current) {
			if (current.type === "git_state") return current.git;
			current = current.parentId ? this.byId.get(current.parentId) : undefined;
		}
		const header = this.fileEntries[0];
		return header?.type === "session" ? header.git : undefined;
	}

	getLatestAgentStatus(): AgentStatus | undefined {
		// Walk the current leaf to root so we only read status on the active branch,
		// not a sibling branch's status that happens to sit later in the file.
		let current = this.leafId ? this.byId.get(this.leafId) : undefined;
		while (current) {
			if (current.type === "agent_status") {
				return { ...current.status };
			}
			current = current.parentId ? this.byId.get(current.parentId) : undefined;
		}
		return undefined;
	}

	async appendCustomMessageEntry<T = unknown>(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: T,
		nativeOrigin?: NativeEntryOrigin,
	): Promise<string> {
		const entry: CustomMessageEntry<T> = {
			type: "custom_message",
			customType,
			content,
			display,
			details,
			...(nativeOrigin ? { nativeOrigin } : {}),
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
		};
		await this._appendEntry(entry);
		return entry.id;
	}

	/**
	 * Append a custom message, undoing the append if persistence fails so a
	 * best-effort record never leaves an unsaved leaf for later entries.
	 */
	async appendCustomMessageEntryWithRollback<T = unknown>(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: T,
	): Promise<string> {
		return this.appendCustomMessageEntry(customType, content, display, details);
	}

	getLeafId(): string | null {
		return this.leafId;
	}

	getLeafEntry(): SessionEntry | undefined {
		return this.leafId ? this.byId.get(this.leafId) : undefined;
	}

	getEntry(id: string): SessionEntry | undefined {
		return this.byId.get(id);
	}

	getChildren(parentId: string): SessionEntry[] {
		const children: SessionEntry[] = [];
		for (const entry of this.byId.values()) {
			if (entry.parentId === parentId) {
				children.push(entry);
			}
		}
		return children;
	}

	getLabel(id: string): string | undefined {
		return this.labelsById.get(id);
	}

	async appendLabelChange(targetId: string, label: string | undefined): Promise<string> {
		if (!this.byId.has(targetId)) {
			throw new Error(`Entry ${targetId} not found`);
		}
		const entry: LabelEntry = {
			type: "label",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			targetId,
			label,
		};
		await this._appendEntry(entry);

		return entry.id;
	}

	getBranch(fromId?: string): SessionEntry[] {
		// push+reverse, not unshift-per-entry: unshift is O(n), which makes this O(n^2) on long sessions.
		const path: SessionEntry[] = [];
		const startId = fromId ?? this.leafId;
		let current = startId ? this.byId.get(startId) : undefined;
		while (current) {
			path.push(current);
			current = current.parentId ? this.byId.get(current.parentId) : undefined;
		}
		path.reverse();
		return path;
	}

	buildSessionContext(): SessionContext {
		// Pass fileEntries directly rather than getEntries(): the resolved context
		// is computed from the leaf-to-root walk over byId (which already excludes
		// the header), so the entries argument is only a fallback for an undefined
		// leaf — never hit here since leafId is always set or null. Avoids an O(n)
		// array copy on every call (attach, get_session_context, agent init, ...).
		return buildSessionContext(this.fileEntries as SessionEntry[], this.leafId, this.byId);
	}

	getHeader(): SessionHeader | null {
		const h = this.fileEntries.find((e) => e.type === "session");
		return h ? (h as SessionHeader) : null;
	}

	/** A lowering-only source qualification; absence does not establish native authorship. */
	getEntryRetention(entryId: string): JournalFrameRetention | undefined {
		const entry = this.byId.get(entryId);
		return entry ? entryRetentions.get(entry) : undefined;
	}

	/** Whole-source count published with acknowledged entries, independent of the current branch. */
	getCompactionCount(): number {
		return this.writeState.compactionCount;
	}

	/** Complete detached snapshot of this resident view, including readonly and in-memory views. */
	materializeResidentHistory(limits: SessionHistoryReadLimits): ResidentSessionHistory {
		const { maxEntries, maxSourceBytes } = limits;
		if (
			!Number.isSafeInteger(maxEntries) ||
			maxEntries <= 0 ||
			!Number.isSafeInteger(maxSourceBytes) ||
			maxSourceBytes <= 0
		)
			throw new Error("Invalid resident history materialization limits");
		const leafId = this.leafId;
		let sourceBytes = 0;
		const clone = <T extends FileEntry>(entry: T): T => {
			const json = stringifyBoundedJson(entry, maxSourceBytes - sourceBytes);
			sourceBytes += Buffer.byteLength(json);
			return JSON.parse(json) as T;
		};
		const originalHeader = this.getHeader();
		const header = originalHeader ? clone(originalHeader) : null;
		const entries: SessionEntry[] = [];
		const retentions: (JournalFrameRetention | null)[] = [];
		for (const entry of this.fileEntries) {
			if (entry.type === "session") continue;
			if (entries.length >= maxEntries) throw new Error("Resident history entry budget exceeded");
			entries.push(clone(entry));
			retentions.push(entryRetentions.get(entry) ?? null);
		}
		return { header, entries, retentions, leafId, sourceBytes };
	}

	getEntries(): SessionEntry[] {
		return this.fileEntries.filter((e): e is SessionEntry => e.type !== "session");
	}

	getFlatTree(): SessionTreeFlatNode[] {
		return this.getEntries()
			.filter(
				(entry): entry is Exclude<SessionEntry, PrivateSessionEntry> =>
					entry.type !== "tool_intent" && entry.type !== "request",
			)
			.map((entry) => {
				// Internal intent records remain in source history, not the conversation tree.
				let parentId = entry.parentId;
				let parent = parentId ? this.byId.get(parentId) : undefined;
				while (parent?.type === "tool_intent" || parent?.type === "request") {
					parentId = parent.parentId;
					parent = parentId ? this.byId.get(parentId) : undefined;
				}
				return {
					entry: parentId === entry.parentId ? entry : { ...entry, parentId },
					label: this.labelsById.get(entry.id),
					labelTimestamp: this.labelTimestampsById.get(entry.id),
				};
			});
	}

	getTree(): SessionTreeNode[] {
		const entries = this.getFlatTree();
		const nodeMap = new Map<string, SessionTreeNode>();
		const roots: SessionTreeNode[] = [];

		for (const flatNode of entries) {
			nodeMap.set(flatNode.entry.id, { ...flatNode, children: [] });
		}

		for (const flatNode of entries) {
			const entry = flatNode.entry;
			const node = nodeMap.get(entry.id)!;
			if (entry.parentId === null || entry.parentId === entry.id) {
				roots.push(node);
			} else {
				const parent = nodeMap.get(entry.parentId);
				if (parent) {
					parent.children.push(node);
				} else {
					roots.push(node);
				}
			}
		}

		// Sort children by timestamp (oldest first, newest at bottom)
		// Use iterative approach to avoid stack overflow on deep trees
		const stack: SessionTreeNode[] = [...roots];
		while (stack.length > 0) {
			const node = stack.pop()!;
			node.children.sort((a, b) => new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime());
			stack.push(...node.children);
		}

		return roots;
	}

	branch(branchFromId: string): void {
		if (!this.byId.has(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		if (this.writeState.pending > 0) throw new Error("Drain session writes before changing the branch");
		this.leafId = branchFromId;
		this.writeState.leafId = branchFromId;
		this.writeState.reservedLeaf = branchFromId;
	}

	resetLeaf(): void {
		if (this.writeState.pending > 0) throw new Error("Drain session writes before changing the branch");
		this.leafId = null;
		this.writeState.leafId = null;
		this.writeState.reservedLeaf = null;
	}

	async branchWithSummary(
		branchFromId: string | null,
		summary: string,
		details?: unknown,
		fromHook?: boolean,
		usage?: Usage,
	): Promise<string> {
		if (branchFromId !== null && !this.byId.has(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		const entry: BranchSummaryEntry = {
			type: "branch_summary",
			id: generateId(this.byId),
			parentId: branchFromId,
			timestamp: new Date().toISOString(),
			fromId: branchFromId ?? "root",
			summary,
			details,
			fromHook,
			usage,
		};
		await this._appendEntry(entry, true);
		return entry.id;
	}

	async forkBranch(
		leafId: string | null,
		options: { persist?: boolean; sessionDir?: string; rlmDepth?: number } = {},
	): Promise<SessionManager> {
		const sourceFile = this.sessionFile;
		const sourceHeader = this.getHeader();
		const persistent = options.persist ?? this.persist;
		const cwd = this.cwd;
		const sessionDir = options.sessionDir ?? this.sessionDir;
		const rlmDepth = options.rlmDepth ?? resolveSessionRlmDepth(sourceHeader ?? {}, sourceFile ?? "");
		const path =
			leafId === null
				? []
				: this.getBranch(leafId).map((entry) =>
						withEntryRetention(
							JSON.parse(stringifyBoundedJson(entry, MAX_SESSION_RECORD_BYTES)) as SessionEntry,
							entryRetentions.get(entry),
						),
					);
		if (leafId !== null && path.length === 0) throw new Error(`Entry ${leafId} not found`);
		const labels = new Map(this.labelsById);
		const labelTimes = new Map(this.labelTimestampsById);
		const labelRetentions = new Map<string, JournalFrameRetention | undefined>();
		for (const entry of this.fileEntries) {
			if (entry.type === "label") labelRetentions.set(entry.targetId, entryRetentions.get(entry));
		}
		await this.flushNow();
		const next = new SessionManager(cwd, sessionDir, persistent, { parentSession: sourceFile, rlmDepth });
		const copied = path.filter((entry) => entry.type !== "label");
		next.fileEntries.push(...copied);
		const ids = new Set(copied.map((entry) => entry.id));
		let parentId = copied[copied.length - 1]?.id ?? null;
		for (const [targetId, label] of labels) {
			if (!ids.has(targetId)) continue;
			const entry: LabelEntry = {
				type: "label",
				id: generateId(ids),
				parentId,
				timestamp: labelTimes.get(targetId)!,
				targetId,
				label,
			};
			ids.add(entry.id);
			next.fileEntries.push(withEntryRetention(entry, labelRetentions.get(targetId)));
			parentId = entry.id;
		}
		next._buildIndex();
		if (persistent) await next._openNew();
		else next.writeState.sequence = next.fileEntries.length - 1;
		return next;
	}

	async createBranchedSession(leafId: string): Promise<string | undefined> {
		this._assertMutable();
		const next = await this.forkBranch(leafId);
		this._assertMutable();
		this.switching = true;
		try {
			await this.flushNow();
			await this._adopt(next);
			return this.sessionFile;
		} finally {
			this.switching = false;
		}
	}

	static async create(cwd: string, sessionDir?: string, options?: NewSessionOptions): Promise<SessionManager> {
		const manager = new SessionManager(cwd, sessionDir ?? getDefaultSessionDir(cwd), true, options);
		await manager._openNew();
		return manager;
	}

	static async open(path: string, sessionDir?: string, cwdOverride?: string): Promise<SessionManager> {
		const target = assertProductStatePath(path);
		if (!existsSync(target)) {
			const manager = new SessionManager(cwdOverride ?? process.cwd(), sessionDir ?? dirname(target), true);
			manager.sessionFile = target;
			await manager._openNew();
			return manager;
		}
		const owner = await SessionJournalOwner.open({ journalPath: target });
		try {
			const entries = await loadEntriesFromFileAsync(owner.journalPath);
			const header = entries[0];
			if (!header || header.type !== "session" || typeof header.id !== "string")
				throw new Error(`Session source has no valid header: ${target}`);
			const sourceVersion = header.version ?? 1;
			if (sourceVersion > CURRENT_SESSION_VERSION) throw new Error(`Unsupported session version: ${sourceVersion}`);
			migrateToCurrentVersion(entries);
			if (header.parentSession && !isValidRlmDepth(header.rlmDepth))
				header.rlmDepth = resolveSessionRlmDepth(header, owner.journalPath);
			const manager = new SessionManager(
				cwdOverride ?? header.cwd ?? process.cwd(),
				sessionDir ?? dirname(owner.journalPath),
				false,
			);
			manager.writeState.sourceVersion = sourceVersion;
			manager.persist = true;
			manager.sessionId = header.id;
			manager.sessionFile = owner.journalPath;
			manager.fileEntries = entries;
			manager.writeState.owner = owner;
			manager.writeState.sequence = owner.nextSequence - 1;
			manager._buildIndex();
			return manager;
		} catch (error) {
			await owner.close().catch(() => undefined);
			throw error;
		}
	}

	static async openAsync(path: string, sessionDir?: string, cwdOverride?: string): Promise<SessionManager> {
		return SessionManager.open(path, sessionDir, cwdOverride);
	}

	static async openReadOnly(path: string, sessionDir?: string, cwdOverride?: string): Promise<SessionManager> {
		const target = realpathIfPresent(resolve(path));
		const entries = await loadEntriesFromFileAsync(target);
		const header = entries[0];
		if (!header || header.type !== "session" || typeof header.id !== "string")
			throw new Error(`Session source has no valid header: ${target}`);
		const sourceVersion = header.version ?? 1;
		if (sourceVersion > CURRENT_SESSION_VERSION) throw new Error(`Unsupported session version: ${sourceVersion}`);
		migrateToCurrentVersion(entries);
		if (header.parentSession && !isValidRlmDepth(header.rlmDepth))
			header.rlmDepth = resolveSessionRlmDepth(header, target);
		const manager = new SessionManager(
			cwdOverride ?? header.cwd ?? process.cwd(),
			sessionDir ?? dirname(target),
			false,
		);
		manager.writeState.sourceVersion = sourceVersion;
		manager.persist = true;
		manager.readOnly = true;
		manager.sessionId = header.id;
		manager.sessionFile = target;
		manager.fileEntries = entries;
		manager.writeState.sequence = entries.length - 1;
		manager._buildIndex();
		return manager;
	}

	static async continueRecent(cwd: string, sessionDir?: string): Promise<SessionManager> {
		const dir = sessionDir ?? getDefaultSessionDir(cwd);
		const mostRecent = findMostRecentSessionForCwd(dir, cwd);
		return mostRecent ? SessionManager.open(mostRecent, dir, cwd) : SessionManager.create(cwd, dir);
	}

	static inMemory(cwd: string = process.cwd(), sessionDir = "", options?: NewSessionOptions): SessionManager {
		return new SessionManager(cwd, sessionDir, false, options);
	}

	static async forkFrom(sourcePath: string, targetCwd: string, sessionDir?: string): Promise<SessionManager> {
		return SessionManager._copyFrom(sourcePath, targetCwd, sessionDir);
	}

	/** Explicit external import: copied payload claims cannot establish native source authority. */
	static async importRetainedFrom(
		sourcePath: string,
		targetCwd: string,
		sessionDir?: string,
	): Promise<SessionManager> {
		return SessionManager._copyFrom(sourcePath, targetCwd, sessionDir, "retained-import");
	}

	private static async _copyFrom(
		sourcePath: string,
		targetCwd: string,
		sessionDir?: string,
		retention?: JournalFrameRetention,
	): Promise<SessionManager> {
		const sourceEntries = await loadEntriesFromFileAsync(sourcePath);
		const sourceHeader = sourceEntries[0];
		if (!sourceHeader || sourceHeader.type !== "session")
			throw new Error(`Cannot fork: source session has no header: ${sourcePath}`);
		migrateToCurrentVersion(sourceEntries);
		const manager = new SessionManager(targetCwd, sessionDir ?? getDefaultSessionDir(targetCwd), true, {
			parentSession: sourcePath,
			rlmDepth: resolveSessionRlmDepth(sourceHeader, sourcePath),
		});
		// Git facts describe the source workspace; preserve other entry IDs and relink their parents.
		const dropped = new Map<string, string | null>();
		for (const entry of sourceEntries) if (entry.type === "git_state") dropped.set(entry.id, entry.parentId);
		for (const entry of sourceEntries) {
			if (entry.type === "session" || entry.type === "git_state") continue;
			let parentId = entry.parentId;
			while (parentId !== null && dropped.has(parentId)) parentId = dropped.get(parentId) ?? null;
			manager.fileEntries.push(
				withEntryRetention(
					parentId === entry.parentId ? entry : { ...entry, parentId },
					retention ?? entryRetentions.get(entry),
				),
			);
		}
		manager._buildIndex();
		await manager._openNew();
		return manager;
	}

	static async list(cwd: string, sessionDir?: string, callbacks?: SessionListCallbacks): Promise<SessionInfo[]> {
		const dir = sessionDir ?? getDefaultSessionDir(cwd);
		const matchesCwd = (session: SessionInfo) => sessionInfoMatchesCwd(session, cwd);
		const sessions = (
			await listSessionsFromDir(dir, {
				onProgress: callbacks?.onProgress,
				onSession: callbacks?.onSession
					? (session) => {
							if (matchesCwd(session)) {
								callbacks.onSession?.(session);
							}
						}
					: undefined,
			})
		).filter(matchesCwd);
		sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
		return sessions;
	}

	static async listAll(callbacks?: SessionListCallbacks, sessionDir?: string): Promise<SessionInfo[]> {
		const sessionsDir = sessionDir ?? getSessionsDir();
		const sessions = await listSessionsFromDir(sessionsDir, callbacks);
		sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
		return sessions;
	}
}
