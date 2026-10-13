import { CompletionWaitTimeoutError } from "../../core/completion.js";
import { MissingSessionCwdError } from "../../core/session-cwd.js";
import { SessionImportFileNotFoundError } from "../../core/session-import-errors.js";
import { SessionAlreadyActiveError } from "../../core/session-lease.js";
import type { DaemonErrorInfo, DaemonResponse } from "./daemon-protocol.js";

export interface DaemonWorkerStartupPhase {
	name: "admission" | "spawn" | "handshake" | "session-open";
	observedAt: string;
}

/** Keep the original error type and cause so ownership/recovery classification is unchanged. */
export function annotateDaemonWorkerStartupError<T>(error: T, phase: DaemonWorkerStartupPhase): T {
	if (!(error instanceof Error)) return error;
	const context = `Worker startup: lastStartupPhase=${phase.name}; observedAt=${phase.observedAt}.`;
	const stack = error.stack;
	error.message = `${error.message} ${context}`;
	if (stack) error.stack = `${stack}\n${context}`;
	return error;
}

export function serializeDaemonError(error: unknown): DaemonErrorInfo | undefined {
	if (error instanceof CompletionWaitTimeoutError) {
		return { code: "completion_wait_timeout", ...error.diagnostics };
	}
	if (error instanceof MissingSessionCwdError) {
		return { code: "missing_session_cwd", issue: error.issue };
	}
	if (error instanceof SessionImportFileNotFoundError) {
		return { code: "session_import_file_not_found", filePath: error.filePath };
	}
	if (error instanceof SessionAlreadyActiveError) {
		return {
			code: "session_already_active",
			sessionPath: error.sessionPath,
			activeSessionId: error.activeSessionId,
		};
	}
	return undefined;
}

export class DaemonSessionCreateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DaemonSessionCreateError";
	}
}

/** Wraps untyped create failures so the CLI prints one line instead of rethrowing. */
export function deserializeDaemonCreateError(response: Extract<DaemonResponse, { success: false }>): Error {
	const error = deserializeDaemonError(response);
	if (response.errorInfo) return error;
	return new DaemonSessionCreateError(error.message);
}

export function deserializeDaemonError(response: Extract<DaemonResponse, { success: false }>): Error {
	const { errorInfo } = response;
	let error: Error;
	if (errorInfo?.code === "completion_wait_timeout") {
		const { code: _code, ...diagnostics } = errorInfo;
		error = new CompletionWaitTimeoutError(diagnostics);
	} else if (errorInfo?.code === "missing_session_cwd") {
		error = new MissingSessionCwdError(errorInfo.issue);
	} else if (errorInfo?.code === "session_import_file_not_found") {
		error = new SessionImportFileNotFoundError(errorInfo.filePath);
	} else if (errorInfo?.code === "session_already_active") {
		error = new SessionAlreadyActiveError(errorInfo.sessionPath, errorInfo.activeSessionId);
	} else {
		return new Error(response.error);
	}
	error.message = response.error ?? error.message;
	return error;
}
