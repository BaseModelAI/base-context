import { randomUUID } from "node:crypto";
import { StringEnum } from "@ponythewhite/base-context-ai";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { AGENT_RESULT_CUSTOM_TYPE } from "./agent-results.js";
import { stringifyBoundedJson } from "./bounded-json.js";
import type { IndexedSourceEvent } from "./history-index.js";
import type { SourceSnapshotRef } from "./request-events.js";
import {
	decodedTextWindow,
	PUBLIC_TEXT_WINDOW_BYTES,
	type RetainedToolOutput,
	readRetainedToolOutput,
	retainedToolOutput,
} from "./retained-tool-output.js";
import { SELECTED_SKILL_CUSTOM_TYPE, selectedSkillCapture } from "./selected-skills.js";
import { hydrateCapturedHistoryEntry, type SessionHistoryReadView } from "./session-history-index.js";
import { getSessionArtifactPathForFile, type SessionEntry } from "./session-manager.js";
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
		cursor: Type.Optional(exactString),
		startByte: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
		endByte: Type.Optional(byteLimit),
		revision: Type.Optional(exactString),
		sourceSessionId: Type.Optional(exactString),
		field: Type.Optional(exactString),
		need: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: 8192,
				description:
					"Literal text selector; alias of query. Prefer one field. If both are supplied, use identical text.",
			}),
		),
		query: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: 8192,
				description:
					"Literal text selector; alias of need. Prefer one field. If both are supplied, use identical text.",
			}),
		),
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
	startLine?: number;
	endLine?: number;
	startByte?: number;
	endByte?: number;
	prefixOmitted?: boolean;
	suffixOmitted?: boolean;
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
	cursor?: string;
	exhausted?: boolean;
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
	retained?: RetainedToolOutput;
	unavailable?: boolean;
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
	if (
		entry.type === "custom" &&
		entry.customType === AGENT_RESULT_CUSTOM_TYPE &&
		qualification === "native-recovery"
	) {
		const findings = object(entry.data)?.findings;
		return typeof findings === "string" ? [{ field: "/data/findings", text: findings }] : undefined;
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
				startByte: record.startByte,
				endByte: record.endByte,
				prefixOmitted: record.prefixOmitted,
				suffixOmitted: record.suffixOmitted,
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

interface RecoveryCursorState {
	source: SourceSnapshotRef;
	operation: NativeRecoveryOperation;
	after: number;
	entryId?: string;
	field: number;
	byte: number;
	line: number;
	overlap: string;
	unavailable: boolean;
	matched: boolean;
}

/** Session-owned, ephemeral searches. No read lease or canonical body survives a call. */
export class NativeRecoveryCursorStore {
	private readonly states = new Map<string, RecoveryCursorState>();
	private generation = 0;
	clear(): void {
		this.states.clear();
		this.generation++;
	}
	get(id: string): RecoveryCursorState | undefined {
		return this.states.get(id);
	}
	delete(id: string): void {
		this.states.delete(id);
	}
	get version(): number {
		return this.generation;
	}
	save(state: RecoveryCursorState, version: number, id: string = randomUUID()): string {
		if (version !== this.generation) throw new Error("Expired recovery cursor");
		this.states.delete(id);
		this.states.set(id, structuredClone(state));
		while (this.states.size > 16) this.states.delete(this.states.keys().next().value!);
		return id;
	}
}

/** The caller captures ONE server branch before entering this service, including for a batch. */
export async function recoverCapturedHistory(
	view: SessionHistoryReadView,
	input: NativeRecoveryInput,
	limits: NativeRecoveryLimits = DEFAULT_NATIVE_RECOVERY_LIMITS,
	signal?: AbortSignal,
	cursors?: NativeRecoveryCursorStore,
): Promise<NativeRecoveryResponse> {
	const cap = { ...limits };
	for (const key of ["maxBytes", "maxSourceBytes", "maxItems", "maxRequests"] as const) {
		if (!Number.isSafeInteger(cap[key]) || cap[key] < 1) throw new NativeRecoveryBudgetRefusal();
		cap[key] = Math.min(cap[key], DEFAULT_NATIVE_RECOVERY_LIMITS[key]);
	}
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
	if (request.action === "skill")
		return createNativeRecoveryRefusal("not_authorized", "native_skill_selection_owner_required", maxBytes);
	const operations = request.action === "batch" ? request.requests : [request];
	const version = cursors?.version ?? 0;
	const resumed = operations.map((operation) => (operation.cursor ? cursors?.get(operation.cursor) : undefined));
	const anchor = resumed.find(Boolean)?.source;
	if (anchor) {
		if (resumed.some((state) => state && JSON.stringify(state.source) !== JSON.stringify(anchor)))
			return createNativeRecoveryRefusal("unavailable", "conflicting_selection", maxBytes);
		try {
			if (!view.atSnapshot) throw new Error("Captured source is unavailable");
			view = await view.atSnapshot(anchor);
		} catch {
			return createNativeRecoveryRefusal("unavailable", "cursor_source_unavailable", maxBytes);
		}
	}
	const { sessionId: sourceSessionId, leafId, sourceSequence } = view.source;
	const scope: NativeRecoveryScope = {
		kind: "branch",
		projection: "public-text-only",
		sourceSessionId,
		leafId,
		sourceSequence,
	};
	const results = operations.map((_, i) => outcome(i, "budget_refused", "unknown", [], "not_admitted"));
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
			if (metadata.locator.length > cap.maxSourceBytes - sourceBytes) throw new NativeRecoveryBudgetRefusal();
			sourceBytes += metadata.locator.length;
			const hydrated = await hydrateCapturedHistoryEntry(metadata, metadata.locator.length, (id, options) =>
				view.readPayload(id, options),
			);
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
				)
					return [{ field: requestedField, text: projection.text }];
				return undefined;
			}
			return undefined;
		}
		const fields = publicFields(cached.entry, DEFAULT_NATIVE_RECOVERY_LIMITS.maxItems, metadata.qualification);
		if (cached.entry.type === "message") {
			const message = object(cached.entry.message);
			const retained =
				message?.role === "toolResult" ? retainedToolOutput(object(message.details)?.retainedOutput) : undefined;
			const field = fields?.find((field) => field.field === retained?.field);
			if (field && retained) {
				if (metadata.qualification === "native-tool-execution" && metadata.retention !== "retained-import")
					field.retained = retained;
				else field.unavailable = true; // A preview is not the complete retained field, nor artifact authority.
			}
		}
		return fields;
	}

	async function recover(supplied: NativeRecoveryOperation, i: number): Promise<NativeRecoveryResult> {
		const saved = resumed[i];
		if (supplied.cursor && !saved) return outcome(i, "unavailable", "unknown", [], "expired_cursor");
		if (saved && supplied.action === "read") return outcome(i, "unavailable", "unknown", [], "conflicting_selection");
		const operation = saved ? { ...saved.operation, maxBytes: supplied.maxBytes } : supplied;
		const needle = operation.need ?? operation.query;
		if (
			saved &&
			Object.entries(supplied).some(
				([key, value]) =>
					!["action", "cursor", "maxBytes"].includes(key) &&
					value !==
						(key === "need" || key === "query" ? needle : saved.operation[key as keyof NativeRecoveryOperation]),
			)
		)
			return outcome(i, "unavailable", "unknown", [], "conflicting_selection");
		if (operation.sourceSessionId !== undefined && operation.sourceSessionId !== sourceSessionId)
			return outcome(i, "not_authorized", "unknown", [], "source_not_in_capture");
		if (
			(operation.need !== undefined && operation.query !== undefined && operation.need !== operation.query) ||
			(operation.endLine !== undefined && operation.endLine < (operation.startLine ?? 1)) ||
			(operation.endByte !== undefined && operation.endByte <= (operation.startByte ?? 0)) ||
			((operation.startByte !== undefined || operation.endByte !== undefined) &&
				(operation.startLine !== undefined || operation.endLine !== undefined))
		)
			return outcome(i, "unavailable", "unknown", [], "conflicting_selection");
		if (
			operation.ref === undefined &&
			(operation.action === "read" ||
				needle === undefined ||
				operation.revision !== undefined ||
				operation.startLine !== undefined ||
				operation.endLine !== undefined ||
				operation.startByte !== undefined ||
				operation.endByte !== undefined)
		)
			return outcome(i, "unavailable", "unknown", [], "exact_selection_requires_ref");
		if (needle !== undefined && Buffer.byteLength(needle) > 8192) throw new NativeRecoveryBudgetRefusal();
		const searching = needle !== undefined;
		const continuable = operation.action !== "read" && searching;
		const state: RecoveryCursorState = saved
			? structuredClone(saved)
			: {
					source: { ...view.source },
					operation: { ...operation, cursor: undefined, maxBytes: undefined },
					after: 0,
					field: 0,
					byte: 0,
					line: 1,
					overlap: "",
					unavailable: false,
					matched: false,
				};
		const records: NativeRecoveryRecord[] = [];
		let partialWindow = false;
		let reason: string | undefined;
		let exhausted = false;
		let windows = 0;
		const cursorId = supplied.cursor ?? randomUUID();
		const progress = (complete: boolean): NativeRecoveryResult => ({
			...outcome(
				i,
				complete && !state.unavailable && !partialWindow
					? records.length || state.matched
						? "found"
						: "complete-miss"
					: "partial",
				complete && !state.unavailable && !partialWindow ? "complete" : "partial",
				records,
				reason,
			),
			...(continuable ? { exhausted: complete, ...(!complete && cursors ? { cursor: cursorId } : {}) } : {}),
		});
		const reserve = () => {
			const candidate = progress(false);
			candidate.reason = "canonical_source_unavailable";
			stringifyBoundedJson(candidate, Math.min(maxBytes, supplied.maxBytes ?? maxBytes));
			const prospective = [...results];
			prospective[i] = candidate;
			stringifyNativeRecoveryResponse(assemble(scope, prospective), maxBytes);
		};
		reserve(); // Keep cursor/status space before examining any source material.
		const admit = (record: NativeRecoveryRecord): boolean => {
			if (selectedItems + records.length >= cap.maxItems) return false;
			records.push(record);
			try {
				reserve();
				return true;
			} catch {
				records.pop();
				return false;
			}
		};
		const resetField = () => {
			state.byte = 0;
			state.line = 1;
			state.overlap = "";
		};
		const nextEntry = (metadata: IndexedSourceEvent) => {
			state.after = metadata.sequence;
			delete state.entryId;
			state.field = 0;
			resetField();
		};
		while (!exhausted) {
			signal?.throwIfAborted();
			if (examined >= cap.maxItems) {
				reason = "scan_limit";
				break;
			}
			let metadata: IndexedSourceEvent | undefined;
			let afterPage: number | null | undefined;
			if (state.entryId || operation.ref) {
				metadata = await view.get(state.entryId ?? operation.ref!);
				if (!metadata) return outcome(i, "not_authorized", "unknown", records, "ref_not_in_captured_branch");
				if (operation.revision !== undefined && metadata.revision !== operation.revision)
					return outcome(i, "unavailable", "unknown", records, "revision_mismatch");
			} else {
				const page = await view.page(state.after, 1, { scan: true });
				if (page.coverage !== "complete" || page.indexedThrough < sourceSequence) state.unavailable = true;
				metadata = page.events[0];
				afterPage = page.nextAfter;
				if (!metadata) {
					examined++;
					if (afterPage === null) {
						exhausted = true;
						break;
					}
					if (afterPage <= state.after) throw new Error("History scan did not advance");
					state.after = afterPage;
					continue;
				}
			}
			examined++;
			state.entryId = metadata.id;
			if (
				!operation.ref &&
				!["message", "custom_message", "compaction", "branch_summary", "custom"].includes(metadata.kind)
			) {
				nextEntry(metadata);
				continue;
			}
			if (metadata.locator.length > cap.maxSourceBytes) {
				if (operation.action === "read")
					return outcome(
						i,
						operation.startByte !== undefined || operation.endByte !== undefined
							? "unavailable"
							: "budget_refused",
						"unknown",
						[],
						"field_window_unsupported",
					);
				state.unavailable = true;
				reason = "field_window_unsupported";
				nextEntry(metadata);
				if (operation.ref) exhausted = true;
				continue;
			}
			if (!cache.has(metadata.id) && metadata.locator.length > cap.maxSourceBytes - sourceBytes) {
				reason = "source_limit";
				break;
			}
			let fields: PublicField[] | undefined;
			try {
				fields = await fieldsFor(metadata, operation.field);
			} catch (error) {
				state.unavailable = true;
				reason =
					error instanceof NativeRecoveryBudgetRefusal
						? "unsupported_public_shape"
						: "canonical_source_unavailable";
				nextEntry(metadata);
				if (operation.ref) exhausted = true;
				continue;
			}
			if (!fields || (operation.field !== undefined && !fields.some((field) => field.field === operation.field))) {
				if (operation.ref) return outcome(i, "unavailable", "unknown", records, "unsupported_public_field");
				if (!fields) state.unavailable = true;
				nextEntry(metadata);
				continue;
			}
			let paused = false;
			for (; state.field < fields.length; state.field++, resetField()) {
				const field = fields[state.field];
				if (operation.field !== undefined && field.field !== operation.field) continue;
				if (field.unavailable) {
					state.unavailable = true;
					reason = "retained_output_unavailable";
					continue;
				}
				const total = field.retained?.byteLength ?? Buffer.byteLength(field.text);
				if (field.retained && !field.retained.captureComplete) {
					state.unavailable = true;
					reason = "capture_incomplete";
				}
				if (state.byte === 0 && operation.startByte !== undefined) state.byte = operation.startByte;
				if (operation.endByte !== undefined && operation.endByte > total) {
					partialWindow = true;
					reason = "requested_end_beyond_source";
				}
				const byteSelection = operation.startByte !== undefined || operation.endByte !== undefined;
				let readText = "";
				let readStart = state.byte;
				let readLine: number | undefined = byteSelection && state.byte > 0 ? undefined : state.line;
				while (state.byte < total || (total === 0 && state.byte === 0)) {
					signal?.throwIfAborted();
					if (++windows > cap.maxItems) {
						paused = true;
						reason = "scan_limit";
						break;
					}
					const allowance = field.retained
						? Math.min(PUBLIC_TEXT_WINDOW_BYTES, cap.maxSourceBytes - sourceBytes - 4)
						: PUBLIC_TEXT_WINDOW_BYTES;
					if (allowance < 4) {
						paused = true;
						reason = "source_limit";
						break;
					}
					const stop = Math.min(total, operation.endByte ?? total, state.byte + allowance);
					if (stop < state.byte) break;
					let window: { text: string; startByte: number; endByte: number };
					try {
						if (field.retained) {
							if (!view.source.sessionFile) throw new Error("Retained output owner unavailable");
							const selected = await readRetainedToolOutput(
								getSessionArtifactPathForFile(view.source.sessionFile, sourceSessionId),
								field.retained,
								state.byte,
								stop - state.byte,
							);
							sourceBytes += selected.sourceBytes;
							window = selected;
						} else window = decodedTextWindow(field.text, state.byte, stop);
					} catch {
						state.unavailable = true;
						reason = "retained_output_unavailable";
						break;
					}
					const startLine = state.line;
					const combined = state.overlap + window.text;
					const combinedStart = window.startByte - Buffer.byteLength(state.overlap);
					const combinedLine = startLine - (state.overlap.match(/\n/g)?.length ?? 0);
					let text = window.text;
					let startByte = window.startByte;
					let endByte = window.endByte;
					let recordLine: number | undefined = byteSelection && state.byte > 0 ? undefined : startLine;
					let selected = !searching;
					if (searching) {
						const lines = combined.split("\n");
						const skip = Math.max(0, (operation.startLine ?? 1) - combinedLine);
						const take = Math.min(lines.length, (operation.endLine ?? Infinity) - combinedLine + 1);
						const prefix = lines.slice(0, skip).join("\n") + (skip ? "\n" : "");
						const selectedText = lines.slice(skip, Math.max(skip, take)).join("\n");
						const localMatch = selectedText.indexOf(needle!);
						const first = localMatch < 0 ? -1 : prefix.length + localMatch;
						selected = first >= 0;
						if (selected) {
							const start = Math.max(prefix.length, first === 0 ? 0 : combined.lastIndexOf("\n", first - 1) + 1);
							const newline = combined.indexOf("\n", first + needle!.length);
							text = combined.slice(
								start,
								Math.min(prefix.length + selectedText.length, newline < 0 ? combined.length : newline),
							);
							startByte = combinedStart + Buffer.byteLength(combined.slice(0, start));
							endByte = startByte + Buffer.byteLength(text);
							recordLine =
								byteSelection && (operation.startByte ?? 0) > 0
									? undefined
									: combinedLine + (combined.slice(0, start).match(/\n/g)?.length ?? 0);
							if (
								Buffer.byteLength(text) > Math.max(Buffer.byteLength(needle!) + 256, Math.floor(maxBytes / 8))
							) {
								const matchByte = Buffer.byteLength(combined.slice(start, first));
								const excerpt = decodedTextWindow(
									text,
									Math.max(0, matchByte - 128),
									matchByte + Buffer.byteLength(needle!) + 128,
								);
								if (recordLine !== undefined)
									recordLine += decodedTextWindow(text, 0, excerpt.startByte).text.match(/\n/g)?.length ?? 0;
								text = excerpt.text;
								startByte += excerpt.startByte;
								endByte = startByte + Buffer.byteLength(text);
							}
						}
					} else if (!byteSelection) {
						const lines = text.split("\n");
						const skip = Math.max(0, (operation.startLine ?? 1) - startLine);
						const take = Math.min(lines.length, (operation.endLine ?? Infinity) - startLine + 1);
						selected = take > skip;
						if (selected) {
							const prefix = lines.slice(0, skip).join("\n") + (skip ? "\n" : "");
							startByte += Buffer.byteLength(prefix);
							text = lines.slice(skip, take).join("\n");
							endByte = startByte + Buffer.byteLength(text);
							recordLine = startLine + skip;
						}
					}
					if (selected) {
						if (!searching) {
							if (!readText) {
								readStart = startByte;
								readLine = recordLine;
							}
							readText += text;
							text = readText;
							startByte = readStart;
							recordLine = readLine;
						}
						const record: NativeRecoveryRecord = {
							ref: metadata.id,
							revision: metadata.revision,
							sourceSessionId,
							kind: metadata.kind,
							field: field.field,
							startByte,
							endByte,
							prefixOmitted: startByte > 0,
							suffixOmitted: endByte < total,
							...(recordLine === undefined
								? {}
								: { startLine: recordLine, endLine: recordLine + (text.match(/\n/g)?.length ?? 0) }),
							text,
						};
						const done =
							searching ||
							window.endByte >= total ||
							(operation.endByte !== undefined && stop >= operation.endByte) ||
							(operation.endLine !== undefined &&
								startLine + (window.text.match(/\n/g)?.length ?? 0) > operation.endLine);
						if (done) {
							if (
								operation.endLine !== undefined &&
								window.endByte >= total &&
								startLine + (window.text.match(/\n/g)?.length ?? 0) < operation.endLine
							) {
								partialWindow = true;
								reason = "requested_end_beyond_source";
							}
							if (!admit(record)) {
								paused = true;
								reason = "output_limit";
								break;
							}
							state.matched = true;
							if (searching && (startByte > 0 || endByte < total) && operation.ref) {
								partialWindow = true;
								reason = "need_window";
							}
							break;
						}
						if (Buffer.byteLength(readText) > maxBytes) throw new NativeRecoveryBudgetRefusal();
					}
					if (
						window.endByte <= state.byte ||
						window.endByte >= total ||
						(operation.endByte !== undefined && window.endByte >= operation.endByte)
					)
						break;
					state.byte = window.endByte;
					state.line += window.text.match(/\n/g)?.length ?? 0;
					let tail = searching ? combined.slice(-needle!.length - 2) : "";
					if (tail.charCodeAt(0) >= 0xdc00 && tail.charCodeAt(0) <= 0xdfff) tail = tail.slice(1);
					state.overlap = searching
						? decodedTextWindow(tail, Math.max(0, Buffer.byteLength(tail) - Buffer.byteLength(needle!) - 3)).text
						: "";
				}
				if (paused) break;
			}
			if (paused) break;
			nextEntry(metadata);
			if (operation.ref || afterPage === null) {
				exhausted = true;
				break;
			}
		}
		signal?.throwIfAborted();
		if (!exhausted && continuable && cursors) cursors.save(state, version, cursorId);
		else if (supplied.cursor && exhausted) cursors?.delete(supplied.cursor);
		if (!searching && !exhausted && records.length === 0)
			return outcome(i, "budget_refused", "unknown", [], reason ?? "operation_budget");
		return progress(exhausted);
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
