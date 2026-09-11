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
import { type Dir, existsSync, readdirSync, readFileSync, realpathSync, type Stats, statSync } from "fs";
import { opendir, open as openFile, stat } from "fs/promises";
import { basename, dirname, join, resolve } from "path";
import { v7 as uuidv7 } from "uuid";
import { getAgentDir as getDefaultAgentDir, getSessionsDir } from "../config.js";
import { assertProductStatePath } from "../runtime-paths.js";
import { captureGitContext, type GitContext, gitContextsEqual } from "../utils/git.js";
import { stringifyBoundedJson } from "./bounded-json.js";
import type { CanonicalPayloadFragment } from "./canonical-payload-parts.js";
import {
	appendContextEpoch,
	CONTEXT_EPOCH_DETAIL,
	type ContextEpochCheckpoint,
	type ContextEpochSummary,
} from "./context-epoch.js";
import {
	type CapturedEpochCopy,
	type CopiedEpochEntry,
	captureEpochCopyEntry,
	readCopiedEpochSource,
	rebuildCopiedContextEpoch,
} from "./context-epoch-copy.js";
import { GOAL_STATE_CUSTOM_TYPE } from "./goals.js";
import type {
	ContextManifestOptions,
	ContextManifestPage,
	HistoryIndexPage,
	HistoryPayloadReadOptions,
	IndexedSourceEvent,
	TaskEvidenceOptions,
	TaskEvidencePage,
} from "./history-index.js";
import { HistoryIndex, HistoryIndexUnsupportedError } from "./history-index.js";
import {
	decodeJournalFrame,
	INITIAL_JOURNAL_CURSOR,
	type JournalFrameRetention,
	type NativeEntryQualification,
} from "./journal-frame.js";
import { type BashExecutionMessage, type CustomMessage, createCompactionSummaryMessage } from "./messages.js";
import type { ContextEpochEntryRef, NativeRequestEvent, SourceSnapshotRef } from "./request-events.js";
import {
	SELECTED_SKILL_CUSTOM_TYPE,
	SELECTED_SKILL_DETAIL,
	selectedSkillBlock,
	selectedSkillCapture,
} from "./selected-skills.js";
import { DEFAULT_NATIVE_RECOVERY_LIMITS } from "./selective-recovery.js";
import { orderContextToolResults, sessionEntryMessage } from "./session-context-messages.js";
import {
	IPYTHON_SENT_AGENT_MESSAGE_CUSTOM_ENTRY,
	type PersistedIpythonSentAgentMessage,
	parsePersistedIpythonSentAgentMessage,
} from "./session-context-updates.js";
import { bindNativeEntryWriter, type NativeEntryOrigin, type NativeEntryWriter } from "./session-entry-origin.js";
import {
	type BoundHistoryReadSink,
	type BoundSessionRequestSink,
	createBranchHistoryReadView,
	createSessionHistoryReadScope,
	type HistoryReadQuery,
	type HydratedSessionHistoryEntry,
	hydrateCapturedHistoryEntry,
	type MaterializedSessionHistory,
	SessionHistoryIndex,
	type SessionHistoryReadLimits,
	type SessionHistoryReadScope,
	type SessionHistoryReadView,
} from "./session-history-index.js";
import {
	appendCappedSearchText,
	extractOversizedMessageSummary,
	extractTextContent,
	getSessionModifiedDateFromLastActivity,
	isMessageWithContent,
	looksLikeMessageEntry,
	normalizeSessionStateStatus,
	SESSION_LIST_PARSE_MAX_LINE_CHARS,
	updateLastActivityTime,
} from "./session-info-projection.js";
import {
	APPEND_NATIVE_ADMISSION,
	APPEND_NATIVE_CONTEXT_EPOCH,
	APPEND_NATIVE_RECOVERY,
	APPEND_NATIVE_TOOL_EXECUTION,
	SESSION_JOURNAL_MAX_RECORD_BYTES as MAX_SESSION_RECORD_BYTES,
	SESSION_JOURNAL_MAX_FRAME_BYTES,
	SessionJournalOwner,
	type SessionJournalState,
} from "./session-journal-owner.js";
import {
	readCapturedSessionJournal,
	readSessionCatalogHeader,
	readSessionJournal,
	readSessionJournalHeader,
	SessionJournalDecoder,
} from "./session-journal-reader.js";
import { readTaskStateFromHistory, type TaskStateView } from "./task-state-reader.js";
import { type TaskStateReadLimits, taskStateReadLimits } from "./task-state-reducer.js";
import {
	addAssistantUsage,
	cloneUsage,
	emptyUsage,
	type SessionUsageSummary,
	sessionUsageSummaryFrom,
	subtractAssistantUsage,
} from "./usage.js";

export const CURRENT_SESSION_VERSION = 3;
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

/** One captured branch for summary input, physical requests, and the queued compaction commit. */
export interface BoundCompactionSink extends BoundSessionRequestSink {
	/** Internal explicit-copy read on this same held source, never a provider-view capability. */
	[readCopiedEpochSource]<T>(read: (history: SessionHistoryReadScope) => Promise<T>): Promise<T>;
	readBranch(): Promise<SessionEntry[]>;
	[appendContextEpoch](
		checkpoint: ContextEpochCheckpoint,
		tokensBefore: number | null,
		summary?: ContextEpochSummary,
	): Promise<string>;
	appendCompaction<T = unknown>(
		summary: string,
		firstKeptEntryId: string,
		tokensBefore: number | null,
		details?: T,
		fromHook?: boolean,
		customInstructions?: string,
		usage?: Usage,
	): Promise<string>;
}

export interface NewSessionOptions {
	id?: string;
	parentSession?: string;
	rlmDepth?: number;
}

