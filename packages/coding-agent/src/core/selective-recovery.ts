import { StringEnum } from "@ponythewhite/base-context-ai";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { stringifyBoundedJson } from "./bounded-json.js";
import type { IndexedSourceEvent } from "./history-index.js";
import { SELECTED_SKILL_CUSTOM_TYPE, selectedSkillCapture } from "./selected-skills.js";
import { hydrateCapturedHistoryEntry, type SessionHistoryReadView } from "./session-history-index.js";
import type { SessionEntry } from "./session-manager.js";
import { projectTaskStateSource } from "./task-state.js";

export interface NativeRecoveryLimits {
	maxBytes: number;
	maxSourceBytes: number;
	maxItems: number;
	maxRequests: number;
}

/** Defaults match bounded index pages and 64KiB payload parts; all admission units are bytes or items. */
export const DEFAULT_NATIVE_RECOVERY_LIMITS: Readonly<NativeRecoveryLimits> = Object.freeze({
	maxBytes: 64 * 1024,
	maxSourceBytes: 1024 * 1024,
	maxItems: 16,
	maxRequests: 8,
});

const exactString = Type.String({ minLength: 1, maxLength: 512 });
const byteLimit = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const operationSchema = Type.Object(
	{
		action: Type.Union([Type.Literal("read"), Type.Literal("search"), Type.Literal("recover")]),
		ref: Type.Optional(exactString),
		revision: Type.Optional(exactString),
		sourceSessionId: Type.Optional(exactString),
		field: Type.Optional(exactString),
		need: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
		query: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
		startLine: Type.Optional(byteLimit),
		endLine: Type.Optional(byteLimit),
		maxBytes: Type.Optional(byteLimit),
	},
	{ additionalProperties: false },
);

/** A ref is a case-sensitive entry ID, never a path. Lines are one-based within each selected field. */
export const nativeRecoveryInputSchema = Type.Union([
	operationSchema,
	Type.Object(
		{ action: Type.Literal("skill"), name: exactString, maxBytes: Type.Optional(byteLimit) },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("batch"),
			requests: Type.Array(operationSchema, { minItems: 1, maxItems: 8 }),
			maxBytes: Type.Optional(byteLimit),
		},
		{ additionalProperties: false },
	),
]);
const providerOperationSchema = Type.Object(
	{ ...operationSchema.properties, action: StringEnum(["read", "search", "recover"] as const) },
	{ additionalProperties: false },
);

/** Provider-facing tools require an object root; execute still applies the strict union above. */
export const nativeRecoveryToolSchema = Type.Object(
	{
		...providerOperationSchema.properties,
		action: StringEnum(["read", "search", "recover", "batch", "skill"] as const),
		name: Type.Optional(exactString),
		requests: Type.Optional(Type.Array(providerOperationSchema, { minItems: 1, maxItems: 8 })),
	},
	{ additionalProperties: false },
);

export type NativeRecoveryInput = Static<typeof nativeRecoveryInputSchema>;
export type NativeRecoveryOperation = Static<typeof operationSchema>;
export type NativeRecoveryStatus =
	| "found"
	| "complete-miss"
	| "partial"
	| "not_authorized"
	| "unavailable"
	| "budget_refused";
export type NativeRecoveryCoverage = "complete" | "partial" | "unknown";
export interface NativeRecoveryScope {
	kind: "branch";
	/** Missing coordinates mean capture was unavailable, not whole-source authority. */
	sourceSessionId?: string;
	leafId?: string | null;
	sourceSequence?: number;
	projection: "public-text-only";
}
export interface NativeRecoverySource {
	sourceSessionId: string;
	entryId: string;
	revision: string;
	field: string;
	startLine: number;
	endLine: number;
}
export interface NativeRecoveryRecord extends Omit<NativeRecoverySource, "entryId"> {
	ref: string;
	kind: string;
	text: string;
}
export interface NativeRecoveryResult {
	requestIndex: number;
	status: NativeRecoveryStatus;
	coverage: NativeRecoveryCoverage;
	records: NativeRecoveryRecord[];
	reason?: string;
}
export interface NativeRecoveryResponse {
	kind: "native-recovery";
	version: 1;
	nativeRecovery: 1;
	authority: "tool-data";
	freshness: "unknown";
	scope: NativeRecoveryScope;
	status: NativeRecoveryStatus;
	coverage: NativeRecoveryCoverage;
	sources: NativeRecoverySource[];
	results: NativeRecoveryResult[];
	reason?: string;
}

