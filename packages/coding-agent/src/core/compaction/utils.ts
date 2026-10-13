/**
 * Shared utilities for compaction and branch summarization.
 */

import type { AgentMessage } from "@ponythewhite/base-context-agent";
import type { AssistantMessage, Message, ToolResultMessage } from "@ponythewhite/base-context-ai";
import { convertToLlm } from "../messages.js";
import { PUBLIC_CONTEXT_RENDERER } from "../public-context.js";
export interface FileOperations {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

export function createFileOps(): FileOperations {
	return {
		read: new Set(),
		written: new Set(),
		edited: new Set(),
	};
}

/** Extract native edits and structured IPython edit results, not arbitrary Python writes. */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
	if (message.role === "toolResult" && message.toolName === "ipython") {
		const details = message.details as { diffs?: unknown } | undefined;
		if (Array.isArray(details?.diffs)) {
			for (const diff of details.diffs) {
				if (diff && typeof diff === "object" && "path" in diff && typeof diff.path === "string" && diff.path) {
					fileOps.edited.add(diff.path);
				}
			}
		}
		return;
	}
	if (message.role !== "assistant") return;
	if (!("content" in message) || !Array.isArray(message.content)) return;

	for (const block of message.content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "toolCall") continue;
		if (!("arguments" in block) || !("name" in block)) continue;

		const args = block.arguments as Record<string, unknown> | undefined;
		if (!args) continue;

		const path = typeof args.path === "string" ? args.path : undefined;
		if (!path) continue;

		switch (block.name) {
			case "edit":
				fileOps.edited.add(path);
				break;
		}
	}
}

/**
 * Compute final file lists from file operations.
 * Returns readFiles (files only read, not modified) and modifiedFiles.
 */
export function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles: readOnly, modifiedFiles };
}

/**
 * Format file operations as XML tags for summary.
 */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	const formatList = (files: string[]) => {
		const shown = files.slice(0, 200).join("\n");
		return files.length > 200 ? `${shown}\n[... ${files.length - 200} more files omitted]` : shown;
	};
	if (readFiles.length > 0) {
		sections.push(`<read-files>\n${formatList(readFiles)}\n</read-files>`);
	}
	if (modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${formatList(modifiedFiles)}\n</modified-files>`);
	}
	if (sections.length === 0) return "";
	return `\n\n${sections.join("\n\n")}`;
}
/** Maximum characters for a tool result in serialized summaries. */
const TOOL_RESULT_MAX_CHARS = 2000;

/** Keep both ends within a JavaScript-character budget, including the omission marker. */
function truncateForSummary(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const marker = (omitted: number) => `\n\n[... ${omitted} characters omitted]\n\n`;
	const retainedChars = maxChars - marker(text.length).length;
	const tailChars = Math.min(500, retainedChars);
	const headChars = retainedChars - tailChars;
	return text.slice(0, headChars) + marker(text.length - headChars - tailChars) + text.slice(-tailChars);
}

type SummaryMessage =
	| Extract<Message, { role: "user" }>
	| Pick<AssistantMessage, "role" | "content">
	| Pick<ToolResultMessage, "role" | "content" | "toolCallId" | "toolName" | "isError">;

/** Read only the selected public representation, never its archived source or hidden reasoning. */
function publicSummaryView(message: AgentMessage): { message: SummaryMessage; prefix: string } | undefined {
	if (
		message.role !== "custom" ||
		message.customType !== PUBLIC_CONTEXT_RENDERER ||
		typeof message.content !== "string"
	)
		return undefined;
	const separator = message.content.indexOf("\n");
	if (separator < 0) return undefined;
	try {
		const data = JSON.parse(message.content.slice(separator + 1)) as Record<string, unknown>;
		if (!data || (data.role !== "assistant" && data.role !== "toolResult") || !Array.isArray(data.content))
			return undefined;
		const { role, content, toolCallId, toolName, isError, ...addresses } = data;
		return {
			message: { role, content, toolCallId, toolName, isError } as SummaryMessage,
			prefix: `${message.content.slice(0, separator)}\n${JSON.stringify(addresses)}`,
		};
	} catch {
		return undefined;
	}
}

/** Serialize native and selected public messages, with bounded result excerpts and local call pairing. */
export function serializeConversation(messages: AgentMessage[]): string {
	const toolCallIndices = new Map<string, number>();
	let nextToolCallIndex = 1;

	const serializeMessage = (msg: SummaryMessage): string => {
		const parts: string[] = [];
		if (msg.role === "user") {
			const content =
				typeof msg.content === "string"
					? msg.content
					: msg.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("");
			if (content) parts.push(`[User]: ${content}`);
		} else if (msg.role === "assistant") {
			const textParts: string[] = [];
			const thinkingParts: string[] = [];
			const toolCalls: string[] = [];

			for (const block of msg.content) {
				if (block.type === "text") {
					textParts.push(block.text);
				} else if (block.type === "thinking") {
					thinkingParts.push(block.thinking);
				} else if (block.type === "toolCall") {
					const args = block.arguments as Record<string, unknown>;
					const argsStr =
						args === null
							? "null"
							: Object.entries(args)
									.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
									.join(", ");
					const index = nextToolCallIndex++;
					toolCallIndices.set(block.id, index);
					toolCalls.push(`#${index} ${block.name}(${argsStr})`);
				}
			}

			if (thinkingParts.length > 0) {
				parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
			}
			if (textParts.length > 0) {
				parts.push(`[Assistant]: ${textParts.join("\n")}`);
			}
			if (toolCalls.length > 0) {
				parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
			}
		} else if (msg.role === "toolResult") {
			const content = msg.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
			if (content) {
				const index = toolCallIndices.get(msg.toolCallId);
				const label = `[Tool result (${msg.toolName}${msg.isError ? ", error" : ""})${index === undefined ? "" : ` #${index}`}]`;
				parts.push(`${label}: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
			}
		}
		return parts.join("\n\n");
	};

	return messages
		.flatMap((message) => {
			const view = publicSummaryView(message);
			if (view) return [`[User]: ${view.prefix}\n${serializeMessage(view.message)}`];
			return convertToLlm([message]).map(serializeMessage);
		})
		.filter(Boolean)
		.join("\n\n");
}
export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;
