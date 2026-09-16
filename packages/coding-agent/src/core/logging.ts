import { type LogEntry, setLogSink, stringifyLogEntry } from "@ponythewhite/base-context-ai";
import { appendRotatingLog, getAgentLogPath } from "../config.js";

const AGENT_LOG_MAX_BYTES = 20 * 1024 * 1024;

let context: Record<string, unknown> = {};

/** Merge late-bound fields (e.g. mode, sessionId) into every subsequent log entry. */
export function setLogContext(fields: Record<string, unknown>): void {
	Object.assign(context, fields);
}

export function writeFileLogEntry(entry: LogEntry): void {
	appendRotatingLog(getAgentLogPath(), stringifyLogEntry({ ...entry, ...context }), AGENT_LOG_MAX_BYTES);
}

/**
 * Route coding-agent and AI logs to the owned local agent log.
 * Writes include the current pid/session context and remain size-bounded.
 */
export function installFileLogSink(fields?: Record<string, unknown>): void {
	context = { pid: process.pid, ...fields };
	setLogSink(writeFileLogEntry);
}