/** A cap smaller than the refusal envelope cannot be satisfied by returning clipped JSON. */
export class NativeRecoveryBudgetRefusal extends Error {
	readonly status = "budget_refused";
	constructor() {
		super("Native recovery byte or item budget refused");
		this.name = "NativeRecoveryBudgetRefusal";
	}
}

export function stringifyNativeRecoveryResponse(
	response: NativeRecoveryResponse,
	maxBytes = DEFAULT_NATIVE_RECOVERY_LIMITS.maxBytes,
): string {
	try {
		return stringifyBoundedJson(response, maxBytes);
	} catch {
		throw new NativeRecoveryBudgetRefusal();
	}
}

/** Tool details carry reference metadata, not a second copy of the selected body. */
export function nativeRecoveryMetadata(response: NativeRecoveryResponse) {
	return {
		kind: response.kind,
		version: response.version,
		nativeRecovery: response.nativeRecovery,
		scope: response.scope,
		sources: response.sources,
		coverage: response.coverage,
		authority: response.authority,
		freshness: response.freshness,
		status: response.status,
	};
}

/** Callers use fixed public reason codes, never raw exceptions or source locators. */
export function createNativeRecoveryRefusal(
	status: "not_authorized" | "unavailable" | "budget_refused",
	reason: string,
	maxBytes = DEFAULT_NATIVE_RECOVERY_LIMITS.maxBytes,
): NativeRecoveryResponse {
	const response: NativeRecoveryResponse = {
		kind: "native-recovery",
		version: 1,
		nativeRecovery: 1,
		authority: "tool-data",
		freshness: "unknown",
		scope: { kind: "branch", projection: "public-text-only" },
		status,
		coverage: "unknown",
		sources: [],
		results: [],
		reason,
	};
	stringifyNativeRecoveryResponse(response, maxBytes);
	return response;
}

interface PublicField {
	field: string;
	text: string;
}
function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Select known public string fields; never traverse executed-input/provider envelopes, signatures or thinking. */
function publicFields(
	entry: SessionEntry,
	maxItems: number,
	qualification?: IndexedSourceEvent["qualification"],
): PublicField[] | undefined {
	if (entry.type === "compaction" || entry.type === "branch_summary") {
		return typeof entry.summary === "string" ? [{ field: "/summary", text: entry.summary }] : undefined;
	}
	let content: unknown;
	let field: string;
	let role: unknown;
	if (
		(entry.type === "custom" || entry.type === "custom_message") &&
		qualification === "native-recovery" &&
		entry.customType === SELECTED_SKILL_CUSTOM_TYPE
	) {
		const skill = selectedSkillCapture(entry);
		if (skill)
			return [
				{ field: entry.type === "custom" ? "/data/content" : "/content", text: skill.content },
				{
					field: `/${entry.type === "custom" ? "data" : "details"}/baseContextSelectedSkill/descriptor`,
					text: JSON.stringify({ ...skill.descriptor, sourceInfo: undefined }),
				},
			];
	}
	if (entry.type === "custom_message") {
		content = entry.content;
		field = "/content";
		role = "custom";
	} else if (entry.type === "message") {
		const message = object(entry.message);
		if (!message || !["user", "assistant", "toolResult", "custom"].includes(String(message.role))) return undefined;
		content = message.content;
		role = message.role;
		field = "/message/content";
	} else return undefined;
	if (typeof content === "string") {
		return role === "user" || role === "custom" ? [{ field, text: content }] : undefined;
	}
	if (!Array.isArray(content)) return undefined;
	if (content.length > maxItems) throw new NativeRecoveryBudgetRefusal();
	const fields: PublicField[] = [];
	for (let i = 0; i < content.length; i++) {
		const block = object(content[i]);
		if (!block) return undefined;
		if (block.type === "text" && typeof block.text === "string") {
			if (fields.length >= maxItems) throw new NativeRecoveryBudgetRefusal();
			fields.push({ field: `${field}/${i}/text`, text: block.text });
		} else if (block.type === "thinking" && role === "assistant" && typeof block.thinking === "string") {
			// Thinking is unsupported by this v1 projection; this does not classify all thinking text as private.
		} else if (
			block.type === "toolCall" &&
			role === "assistant" &&
			typeof block.id === "string" &&
			typeof block.name === "string" &&
			object(block.arguments)
		) {
			// Assistant-authored string arguments are public action data, not executed-input/auth envelopes.
			const arguments_ = block.arguments as Record<string, unknown>;
			let visited = 0;
			for (const key in arguments_) {
				if (!Object.hasOwn(arguments_, key)) continue;
				if (++visited > maxItems) throw new NativeRecoveryBudgetRefusal();
				const value = arguments_[key];
				// v1 does not select nested/non-string argument fields; it does not label them private.
				if (typeof value !== "string") continue;
				if (fields.length >= maxItems) throw new NativeRecoveryBudgetRefusal();
				const escaped = key.replaceAll("~", "~0").replaceAll("/", "~1");
				fields.push({ field: `${field}/${i}/arguments/${escaped}`, text: value });
			}
		} else if (
			block.type === "image" &&
			role !== "assistant" &&
			typeof block.data === "string" &&
			typeof block.mimeType === "string"
		) {
			// This API selects text only; it makes no lossless multimodal claim.
		} else return undefined;
	}
	return fields;
}