/** Source preparation only. No destination is allocated and no activation result is predicted. */
export interface SessionImportPreview {
	sourcePath: string;
	sourceFormat: "legacy-jsonl" | "native-framed";
	inputVersion: number;
	/** Decoded records after the initial header. */
	entriesRead: number;
	/** Decoded JSON bytes including the header, not physical file bytes. */
	sourceJsonBytes: number;
	/** Prepared source entries, excluding the new header and any rebuilt epoch. */
	preparedEntryCount: number;
	targetCwd: string;
	targetDirectory: string;
	retention: "retained-import";
	sourceHeader: "replace";
	gitState: "omit-and-relink-parents";
	capture: "bounded-prefix-not-live-snapshot";
	destinationCreated: false;
	destinationCreationAndIndexing: "not-assessed";
	canonicalEpochActivation: "not-assessed";
	referenceReplayCoverage: "not-assessed";
	laterImport: "rereads-source-and-can-fail";
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
	/** Only the qualified original execution owner supplies this acknowledged source. */
	assistant?: ContextEpochEntryRef & { sessionFile: string | undefined };
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
	/** Prior-context estimate; null when the original context is not measurable. */
	tokensBefore: number | null;
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

interface CapturedForkInput {
	source?: SourceSnapshotRef;
	epochCopy?: CapturedEpochCopy;
	leafId?: string | null;
	selectedEntry?: SessionEntry;
	path: SessionEntry[];
	labels: {
		targetId: string;
		label: string;
		timestamp: string;
		retention?: JournalFrameRetention;
		qualification?: NativeEntryQualification;
	}[];
	sourceFile?: string;
	cwd: string;
	sessionDir: string;
	persist: boolean;
	rlmDepth: number | undefined;
	limits: SessionHistoryReadLimits;
}

export interface PreparedSessionFork {
	/** Present only for an owned canonical capture. */
	source?: SourceSnapshotRef;
	selectedEntry: SessionEntry;
	create(): Promise<SessionManager>;
}

export interface ChildUsageAttributionAcknowledgement {
	entryId: string;
	aggregateUsage: Usage;
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
	/** Per-row source controls, outside the unchanged entry payloads. */
	retentions: (JournalFrameRetention | null)[];
	qualifications: (NativeEntryQualification | null)[];
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
	| "readEntry"
	| "readLeafEntry"
	| "readEntryRetention"
	| "readLabel"
	| "readBranch"
	| "readBranches"
	| "readEntries"
	| "readFlatTree"
	| "readTree"
	| "readToolExchange"
	| "supportsCapturedHistoryReads"
	| "materializeResidentHistory"
	| "readBranchHistory"
	| "readSourceHistory"
	| "materializeParentPathHistory"
	| "materializeBranchHistory"
	| "materializeSourceHistory"
	| "getHeader"
	| "getCompactionCount"
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

export function applyChildUsageAttributions(entries: FileEntry[]): void {
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
const entryQualifications = new WeakMap<FileEntry, NativeEntryQualification>();

function withEntryRetention<T extends FileEntry>(
	entry: T,
	retention?: JournalFrameRetention,
	qualification?: NativeEntryQualification,
): T {
	if (retention !== undefined) entryRetentions.set(entry, retention);
	if (qualification !== undefined) entryQualifications.set(entry, qualification);
	return entry;
}

function sessionFileEntry(
	value: unknown,
	retention?: JournalFrameRetention,
	qualification?: NativeEntryQualification,
): FileEntry {
	if (!value || typeof value !== "object" || !("type" in value) || typeof value.type !== "string")
		throw new Error("Invalid session journal entry");
	return withEntryRetention(value as FileEntry, retention, qualification);
}

function appendSourceEntry(owner: SessionJournalOwner, json: string, entry: FileEntry): Promise<{ sequence: number }> {
	const qualification = entryQualifications.get(entry);
	if (qualification === "native-admission") return owner[APPEND_NATIVE_ADMISSION](json, entryRetentions.get(entry));
	if (qualification === "native-recovery") return owner[APPEND_NATIVE_RECOVERY](json, entryRetentions.get(entry));
	if (qualification === "native-context-epoch")
		return owner[APPEND_NATIVE_CONTEXT_EPOCH](json, entryRetentions.get(entry));
	if (qualification === "native-tool-execution")
		return owner[APPEND_NATIVE_TOOL_EXECUTION](json, entryRetentions.get(entry));
	return owner.appendJson(json, entryRetentions.get(entry));
}

function parseEntriesFromBuffer(buffer: Buffer): FileEntry[] {
	const decoder = new SessionJournalDecoder();
	const entries: FileEntry[] = [];
	let start = 0;
	while (start < buffer.length) {
		const end = buffer.indexOf(0x0a, start);
		if (end === -1) break; // Only exclusive recovery may change an incomplete tail.
		const record = decoder.decode(buffer.subarray(start, end + 1));
		if (record) entries.push(sessionFileEntry(record.entry, record.retention, record.qualification));
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
		entries.push(sessionFileEntry(record.entry, record.retention, record.qualification));
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

/** Native catalog pages visit the existing directories without an all-paths array. */
export async function* iterateSessionCatalogFiles(sessionDir: string): AsyncGenerator<string> {
	const entries = async function* (directory: string) {
		let handle: Dir;
		try {
			handle = await opendir(directory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		for await (const entry of handle) yield entry;
	};
	for await (const entry of entries(sessionDir)) if (entry.name.endsWith(".jsonl")) yield join(sessionDir, entry.name);
	// Match the existing catalog's root-files, project-directories, legacy-files order.
	for await (const entry of entries(sessionDir)) {
		if (entry.isDirectory() && /^--.+--$/.test(entry.name)) {
			const directory = join(sessionDir, entry.name);
			for await (const child of entries(directory))
				if (child.name.endsWith(".jsonl")) yield join(directory, child.name);
		}
	}
	if (resolve(sessionDir) === resolve(getSessionsDir())) {
		for await (const entry of entries(getDefaultAgentDir()))
			if (entry.name.endsWith(".jsonl")) yield join(getDefaultAgentDir(), entry.name);
	}
}

/** Directory membership only; the existing source reader still decides readability. */
export function isSessionCatalogFile(path: string, sessionDir: string): boolean {
	const directory = dirname(resolve(path));
	const root = resolve(sessionDir);
	return (
		path.endsWith(".jsonl") &&
		(directory === root ||
			(dirname(directory) === root && /^--.+--$/.test(basename(directory))) ||
			(root === resolve(getSessionsDir()) && directory === resolve(getDefaultAgentDir())))
	);
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

const SESSION_INFO_CACHE_MAX_ENTRIES = 256;
const SESSION_INFO_CACHE_MAX_BYTES = 4 * 1024 * 1024;

interface SessionInfoCacheEntry {
	dev: number;
	ino: number;
	nativeRevision?: string;
	size: number;
	mtimeMs: number;
	info: SessionInfo | null;
	encodedBytes: number;
}

// Optional derived metadata. Native hits also require current indexed coverage.
// The byte limit covers encoded key/stat/capture/info data, not process heap.
const sessionInfoCache = new Map<string, SessionInfoCacheEntry>();

export class SessionCatalogReadError extends Error {
	constructor(
		readonly reason: "unavailable" | "stale" | "unsupported" | "error",
		message: string,
		options?: ErrorOptions,
	) {
		super(`Native session catalog ${reason}: ${message}`, options);
		this.name = "SessionCatalogReadError";
	}
}

async function readIndexedSessionInfo(
	filePath: string,
	stats: Stats,
	header: SessionHeader,
	headerChecksum: string,
	cached?: SessionInfoCacheEntry,
): Promise<{ info: SessionInfo; revision: string; cached: boolean }> {
	const source = {
		journalPath: realpathIfPresent(resolve(filePath)),
		dev: stats.dev,
		ino: stats.ino,
		byteLength: stats.size,
		headerChecksum,
	};
	const indexPath = join(getSessionArtifactPathForFile(source.journalPath, header.id), "history.sqlite");
	let index: HistoryIndex | undefined;
	const outcome = await (async () => {
		try {
			await stat(indexPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				throw new SessionCatalogReadError("unavailable", "The existing history index is missing");
			throw error;
		}
		index = await HistoryIndex.open(indexPath, { readOnly: true });
		const capturedIndex = index;
		const view = await index.readSessionCatalog(header.id, source);
		if (view.selection !== "covered") throw new SessionCatalogReadError(view.selection, view.reason);
		const revision = view.frontier.checksum!;
		const hit =
			!!cached?.info &&
			cached.nativeRevision === revision &&
			cached.dev === stats.dev &&
			cached.ino === stats.ino &&
			cached.size === stats.size &&
			cached.mtimeMs === stats.mtimeMs;
		let info: SessionInfo;
		if (hit && cached?.info) {
			try {
				info = structuredClone(cached.info);
			} catch {
				sessionInfoCache.delete(filePath);
				info = cached.info;
			}
			if (sessionInfoCache.has(filePath)) {
				sessionInfoCache.delete(filePath);
				sessionInfoCache.set(filePath, cached);
			}
		} else {
			const read = async (ref: IndexedSourceEvent | null) =>
				ref
					? (
							await hydrateCapturedHistoryEntry(ref, MAX_SESSION_RECORD_BYTES, (id, options) =>
								capturedIndex.readSourcePayload(header.id, id, view.frontier.indexedThrough, options),
							)
						).entry
					: undefined;
			let firstMessage = "(no messages)";
			if (view.projection.firstMessage && "preview" in view.projection.firstMessage)
				firstMessage = view.projection.firstMessage.preview;
			else if (view.refs.firstMessage) {
				const entry = await read(view.refs.firstMessage);
				if (entry?.type !== "message" || entry.message.role !== "user" || !isMessageWithContent(entry.message))
					throw new Error("Indexed catalog first-message reference is invalid");
				firstMessage = extractTextContent(entry.message) || "(no messages)";
			}
			const named = await read(view.refs.name);
			if (named && named.type !== "session_info") throw new Error("Indexed catalog name reference is invalid");
			const status = await read(view.refs.agentStatus);
			if (status && status.type !== "agent_status") throw new Error("Indexed catalog status reference is invalid");
			info = {
				path: filePath,
				id: header.id,
				cwd: typeof header.cwd === "string" ? header.cwd : "",
				name: named?.type === "session_info" ? named.name?.trim() || undefined : undefined,
				state: view.projection.state,
				parentSessionPath: header.parentSession,
				rlmDepth: resolveSessionRlmDepth(header, filePath),
				created: new Date(header.timestamp),
				modified: getSessionModifiedDateFromLastActivity(view.projection.lastActivityTime, header, stats.mtime),
				messageCount: view.projection.messageCount,
				firstMessage,
				allMessagesText: view.projection.allMessagesText,
				agentStatus: status?.type === "agent_status" ? status.status : undefined,
				usage: view.projection.usage,
			};
		}
		// The same read transaction and descriptor/frontier contract must still be current
		// after bounded source-part hydration, not merely when the query began.
		const final = await index.readSessionCatalog(header.id, source);
		if (final.selection !== "covered") throw new SessionCatalogReadError(final.selection, final.reason);
		return { info, revision, cached: hit };
	})().then(
		(value) => ({ ok: true as const, value }),
		(error: unknown) => ({
			ok: false as const,
			error:
				error instanceof SessionCatalogReadError
					? error
					: error instanceof HistoryIndexUnsupportedError
						? new SessionCatalogReadError("unsupported", error.message, { cause: error })
						: new SessionCatalogReadError("error", `Indexed metadata read failed: ${String(error)}`, {
								cause: error,
							}),
		}),
	);
	try {
		await index?.close();
	} catch (error) {
		throw new SessionCatalogReadError(
			"error",
			outcome.ok
				? `Index reader close failed: ${String(error)}`
				: `Catalog read and close failed: ${String(outcome.error)}; ${String(error)}`,
			{ cause: outcome.ok ? error : new AggregateError([outcome.error, error], "Catalog read and close failed") },
		);
	}
	if (!outcome.ok) throw outcome.error;
	return outcome.value;
}

export async function readSessionInfo(filePath: string): Promise<SessionInfo | null> {
	let stats: Awaited<ReturnType<typeof stat>>;
	try {
		stats = await stat(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR")
			return null;
		throw new SessionCatalogReadError("error", `Source metadata stat failed: ${String(error)}`, { cause: error });
	}
	const cached = sessionInfoCache.get(filePath);
	if (
		cached &&
		cached.nativeRevision === undefined &&
		cached.dev === stats.dev &&
		cached.ino === stats.ino &&
		cached.size === stats.size &&
		cached.mtimeMs === stats.mtimeMs
	) {
		try {
			const info = structuredClone(cached.info);
			sessionInfoCache.delete(filePath);
			sessionInfoCache.set(filePath, cached);
			return info;
		} catch {
			// Give up cache ownership rather than lose a complete successful result.
			sessionInfoCache.delete(filePath);
			return cached.info;
		}
	}
	let nativeRevision: string | undefined;
	let info: SessionInfo | null;
	try {
		const first = readSessionCatalogHeader(filePath);
		if (first?.source) {
			const header = first.entry as SessionHeader;
			if (header?.type !== "session" || typeof header.id !== "string")
				throw new SessionCatalogReadError("unsupported", "Native source has no supported session header");
			const result = await readIndexedSessionInfo(filePath, stats, header, first.source.revision, cached);
			if (result.cached) return result.info;
			info = result.info;
			nativeRevision = result.revision;
		} else info = first ? await scanSessionInfo(filePath, stats) : null; // Explicitly legacy/invalid-header only.
	} catch (error) {
		if (error instanceof SessionCatalogReadError) throw error;
		throw new SessionCatalogReadError("error", `Source header read failed: ${String(error)}`, { cause: error });
	}
	sessionInfoCache.delete(filePath);
	try {
		const encoded = stringifyBoundedJson(
			{
				filePath,
				size: stats.size,
				mtimeMs: stats.mtimeMs,
				dev: stats.dev,
				ino: stats.ino,
				nativeRevision,
				info:
					info === null
						? null
						: {
								...info,
								created: info.created.toISOString(),
								modified: info.modified.toISOString(),
							},
			},
			SESSION_INFO_CACHE_MAX_BYTES,
		);
		const entry: SessionInfoCacheEntry = {
			size: stats.size,
			mtimeMs: stats.mtimeMs,
			dev: stats.dev,
			ino: stats.ino,
			nativeRevision,
			info: structuredClone(info),
			encodedBytes: Buffer.byteLength(encoded),
		};
		let retainedBytes = 0;
		for (const retained of sessionInfoCache.values()) retainedBytes += retained.encodedBytes;
		while (
			sessionInfoCache.size >= SESSION_INFO_CACHE_MAX_ENTRIES ||
			retainedBytes + entry.encodedBytes > SESSION_INFO_CACHE_MAX_BYTES
		) {
			const oldest = sessionInfoCache.entries().next().value;
			if (!oldest) return info;
			sessionInfoCache.delete(oldest[0]);
			retainedBytes -= oldest[1].encodedBytes;
		}
		sessionInfoCache.set(filePath, entry);
	} catch {
		// Cache admission is optional. Return the complete successful result unchanged.
	}
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

			const entry = sessionFileEntry(record.entry, record.retention, record.qualification);

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
	} catch (error) {
		if (error instanceof SessionCatalogReadError) throw error;
		// Return no sessions when the directory cannot be read.
	}

	return sessions;
}

const DEFAULT_MANAGER_HISTORY_LIMITS: SessionHistoryReadLimits = {
	maxEntries: 16_384,
	maxSourceBytes: 64 * 1024 * 1024,
};

async function readOwnedSessionHeader(snapshot: SessionJournalState): Promise<SessionHeader> {
	const handle = await openFile(snapshot.journalPath, "r");
	let capturedHeader: SessionHeader | undefined;
	try {
		const checkIdentity = async () => {
			const identity = await handle.stat();
			if (identity.dev !== snapshot.dev || identity.ino !== snapshot.ino || identity.size < snapshot.byteLength)
				throw new Error("Owned session header source identity changed");
		};
		await checkIdentity();
		const maximum = Math.min(snapshot.byteLength, SESSION_JOURNAL_MAX_FRAME_BYTES);
		const parts: Buffer[] = [];
		let offset = 0;
		while (offset < maximum) {
			const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maximum - offset));
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
			if (bytesRead === 0) break;
			const chunk = buffer.subarray(0, bytesRead);
			const end = chunk.indexOf(0x0a);
			parts.push(end < 0 ? chunk : chunk.subarray(0, end + 1));
			offset += bytesRead;
			if (end < 0) continue;
			const frame = decodeJournalFrame(
				Buffer.concat(parts),
				INITIAL_JOURNAL_CURSOR,
				SESSION_JOURNAL_MAX_FRAME_BYTES,
			);
			const header = frame.payload as SessionHeader;
			if (!header || header.type !== "session" || typeof header.id !== "string")
				throw new Error(`Session source has no valid header: ${snapshot.journalPath}`);
			await checkIdentity();
			capturedHeader = header;
			break;
		}
		if (!capturedHeader) throw new Error("Owned session header is incomplete or exceeds the frame byte limit");
	} catch (error) {
		try {
			await handle.close();
		} catch (closeError) {
			throw new AggregateError([error, closeError], "Owned session header read and close failed", { cause: error });
		}
		throw error;
	}
	await handle.close();
	return capturedHeader;
}

interface SessionWriteState {
	owner?: SessionJournalOwner;
	history?: SessionHistoryIndex;
	tail: Promise<void>;
	pending: number;
	bytes: number;
	reservedLeaf: string | null;
	leafId: string | null;
	branchSelectionRevision: number;
	pins: number;
	retired: boolean;
	closed: boolean;
	sequence: number;
	compactionCount: number;
	sessionName?: string;
	sourceVersion: number;
	header?: SessionHeader;
	sessionState?: SessionState;
	hasUserContent?: boolean;
	contentPrefix?: number;
	git?: GitContext;
	agentStatus?: AgentStatus;
	metadataRefs?: { name?: string; state?: string; git?: string; status?: string };
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
		branchSelectionRevision: 0,
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
	private freshContextPolicySource = true;
	private indexed = false;
	private header: SessionHeader | null = null;

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
				const ack = await appendSourceEntry(owner, stringifyBoundedJson(entry, MAX_SESSION_RECORD_BYTES), entry);
				state.sequence = ack.sequence;
			}
			await this._activateIndexedSource(this.fileEntries[0] as SessionHeader);
		} catch (error) {
			state.closed = true;
			try {
				await this._closeSourceActors(state);
			} catch (cleanup) {
				throw new AggregateError([error, cleanup], "Session creation and cleanup failed");
			}
			throw error;
		}
	}

	private async _adopt(next: SessionManager): Promise<void> {
		const previous = this.writeState;
		try {
			await this._retire(previous);
		} catch (error) {
			try {
				await next.close();
			} catch (cleanup) {
				throw new AggregateError([error, cleanup], "Session adoption and destination close failed");
			}
			throw error;
		}
		this.sessionId = next.sessionId;
		this.sessionFile = next.sessionFile;
		this.sessionDir = next.sessionDir;
		this.persist = next.persist;
		this.freshContextPolicySource = next.freshContextPolicySource;
		this.indexed = next.indexed;
		this.header = next.header;
		this.fileEntries = next.fileEntries;
		this.byId = next.byId;
		this.labelsById = next.labelsById;
		this.labelTimestampsById = next.labelTimestampsById;
		this.leafId = next.leafId;
		this.finalizedToolMessages = next.finalizedToolMessages;
		this.writeState = next.writeState;
	}

	private _assertResident(): void {
		if (this.indexed)
			throw new Error(
				"Synchronous history access requires a resident session view; use captured async history reads",
			);
	}

	private async _acknowledgedHistory(
		state: SessionWriteState,
		snapshot = state.owner!.getSnapshot(),
	): Promise<SessionHistoryReadScope> {
		const owner = state.owner;
		const header = state.header;
		if (!owner || !header || owner.format !== "framed" || state.sourceVersion !== CURRENT_SESSION_VERSION)
			throw new Error("An owned canonical session source is required");
		state.history ??= new SessionHistoryIndex(
			header.id,
			join(assertProductStatePath(getSessionArtifactPathForFile(owner.journalPath, header.id)), "history.sqlite"),
		);
		const index = await state.history.synchronize(snapshot);
		return createSessionHistoryReadScope(
			index,
			Object.freeze({
				sessionId: header.id,
				sessionFile: owner.journalPath,
				leafId: state.leafId,
				sourceSequence: snapshot.nextSequence - 1,
				persistent: true,
			}),
			(operation) => operation(),
			"source",
		);
	}

	private async _storedEntry(
		history: SessionHistoryReadScope,
		id: string,
		maxSourceBytes = DEFAULT_MANAGER_HISTORY_LIMITS.maxSourceBytes,
	): Promise<HydratedSessionHistoryEntry | undefined> {
		const value = await history.hydrateEntry(id, maxSourceBytes);
		if (!value || value.entry.type !== "message" || value.entry.message.role !== "assistant") return value;
		const update = await history.sourceAssistantUsage(id);
		if (!update) return value;
		if (value.source.locator.length + update.locator.length > maxSourceBytes)
			throw new Error("Stored assistant source byte budget exceeded");
		const related = await history.hydrateEntry(update.id, maxSourceBytes - value.source.locator.length);
		if (!related || related.entry.type !== "child_usage_attributed")
			throw new Error("Stored assistant aggregate source is unavailable");
		value.entry.message.usage = cloneUsage(related.entry.aggregateUsage);
		return value;
	}

	private async _refreshOwnedMetadata(state: SessionWriteState, startup = false): Promise<void> {
		const owner = state.owner!;
		const snapshot = owner.getSnapshot();
		const history = await this._acknowledgedHistory(state, snapshot);
		const bootstrap = await state.history!.currentSourceBootstrap(snapshot);
		const leafId = startup ? (bootstrap.leaf?.id ?? null) : state.leafId;
		const index = await state.history!.synchronize(snapshot);
		const branch = await index.branchBootstrap(state.header!.id, {
			leafId,
			through: history.source.sourceSequence,
		});
		const refs = [bootstrap.sessionInfo, bootstrap.sessionState, branch.gitState, branch.agentStatus];
		if (
			refs.reduce((bytes, ref) => bytes + (ref?.locator.length ?? 0), 0) >
			DEFAULT_MANAGER_HISTORY_LIMITS.maxSourceBytes
		)
			throw new Error("Owned session metadata source byte budget exceeded");
		const previous = state.metadataRefs ?? {};
		const read = async (ref: IndexedSourceEvent | null) => {
			if (!ref) return undefined;
			const value = await history.hydrateEntry(ref.id, DEFAULT_MANAGER_HISTORY_LIMITS.maxSourceBytes);
			if (!value) throw new Error("Owned session metadata source is unavailable");
			return value.entry;
		};
		if (!state.metadataRefs || previous.name !== bootstrap.sessionInfo?.revision) {
			const entry = await read(bootstrap.sessionInfo);
			state.sessionName = entry?.type === "session_info" ? entry.name : undefined;
		}
		if (!state.metadataRefs || previous.state !== bootstrap.sessionState?.revision) {
			const entry = await read(bootstrap.sessionState);
			const status = entry?.type === "session_state" ? normalizeSessionStateStatus(entry.state.status) : undefined;
			state.sessionState = status ? { status } : undefined;
		}
		if (!state.metadataRefs || previous.git !== branch.gitState?.revision) {
			const entry = await read(branch.gitState);
			state.git = entry?.type === "git_state" ? entry.git : state.header?.git;
		}
		if (!state.metadataRefs || previous.status !== branch.agentStatus?.revision) {
			const entry = await read(branch.agentStatus);
			state.agentStatus = entry?.type === "agent_status" ? { ...entry.status } : undefined;
		}
		state.metadataRefs = {
			name: bootstrap.sessionInfo?.revision,
			state: bootstrap.sessionState?.revision,
			git: branch.gitState?.revision,
			status: branch.agentStatus?.revision,
		};
		state.compactionCount = bootstrap.compactionCount;
		state.hasUserContent = bootstrap.hasUserContent;
		state.contentPrefix = bootstrap.contentPrefix;
		state.leafId = leafId;
		state.reservedLeaf = leafId;
		if (this.writeState === state) this.leafId = leafId;
	}

	private async _prepareOwnedMetadata(
		state: SessionWriteState,
		entry: SessionEntry,
		history: SessionHistoryReadScope,
		advanceLeaf: boolean,
	): Promise<
		Pick<
			SessionWriteState,
			"compactionCount" | "sessionName" | "sessionState" | "hasUserContent" | "contentPrefix" | "git" | "agentStatus"
		>
	> {
		if (state.hasUserContent === undefined || state.contentPrefix === undefined)
			throw new Error("Owned session metadata is unavailable");
		const metadata = {
			compactionCount: state.compactionCount + (entry.type === "compaction" ? 1 : 0),
			sessionName: entry.type === "session_info" ? entry.name : state.sessionName,
			sessionState: state.sessionState,
			hasUserContent: state.hasUserContent,
			contentPrefix: state.contentPrefix,
			git: state.git,
			agentStatus: state.agentStatus,
		};
		if (entry.type === "session_state") {
			const status = normalizeSessionStateStatus(entry.state?.status);
			if (status) metadata.sessionState = { status };
		}
		if (!metadata.hasUserContent && CONTENT_ENTRY_TYPES.has(entry.type)) {
			const prefix = ["model_change", "thinking_level_change", "service_tier_change"];
			while (metadata.contentPrefix < prefix.length && entry.type !== prefix[metadata.contentPrefix])
				metadata.contentPrefix++;
			if (metadata.contentPrefix < prefix.length) metadata.contentPrefix++;
			else metadata.hasUserContent = true;
		}
		if (advanceLeaf) {
			if (entry.parentId !== state.leafId) {
				const index = await state.history!.synchronize(state.owner!.getSnapshot());
				const branch = await index.branchBootstrap(state.header!.id, {
					leafId: entry.parentId,
					through: history.source.sourceSequence,
				});
				let remaining = DEFAULT_MANAGER_HISTORY_LIMITS.maxSourceBytes;
				const read = async (reference: IndexedSourceEvent | null) => {
					if (!reference) return undefined;
					const budget = remaining;
					remaining -= reference.locator.length;
					if (remaining < 0) throw new Error("Owned session metadata source byte budget exceeded");
					const hydrated = await history.hydrateEntry(reference.id, budget);
					if (!hydrated) throw new Error("Owned session metadata source is unavailable");
					return hydrated.entry;
				};
				const git = await read(branch.gitState);
				const status = await read(branch.agentStatus);
				metadata.git = git?.type === "git_state" ? git.git : state.header?.git;
				metadata.agentStatus = status?.type === "agent_status" ? { ...status.status } : undefined;
			}
			if (entry.type === "git_state") metadata.git = entry.git;
			if (entry.type === "agent_status") metadata.agentStatus = { ...entry.status };
		}
		return metadata;
	}

	private async _activateIndexedSource(header: SessionHeader, state = this.writeState): Promise<void> {
		state.header = header;
		await this._refreshOwnedMetadata(state, true);
		this.writeState = state;
		this.header = header;
		this.leafId = state.leafId;
		this.fileEntries = [];
		this.byId.clear();
		this.labelsById.clear();
		this.labelTimestampsById.clear();
		this.indexed = true;
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

	/** Actual new-owner creation plus the existing canonical bootstrap-content boundary. */
	canSeedContextModeContract(): boolean {
		return this.freshContextPolicySource && !this.readOnly && !this.hasUserContent();
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
			const captured = this.materializeResidentHistory(DEFAULT_MANAGER_HISTORY_LIMITS);
			next.fileEntries.push(
				...captured.entries.map((entry, index) =>
					withEntryRetention(
						entry,
						captured.retentions[index] ?? undefined,
						captured.qualifications[index] ?? undefined,
					),
				),
			);
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

	/** Complete bounded structured task reduction on one captured native branch. */
	async readTaskState(limits: Partial<TaskStateReadLimits> = {}): Promise<TaskStateView> {
		const captured = taskStateReadLimits(limits);
		if (!this.supportsCapturedHistoryReads())
			throw new Error("Task-state reduction requires captured native history");
		return this.readSourceHistory((history) => readTaskStateFromHistory(history, captured));
	}

	/** Complete actual parent chain, excluding merely attached request evidence. */
	private async _materializeParentPath(
		view: SessionHistoryReadScope,
		leafId: string | null,
		limits: SessionHistoryReadLimits,
	): Promise<Omit<MaterializedSessionHistory, "scope">> {
		const { maxEntries, maxSourceBytes } = limits;
		if (
			!Number.isSafeInteger(maxEntries) ||
			maxEntries <= 0 ||
			!Number.isSafeInteger(maxSourceBytes) ||
			maxSourceBytes <= 0
		)
			throw new Error("Invalid parent-path materialization limits");
		const entries: MaterializedSessionHistory["entries"] = [];
		let sourceBytes = 0;
		let page = await view.parentPathFrom(leafId);
		for (;;) {
			if (page.totalEntries > maxEntries) throw new Error("Parent-path entry budget exceeded");
			for (const ref of page.events) {
				if (entries.length >= maxEntries) throw new Error("Parent-path entry budget exceeded");
				const remaining = maxSourceBytes - sourceBytes;
				sourceBytes += ref.locator.length;
				if (sourceBytes > maxSourceBytes) throw new Error("Parent-path source byte budget exceeded");
				const hydrated = await view.hydrateEntry(ref.id, remaining);
				if (!hydrated) throw new Error("Parent-path entry source is unavailable");
				entries.push(hydrated);
			}
			if (!page.nextCursor) return { source: view.source, entries, sourceBytes };
			page = await view.parentPathFrom(leafId, { cursor: page.nextCursor });
		}
	}

	async materializeParentPathHistory(
		limits: SessionHistoryReadLimits,
	): Promise<Omit<MaterializedSessionHistory, "scope">> {
		const capturedLimits = { ...limits };
		return this.readSourceHistory((history) =>
			this._materializeParentPath(history, history.source.leafId, capturedLimits),
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
		if (state.pins > 0) throw new Error("Drain captured requests before migrating session history");
		this.switching = true;
		try {
			await this._enqueue(state, 0, async () => {
				if (!state.owner) throw new Error("An owned persistent source is required for migration");
				if (state.sourceVersion !== CURRENT_SESSION_VERSION)
					throw new Error("Legacy session payload requires an explicit retained import before writing");
				try {
					await state.owner.migrateLegacy();
					state.sequence = state.owner.nextSequence - 1;
					await this._activateIndexedSource(this.getHeader()!, state);
					this._publishHistory(state);
				} catch (error) {
					state.failure = new Error("Session source migration failed; outcome may be unknown", { cause: error });
					throw error;
				}
			});
		} finally {
			this.switching = false;
		}
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
			const state = newSessionWriteState();
			state.owner = owner;
			try {
				await owner.recover();
				let residentEntries: FileEntry[] | undefined;
				let header: SessionHeader;
				if (owner.format === "framed") header = await readOwnedSessionHeader(owner.getSnapshot());
				else {
					residentEntries = await loadEntriesFromFileAsync(owner.journalPath);
					const first = residentEntries[0];
					if (!first || first.type !== "session") throw new Error("Recovered source has no valid header");
					header = first;
				}
				if (header.id !== this.sessionId) throw new Error("Recovered source identity does not match this session");
				state.sequence = owner.nextSequence - 1;
				state.sourceVersion = header.version ?? 1;
				if (owner.format === "framed" && state.sourceVersion === CURRENT_SESSION_VERSION)
					await this._activateIndexedSource(header, state);
				else {
					const entries = residentEntries ?? (await loadEntriesFromFileAsync(owner.journalPath));
					migrateToCurrentVersion(entries);
					this.indexed = false;
					this.fileEntries = entries;
					this.writeState = state;
					this._buildIndex();
				}
				this.finalizedToolMessages = new WeakMap();
			} catch (error) {
				try {
					await this._closeSourceActors(state);
				} catch (cleanup) {
					throw new AggregateError([error, cleanup], "Session recovery and cleanup failed");
				}
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

	private async _appendIndexedEntry(
		state: SessionWriteState,
		entry: SessionEntry,
		explicitParent = false,
		prepare?: (snapshot: SessionEntry) => void | Promise<void>,
		onDuplicate?: (entry: SessionEntry) => SessionEntry,
		advanceLeaf = true,
		deduplicate?: (history: SessionHistoryReadScope) => Promise<SessionEntry | undefined>,
		assertCurrent?: () => void,
	): Promise<SessionEntry> {
		if (state.failure) throw state.failure;
		const generated = entry.id === "";
		const initial = { ...entry, parentId: explicitParent ? entry.parentId : null };
		const snapshot = withEntryRetention(
			JSON.parse(stringifyBoundedJson(initial, MAX_SESSION_RECORD_BYTES)) as SessionEntry,
			entryRetentions.get(entry),
			entryQualifications.get(entry),
		);
		const ownsPendingId = !generated && !state.pendingIds.has(snapshot.id);
		if (!generated && !ownsPendingId && !onDuplicate) throw new Error(`Duplicate session entry: ${snapshot.id}`);
		const idBytes = (id: string) => Buffer.byteLength(JSON.stringify(id));
		const parentBytes = explicitParent
			? 0
			: Math.max(38, idBytes(state.leafId ?? ""), ...Array.from(state.pendingIds, idBytes));
		const admittedBytes =
			Buffer.byteLength(stringifyBoundedJson(snapshot, MAX_SESSION_RECORD_BYTES)) +
			parentBytes +
			(generated ? 36 : 0) +
			(prepare ? 16 * 1024 : 0);
		if (state.pending >= MAX_SESSION_PENDING_OPERATIONS || state.bytes + admittedBytes > MAX_SESSION_PENDING_BYTES)
			throw new Error("Session source queue limit exceeded");
		if (ownsPendingId) state.pendingIds.add(snapshot.id);
		try {
			return await this._enqueue(state, admittedBytes, async () => {
				const history = await this._acknowledgedHistory(state);
				const duplicate = await deduplicate?.(history);
				if (duplicate) return duplicate;
				if (generated) {
					for (let attempt = 0; ; attempt++) {
						const id = attempt < 100 ? randomUUID().slice(0, 8) : randomUUID();
						if (state.pendingIds.has(id) || (await history.get(id))) {
							if (attempt >= 100) throw new Error(`Duplicate session entry: ${id}`);
							continue;
						}
						snapshot.id = id;
						state.pendingIds.add(id);
						break;
					}
				} else {
					const reference = await history.get(snapshot.id);
					if (reference) {
						if (!onDuplicate) throw new Error(`Duplicate session entry: ${snapshot.id}`);
						const existing = await history.hydrateEntry(reference.id, MAX_SESSION_RECORD_BYTES);
						if (!existing) throw new Error("Duplicate entry source is unavailable");
						return onDuplicate(existing.entry);
					}
				}
				if (!explicitParent) snapshot.parentId = state.leafId;
				if (prepare) await prepare(snapshot);
				const metadata = await this._prepareOwnedMetadata(state, snapshot, history, advanceLeaf);
				const json = stringifyBoundedJson(snapshot, Math.min(admittedBytes, MAX_SESSION_RECORD_BYTES));
				assertCurrent?.();
				try {
					const ack = await appendSourceEntry(state.owner!, json, snapshot);
					state.sequence = ack.sequence;
				} catch (error) {
					state.failure = new Error("Session source append failed; outcome may be unknown", { cause: error });
					throw error;
				}
				Object.assign(state, metadata);
				state.metadataRefs = undefined;
				if (advanceLeaf) state.leafId = snapshot.id;
				state.reservedLeaf = state.leafId;
				if (this.writeState === state) this.leafId = state.leafId;
				this._publishHistory(state);
				entry.id = snapshot.id;
				if (this.writeState === state) this._notifyPersistListeners();
				return snapshot;
			});
		} finally {
			if (generated || ownsPendingId) state.pendingIds.delete(snapshot.id);
		}
	}

	private async _appendEntry(
		entry: SessionEntry,
		explicitParent = false,
		prepare?: (snapshot: SessionEntry) => void | Promise<void>,
		onDuplicate?: (entry: SessionEntry) => SessionEntry,
		assertCurrent?: () => void,
	): Promise<SessionEntry> {
		this._assertMutable();
		if (this.indexed)
			return this._appendIndexedEntry(
				this.writeState,
				entry,
				explicitParent,
				prepare,
				onDuplicate,
				true,
				undefined,
				assertCurrent,
			);
		const state = this.writeState;
		if (state.failure) throw state.failure;
		if (state.owner?.format === "legacy") throw new Error("Session journal requires explicit legacy migration");
		if (this.byId.has(entry.id) || state.pendingIds.has(entry.id))
			throw new Error(`Duplicate session entry: ${entry.id}`);
		if (!explicitParent) entry.parentId = state.pending ? state.reservedLeaf : this.leafId;
		let json = stringifyBoundedJson(entry, MAX_SESSION_RECORD_BYTES);
		const retention = entryRetentions.get(entry);
		const snapshot = withEntryRetention(JSON.parse(json) as SessionEntry, retention, entryQualifications.get(entry));
		// Queued usage projection only changes a fixed set of numeric fields.
		let parentBytes = 0;
		if (!explicitParent) {
			parentBytes = Math.max(38, Buffer.byteLength(JSON.stringify(state.leafId)));
			for (const id of state.pendingIds) parentBytes = Math.max(parentBytes, Buffer.byteLength(JSON.stringify(id)));
		}
		const admittedBytes = Buffer.byteLength(json) + parentBytes + (prepare ? 16 * 1024 : 0);
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
				if (!explicitParent) snapshot.parentId = state.leafId;
				if (prepare) await prepare(snapshot);
				json = stringifyBoundedJson(snapshot, admittedBytes);
				assertCurrent?.();
				try {
					if (state.owner) {
						const ack = await appendSourceEntry(state.owner, json, snapshot);
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
		return snapshot;
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

	/** Capture ownership, not a history frontier: ordinary appends may finish before the checkpoint capture. */
	captureCompactionSourceOwner(): () => boolean {
		const state = this.writeState;
		const owner = state.owner;
		const sessionId = this.sessionId;
		const sessionFile = this.sessionFile;
		const selectionRevision = state.branchSelectionRevision;
		return () =>
			this.writeState === state &&
			state.owner === owner &&
			!state.retired &&
			!state.closed &&
			this.sessionId === sessionId &&
			this.sessionFile === sessionFile &&
			state.branchSelectionRevision === selectionRevision;
	}

	bindCompactionSink(limits: SessionHistoryReadLimits = DEFAULT_MANAGER_HISTORY_LIMITS): BoundCompactionSink {
		const state = this.writeState;
		const owner = state.owner;
		const sessionId = this.sessionId;
		const sessionFile = this.sessionFile;
		const indexed = this.indexed;
		const byId = this.byId;
		const capturedLimits = { ...limits };
		let residentBranch: SessionEntry[] | undefined;
		let capturedSource: SourceSnapshotRef | undefined;
		let captureFailure: unknown;
		let selectionRevision: number;
		const sink = this._bindHistorySource(
			(index, source, query) => createSessionHistoryReadScope(index, source, query, "source"),
			(source) => {
				selectionRevision = state.branchSelectionRevision;
				if (!indexed)
					residentBranch = this._readResidentBranches([source.leafId], capturedLimits, byId).branches[0];
				capturedSource = source;
			},
		);
		void sink.source.catch((error: unknown) => {
			captureFailure = error;
		});
		const appendCaptured = async (
			summary: string,
			firstKeptEntryId: string,
			tokensBefore: number | null,
			details?: unknown,
			fromHook?: boolean,
			instructions?: string,
			usage?: Usage,
			qualification?: NativeEntryQualification,
		): Promise<string> => {
			sink.assertRetained();
			const values = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				details,
				fromHook,
				instructions,
				usage: usage ? cloneUsage(usage) : undefined,
			};
			const snapshot = JSON.parse(stringifyBoundedJson(values, MAX_SESSION_RECORD_BYTES)) as typeof values;
			const assertCurrent = () => {
				if (captureFailure !== undefined) throw captureFailure;
				if (qualification === "native-context-epoch") {
					const epoch = (snapshot.details as { [CONTEXT_EPOCH_DETAIL]: ContextEpochCheckpoint })[
						CONTEXT_EPOCH_DETAIL
					];
					if (JSON.stringify(epoch.source) !== JSON.stringify(capturedSource))
						throw new Error("Context epoch does not match the bound source capture");
				}
				if (
					!capturedSource ||
					this.writeState !== state ||
					state.owner !== owner ||
					state.retired ||
					state.closed ||
					this.sessionId !== sessionId ||
					this.sessionFile !== sessionFile ||
					state.branchSelectionRevision !== selectionRevision ||
					state.leafId !== capturedSource.leafId
				)
					throw new Error("Compaction source or branch changed");
			};
			// Admission is synchronous; this append queues behind the capture before release can drain it.
			const args = [
				snapshot.summary,
				snapshot.firstKeptEntryId,
				snapshot.tokensBefore,
				snapshot.details,
				snapshot.fromHook,
				snapshot.instructions,
				snapshot.usage,
				assertCurrent,
			] as const;
			return qualification ? this._appendCompaction(...args, qualification) : this.appendCompaction(...args);
		};
		return {
			...sink,
			readHistory: (read) => sink.readHistory((history) => read(history.branchContext)),
			[readCopiedEpochSource]: (read) => sink.readHistory(read),
			readBranch: async () => {
				if (indexed)
					return sink.readHistory(
						async (history) =>
							(await this._readBranchesAt(history, [history.source.leafId], capturedLimits)).branches[0],
					);
				sink.assertRetained();
				await sink.source;
				return residentBranch!.map((entry) =>
					withEntryRetention(
						JSON.parse(stringifyBoundedJson(entry, capturedLimits.maxSourceBytes)) as SessionEntry,
						entryRetentions.get(entry),
						entryQualifications.get(entry),
					),
				);
			},
			appendCompaction: appendCaptured,
			[appendContextEpoch]: (checkpoint, tokensBefore, summary) => {
				if (checkpoint.policyOnly && (tokensBefore !== null || summary !== undefined))
					throw new Error("Context mode policy ACK is not a measured request or summary");
				if (Boolean(summary) !== Boolean(checkpoint.includeSummary))
					throw new Error("Context epoch summary does not match its rendering plan");
				return appendCaptured(
					summary?.summary ?? "",
					checkpoint.literalTailId,
					tokensBefore,
					{ ...summary?.details, [CONTEXT_EPOCH_DETAIL]: checkpoint },
					summary?.fromHook ?? false,
					summary?.customInstructions,
					summary?.usage,
					"native-context-epoch",
				);
			},
		};
	}

	private _bindHistorySource<View>(
		createView: (index: HistoryIndex, source: SourceSnapshotRef, query: HistoryReadQuery) => View,
		onCapture?: (source: SourceSnapshotRef) => void,
	): BoundHistoryReadSink<View> & { assertRetained(): void } {
		this._assertMutable();
		const state = this.writeState;
		const sourceFile =
			state.owner?.journalPath ?? (this.sessionFile ? realpathIfPresent(resolve(this.sessionFile)) : undefined);
		const sessionId = this.sessionId;
		const persistent = this.persist;
		const indexed = this.indexed;
		const entries = this.fileEntries;
		const byId = this.byId;
		let held = false;
		const retain = () => {
			if (held) return;
			if (state.closed || state.closing) throw new Error("Captured session source owner is closed");
			held = true;
			state.pins++;
		};
		const assertRetained = () => {
			if (!held) throw new Error("Captured request sink is not retained");
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
			const snapshot = state.owner?.getSnapshot();
			onCapture?.(source);
			return { source, snapshot };
		});
		const source = captured.then((value) => value.source);
		// A captured auxiliary operation can await UI work before consuming its barrier.
		void source.catch(() => undefined);
		return {
			source,
			assertRetained,
			readHistory: async <T>(read: (view: View) => Promise<T>): Promise<T> => {
				assertRetained();
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
				assertRetained();
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
				if (indexed) {
					await this._appendIndexedEntry(
						state,
						entry,
						true,
						undefined,
						(existing) => {
							if (existing.type !== "request" || !isDeepStrictEqual(existing.request, request))
								throw new Error(`Conflicting request event: ${id}`);
							return existing;
						},
						false,
					);
					return;
				}
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

	appendToolInvocation(invocation: ToolInvocation): Promise<string> {
		return this._appendToolInvocation(invocation);
	}

	private async _appendToolInvocation(
		invocation: ToolInvocation,
		assistant?: ContextEpochEntryRef & { sessionFile: string | undefined },
	): Promise<string> {
		const id = `${invocation.executionId}:intent`;
		if (!this.indexed && this.byId.has(id))
			throw new Error(`Tool invocation already admitted: ${invocation.executionId}`);
		const entry: ToolIntentEntry = {
			type: "tool_intent",
			id,
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			invocation: structuredClone(invocation),
			...(assistant ? { assistant: { ...assistant } } : {}),
		};
		await this._appendEntry(
			withEntryRetention(entry, undefined, assistant ? "native-tool-execution" : undefined),
			false,
			undefined,
			() => {
				throw new Error(`Tool invocation already admitted: ${invocation.executionId}`);
			},
		);
		return entry.id;
	}

	appendToolExchange(exchange: FinalizedToolExchange): Promise<string> {
		return this._appendToolExchangeOnce(exchange);
	}

	private _appendToolExchangeOnce(
		exchange: FinalizedToolExchange,
		qualification?: "native-recovery" | "native-tool-execution",
	): Promise<string> {
		const executionId = exchange.executionId;
		const pending = this.pendingToolExchanges.get(executionId);
		if (pending) return pending;
		const result = this._appendToolExchange(exchange, qualification).finally(() => {
			this.pendingToolExchanges.delete(executionId);
		});
		this.pendingToolExchanges.set(executionId, result);
		return result;
	}

	private async _appendToolExchange(
		exchange: FinalizedToolExchange,
		qualification?: "native-recovery" | "native-tool-execution",
	): Promise<string> {
		if (this.indexed) {
			const state = this.writeState;
			const executionId = exchange.executionId;
			const { result, originalInput, executedInput, ...rest } = exchange;
			const outcome = structuredClone(rest);
			const entry: SessionMessageEntry = {
				type: "message",
				id: executionId,
				parentId: this.leafId,
				timestamp: new Date().toISOString(),
				message: structuredClone(result),
				execution: structuredClone({
					...outcome,
					originalInput,
					...(exchange.executionOutcome === "not_started" ? {} : { executedInput }),
				}),
			};
			const acknowledged = await this._appendEntry(
				withEntryRetention(entry, undefined, qualification),
				false,
				async (snapshot) => {
					const invocationId = `${executionId}:intent`;
					const history = await this._acknowledgedHistory(state);
					if (await history.get(invocationId))
						(snapshot as SessionMessageEntry).execution = { ...outcome, invocationId };
				},
				(existing) => {
					if (existing.type !== "message" || existing.execution?.executionId !== executionId)
						throw new Error(`Conflicting tool execution ID: ${executionId}`);
					return existing;
				},
			);
			this.finalizedToolMessages.set(result, acknowledged.id);
			return acknowledged.id;
		}

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
		await this._appendEntry(withEntryRetention(entry, undefined, qualification));
		finalized.set(result, entry.id);
		return entry.id;
	}

	getToolExchange(executionId: string): FinalizedToolExchange | undefined {
		this._assertResident();
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

	/** Internal native admission. Ordinary append arguments remain descriptive JSON. */
	[bindNativeEntryWriter](): NativeEntryWriter {
		this._assertMutable();
		const state = this.writeState;
		const assertWriter = () => {
			this._assertMutable();
			if (this.writeState !== state || state.retired || state.closed)
				throw new Error("Session source changed after native admission capture");
		};
		return {
			captureSkillSelection: () => ({
				assertCurrent: assertWriter,
				append: (capture, producer) => {
					assertWriter();
					if (producer === "command")
						return this._appendCustomEntry(
							SELECTED_SKILL_CUSTOM_TYPE,
							{
								content: capture.content,
								[SELECTED_SKILL_DETAIL]: {
									version: 1,
									producer,
									descriptor: structuredClone(capture.descriptor),
								},
							},
							undefined,
							"native-recovery",
							{ maxSourceBytes: DEFAULT_NATIVE_RECOVERY_LIMITS.maxSourceBytes, assertCurrent: assertWriter },
						);
					return this._appendCustomMessageEntry(
						SELECTED_SKILL_CUSTOM_TYPE,
						capture.content,
						false,
						{
							[SELECTED_SKILL_DETAIL]: { version: 1, producer, descriptor: structuredClone(capture.descriptor) },
						},
						undefined,
						"native-recovery",
						{ maxSourceBytes: DEFAULT_NATIVE_RECOVERY_LIMITS.maxSourceBytes, assertCurrent: assertWriter },
					);
				},
			}),
			captureToolInvocation: (assistant) => {
				const captured = assistant ? { ...assistant } : undefined;
				if (
					captured &&
					(captured.sessionId !== this.getSessionId() ||
						typeof captured.sessionFile !== "string" ||
						captured.sessionFile !== this.getSessionFile())
				)
					throw new Error("Tool intent belongs to another assistant owner");
				return (invocation) => {
					assertWriter();
					return this._appendToolInvocation(invocation, captured);
				};
			},
			captureToolExchange: (executionId) => (exchange) => {
				assertWriter();
				if (exchange.executionId !== executionId) throw new Error("Tool execution identity changed");
				return this._appendToolExchangeOnce(exchange, "native-tool-execution");
			},
			captureRecoveryExchange: (executionId) => (exchange) => {
				assertWriter();
				if (exchange.executionId !== executionId) throw new Error("Recovery execution identity changed");
				return this._appendToolExchangeOnce(exchange, "native-recovery");
			},
			captureMessage: (origin) => {
				const captured = JSON.parse(stringifyBoundedJson(origin, MAX_SESSION_RECORD_BYTES)) as typeof origin;
				return async (message) => {
					assertWriter();
					let applied = captured;
					const selectedSkillRef = captured.selectedSkillRef;
					if (selectedSkillRef) {
						if (
							selectedSkillRef.sessionId !== this.getSessionId() ||
							selectedSkillRef.sessionFile !== this.getSessionFile()
						)
							throw new Error("Native input skill capture belongs to another source");
						const source = await this.readBranchHistory((history) =>
							history.hydrateEntry(selectedSkillRef.entryId, DEFAULT_NATIVE_RECOVERY_LIMITS.maxSourceBytes),
						);
						assertWriter();
						const skill =
							source?.source.qualification === "native-recovery"
								? selectedSkillCapture(source.entry)
								: undefined;
						if (!skill) throw new Error("Native input selected skill source is unavailable");
						const texts =
							typeof message.content === "string"
								? [message.content]
								: message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
						// This only drops a real producer binding after a body replacement; copied text cannot add one.
						if (!texts.some((text) => text.includes(selectedSkillBlock(skill, selectedSkillRef.entryId))))
							applied = { ...captured, selectedSkillRef: undefined };
					}
					// Hooks may replace the body. Input/task admission stays on the original action/record.
					return message.role === "custom"
						? this._appendCustomMessageEntry(
								message.customType,
								message.content,
								message.display,
								message.details,
								applied,
								"native-admission",
							)
						: this._appendMessage(message, applied, "native-admission");
				};
			},
			captureGoalOperation: (origin) => {
				const captured = JSON.parse(stringifyBoundedJson(origin, MAX_SESSION_RECORD_BYTES)) as typeof origin;
				return (goal) => {
					assertWriter();
					return this._appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, goal, captured, "native-admission");
				};
			},
		};
	}

	appendMessage(
		message: Message | CustomMessage | BashExecutionMessage,
		nativeOrigin?: NativeEntryOrigin,
	): Promise<string> {
		return this._appendMessage(message, nativeOrigin);
	}

	private async _appendMessage(
		message: Message | CustomMessage | BashExecutionMessage,
		nativeOrigin?: NativeEntryOrigin,
		qualification?: NativeEntryQualification,
	): Promise<string> {
		const finalized = this.finalizedToolMessages.get(message);
		if (finalized) return finalized;
		const entry: SessionMessageEntry = {
			type: "message",
			id: this.indexed ? "" : generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			message,
			...(nativeOrigin ? { nativeOrigin } : {}),
		};
		await this._appendEntry(withEntryRetention(entry, undefined, qualification));
		return entry.id;
	}

	async appendThinkingLevelChange(thinkingLevel: string): Promise<string> {
		const entry: ThinkingLevelChangeEntry = {
			type: "thinking_level_change",
			id: this.indexed ? "" : generateId(this.byId),
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
			id: this.indexed ? "" : generateId(this.byId),
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
			id: this.indexed ? "" : generateId(this.byId),
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
		tokensBefore: number | null,
		details?: T,
		fromHook?: boolean,
		customInstructions?: string,
		usage?: Usage,
		assertCurrent?: () => void,
	): Promise<string> {
		return this._appendCompaction(
			summary,
			firstKeptEntryId,
			tokensBefore,
			details,
			fromHook,
			customInstructions,
			usage,
			assertCurrent,
		);
	}

	private async _appendCompaction<T = unknown>(
		summary: string,
		firstKeptEntryId: string,
		tokensBefore: number | null,
		details?: T,
		fromHook?: boolean,
		customInstructions?: string,
		usage?: Usage,
		assertCurrent?: () => void,
		qualification?: NativeEntryQualification,
	): Promise<string> {
		const entry: CompactionEntry<T> = {
			type: "compaction",
			id: this.indexed ? "" : generateId(this.byId),
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
		await this._appendEntry(
			withEntryRetention(entry, undefined, qualification),
			false,
			undefined,
			undefined,
			assertCurrent,
		);
		return entry.id;
	}

	appendCustomEntry(customType: string, data?: unknown, nativeOrigin?: NativeEntryOrigin): Promise<string> {
		return this._appendCustomEntry(customType, data, nativeOrigin);
	}

	private async _appendCustomEntry(
		customType: string,
		data?: unknown,
		nativeOrigin?: NativeEntryOrigin,
		qualification?: NativeEntryQualification,
		selection?: { maxSourceBytes: number; assertCurrent: () => void },
	): Promise<string> {
		const entry: CustomEntry = {
			type: "custom",
			customType,
			data,
			...(nativeOrigin ? { nativeOrigin } : {}),
			id: this.indexed ? "" : generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
		};
		await this._appendEntry(
			withEntryRetention(entry, undefined, qualification),
			false,
			selection
				? (snapshot) => {
						stringifyBoundedJson(snapshot, selection.maxSourceBytes);
					}
				: undefined,
			undefined,
			selection?.assertCurrent,
		);
		return entry.id;
	}

	async appendIpythonSentAgentMessage(
		data: PersistedIpythonSentAgentMessage,
	): Promise<{ entryId: string; appended: boolean }> {
		this._assertMutable();
		if (!this.indexed) throw new Error("Atomic IPython message append requires an indexed owned source");
		const captured = parsePersistedIpythonSentAgentMessage(structuredClone(data));
		if (!captured) throw new Error("Invalid persisted IPython sent message");
		const state = this.writeState;
		const entry: CustomEntry<PersistedIpythonSentAgentMessage> = {
			type: "custom",
			id: "",
			parentId: state.leafId,
			timestamp: new Date().toISOString(),
			customType: IPYTHON_SENT_AGENT_MESSAGE_CUSTOM_ENTRY,
			data: captured,
		};
		let appended = true;
		const acknowledged = await this._appendIndexedEntry(
			state,
			entry,
			false,
			undefined,
			undefined,
			true,
			async (history) => {
				let page = await history.ipythonSentMessages(captured.toolCallId, { messageId: captured.message.id });
				for (;;) {
					const reference = page.refs[0];
					if (reference) {
						const value = await history.hydrateEntry(reference.entryId, MAX_SESSION_RECORD_BYTES);
						if (!value) throw new Error("IPython sent message source is unavailable");
						appended = false;
						return value.entry;
					}
					if (!page.nextCursor) return undefined;
					page = await history.ipythonSentMessages(captured.toolCallId, {
						messageId: captured.message.id,
						cursor: page.nextCursor,
					});
				}
			},
		);
		return { entryId: acknowledged.id, appended };
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
		return (await this.appendChildUsageAttributionWithAggregate(targetId, childUsage, aggregateUsage, origin))
			.entryId;
	}

	async appendChildUsageAttributionWithAggregate(
		targetId: string,
		childUsage: Usage,
		aggregateUsage?: Usage,
		origin?: ChildUsageAttributionEntry["origin"],
	): Promise<ChildUsageAttributionAcknowledgement> {
		const state = this.writeState;
		const indexed = this.indexed;
		const residentTarget = indexed ? undefined : this.byId.get(targetId);
		if (!indexed && (residentTarget?.type !== "message" || residentTarget.message.role !== "assistant"))
			throw new Error(`Assistant message entry ${targetId} not found`);
		const entry: ChildUsageAttributionEntry = {
			type: "child_usage_attributed",
			id: indexed ? "" : generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			targetId,
			childUsage: cloneUsage(childUsage),
			aggregateUsage: cloneUsage(aggregateUsage ?? emptyUsage()),
			...(origin ? { origin } : {}),
		};
		const acknowledged = await this._appendEntry(entry, false, async (snapshot) => {
			if (snapshot.type !== "child_usage_attributed") throw new Error("Expected child usage projection");
			let target = residentTarget;
			let history: SessionHistoryReadScope | undefined;
			if (indexed) {
				history = await this._acknowledgedHistory(state);
				target = (await history.hydrateEntry(targetId, MAX_SESSION_RECORD_BYTES))?.entry;
			}
			if (target?.type !== "message" || target.message.role !== "assistant")
				throw new Error(`Assistant message entry ${targetId} not found`);
			if (aggregateUsage === undefined) {
				let usage = target.message.usage;
				if (history) {
					const reference = await history.sourceAssistantUsage(targetId);
					if (reference) {
						const aggregate = await history.hydrateEntry(reference.id, MAX_SESSION_RECORD_BYTES);
						if (!aggregate || aggregate.entry.type !== "child_usage_attributed")
							throw new Error("Stored assistant aggregate source is unavailable");
						usage = cloneUsage(aggregate.entry.aggregateUsage);
					}
				}
				const total = cloneUsage(usage);
				const contextTokens = total.totalTokens || total.input + total.output + total.cacheRead + total.cacheWrite;
				addAssistantUsage(total, snapshot.childUsage);
				total.totalTokens = contextTokens;
				snapshot.aggregateUsage = total;
			}
		});
		return {
			entryId: acknowledged.id,
			aggregateUsage: cloneUsage((acknowledged as ChildUsageAttributionEntry).aggregateUsage),
		};
	}

	async appendSessionInfo(name: string): Promise<string> {
		const entry: SessionInfoEntry = {
			type: "session_info",
			id: this.indexed ? "" : generateId(this.byId),
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
			id: this.indexed ? "" : generateId(this.byId),
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
		if (this.indexed) {
			const state = this.writeState.sessionState;
			return state ? { ...state } : undefined;
		}
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
		if (this.indexed) {
			if (this.writeState.hasUserContent === undefined) throw new Error("Owned session metadata is unavailable");
			return this.writeState.hasUserContent;
		}
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
			id: this.indexed ? "" : generateId(this.byId),
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
			id: this.indexed ? "" : generateId(this.byId),
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
		if (this.indexed) return this.writeState.git;
		let current = this.leafId ? this.byId.get(this.leafId) : undefined;
		while (current) {
			if (current.type === "git_state") return current.git;
			current = current.parentId ? this.byId.get(current.parentId) : undefined;
		}
		const header = this.fileEntries[0];
		return header?.type === "session" ? header.git : undefined;
	}

	getLatestAgentStatus(): AgentStatus | undefined {
		if (this.indexed) return this.writeState.agentStatus ? { ...this.writeState.agentStatus } : undefined;
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

	appendCustomMessageEntry<T = unknown>(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: T,
		nativeOrigin?: NativeEntryOrigin,
	): Promise<string> {
		return this._appendCustomMessageEntry(customType, content, display, details, nativeOrigin);
	}

	private async _appendCustomMessageEntry<T = unknown>(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: T,
		nativeOrigin?: NativeEntryOrigin,
		qualification?: NativeEntryQualification,
		selection?: { maxSourceBytes: number; assertCurrent: () => void },
	): Promise<string> {
		const entry: CustomMessageEntry<T> = {
			type: "custom_message",
			customType,
			content,
			display,
			details,
			...(nativeOrigin ? { nativeOrigin } : {}),
			id: this.indexed ? "" : generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
		};
		await this._appendEntry(
			withEntryRetention(entry, undefined, qualification),
			false,
			selection
				? (snapshot) => {
						stringifyBoundedJson(snapshot, selection.maxSourceBytes);
					}
				: undefined,
			undefined,
			selection?.assertCurrent,
		);
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

	async readEntry(
		id: string,
		maxSourceBytes = DEFAULT_MANAGER_HISTORY_LIMITS.maxSourceBytes,
	): Promise<SessionEntry | undefined> {
		if (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes <= 0)
			throw new Error("Invalid history entry source byte budget");
		if (!this.indexed) {
			const entry = this.getEntry(id);
			return entry
				? withEntryRetention(
						JSON.parse(stringifyBoundedJson(entry, maxSourceBytes)) as SessionEntry,
						entryRetentions.get(entry),
						entryQualifications.get(entry),
					)
				: undefined;
		}
		return this.readSourceHistory(async (history) => {
			const value = await this._storedEntry(history, id, maxSourceBytes);
			return value ? withEntryRetention(value.entry, value.source.retention, value.source.qualification) : undefined;
		});
	}

	async readLeafEntry(
		maxSourceBytes = DEFAULT_MANAGER_HISTORY_LIMITS.maxSourceBytes,
	): Promise<SessionEntry | undefined> {
		if (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes <= 0)
			throw new Error("Invalid history entry source byte budget");
		if (!this.indexed) return this.leafId ? this.readEntry(this.leafId, maxSourceBytes) : undefined;
		return this.readSourceHistory(async (history) => {
			if (history.source.leafId === null) return undefined;
			const value = await this._storedEntry(history, history.source.leafId, maxSourceBytes);
			return value ? withEntryRetention(value.entry, value.source.retention, value.source.qualification) : undefined;
		});
	}

	async readEntryRetention(id: string): Promise<JournalFrameRetention | undefined> {
		if (!this.indexed) return this.getEntryRetention(id);
		return this.readSourceHistory(async (history) => (await history.get(id))?.retention);
	}

	async readLabel(
		id: string,
		maxSourceBytes = DEFAULT_MANAGER_HISTORY_LIMITS.maxSourceBytes,
	): Promise<string | undefined> {
		if (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes <= 0)
			throw new Error("Invalid history entry source byte budget");
		if (!this.indexed) {
			const label = this.getLabel(id);
			return label === undefined ? undefined : (JSON.parse(stringifyBoundedJson(label, maxSourceBytes)) as string);
		}
		return this.readSourceHistory(async (history) => {
			const reference = await history.sourceLabel(id);
			if (!reference) return undefined;
			const value = await history.hydrateEntry(reference.id, maxSourceBytes);
			if (!value || value.entry.type !== "label") throw new Error("Label source is unavailable");
			return value.entry.label || undefined;
		});
	}

	async readEntries(limits: SessionHistoryReadLimits = DEFAULT_MANAGER_HISTORY_LIMITS): Promise<SessionEntry[]> {
		const capturedLimits = { ...limits };
		if (!this.indexed) {
			const resident = this.materializeResidentHistory(capturedLimits);
			return resident.entries.map((entry, index) =>
				withEntryRetention(
					entry,
					resident.retentions[index] ?? undefined,
					resident.qualifications[index] ?? undefined,
				),
			);
		}
		return this.readSourceHistory(async (history) => {
			const result = await history.materialize(capturedLimits);
			const entries = result.entries.map(({ entry, source }) =>
				withEntryRetention(entry, source.retention, source.qualification),
			);
			applyChildUsageAttributions(entries);
			return entries;
		});
	}

	private async _readBranchesAt(
		history: SessionHistoryReadScope,
		leafIds: readonly (string | null)[],
		limits: SessionHistoryReadLimits,
	): Promise<{ source: SourceSnapshotRef; branches: SessionEntry[][]; sourceBytes: number }> {
		const { maxEntries, maxSourceBytes } = limits;
		if (
			!Number.isSafeInteger(maxEntries) ||
			maxEntries <= 0 ||
			!Number.isSafeInteger(maxSourceBytes) ||
			maxSourceBytes <= 0
		)
			throw new Error("Invalid parent-path materialization limits");
		const loaded = new Map<string, SessionEntry>();
		let sourceBytes = 0;
		const load = async (reference: IndexedSourceEvent) => {
			const existing = loaded.get(reference.id);
			if (existing) return existing;
			if (loaded.size >= maxEntries) throw new Error("Parent-path entry budget exceeded");
			const remaining = maxSourceBytes - sourceBytes;
			sourceBytes += reference.locator.length;
			if (sourceBytes > maxSourceBytes) throw new Error("Parent-path source byte budget exceeded");
			const value = await history.hydrateEntry(reference.id, remaining);
			if (!value) throw new Error("Parent-path entry source is unavailable");
			const entry = withEntryRetention(value.entry, value.source.retention, value.source.qualification);
			loaded.set(entry.id, entry);
			return entry;
		};
		const branches: SessionEntry[][] = [];
		for (const leafId of leafIds) {
			const branch: SessionEntry[] = [];
			let page = await history.parentPathFrom(leafId);
			for (;;) {
				if (page.totalEntries > maxEntries) throw new Error("Parent-path entry budget exceeded");
				for (const reference of page.events) branch.push(await load(reference));
				if (!page.nextCursor) break;
				page = await history.parentPathFrom(leafId, { cursor: page.nextCursor });
			}
			branches.push(branch);
		}
		for (const entry of loaded.values()) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const reference = await history.sourceAssistantUsage(entry.id);
			if (!reference) continue;
			const aggregate = await load(reference);
			if (aggregate.type !== "child_usage_attributed")
				throw new Error("Stored assistant aggregate source is unavailable");
			entry.message.usage = cloneUsage(aggregate.aggregateUsage);
		}
		return { source: history.source, branches, sourceBytes };
	}

	private _residentParentPath(id: string | null, byId = this.byId): SessionEntry[] {
		const entries: SessionEntry[] = [];
		const seen = new Set<string>();
		let current = id;
		while (current !== null) {
			if (seen.has(current)) throw new Error("Parent path lineage is unresolved");
			seen.add(current);
			const entry = byId.get(current);
			if (!entry) throw new Error("Parent path lineage is unresolved");
			entries.push(entry);
			current = entry.parentId;
		}
		return entries.reverse();
	}

	async readBranches(
		leafIds: readonly (string | null)[],
		limits: SessionHistoryReadLimits = DEFAULT_MANAGER_HISTORY_LIMITS,
	): Promise<{ source?: SourceSnapshotRef; branches: SessionEntry[][]; sourceBytes: number }> {
		const ids = [...leafIds];
		const capturedLimits = { ...limits };
		if (this.indexed) return this.readSourceHistory((history) => this._readBranchesAt(history, ids, capturedLimits));
		return this._readResidentBranches(ids, capturedLimits, this.byId);
	}

	private _readResidentBranches(
		ids: readonly (string | null)[],
		limits: SessionHistoryReadLimits,
		byId: Map<string, SessionEntry>,
	): { branches: SessionEntry[][]; sourceBytes: number } {
		const { maxEntries, maxSourceBytes } = limits;
		if (
			!Number.isSafeInteger(maxEntries) ||
			maxEntries <= 0 ||
			!Number.isSafeInteger(maxSourceBytes) ||
			maxSourceBytes <= 0
		)
			throw new Error("Invalid parent-path materialization limits");
		const cloned = new Map<string, SessionEntry>();
		let sourceBytes = 0;
		const branches = ids.map((id) =>
			this._residentParentPath(id, byId).map((entry) => {
				const existing = cloned.get(entry.id);
				if (existing) return existing;
				if (cloned.size >= maxEntries) throw new Error("Parent-path entry budget exceeded");
				const json = stringifyBoundedJson(entry, maxSourceBytes - sourceBytes);
				sourceBytes += Buffer.byteLength(json);
				const copy = withEntryRetention(
					JSON.parse(json) as SessionEntry,
					entryRetentions.get(entry),
					entryQualifications.get(entry),
				);
				cloned.set(copy.id, copy);
				return copy;
			}),
		);
		return { branches, sourceBytes };
	}

	async readBranch(
		fromId?: string | null,
		limits: SessionHistoryReadLimits = DEFAULT_MANAGER_HISTORY_LIMITS,
	): Promise<SessionEntry[]> {
		const capturedLimits = { ...limits };
		if (!this.indexed)
			return (await this.readBranches([fromId === undefined ? this.leafId : fromId], capturedLimits)).branches[0];
		return this.readSourceHistory(
			async (history) =>
				(
					await this._readBranchesAt(
						history,
						[fromId === undefined ? history.source.leafId : fromId],
						capturedLimits,
					)
				).branches[0],
		);
	}

	async branchTo(id: string | null): Promise<void> {
		this._assertMutable();
		if (!this.indexed) {
			if (id === null) this.resetLeaf();
			else this.branch(id);
			return;
		}
		const state = this.writeState;
		if (state.pending > 0) throw new Error("Drain session writes before changing the branch");
		await this._enqueue(state, 0, async () => {
			const history = await this._acknowledgedHistory(state);
			if (id !== null && !(await history.get(id))) throw new Error(`Entry ${id} not found`);
			const previous = state.leafId;
			state.leafId = id;
			try {
				await this._refreshOwnedMetadata(state);
				if (id !== previous) state.branchSelectionRevision++;
			} catch (error) {
				state.leafId = previous;
				throw error;
			}
		});
	}

	getLeafId(): string | null {
		return this.leafId;
	}

	getLeafEntry(): SessionEntry | undefined {
		this._assertResident();
		return this.leafId ? this.byId.get(this.leafId) : undefined;
	}

	getEntry(id: string): SessionEntry | undefined {
		this._assertResident();
		return this.byId.get(id);
	}

	getChildren(parentId: string): SessionEntry[] {
		this._assertResident();
		const children: SessionEntry[] = [];
		for (const entry of this.byId.values()) {
			if (entry.parentId === parentId) {
				children.push(entry);
			}
		}
		return children;
	}

	getLabel(id: string): string | undefined {
		this._assertResident();
		return this.labelsById.get(id);
	}

	async appendLabelChange(targetId: string, label: string | undefined): Promise<string> {
		const state = this.writeState;
		if (!this.indexed && !this.byId.has(targetId)) {
			throw new Error(`Entry ${targetId} not found`);
		}
		const entry: LabelEntry = {
			type: "label",
			id: this.indexed ? "" : generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			targetId,
			label,
		};
		await this._appendEntry(
			entry,
			false,
			this.indexed
				? async () => {
						const history = await this._acknowledgedHistory(state);
						if (!(await history.get(targetId))) throw new Error(`Entry ${targetId} not found`);
					}
				: undefined,
		);

		return entry.id;
	}

	getBranch(fromId?: string): SessionEntry[] {
		this._assertResident();
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
		this._assertResident();
		// Pass fileEntries directly rather than getEntries(): the resolved context
		// is computed from the leaf-to-root walk over byId (which already excludes
		// the header), so the entries argument is only a fallback for an undefined
		// leaf — never hit here since leafId is always set or null. Avoids an O(n)
		// array copy on every call (attach, get_session_context, agent init, ...).
		return buildSessionContext(this.fileEntries as SessionEntry[], this.leafId, this.byId);
	}

	getHeader(): SessionHeader | null {
		if (this.indexed) return this.header;
		const header = this.fileEntries.find((entry) => entry.type === "session");
		return header ? (header as SessionHeader) : null;
	}

	/** A lowering-only source qualification; absence does not establish native authorship. */
	getEntryRetention(entryId: string): JournalFrameRetention | undefined {
		this._assertResident();
		const entry = this.byId.get(entryId);
		return entry ? entryRetentions.get(entry) : undefined;
	}

	/** Whole-source count published with acknowledged entries, independent of the current branch. */
	getCompactionCount(): number {
		return this.writeState.compactionCount;
	}

	/** Complete detached snapshot of this resident view, including readonly and in-memory views. */
	materializeResidentHistory(limits: SessionHistoryReadLimits): ResidentSessionHistory {
		this._assertResident();
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
		const qualifications: (NativeEntryQualification | null)[] = [];
		for (const entry of this.fileEntries) {
			if (entry.type === "session") continue;
			if (entries.length >= maxEntries) throw new Error("Resident history entry budget exceeded");
			entries.push(clone(entry));
			retentions.push(entryRetentions.get(entry) ?? null);
			qualifications.push(entryQualifications.get(entry) ?? null);
		}
		return { header, entries, retentions, qualifications, leafId, sourceBytes };
	}

	getEntries(): SessionEntry[] {
		this._assertResident();
		return this.fileEntries.filter((e): e is SessionEntry => e.type !== "session");
	}

	async readFlatTree(
		limits: SessionHistoryReadLimits = DEFAULT_MANAGER_HISTORY_LIMITS,
	): Promise<SessionTreeFlatNode[]> {
		const entries = await this.readEntries({ ...limits });
		const byId = new Map(entries.map((entry) => [entry.id, entry]));
		const labels = new Map<string, { value: string; timestamp: string }>();
		for (const entry of entries) {
			if (entry.type !== "label") continue;
			if (entry.label) labels.set(entry.targetId, { value: entry.label, timestamp: entry.timestamp });
			else labels.delete(entry.targetId);
		}
		return entries
			.filter(
				(entry): entry is Exclude<SessionEntry, PrivateSessionEntry> =>
					entry.type !== "tool_intent" && entry.type !== "request",
			)
			.map((entry) => {
				let parentId = entry.parentId;
				let parent = parentId ? byId.get(parentId) : undefined;
				const seen = new Set<string>();
				while (parent?.type === "tool_intent" || parent?.type === "request") {
					if (seen.has(parent.id)) throw new Error("Session tree private ancestry is unresolved");
					seen.add(parent.id);
					parentId = parent.parentId;
					parent = parentId ? byId.get(parentId) : undefined;
				}
				const label = labels.get(entry.id);
				return {
					entry:
						parentId === entry.parentId
							? entry
							: withEntryRetention(
									{ ...entry, parentId },
									entryRetentions.get(entry),
									entryQualifications.get(entry),
								),
					label: label?.value,
					labelTimestamp: label?.timestamp,
				};
			});
	}

	async readTree(limits: SessionHistoryReadLimits = DEFAULT_MANAGER_HISTORY_LIMITS): Promise<SessionTreeNode[]> {
		const entries = await this.readFlatTree({ ...limits });
		const nodes = new Map<string, SessionTreeNode>();
		const roots: SessionTreeNode[] = [];
		for (const entry of entries) nodes.set(entry.entry.id, { ...entry, children: [] });
		for (const flat of entries) {
			const node = nodes.get(flat.entry.id)!;
			const parent =
				flat.entry.parentId === null || flat.entry.parentId === flat.entry.id
					? undefined
					: nodes.get(flat.entry.parentId);
			if (parent) parent.children.push(node);
			else roots.push(node);
		}
		const stack = [...roots];
		while (stack.length) {
			const node = stack.pop()!;
			node.children.sort(
				(left, right) => new Date(left.entry.timestamp).getTime() - new Date(right.entry.timestamp).getTime(),
			);
			stack.push(...node.children);
		}
		return roots;
	}

	async readToolExchange(
		executionId: string,
		maxSourceBytes = DEFAULT_MANAGER_HISTORY_LIMITS.maxSourceBytes,
	): Promise<FinalizedToolExchange | undefined> {
		if (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes <= 0)
			throw new Error("Invalid history entry source byte budget");
		if (!this.indexed) {
			const exchange = this.getToolExchange(executionId);
			return exchange
				? (JSON.parse(stringifyBoundedJson(exchange, maxSourceBytes)) as FinalizedToolExchange)
				: undefined;
		}
		return this.readSourceHistory(async (history) => {
			const value = await history.hydrateEntry(executionId, maxSourceBytes);
			const entry = value?.entry;
			if (entry?.type !== "message" || entry.message.role !== "toolResult" || !entry.execution) return undefined;
			if (!("invocationId" in entry.execution)) return { ...entry.execution, result: entry.message };
			const intentValue = await history.hydrateEntry(
				entry.execution.invocationId,
				maxSourceBytes - value!.source.locator.length,
			);
			if (intentValue?.entry.type !== "tool_intent")
				throw new Error(`Missing invocation for tool execution ${executionId}`);
			const { invocationId: _invocationId, ...outcome } = entry.execution;
			const { executedInput, ...invocation } = intentValue.entry.invocation;
			return {
				...invocation,
				...outcome,
				...(outcome.executionOutcome === "not_started" ? {} : { executedInput }),
				result: entry.message,
			};
		});
	}

	getFlatTree(): SessionTreeFlatNode[] {
		this._assertResident();
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
		this._assertResident();
		if (!this.byId.has(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		if (this.writeState.pending > 0) throw new Error("Drain session writes before changing the branch");
		if (this.writeState.leafId !== branchFromId) this.writeState.branchSelectionRevision++;
		this.leafId = branchFromId;
		this.writeState.leafId = branchFromId;
		this.writeState.reservedLeaf = branchFromId;
	}

	resetLeaf(): void {
		this._assertResident();
		if (this.writeState.pending > 0) throw new Error("Drain session writes before changing the branch");
		if (this.writeState.leafId !== null) this.writeState.branchSelectionRevision++;
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
		const state = this.writeState;
		if (!this.indexed && branchFromId !== null && !this.byId.has(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		const entry: BranchSummaryEntry = {
			type: "branch_summary",
			id: this.indexed ? "" : generateId(this.byId),
			parentId: branchFromId,
			timestamp: new Date().toISOString(),
			fromId: branchFromId ?? "root",
			summary,
			details,
			fromHook,
			usage,
		};
		await this._appendEntry(
			entry,
			true,
			this.indexed
				? async () => {
						const history = await this._acknowledgedHistory(state);
						if (branchFromId !== null) {
							if (!(await history.get(branchFromId))) throw new Error(`Entry ${branchFromId} not found`);
							await history.parentPathFrom(branchFromId, { limit: 1 });
						}
					}
				: undefined,
		);
		return entry.id;
	}

	private async _captureForkInput(
		target: { leafId: string | null } | { entryId: string; position: "before" | "at" },
		options: { persist?: boolean; sessionDir?: string; rlmDepth?: number; limits?: SessionHistoryReadLimits },
	): Promise<CapturedForkInput> {
		const limits = { ...(options.limits ?? DEFAULT_MANAGER_HISTORY_LIMITS) };
		const sourceFile = this.sessionFile;
		const header = JSON.parse(stringifyBoundedJson(this.getHeader(), limits.maxSourceBytes)) as SessionHeader | null;
		const settings = {
			sourceFile,
			cwd: this.cwd,
			sessionDir: options.sessionDir ?? this.sessionDir,
			persist: options.persist ?? this.persist,
			rlmDepth: options.rlmDepth ?? resolveSessionRlmDepth(header ?? {}, sourceFile ?? ""),
			limits,
		};
		const finish = async (
			entries: SessionEntry[],
			history?: SessionHistoryReadScope,
			epochCopy?: CapturedEpochCopy,
		): Promise<CapturedForkInput> => {
			const byId = new Map<string, SessionEntry>();
			for (const entry of entries) if (!byId.has(entry.id)) byId.set(entry.id, entry);
			const selectedEntry = "entryId" in target ? byId.get(target.entryId) : undefined;
			let leafId: string | null;
			if ("entryId" in target) {
				if (!selectedEntry) throw new Error("Invalid entry ID for forking");
				if (
					target.position === "before" &&
					(selectedEntry.type !== "message" || selectedEntry.message.role !== "user")
				)
					throw new Error("Invalid entry ID for forking");
				leafId = target.position === "at" ? selectedEntry.id : selectedEntry.parentId;
			} else leafId = target.leafId;
			const path: SessionEntry[] = [];
			if (history) {
				let page = await history.parentPathFrom(leafId);
				for (;;) {
					for (const reference of page.events) {
						const entry = byId.get(reference.id);
						if (!entry) throw new Error("Fork path source is unavailable");
						path.push(entry);
					}
					if (!page.nextCursor) break;
					page = await history.parentPathFrom(leafId, { cursor: page.nextCursor });
				}
			} else {
				const seen = new Set<string>();
				let id = leafId;
				while (id !== null) {
					const entry = byId.get(id);
					if (!entry || seen.has(id)) throw new Error("Parent path lineage is unresolved");
					seen.add(id);
					path.push(entry);
					id = entry.parentId;
				}
				path.reverse();
			}
			let copied: SessionEntry[] = path.filter((entry) => entry.type !== "label");
			const ids = new Set(copied.map((entry) => entry.id));
			if (epochCopy) {
				// Preserve source-backed display updates and original invocation relations, not baked replacement bodies.
				const toolCalls = new Set(
					copied.flatMap((entry) =>
						entry.type === "message" && entry.message.role === "toolResult" ? [entry.message.toolCallId] : [],
					),
				);
				for (const entry of copied) {
					if (entry.type === "message" && entry.execution && "invocationId" in entry.execution)
						ids.add(entry.execution.invocationId);
				}
				for (const entry of entries) {
					if (entry.type === "child_usage_attributed" && ids.has(entry.targetId)) ids.add(entry.id);
					if (entry.type === "custom" && entry.customType === IPYTHON_SENT_AGENT_MESSAGE_CUSTOM_ENTRY) {
						const sent = parsePersistedIpythonSentAgentMessage(entry.data);
						if (sent && toolCalls.has(sent.toolCallId)) ids.add(entry.id);
					}
				}
				// Related records keep their actual parent relations, including necessary off-branch ancestors.
				for (const id of ids) {
					const entry = byId.get(id);
					if (!entry) throw new Error("Fork related source is unavailable");
					if (entry.parentId !== null) ids.add(entry.parentId);
				}
				const order = new Map(epochCopy.entries.map((entry) => [entry.id, entry.sequence]));
				copied = [...ids].map((id) => byId.get(id)!).sort((a, b) => order.get(a.id)! - order.get(b.id)!);
			}
			const activeLabels = new Map<string, CapturedForkInput["labels"][number]>();
			for (const entry of entries) {
				if (entry.type !== "label") continue;
				if (entry.label)
					activeLabels.set(entry.targetId, {
						targetId: entry.targetId,
						label: entry.label,
						timestamp: entry.timestamp,
						retention: entryRetentions.get(entry),
						qualification: entryQualifications.get(entry),
					});
				else activeLabels.delete(entry.targetId);
			}
			return {
				...settings,
				source: history?.source,
				...(epochCopy ? { epochCopy, leafId } : {}),
				selectedEntry: selectedEntry
					? withEntryRetention(
							JSON.parse(stringifyBoundedJson(selectedEntry, limits.maxSourceBytes)) as SessionEntry,
							entryRetentions.get(selectedEntry),
							entryQualifications.get(selectedEntry),
						)
					: undefined,
				path: copied,
				labels: [...activeLabels.values()].filter((label) => ids.has(label.targetId)),
			};
		};
		if (!this.indexed) {
			const resident = this.materializeResidentHistory(limits);
			return finish(
				resident.entries.map((entry, index) =>
					withEntryRetention(
						entry,
						resident.retentions[index] ?? undefined,
						resident.qualifications[index] ?? undefined,
					),
				),
			);
		}
		const headerBytes = Buffer.byteLength(stringifyBoundedJson(header, limits.maxSourceBytes));
		if (headerBytes >= limits.maxSourceBytes) throw new Error("Fork source byte budget exceeded");
		return this.readSourceHistory(async (history) => {
			const materialized = await history.materialize({
				...limits,
				maxSourceBytes: limits.maxSourceBytes - headerBytes,
			});
			const entries = materialized.entries.map(({ entry, source }) =>
				withEntryRetention(entry, source.retention, source.qualification),
			);
			const sourceEntries = materialized.entries.map(({ entry, source }) => captureEpochCopyEntry(entry, source));
			const hasEpoch = sourceEntries.some(
				(entry) => entry.kind === "compaction" && entry.qualification === "native-context-epoch",
			);
			if (!hasEpoch) applyChildUsageAttributions(entries);
			return finish(
				entries,
				history,
				hasEpoch
					? {
							sessionId: history.source.sessionId,
							sessionFile: history.source.sessionFile,
							through: history.source.sourceSequence,
							entries: sourceEntries,
							retained: false,
						}
					: undefined,
			);
		});
	}

	private async _rebuildCopiedEpoch(copied: CapturedEpochCopy, limits: SessionHistoryReadLimits): Promise<void> {
		if (
			!copied.entries.some((entry) => entry.kind === "compaction" && entry.qualification === "native-context-epoch")
		)
			return;
		if (!this.supportsCapturedHistoryReads())
			throw new Error("Copied context epochs require an owned persistent source");
		const sink = this.bindCompactionSink(limits);
		await this._runHistoryRead(
			{ ...sink, readHistory: (read) => sink[readCopiedEpochSource](read) },
			async (history: SessionHistoryReadScope) => {
				const rebuilt = await rebuildCopiedContextEpoch(history, copied, limits);
				if (rebuilt) await sink[appendContextEpoch](rebuilt.checkpoint, rebuilt.tokensBefore, rebuilt.summary);
			},
		);
	}

	private static async _createCapturedFork(input: CapturedForkInput): Promise<SessionManager> {
		const next = new SessionManager(input.cwd, input.sessionDir, input.persist, {
			parentSession: input.sourceFile,
			rlmDepth: input.rlmDepth,
		});
		next.freshContextPolicySource = false;
		let bytes = Buffer.byteLength(stringifyBoundedJson(next.fileEntries[0], input.limits.maxSourceBytes));
		const append = (
			entry: SessionEntry,
			retention?: JournalFrameRetention,
			qualification = entryQualifications.get(entry),
		) => {
			if (next.fileEntries.length - 1 >= input.limits.maxEntries) throw new Error("Fork entry budget exceeded");
			const json = stringifyBoundedJson(entry, input.limits.maxSourceBytes - bytes);
			bytes += Buffer.byteLength(json);
			next.fileEntries.push(withEntryRetention(JSON.parse(json) as SessionEntry, retention, qualification));
		};
		for (const entry of input.path) append(entry, entryRetentions.get(entry));
		const ids = new Set(input.path.map((entry) => entry.id));
		let parentId = input.path.at(-1)?.id ?? null;
		for (const label of input.labels) {
			const id = generateId(ids);
			ids.add(id);
			append(
				{ type: "label", id, parentId, timestamp: label.timestamp, targetId: label.targetId, label: label.label },
				label.retention,
				label.qualification,
			);
			parentId = id;
		}
		next._buildIndex();
		if (input.persist) await next._openNew();
		else next.writeState.sequence = next.fileEntries.length - 1;
		if (input.epochCopy) {
			try {
				await next.branchTo(input.leafId ?? null);
				await next._rebuildCopiedEpoch(input.epochCopy, input.limits);
			} catch (error) {
				try {
					await next.close();
				} catch (cleanup) {
					throw new AggregateError([error, cleanup], "Fork activation and destination close failed");
				}
				throw error;
			}
		}
		return next;
	}

	async prepareFork(
		entryId: string,
		options: {
			position?: "before" | "at";
			persist?: boolean;
			sessionDir?: string;
			rlmDepth?: number;
			limits?: SessionHistoryReadLimits;
		} = {},
	): Promise<PreparedSessionFork> {
		const captured = await this._captureForkInput(
			{ entryId, position: options.position ?? "before" },
			{ ...options },
		);
		return {
			source: captured.source,
			selectedEntry: captured.selectedEntry!,
			create: () => SessionManager._createCapturedFork(captured),
		};
	}

	async forkBranch(
		leafId: string | null,
		options: { persist?: boolean; sessionDir?: string; rlmDepth?: number; limits?: SessionHistoryReadLimits } = {},
	): Promise<SessionManager> {
		return SessionManager._createCapturedFork(await this._captureForkInput({ leafId }, { ...options }));
	}

	async createBranchedSession(leafId: string): Promise<string | undefined> {
		this._assertMutable();
		const next = await this.forkBranch(leafId);
		this._assertMutable();
		this.switching = true;
		try {
			try {
				await this.flushNow();
			} catch (error) {
				try {
					await next.close();
				} catch (cleanup) {
					throw new AggregateError([error, cleanup], "Branch adoption preparation and destination close failed");
				}
				throw error;
			}
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
		let manager: SessionManager | undefined;
		try {
			let entries: FileEntry[] | undefined;
			let header: SessionHeader;
			if (owner.format === "framed") header = await readOwnedSessionHeader(owner.getSnapshot());
			else {
				entries = await loadEntriesFromFileAsync(owner.journalPath);
				const first = entries[0];
				if (!first || first.type !== "session" || typeof first.id !== "string")
					throw new Error(`Session source has no valid header: ${target}`);
				header = first;
			}
			const sourceVersion = header.version ?? 1;
			if (sourceVersion > CURRENT_SESSION_VERSION) throw new Error(`Unsupported session version: ${sourceVersion}`);
			if (header.parentSession && !isValidRlmDepth(header.rlmDepth))
				header.rlmDepth = resolveSessionRlmDepth(header, owner.journalPath);
			manager = new SessionManager(
				cwdOverride ?? header.cwd ?? process.cwd(),
				sessionDir ?? dirname(owner.journalPath),
				false,
			);
			manager.persist = true;
			manager.freshContextPolicySource = false;
			manager.sessionId = header.id;
			manager.sessionFile = owner.journalPath;
			manager.writeState.owner = owner;
			manager.writeState.sequence = owner.nextSequence - 1;
			manager.writeState.sourceVersion = sourceVersion;
			if (owner.format === "framed" && sourceVersion === CURRENT_SESSION_VERSION) {
				await manager._activateIndexedSource(header);
			} else {
				entries ??= await loadEntriesFromFileAsync(owner.journalPath);
				migrateToCurrentVersion(entries);
				manager.fileEntries = entries;
				manager._buildIndex();
			}
			return manager;
		} catch (error) {
			try {
				if (manager) await manager._closeSourceActors(manager.writeState);
				else await owner.close();
			} catch (cleanup) {
				throw new AggregateError([error, cleanup], "Session open and cleanup failed");
			}
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

	static async forkFrom(
		sourcePath: string,
		targetCwd: string,
		sessionDir?: string,
		limits: SessionHistoryReadLimits = DEFAULT_MANAGER_HISTORY_LIMITS,
	): Promise<SessionManager> {
		return SessionManager._copyFrom(sourcePath, targetCwd, sessionDir, undefined, { ...limits });
	}

	/** Explicit external import: supported payload versions and complete captured records, with copied authority lowered. */
	static async importRetainedFrom(
		sourcePath: string,
		targetCwd: string,
		sessionDir?: string,
		limits: SessionHistoryReadLimits = DEFAULT_MANAGER_HISTORY_LIMITS,
	): Promise<SessionManager> {
		return SessionManager._copyFrom(sourcePath, targetCwd, sessionDir, "retained-import", { ...limits });
	}

	/** Prepare one retained source without allocating a destination or assessing its activation. */
	static async previewRetainedImport(
		sourcePath: string,
		targetCwd: string,
		sessionDir?: string,
		limits: SessionHistoryReadLimits = DEFAULT_MANAGER_HISTORY_LIMITS,
	): Promise<SessionImportPreview> {
		const targetDirectory = assertProductStatePath(sessionDir ?? getDefaultSessionDir(targetCwd));
		const prepared = await SessionManager._prepareCopy(sourcePath, "retained-import", { ...limits });
		return {
			sourcePath: prepared.sourcePath,
			sourceFormat: prepared.sourceFormat,
			inputVersion: prepared.inputVersion,
			entriesRead: prepared.entriesRead,
			sourceJsonBytes: prepared.sourceJsonBytes,
			preparedEntryCount: prepared.targetEntries.length,
			targetCwd,
			targetDirectory,
			retention: "retained-import",
			sourceHeader: "replace",
			gitState: "omit-and-relink-parents",
			capture: "bounded-prefix-not-live-snapshot",
			destinationCreated: false,
			destinationCreationAndIndexing: "not-assessed",
			canonicalEpochActivation: "not-assessed",
			referenceReplayCoverage: "not-assessed",
			laterImport: "rereads-source-and-can-fail",
		};
	}

	private static async _copyFrom(
		sourcePath: string,
		targetCwd: string,
		sessionDir?: string,
		retention?: JournalFrameRetention,
		limits: SessionHistoryReadLimits = DEFAULT_MANAGER_HISTORY_LIMITS,
	): Promise<SessionManager> {
		const targetDirectory = resolve(sessionDir ?? getDefaultSessionDir(targetCwd));
		const prepared = await SessionManager._prepareCopy(sourcePath, retention, limits);
		const manager = new SessionManager(targetCwd, targetDirectory, true, {
			parentSession: sourcePath,
			rlmDepth: resolveSessionRlmDepth(prepared.sourceHeader, sourcePath),
		});
		prepared.targetEntries.unshift(manager.fileEntries[0]);
		manager.fileEntries = prepared.targetEntries;
		manager._buildIndex();
		await manager._openNew();
		try {
			await manager._rebuildCopiedEpoch(prepared.epochCopy, limits);
		} catch (error) {
			try {
				await manager.close();
			} catch (cleanup) {
				throw new AggregateError([error, cleanup], "Copied context activation and destination close failed");
			}
			throw error;
		}
		return manager;
	}

	/** The same held source preparation feeds preview and the real destination writer. */
	private static async _prepareCopy(
		sourcePath: string,
		retention: JournalFrameRetention | undefined,
		limits: SessionHistoryReadLimits,
	) {
		const { maxEntries, maxSourceBytes } = limits;
		const explicitImport = retention === "retained-import";
		if (
			!Number.isSafeInteger(maxEntries) ||
			maxEntries <= 0 ||
			!Number.isSafeInteger(maxSourceBytes) ||
			maxSourceBytes <= 0
		)
			throw new Error("Invalid copied history limits");
		let entriesRead = 0;
		let sourceBytes = 0;
		let sourceHeader:
			| {
					entry: SessionHeader;
					format: SessionImportPreview["sourceFormat"];
					inputVersion: number;
			  }
			| undefined;
		const capturedPath = realpathIfPresent(resolve(sourcePath));
		const capturedEntries: CopiedEpochEntry[] = [];
		let through = 0;
		let legacyEntries: FileEntry[] | undefined;
		// This becomes the target's resident array; current-version copies do not retain a second source array.
		const targetEntries: FileEntry[] = [];
		const dropped = new Map<string, string | null>();
		const keep = (entry: FileEntry) => {
			if (entry.type === "session") return;
			if (entry.type === "git_state") dropped.set(entry.id, entry.parentId);
			else
				targetEntries.push(
					withEntryRetention(entry, retention ?? entryRetentions.get(entry), entryQualifications.get(entry)),
				);
		};
		if (existsSync(sourcePath)) {
			await readCapturedSessionJournal(
				capturedPath,
				(record) => {
					sourceBytes += Buffer.byteLength(record.json);
					if (sourceBytes > maxSourceBytes) throw new Error("Copied history JSON byte budget exceeded");
					const entry = sessionFileEntry(record.entry, record.retention, record.qualification);
					if (record.source) through = record.source.sequence;
					if (!sourceHeader) {
						if (entry.type !== "session" || typeof entry.id !== "string")
							throw new Error("Session source has no valid header");
						const version = entry.version === undefined ? 1 : entry.version;
						if (explicitImport && ![1, 2, CURRENT_SESSION_VERSION].includes(version))
							throw new Error(`Unsupported session version for retained import: ${String(entry.version)}`);
						sourceHeader = {
							entry,
							format: record.source ? "native-framed" : "legacy-jsonl",
							inputVersion: version,
						};
						if (entry.version !== CURRENT_SESSION_VERSION) legacyEntries = [entry];
					} else {
						if (++entriesRead > maxEntries) throw new Error("Copied history entry budget exceeded");
						if (entry.type !== "session" && record.source)
							capturedEntries.push(
								captureEpochCopyEntry(entry, {
									...record.source,
									id: entry.id,
									parentId: entry.parentId,
									kind: entry.type,
									retention: record.retention,
									qualification: record.qualification,
								}),
							);
						if (legacyEntries) legacyEntries.push(entry);
						else keep(entry);
					}
				},
				{ requireCompleteTail: explicitImport },
			);
		}
		if (!sourceHeader)
			throw new Error(`Cannot ${explicitImport ? "import" : "fork"}: source session has no header: ${sourcePath}`);
		if (legacyEntries) {
			finalizeLoadedEntries(legacyEntries);
			migrateToCurrentVersion(legacyEntries);
			for (const entry of legacyEntries) keep(entry);
		} else if (
			!capturedEntries.some((entry) => entry.kind === "compaction" && entry.qualification === "native-context-epoch")
		) {
			applyChildUsageAttributions(targetEntries);
		}
		// Relink after reading so even forward references through dropped git facts keep their old meaning.
		for (let index = 0; index < targetEntries.length; index++) {
			const entry = targetEntries[index] as SessionEntry;
			let parentId = entry.parentId;
			const seen = new Set<string>();
			while (parentId !== null && dropped.has(parentId)) {
				if (seen.has(parentId)) throw new Error("Copied session git ancestry is unresolved");
				seen.add(parentId);
				parentId = dropped.get(parentId) ?? null;
			}
			if (parentId !== entry.parentId)
				targetEntries[index] = withEntryRetention(
					{ ...entry, parentId },
					entryRetentions.get(entry),
					entryQualifications.get(entry),
				);
		}
		return {
			sourcePath: capturedPath,
			sourceFormat: sourceHeader.format,
			inputVersion: sourceHeader.inputVersion,
			entriesRead,
			sourceJsonBytes: sourceBytes,
			sourceHeader: sourceHeader.entry,
			targetEntries,
			epochCopy: {
				sessionId: sourceHeader.entry.id,
				sessionFile: capturedPath,
				through,
				entries: capturedEntries,
				retained: retention === "retained-import",
			},
		};
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
