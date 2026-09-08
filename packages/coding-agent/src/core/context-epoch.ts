import type { ProviderRequestRepresentation, RequestTokenAssessment, Usage } from "@ponythewhite/base-context-ai";
import { stringifyBoundedJson } from "./bounded-json.js";
import type { ContextRef } from "./history-index.js";
import type { SourceSnapshotRef } from "./request-events.js";
import type { CompiledTaskFrame } from "./task-frame.js";

export const CONTEXT_EPOCH_DETAIL = "baseContextEpoch";
/** Internal admission, not a field accepted by ordinary appendCompaction callers. */
export const appendContextEpoch = Symbol("appendContextEpoch");
export const CONTEXT_EPOCH_RENDERER = "native-canonical-epoch/2";
export type ContextReplayContract = "complete-context" | "message-groups";

/** An ordinary summary and its retained source recipes share the existing compaction ACK. */
export interface ContextEpochSummary {
	readonly summary: string;
	readonly details?: Record<string, unknown>;
	readonly fromHook?: boolean;
	readonly customInstructions?: string;
	readonly usage?: Usage;
}

/** A frozen read recipe, not a second copy of an archived message body. */
export interface EpochViewReference {
	readonly source: SourceSnapshotRef;
	readonly ref: ContextRef;
	readonly sourceRevision: string;
	/** Present only for an existing rendered compaction summary. */
	readonly retainedMessageCount?: number;
}

export interface ContextEpochCheckpoint {
	readonly version: 1 | 2;
	readonly renderer: "native-canonical-epoch/1" | typeof CONTEXT_EPOCH_RENDERER;
	readonly source: SourceSnapshotRef;
	/** Null only for an ordinary summary, which is not a measured provider request. */
	readonly representation: string | null;
	readonly includeSummary?: true;
	/** Granted by an actual accepted adapter projection, never a caller profile name. */
	readonly replayContract?: ContextReplayContract;
	readonly views: readonly EpochViewReference[];
	/** Derived display only. The task reducer remains the authority for later changes. */
	readonly taskFrame?: CompiledTaskFrame;
	readonly literalTailId: string;
}

export function snapshotContextEpoch(value: ContextEpochCheckpoint, maxBytes: number): ContextEpochCheckpoint {
	return JSON.parse(stringifyBoundedJson(value, maxBytes)) as ContextEpochCheckpoint;
}

/** Called only after checking the source frame's genuine epoch qualification. */
export function readContextEpoch(details: unknown, maxBytes: number): ContextEpochCheckpoint | undefined {
	if (!details || typeof details !== "object" || !(CONTEXT_EPOCH_DETAIL in details)) return;
	const value: unknown = details[CONTEXT_EPOCH_DETAIL];
	if (
		!value ||
		typeof value !== "object" ||
		!("version" in value) ||
		!("renderer" in value) ||
		!(
			(value.version === 1 && value.renderer === "native-canonical-epoch/1") ||
			(value.version === 2 && value.renderer === CONTEXT_EPOCH_RENDERER)
		) ||
		!("source" in value) ||
		!value.source ||
		!("views" in value) ||
		!Array.isArray(value.views) ||
		!("literalTailId" in value) ||
		typeof value.literalTailId !== "string" ||
		!("representation" in value) ||
		!(
			typeof value.representation === "string" ||
			(value.version === 2 &&
				value.representation === null &&
				"includeSummary" in value &&
				value.includeSummary === true)
		) ||
		("includeSummary" in value &&
			(value.version !== 2 || value.includeSummary !== true || value.representation !== null)) ||
		("replayContract" in value &&
			value.replayContract !== "complete-context" &&
			value.replayContract !== "message-groups")
	)
		throw new Error("Invalid committed context epoch");
	return snapshotContextEpoch(value as ContextEpochCheckpoint, maxBytes);
}

/** Stable representation, not the changing input, an auth envelope, or a cache-hit claim. */
export function contextEpochRepresentation(
	request: ProviderRequestRepresentation,
	assessment: RequestTokenAssessment | undefined,
	maxBytes: number,
): string {
	if (
		!assessment?.profile ||
		assessment.limitSource !== "explicit-profile" ||
		!assessment.route ||
		!assessment.model ||
		request.body === undefined
	)
		throw new Error("Committed context epoch requires its explicit request profile");
	const body: unknown = JSON.parse(request.body);
	if (!body || typeof body !== "object" || Array.isArray(body))
		throw new Error("Context epoch request representation is unavailable");
	const configuration: Record<string, unknown> = {};
	const fields = new Set([
		"model",
		"instructions",
		"stream",
		"max_output_tokens",
		"max_tokens",
		"max_completion_tokens",
		"temperature",
		"top_p",
		"text",
		"tools",
		"tool_choice",
		"parallel_tool_calls",
		"store",
		"reasoning",
		"service_tier",
		"truncation",
		"include",
		"prompt_cache_retention",
		"stream_options",
	]);
	for (const [key, value] of Object.entries(body)) {
		if (["input", "messages", "previous_response_id", "prompt_cache_key"].includes(key)) continue;
		// Unknown payload extensions may contain private data or change the representation.
		if (!fields.has(key)) throw new Error("Unsupported context epoch request configuration");
		configuration[key] = value;
	}
	const input: unknown = "input" in body ? body.input : "messages" in body ? body.messages : undefined;
	if (!Array.isArray(input)) throw new Error("Context epoch request messages are unavailable");
	const policy = input.filter(
		(item: unknown) =>
			item && typeof item === "object" && "role" in item && (item.role === "system" || item.role === "developer"),
	);
	return stringifyBoundedJson(
		{
			renderer: CONTEXT_EPOCH_RENDERER,
			api: request.api,
			provider: request.provider,
			route: assessment.route,
			model: assessment.model,
			profile: assessment.profile,
			contextTokens: assessment.contextTokens,
			outputReserveTokens: assessment.outputReserveTokens,
			configuration,
			policy,
		},
		maxBytes,
	);
}