function outcome(
	requestIndex: number,
	status: NativeRecoveryStatus,
	coverage: NativeRecoveryCoverage = "unknown",
	records: NativeRecoveryRecord[] = [],
	reason?: string,
): NativeRecoveryResult {
	return { requestIndex, status, coverage, records, ...(reason ? { reason } : {}) };
}

function assemble(scope: NativeRecoveryScope, results: NativeRecoveryResult[]): NativeRecoveryResponse {
	const statuses = new Set(results.map((result) => result.status));
	const status =
		statuses.size === 1
			? results[0].status
			: results.every((result) => result.status === "found" || result.status === "complete-miss")
				? "found"
				: "partial";
	const coverage = results.every((result) => result.coverage === "complete")
		? "complete"
		: results.some((result) => result.coverage === "partial")
			? "partial"
			: "unknown";
	return {
		kind: "native-recovery",
		version: 1,
		nativeRecovery: 1,
		authority: "tool-data",
		freshness: "unknown",
		scope,
		status,
		coverage,
		results,
		sources: results.flatMap((result) =>
			result.records.map((record) => ({
				sourceSessionId: record.sourceSessionId,
				entryId: record.ref,
				revision: record.revision,
				field: record.field,
				startLine: record.startLine,
				endLine: record.endLine,
			})),
		),
	};
}

/** Shared runtime admission for the native tool and Python host bridge. */
export function parseNativeRecoveryInput(value: unknown): NativeRecoveryInput {
	let request: NativeRecoveryInput;
	try {
		request = JSON.parse(stringifyBoundedJson(value, 128 * 1024)) as NativeRecoveryInput;
	} catch {
		throw new NativeRecoveryBudgetRefusal();
	}
	if (!Value.Check(nativeRecoveryInputSchema, request)) throw new Error("Invalid native recovery request");
	return request;
}

