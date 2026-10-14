/**
 * Bash command execution with streaming support and cancellation.
 *
 * This module provides a unified bash execution implementation used by:
 * - AgentSession.executeBash() for interactive and RPC modes
 * - Direct calls from modes that need bash execution
 */

import stripAnsi from "strip-ansi";
import { sanitizeBinaryOutput } from "../utils/shell.js";
import type { BashOperations } from "./tools/bash.js";
import { OutputAccumulator } from "./tools/output-accumulator.js";
export interface BashExecutorOptions {
	/** Callback for streaming output chunks (already sanitized) */
	onChunk?: (chunk: string) => void;
	/** AbortSignal for cancellation */
	signal?: AbortSignal;
}

export interface BashResult {
	/** Combined stdout + stderr output (sanitized, possibly truncated) */
	output: string;
	/** Process exit code (undefined if killed/cancelled) */
	exitCode: number | undefined;
	/** Whether the command was cancelled via signal */
	cancelled: boolean;
	/** Whether the output was truncated */
	truncated: boolean;
	/** Path to temp file containing full output (if output exceeded truncation threshold) */
	fullOutputPath?: string;
}
/**
 * Execute a bash command using custom BashOperations.
 * Used for remote execution (SSH, containers, etc.).
 */
export async function executeBashWithOperations(
	command: string,
	cwd: string,
	operations: BashOperations,
	options?: BashExecutorOptions,
): Promise<BashResult> {
	const output = new OutputAccumulator({ tempFilePrefix: "pi-bash" });
	const decoder = new TextDecoder();
	const appendText = (decoded: string) => {
		const text = sanitizeBinaryOutput(stripAnsi(decoded)).replace(/\r/g, "");
		if (!text) return;
		output.append(Buffer.from(text));
		options?.onChunk?.(text);
	};

	try {
		let exitCode: number | null | undefined;
		try {
			const result = await operations.exec(command, cwd, {
				onData: (data) => appendText(decoder.decode(data, { stream: true })),
				signal: options?.signal,
			});
			exitCode = result.exitCode;
		} catch (error) {
			if (!options?.signal?.aborted) throw error;
		}

		appendText(decoder.decode());
		output.finish();
		const snapshot = output.snapshot({ persistIfTruncated: true });
		const cancelled = options?.signal?.aborted ?? false;
		return {
			output: snapshot.content,
			exitCode: cancelled ? undefined : (exitCode ?? undefined),
			cancelled,
			truncated: snapshot.truncation.truncated,
			fullOutputPath: snapshot.fullOutputPath,
		};
	} finally {
		output.finish();
		await output.closeTempFile();
	}
}
