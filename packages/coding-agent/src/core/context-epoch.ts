import type { ProviderRequestRepresentation, RequestTokenAssessment, Usage } from "@ponythewhite/base-context-ai";
import { requestTokenRouteIdentity } from "@ponythewhite/base-context-ai";
import { stringifyBoundedJson } from "./bounded-json.js";
import type { ContextRef } from "./history-index.js";
import type { SourceSnapshotRef } from "./request-events.js";
import { MAX_RESOURCE_REVISION_BYTES } from "./resource-view.js";
import type { CompiledTaskFrame } from "./task-frame.js";

export const CONTEXT_EPOCH_DETAIL = "baseContextEpoch";
/** Internal admission, not a field accepted by ordinary appendCompaction callers. */
export const appendContextEpoch = Symbol("appendContextEpoch");
export const CONTEXT_EPOCH_RENDERER = "native-canonical-epoch/4";
export const CONTEXT_POLICY_EPOCH_RENDERER = "native-canonical-epoch/5";
export type ContextMode = "on" | "off";

/** Compatibility retained from an accepted native request, not measurement or replay credit. */
export interface ContextEpochRequestContract {
	readonly api: string;
	readonly provider: string;
	readonly route: string;
	readonly model: string;
	readonly replayContract: ContextReplayContract;
}
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
	readonly rendering?: "public-history/1";
}

interface ContextEpochFields {
	readonly renderer:
		| "native-canonical-epoch/1"
		| "native-canonical-epoch/2"
		| "native-canonical-epoch/3"
		| typeof CONTEXT_EPOCH_RENDERER
		| typeof CONTEXT_POLICY_EPOCH_RENDERER;
	readonly source: SourceSnapshotRef;
	readonly includeSummary?: true;
	/** Granted by an actual accepted adapter projection, never a caller profile name. */
	readonly replayContract?: ContextReplayContract;
	/** Actual adapter permission to leave completed native groups for a fresh public window. */
	readonly publicWindow?: true;
	/** Frozen public transition. Later native messages are not silently converted. */
	readonly continuation?: {
		readonly kind: "harness-summary" | "portable-checkpoint";
		readonly publicTailThrough: SourceSnapshotRef;
	};
	readonly views: readonly EpochViewReference[];
	/** Derived display only. The task reducer remains the authority for later changes. */
	readonly taskFrame?: CompiledTaskFrame;
	/** Accepted-state comparison only; saved metadata never establishes current resource liveness. */
	readonly resourceRevision?: string;
	readonly literalTailId: string;
}

/** v5 policy-only null is a mode ACK, not an ordinary summary or a measured request. */
export type ContextEpochCheckpoint = ContextEpochFields &
	(
		| {
				readonly version: 1 | 2 | 3 | 4;
				readonly representation: string | null;
				readonly mode?: never;
				readonly policyOnly?: never;
				readonly requestContract?: never;
				readonly pendingRequestContract?: never;
		  }
		| {
				readonly version: 5;
				readonly mode: ContextMode;
				readonly representation: null;
				readonly policyOnly: true;
				readonly includeSummary?: never;
				readonly requestContract?: ContextEpochRequestContract;
				readonly pendingRequestContract?: true;
		  }
	);

export function contextEpochMode(
	checkpoint: ContextEpochCheckpoint | undefined,
	initial: ContextMode = "on",
): ContextMode {
	return checkpoint ? (checkpoint.version === 5 ? checkpoint.mode : "on") : initial;
}

function isRequestContract(value: unknown): value is ContextEpochRequestContract {
	if (!value || typeof value !== "object") return false;
	return (
		["api", "provider", "route", "model"].every(
			(key) =>
				key in value &&
				typeof (value as Record<string, unknown>)[key] === "string" &&
				(value as Record<string, unknown>)[key] !== "",
		) &&
		"replayContract" in value &&
		(value.replayContract === "complete-context" || value.replayContract === "message-groups")
	);
}

/** Only call with a qualified checkpoint, never raw compaction marker data. */
export function retainedContextRequestContract(
	checkpoint: ContextEpochCheckpoint | undefined,
): ContextEpochRequestContract | undefined {
	if (!checkpoint) return;
	if (checkpoint.requestContract) return structuredClone(checkpoint.requestContract);
	if (!checkpoint.representation) return;
	const accepted: unknown = JSON.parse(checkpoint.representation);
	if (!accepted || typeof accepted !== "object") throw new Error("Accepted context request contract is unavailable");
	const value = { ...accepted, replayContract: checkpoint.replayContract ?? "complete-context" };
	if (!isRequestContract(value)) throw new Error("Accepted context request contract is unavailable");
	return {
		api: value.api,
		provider: value.provider,
		route: value.route,
		model: value.model,
		replayContract: value.replayContract,
	};
}