/** The caller captures ONE server branch before entering this service, including for a batch. */
export async function recoverCapturedHistory(
	view: SessionHistoryReadView,
	input: NativeRecoveryInput,
	limits: NativeRecoveryLimits = DEFAULT_NATIVE_RECOVERY_LIMITS,
	signal?: AbortSignal,
): Promise<NativeRecoveryResponse> {
	const cap = { ...limits };
	for (const key of ["maxBytes", "maxSourceBytes", "maxItems", "maxRequests"] as const) {
		if (!Number.isSafeInteger(cap[key]) || cap[key] < 1) throw new NativeRecoveryBudgetRefusal();
		cap[key] = Math.min(cap[key], DEFAULT_NATIVE_RECOVERY_LIMITS[key]);
	}
	// Bound and detach input before schema traversal or the first await. Unknown selectors are rejected.
	let request: NativeRecoveryInput;
	try {
		request = parseNativeRecoveryInput(input);
	} catch (error) {
		return createNativeRecoveryRefusal(
			error instanceof NativeRecoveryBudgetRefusal ? "budget_refused" : "unavailable",
			"invalid_request",
			cap.maxBytes,
		);
	}
	const maxBytes = Math.min(cap.maxBytes, request.maxBytes ?? cap.maxBytes);
	const { sessionId: sourceSessionId, leafId, sourceSequence } = view.source;
	const scope: NativeRecoveryScope = {
		kind: "branch",
		projection: "public-text-only",
		sourceSessionId,
		leafId,
		sourceSequence,
	};
	if (request.action === "skill")
		return createNativeRecoveryRefusal("not_authorized", "native_skill_selection_owner_required", maxBytes);
	const operations = request.action === "batch" ? request.requests : [request];
	const results = operations.map((_, i) => outcome(i, "budget_refused", "unknown", [], "not_admitted"));
	// Reserve an explicit result for EVERY requested operation before touching canonical payloads.
	stringifyNativeRecoveryResponse(assemble(scope, results), maxBytes);
	if (operations.length > cap.maxRequests) return assemble(scope, results);
	let sourceBytes = 0;
	let examined = 0;
	let selectedItems = 0;
	const cache = new Map<string, { revision: string; entry: SessionEntry }>();

	async function fieldsFor(metadata: IndexedSourceEvent, requestedField?: string): Promise<PublicField[] | undefined> {
		signal?.throwIfAborted();
		let cached = cache.get(metadata.id);
		if (cached && cached.revision !== metadata.revision) throw new Error("Captured revision changed");
		if (!cached) {
			if (++examined > cap.maxItems || metadata.locator.length > cap.maxSourceBytes - sourceBytes) {
				throw new NativeRecoveryBudgetRefusal();
			}
			sourceBytes += metadata.locator.length;
			const hydrated = await hydrateCapturedHistoryEntry(metadata, metadata.locator.length, async (id, options) => {
				signal?.throwIfAborted();
				return view.readPayload(id, options);
			});
			signal?.throwIfAborted();
			cached = { revision: metadata.revision, entry: hydrated.entry };
			cache.set(metadata.id, cached);
		}
		if (requestedField === "/nativeOrigin/submitted/text") {
			if (
				cached.entry.type !== "message" ||
				metadata.qualification !== "native-admission" ||
				metadata.retention === "retained-import"
			)
				return undefined;
			// Reuse the existing exact native-input qualification, not generic origin traversal.
			// The first qualifying projection is submitted.text; return before visiting content parts.
			for (const projection of projectTaskStateSource({
				sessionId: sourceSessionId,
				sequence: metadata.sequence,
				revision: metadata.revision,
				qualification: metadata.qualification,
				retention: metadata.retention,
				entry: cached.entry,
			})) {
				if (
					projection.source.field === requestedField &&
					projection.authority === "user" &&
					projection.attribution === "source-backed" &&
					typeof projection.text === "string"
				) {
					return [{ field: requestedField, text: projection.text }];
				}
				return undefined;
			}
			return undefined;
		}
		return publicFields(cached.entry, cap.maxItems, metadata.qualification);
	}

	async function recover(operation: NativeRecoveryOperation, i: number): Promise<NativeRecoveryResult> {
		if (operation.sourceSessionId !== undefined && operation.sourceSessionId !== scope.sourceSessionId) {
			return outcome(i, "not_authorized", "unknown", [], "source_not_in_capture");
		}
		if (
			(operation.need !== undefined && operation.query !== undefined && operation.need !== operation.query) ||
			(operation.endLine !== undefined && operation.endLine < (operation.startLine ?? 1))
		) {
			return outcome(i, "unavailable", "unknown", [], "conflicting_selection");
		}
		const needle = operation.need ?? operation.query;
		let candidates: IndexedSourceEvent[];
		let coverage: NativeRecoveryCoverage;
		if (operation.ref !== undefined) {
			const metadata = await view.get(operation.ref);
			if (!metadata || metadata.id !== operation.ref) {
				return outcome(i, "not_authorized", "unknown", [], "ref_not_in_captured_branch");
			}
			if (operation.revision !== undefined && operation.revision !== metadata.revision) {
				return outcome(i, "unavailable", "unknown", [], "revision_mismatch");
			}
			candidates = [metadata];
			coverage = "complete";
		} else {
			if (
				operation.action === "read" ||
				needle === undefined ||
				operation.revision !== undefined ||
				operation.field !== undefined ||
				operation.startLine !== undefined ||
				operation.endLine !== undefined
			) {
				return outcome(i, "unavailable", "unknown", [], "exact_selection_requires_ref");
			}
			if (Buffer.byteLength(needle) > 8192) throw new NativeRecoveryBudgetRefusal();
			if (examined >= cap.maxItems) throw new NativeRecoveryBudgetRefusal();
			const page = await view.search(needle, cap.maxItems - examined);
			candidates = page.events;
			// Search indexes token conjunctions, including non-public strings. It is not an exhaustive
			// literal-substring search even when its indexed text coverage is reported complete.
			coverage =
				page.coverage === "partial" || page.truncated || page.indexedThrough < sourceSequence
					? "partial"
					: "unknown";
		}
		const records: NativeRecoveryRecord[] = [];
		let unavailable = false;
		let beyondWindow = false;
		let needWindow = false;
		for (const metadata of candidates) {
			const fields = await fieldsFor(metadata, operation.field);
			if (!fields || (operation.field !== undefined && !fields.some((field) => field.field === operation.field))) {
				unavailable = true;
				continue;
			}
			for (const selected of fields) {
				if (operation.field !== undefined && operation.field !== selected.field) continue;
				const lines = selected.text.split("\n");
				let startLine = operation.startLine ?? 1;
				let endLine = Math.min(operation.endLine ?? lines.length, lines.length);
				if (needle !== undefined && operation.startLine === undefined && operation.endLine === undefined) {
					const first = selected.text.indexOf(needle);
					if (first < 0) continue;
					// Select whole exact lines containing the first literal occurrence, including every
					// line of a multiline needle. A required huge line is refused, never prefix-clipped.
					startLine = selected.text.slice(0, first).split("\n").length;
					endLine = startLine + needle.split("\n").length - 1;
					if (startLine > 1 || endLine < lines.length) needWindow = true;
				}
				if (startLine > lines.length) continue;
				const text = lines.slice(startLine - 1, endLine).join("\n");
				if (needle !== undefined && !text.includes(needle)) continue;
				if (operation.endLine !== undefined && operation.endLine > lines.length) beyondWindow = true;
				if (selectedItems + records.length >= cap.maxItems) throw new NativeRecoveryBudgetRefusal();
				records.push({
					ref: metadata.id,
					revision: metadata.revision,
					sourceSessionId,
					kind: metadata.kind,
					field: selected.field,
					startLine,
					endLine,
					text,
				});
			}
		}
		if (operation.ref !== undefined && unavailable)
			return outcome(i, "unavailable", "unknown", [], "unsupported_public_field");
		if (unavailable || beyondWindow || needWindow) coverage = "partial";
		const status = coverage === "complete" ? (records.length ? "found" : "complete-miss") : "partial";
		return outcome(
			i,
			status,
			coverage,
			records,
			coverage === "unknown"
				? "candidate_search_not_exhaustive"
				: unavailable
					? "unsupported_public_shape"
					: beyondWindow
						? "requested_end_beyond_source"
						: needWindow
							? "need_window"
							: undefined,
		);
	}

	for (let i = 0; i < operations.length; i++) {
		try {
			signal?.throwIfAborted();
			const result = await recover(operations[i], i);
			signal?.throwIfAborted();
			stringifyBoundedJson(result, Math.min(maxBytes, operations[i].maxBytes ?? maxBytes));
			results[i] = result;
			stringifyNativeRecoveryResponse(assemble(scope, results), maxBytes);
			selectedItems += result.records.length;
		} catch (error) {
			const budget =
				error instanceof NativeRecoveryBudgetRefusal ||
				(error instanceof Error && /budget|limit/i.test(error.message));
			results[i] = outcome(
				i,
				budget ? "budget_refused" : "unavailable",
				"unknown",
				[],
				budget ? "operation_budget" : signal?.aborted ? "aborted" : "canonical_source_unavailable",
			);
		}
	}
	const response = assemble(scope, results);
	stringifyNativeRecoveryResponse(response, maxBytes);
	return response;
}
