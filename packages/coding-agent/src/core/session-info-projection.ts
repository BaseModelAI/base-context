import type { AgentMessage } from "@ponythewhite/base-context-agent";
import type { Message, TextContent } from "@ponythewhite/base-context-ai";
import type {
	FileEntry,
	SessionEntryBase,
	SessionHeader,
	SessionMessageEntry,
	SessionState,
	SessionStateStatus,
} from "./session-manager.js";
import type { SessionUsageSummary } from "./usage.js";

export const SESSION_LIST_SEARCH_TEXT_MAX_CHARS = 64 * 1024;
export const SESSION_LIST_PARSE_MAX_LINE_CHARS = 1024 * 1024;
export const SESSION_LIST_LARGE_MESSAGE_PREVIEW_MAX_CHARS = 256;

export function isMessageWithContent(message: AgentMessage): message is Message {
	return typeof (message as Message).role === "string" && "content" in message;
}

export function extractTextContent(message: Message): string {
	const content = message.content;
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join(" ");
}

export function normalizeSessionStateStatus(value: unknown): SessionStateStatus | undefined {
	if (value === "active" || value === "archived" || value === "crash") {
		return value;
	}
	if (value === "hidden" || value === "sleep") {
		return "archived";
	}
	return undefined;
}

export function updateLastActivityTime(lastActivityTime: number | undefined, entry: FileEntry): number | undefined {
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

export function getSessionModifiedDateFromLastActivity(
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

export function appendCappedSearchText(current: string, text: string): string {
	if (!text || current.length >= SESSION_LIST_SEARCH_TEXT_MAX_CHARS) {
		return current;
	}
	const next = current ? ` ${text}` : text;
	return current + next.slice(0, SESSION_LIST_SEARCH_TEXT_MAX_CHARS - current.length);
}

export function looksLikeMessageEntry(line: string): boolean {
	return line.includes('"type":"message"') || line.includes('"type": "message"');
}

export function extractJsonStringPropertyPrefix(
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

export function extractOversizedMessageSummary(line: string): {
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

/** Whole-source derived state; large returned fields remain source references. */
export interface SessionCatalogProjection {
	version: 1;
	messageCount: number;
	firstMessage: { id: string } | { preview: string } | null;
	allMessagesText: string;
	nameId: string | null;
	state?: SessionState;
	agentStatusId: string | null;
	lastActivityTime?: number;
	usage?: SessionUsageSummary;
	unsupported?: string;
}

export function emptySessionCatalog(): SessionCatalogProjection {
	return { version: 1, messageCount: 0, firstMessage: null, allMessagesText: "", nameId: null, agentStatusId: null };
}

export class CatalogProjectionUnsupportedError extends Error {}

export function foldSessionCatalog(state: SessionCatalogProjection, entry: FileEntry, json: string): void {
	try {
		foldCatalogFields(state, entry, json);
	} catch (error) {
		if (error instanceof TypeError) throw new CatalogProjectionUnsupportedError("Unsupported catalog source fields");
		throw error;
	}
}

function foldCatalogFields(state: SessionCatalogProjection, entry: FileEntry, json: string): void {
	if (state.unsupported) return;
	if (json.length > SESSION_LIST_PARSE_MAX_LINE_CHARS) {
		if (looksLikeMessageEntry(json)) {
			state.messageCount++;
			const summary = extractOversizedMessageSummary(json);
			if (typeof summary.timestamp === "number" && (summary.role === "user" || summary.role === "assistant"))
				state.lastActivityTime = Math.max(state.lastActivityTime ?? 0, summary.timestamp);
			if (summary.role === "user" && !state.firstMessage)
				state.firstMessage = { preview: summary.textPreview || "(large message)" };
		}
		return;
	}
	if (entry.type === "session_info") state.nameId = entry.id;
	if (entry.type === "session_state") {
		const status = normalizeSessionStateStatus(entry.state?.status);
		if (status) state.state = { status };
	}
	if (entry.type === "agent_status") state.agentStatusId = entry.id;
	state.lastActivityTime = updateLastActivityTime(state.lastActivityTime, entry);
	if (state.lastActivityTime !== undefined && !Number.isFinite(state.lastActivityTime))
		throw new CatalogProjectionUnsupportedError("Non-finite catalog activity is unsupported");
	if (entry.type !== "message") return;
	state.messageCount++;
	const message = entry.message;
	if (!isMessageWithContent(message) || (message.role !== "user" && message.role !== "assistant")) return;
	const text = extractTextContent(message);
	if (!text) return;
	state.allMessagesText = appendCappedSearchText(state.allMessagesText, text);
	if (!state.firstMessage && message.role === "user") state.firstMessage = { id: entry.id };
}

export function decodeSessionCatalog(value: unknown): SessionCatalogProjection {
	if (!value || typeof value !== "object") throw new Error("Invalid catalog projection metadata");
	const state = value as SessionCatalogProjection;
	if (
		state.version !== 1 ||
		!Number.isSafeInteger(state.messageCount) ||
		state.messageCount < 0 ||
		typeof state.allMessagesText !== "string" ||
		state.allMessagesText.length > SESSION_LIST_SEARCH_TEXT_MAX_CHARS ||
		!(state.nameId === null || typeof state.nameId === "string") ||
		!(state.agentStatusId === null || typeof state.agentStatusId === "string") ||
		!(
			state.firstMessage === null ||
			(typeof state.firstMessage === "object" &&
				(("id" in state.firstMessage && typeof state.firstMessage.id === "string") ||
					("preview" in state.firstMessage && typeof state.firstMessage.preview === "string")))
		) ||
		(state.lastActivityTime !== undefined && !Number.isFinite(state.lastActivityTime))
	)
		throw new Error("Invalid catalog projection metadata");
	return state;
}
