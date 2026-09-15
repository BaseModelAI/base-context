import type { AgentMessage } from "@ponythewhite/base-context-agent";
import type { KernelSentAgentMessage } from "./kernel/index.js";

export const IPYTHON_SENT_AGENT_MESSAGE_CUSTOM_ENTRY = "ipython_sent_agent_message";

export interface PersistedIpythonSentAgentMessage {
	toolCallId: string;
	message: KernelSentAgentMessage;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePersistedIpythonSentAgentMessage(value: unknown): PersistedIpythonSentAgentMessage | undefined {
	if (!isObjectRecord(value) || typeof value.toolCallId !== "string" || !isObjectRecord(value.message)) {
		return undefined;
	}
	const { id, message, deliveryStatus, target } = value.message;
	if (
		typeof id !== "string" ||
		typeof message !== "string" ||
		(deliveryStatus !== "delivered" && deliveryStatus !== "queued") ||
		!isObjectRecord(target) ||
		typeof target.activeSessionId !== "string" ||
		typeof target.sessionId !== "string"
	) {
		return undefined;
	}
	return {
		toolCallId: value.toolCallId,
		message: {
			id,
			message,
			deliveryStatus,
			target: {
				activeSessionId: target.activeSessionId,
				sessionId: target.sessionId,
				...(typeof target.sessionName === "string" ? { sessionName: target.sessionName } : {}),
			},
		},
	};
}

export function appendSentAgentMessageToToolResult(
	message: AgentMessage,
	toolCallId: string,
	sentMessage: KernelSentAgentMessage,
): boolean {
	if (message.role !== "toolResult" || message.toolName !== "ipython" || message.toolCallId !== toolCallId) {
		return false;
	}
	const details = isObjectRecord(message.details) ? message.details : {};
	const current = Array.isArray(details.sentAgentMessages) ? details.sentAgentMessages : [];
	if (current.some((entry) => isObjectRecord(entry) && entry.id === sentMessage.id)) {
		return true;
	}
	message.details = {
		...details,
		sentAgentMessages: [...current, sentMessage],
	};
	return true;
}
