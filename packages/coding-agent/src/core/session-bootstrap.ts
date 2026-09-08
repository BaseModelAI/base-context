import { CanonicalContextCompiler, type CanonicalContextLimits } from "./canonical-context.js";
import type { SessionContext, SessionEntry, SessionManager } from "./session-manager.js";

function restoreBootstrapSetting(context: SessionContext, entry: SessionEntry): void {
	switch (entry.type) {
		case "model_change":
			context.model = { provider: entry.provider, modelId: entry.modelId };
			break;
		case "message":
			if (entry.message.role !== "assistant") throw new Error("Bootstrap model source is not an assistant");
			context.model = { provider: entry.message.provider, modelId: entry.message.model };
			break;
		case "thinking_level_change":
			context.thinkingLevel = entry.thinkingLevel;
			break;
		case "service_tier_change":
			context.serviceTier = entry.serviceTier;
			break;
		default:
			throw new Error("Unexpected bootstrap setting source kind");
	}
}

/** Restore settings and presence from one captured branch, including messages by default. */
export async function readSessionBootstrap(
	sessionManager: SessionManager,
	limits: CanonicalContextLimits,
	options: { includeMessages?: boolean } = {},
) {
	limits = { ...limits };
	const includeMessages = options.includeMessages ?? true;
	if (!sessionManager.supportsCapturedHistoryReads()) {
		const context: SessionContext = includeMessages
			? sessionManager.buildSessionContext()
			: { messages: [], thinkingLevel: "off", serviceTier: "default", model: null };
		const branch = sessionManager.getBranch();
		if (!includeMessages) {
			for (const entry of branch) {
				if (
					entry.type === "model_change" ||
					entry.type === "thinking_level_change" ||
					entry.type === "service_tier_change" ||
					(entry.type === "message" && entry.message.role === "assistant")
				)
					restoreBootstrapSetting(context, entry);
			}
		}
		return {
			context,
			hasExistingSession: includeMessages
				? context.messages.length > 0
				: branch.some(
						(entry) =>
							entry.type === "compaction" ||
							entry.type === "custom_message" ||
							(entry.type === "message" && !!entry.message) ||
							(entry.type === "branch_summary" && !!entry.summary),
					),
			hasThinkingEntry: branch.some((entry) => entry.type === "thinking_level_change"),
			hasServiceTierEntry: branch.some((entry) => entry.type === "service_tier_change"),
		};
	}
	return sessionManager.readBranchHistory(async (view) => {
		const bootstrap = await view.branchBootstrap();
		const context: SessionContext = { messages: [], thinkingLevel: "off", serviceTier: "default", model: null };
		let sourceBytes = 0;
		for (const ref of [bootstrap.model, bootstrap.thinkingLevel, bootstrap.serviceTier]) {
			if (!ref) continue;
			const remaining = limits.maxSourceBytes - sourceBytes;
			sourceBytes += ref.locator.length;
			if (sourceBytes > limits.maxSourceBytes) throw new Error("Bootstrap source byte budget exceeded");
			const hydrated = await view.hydrateEntry(ref.id, remaining);
			if (!hydrated) throw new Error("Bootstrap setting source is unavailable");
			restoreBootstrapSetting(context, hydrated.entry);
		}
		if (includeMessages) context.messages = await new CanonicalContextCompiler().compile(view.branchContext, limits);
		return {
			context,
			hasExistingSession: bootstrap.hasContextMessages,
			hasThinkingEntry: bootstrap.thinkingLevel !== null,
			hasServiceTierEntry: bootstrap.serviceTier !== null,
		};
	});
}
