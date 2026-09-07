import type { AgentMessage } from "@ponythewhite/base-context-agent";
import type {
	ContextManifestCursor,
	ContextManifestPage,
	ContextRef,
	ContextUpdateRef,
	ContextUpdateTarget,
} from "./history-index.js";
import { createCompactionSummaryMessage } from "./messages.js";
import type { SourceSnapshotRef } from "./request-events.js";
import { orderContextToolResults, sessionEntryMessage } from "./session-context-messages.js";
import {
	appendSentAgentMessageToToolResult,
	parsePersistedIpythonSentAgentMessage,
} from "./session-context-updates.js";
import type { SessionHistoryReadView } from "./session-history-index.js";
import type { SessionEntry } from "./session-manager.js";
import { cloneUsage } from "./usage.js";

export interface CanonicalContextLimits {
	maxMessages: number;
	/** Canonical frame bytes, not a tokenizer or an estimate of JavaScript heap size. */
	maxSourceBytes: number;
}

interface CachedEntry {
	revision: string;
	entry: SessionEntry;
}

type KnownManifest = Extract<ContextManifestPage, { selection: "known" }>;

/** Exact active-context reconstruction. It never silently chooses a last-N transcript. */
export class CanonicalContextCompiler {
	private source?: SourceSnapshotRef;
	private entries = new Map<string, CachedEntry>();
	private sourceBytes = 0;
	private messageCount = 0;

	/** Membership in the last successful active-source cache, including explicitly omitted responses. */
	hasActiveEntry(entryId: string): boolean {
		return this.entries.has(entryId);
	}