/** Identity comes from the actual final native serialization, not a model/profile label. */
export function contextRequestContract(
	request: ProviderRequestRepresentation,
	replayContract: ContextReplayContract,
): ContextEpochRequestContract {
	const route = requestTokenRouteIdentity(request.url);
	const body: unknown = request.body === undefined ? undefined : JSON.parse(request.body);
	if (
		!route ||
		!body ||
		typeof body !== "object" ||
		!("model" in body) ||
		typeof body.model !== "string" ||
		!body.model
	)
		throw new Error("Native context request identity is unavailable");
	return { api: request.api, provider: request.provider, route, model: body.model, replayContract };
}

export function assertContextRequestContract(
	contract: ContextEpochRequestContract,
	request: ProviderRequestRepresentation,
	replayContract: ContextReplayContract,
): void {
	const actual = contextRequestContract(request, replayContract);
	if (
		actual.api !== contract.api ||
		actual.provider !== contract.provider ||
		actual.route !== contract.route ||
		actual.model !== contract.model ||
		actual.replayContract !== contract.replayContract
	)
		throw new Error("Retained context requires its accepted native request contract");
}

export function snapshotContextEpoch<T extends ContextEpochCheckpoint>(value: T, maxBytes: number): T {
	return JSON.parse(stringifyBoundedJson(value, maxBytes)) as T;
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
			(value.version === 2 && value.renderer === "native-canonical-epoch/2") ||
			(value.version === 3 && value.renderer === "native-canonical-epoch/3") ||
			(value.version === 4 && value.renderer === "native-canonical-epoch/4") ||
			(value.version === 5 && value.renderer === CONTEXT_POLICY_EPOCH_RENDERER)
		) ||
		!("source" in value) ||
		!value.source ||
		!("views" in value) ||
		!Array.isArray(value.views) ||
		!("literalTailId" in value) ||
		typeof value.literalTailId !== "string" ||
		!("representation" in value) ||
		(value.version === 5 ? !("mode" in value) || (value.mode !== "on" && value.mode !== "off") : "mode" in value) ||
		(value.version === 5 &&
			(value.representation !== null || !("policyOnly" in value) || value.policyOnly !== true)) ||
		("policyOnly" in value &&
			(value.version !== 5 ||
				value.policyOnly !== true ||
				value.representation !== null ||
				"includeSummary" in value)) ||
		("pendingRequestContract" in value &&
			(value.version !== 5 ||
				!("mode" in value) ||
				value.mode !== "off" ||
				value.pendingRequestContract !== true ||
				"requestContract" in value)) ||
		("requestContract" in value && (value.version !== 5 || !isRequestContract(value.requestContract))) ||
		!(
			typeof value.representation === "string" ||
			(value.version === 5 && value.representation === null && "policyOnly" in value && value.policyOnly === true) ||
			((value.version === 2 || value.version === 3 || value.version === 4) &&
				value.representation === null &&
				"includeSummary" in value &&
				value.includeSummary === true)
		) ||
		("includeSummary" in value &&
			((value.version !== 2 && value.version !== 3 && value.version !== 4) ||
				value.includeSummary !== true ||
				value.representation !== null)) ||
		("replayContract" in value &&
			value.replayContract !== "complete-context" &&
			value.replayContract !== "message-groups") ||
		("resourceRevision" in value &&
			(typeof value.resourceRevision !== "string" ||
				Buffer.byteLength(value.resourceRevision, "utf8") > MAX_RESOURCE_REVISION_BYTES)) ||
		("publicWindow" in value &&
			((value.version !== 3 && value.version !== 4 && value.version !== 5) || value.publicWindow !== true)) ||
		("continuation" in value &&
			((value.version !== 3 && value.version !== 4 && value.version !== 5) ||
				!value.continuation ||
				typeof value.continuation !== "object" ||
				!("kind" in value.continuation) ||
				(value.continuation.kind !== "harness-summary" &&
					((value.version !== 4 && value.version !== 5) || value.continuation.kind !== "portable-checkpoint")) ||
				!("publicTailThrough" in value.continuation) ||
				!value.continuation.publicTailThrough))
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
