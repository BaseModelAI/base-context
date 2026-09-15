import type { AgentSessionMessageSender } from "./agent-messages.js";
import { bindNativeEntryWriter } from "./session-entry-origin.js";
import type { SessionManager } from "./session-manager.js";

export const AGENT_RESULT_CUSTOM_TYPE = "base-context.agent-result";

/** Child-authored descriptive data, not task instructions or verified outcomes. */
export interface AgentResultData {
	messageId: string;
	summary: string;
	findings: string;
	from?: AgentSessionMessageSender;
}

export interface AgentResultReference {
	sourceSessionId: string;
	ref: string;
	field: "/data/findings";
}

export type CapturedAgentResultWrite = (data: AgentResultData) => Promise<string>;

export function normalizeAgentResultSummary(summary: string): string {
	if (typeof summary !== "string" || !summary.trim()) throw new Error("Agent result summary must not be empty");
	const normalized = summary.trim();
	if (normalized.length > 2_000) throw new Error("Agent result summary exceeds 2,000 characters");
	return normalized;
}

/** The host authorizes sender and recipient before staging, then delivers only the capsule and this ref. */
export async function stageAgentResult(manager: SessionManager, data: AgentResultData): Promise<AgentResultReference> {
	const summary = normalizeAgentResultSummary(data.summary);
	if (typeof data.findings !== "string" || !data.findings.trim())
		throw new Error("Agent result findings must not be empty");
	if (typeof data.messageId !== "string" || !data.messageId.trim())
		throw new Error("Agent result message ID must not be empty");
	const sourceSessionId = manager.getSessionId();
	const write = manager[bindNativeEntryWriter]().captureAgentResult();
	const ref = await write({
		messageId: data.messageId,
		summary,
		findings: data.findings,
		...(data.from ? { from: { ...data.from } } : {}),
	});
	return { sourceSessionId, ref, field: "/data/findings" };
}