	async compile(
		view: SessionHistoryReadView,
		limits: CanonicalContextLimits,
		omittedAssistantIds: ReadonlySet<string> = new Set(),
	): Promise<AgentMessage[]> {
		const omitted = new Set(omittedAssistantIds);
		const { maxMessages, maxSourceBytes } = limits;
		if (
			!Number.isSafeInteger(maxMessages) ||
			maxMessages <= 0 ||
			!Number.isSafeInteger(maxSourceBytes) ||
			maxSourceBytes <= 0
		)
			throw new Error("Invalid canonical context limits");
		if (
			this.source?.sessionId !== view.source.sessionId ||
			this.source?.sessionFile !== view.source.sessionFile ||
			this.messageCount > maxMessages ||
			this.sourceBytes > maxSourceBytes
		) {
			this.entries.clear();
			this.sourceBytes = 0;
			this.messageCount = 0;
		}
		let first: KnownManifest | undefined;
		let cursor: ContextManifestCursor | undefined;
		let expected = 0;
		let sourceBytes = 0;
		const refs: ContextRef[] = [];
		const countBytes = (ref: Pick<ContextRef, "locator">) => {
			sourceBytes += ref.locator.length;
			if (sourceBytes > maxSourceBytes) throw new Error("Canonical context source byte budget exceeded");
		};
		for (;;) {
			const page = await view.contextManifest({ cursor, limit: 128 });
			if (page.selection !== "known") throw new Error(`Canonical context selection is ${page.selection}`);
			if (!first) {
				first = page;
				if (page.activeMessageCount + (page.summaryRef ? 1 : 0) > maxMessages)
					throw new Error("Canonical context message budget exceeded");
				expected = page.activeBase + 1;
				if (page.summaryRef) countBytes(page.summaryRef);
			} else if (
				page.activeBase !== first.activeBase ||
				page.activeMessageCount !== first.activeMessageCount ||
				page.retainedMessageCount !== first.retainedMessageCount ||
				page.summaryRef?.entryId !== first.summaryRef?.entryId ||
				page.summaryRef?.revision !== first.summaryRef?.revision
			) {
				throw new Error("Canonical context manifest changed during its captured read");
			}
			for (const ref of page.refs) {
				if (ref.ordinal !== expected++) throw new Error("Canonical context manifest skipped an active message");
				countBytes(ref);
				refs.push(ref);
			}
			if (!page.nextCursor) break;
			if (!page.refs.length || page.nextCursor.nextOrdinal !== expected)
				throw new Error("Canonical context manifest did not advance");
			cursor = page.nextCursor;
		}
		if (refs.length !== first.activeMessageCount) throw new Error("Canonical context manifest is incomplete");

		const next = new Map<string, CachedEntry>();
		const hydrate = async (
			ref: ContextRef | ContextUpdateRef,
			target?: ContextUpdateTarget,
		): Promise<SessionEntry> => {
			const cached = this.entries.get(ref.entryId);
			if (cached?.revision === ref.revision) {
				next.set(ref.entryId, cached);
				return cached.entry;
			}
			const fragments: string[] = [];
			let offset = 0;
			let part = target
				? await view.readContextUpdatePayload(ref.entryId, target)
				: await view.readPayload(ref.entryId);
			for (;;) {
				if (!part || part.byteOffset !== offset || part.byteLength <= 0)
					throw new Error("Canonical context payload is unavailable or incomplete");
				offset += part.byteLength;
				if (offset > ref.locator.length) throw new Error("Canonical context payload exceeds its source locator");
				fragments.push(part.text);
				if (!part.nextCursor) break;
				part = target
					? await view.readContextUpdatePayload(ref.entryId, target, { cursor: part.nextCursor })
					: await view.readPayload(ref.entryId, { cursor: part.nextCursor });
			}
			const value: unknown = JSON.parse(fragments.join(""));
			if (
				!value ||
				typeof value !== "object" ||
				!("id" in value) ||
				value.id !== ref.entryId ||
				!("type" in value) ||
				value.type !== ref.kind
			)
				throw new Error("Canonical context payload does not match its source reference");
			const entry = value as SessionEntry;
			next.set(ref.entryId, { revision: ref.revision, entry });
			return entry;
		};
		const messages: AgentMessage[] = [];
		if (first.summaryRef) {
			const summary = await hydrate(first.summaryRef);
			if (summary.type !== "compaction") throw new Error("Canonical context summary has the wrong source kind");
			messages.push(
				createCompactionSummaryMessage(
					summary.summary,
					summary.tokensBefore,
					summary.timestamp,
					summary.customInstructions,
					first.retainedMessageCount,
				),
			);
		}
		for (const ref of refs) {
			const original = sessionEntryMessage(await hydrate(ref));
			if (!original) throw new Error("Canonical context reference is not a visible context entry");
			// These IDs come from actual native retry controls, not inferred transcript membership or stop reasons.
			if (original.role === "assistant" && omitted.has(ref.entryId)) continue;
			// Neither canonical updates nor replaceable transforms may mutate cached source entries.
			const message = structuredClone(original);
			if (message.role === "assistant") {
				const target: ContextUpdateTarget = { kind: "assistant-usage", targetId: ref.entryId };
				for (const update of (await view.contextUpdates(target)).refs) {
					countBytes(update);
					const entry = await hydrate(update, target);
					if (entry.type !== "child_usage_attributed") throw new Error("Canonical usage update kind mismatch");
					message.usage = cloneUsage(entry.aggregateUsage);
				}
			} else if (message.role === "toolResult" && message.toolName === "ipython") {
				const target: ContextUpdateTarget = { kind: "ipython-sent-message", toolCallId: message.toolCallId };
				for (const update of (await view.contextUpdates(target)).refs) {
					countBytes(update); // Charge each application, even when the source record is cached.
					const entry = await hydrate(update, target);
					const sent = entry.type === "custom" ? parsePersistedIpythonSentAgentMessage(entry.data) : undefined;
					if (!sent || sent.toolCallId !== message.toolCallId)
						throw new Error("Canonical sent-message update mismatch");
					appendSentAgentMessageToToolResult(message, message.toolCallId, sent.message);
				}
			}
			messages.push(message);
		}
		orderContextToolResults(messages);
		this.entries = next;
		this.source = view.source;
		this.sourceBytes = sourceBytes;
		this.messageCount = first.activeMessageCount + (first.summaryRef ? 1 : 0);
		return messages;
	}
}
