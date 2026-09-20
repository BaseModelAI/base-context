import type { AgentMessage } from "@ponythewhite/base-context-agent";
import {
	type Context,
	type ProviderRequestProjection,
	type ProviderRequestPublicMessage,
	type ProviderRequestRepresentation,
	type RequestTokenAssessment,
	RequestTokenBudgetError,
	type RequestTokenBudgetEvaluator,
	withRequestBody,
} from "@ponythewhite/base-context-ai";
import {
	type CanonicalViewSelectionSource,
	captureCanonicalRequestMessages,
	getCanonicalEpochContext,
	getCanonicalViewSelectionSource,
	preparePublicContextWindow,
	prepareToolContinuationWindow,
	type RecoveryCompactionAuthorization,
} from "./canonical-context.js";
import { convertToLlm } from "./messages.js";
import type { ContextEpochEntryRef, SourceSnapshotRef } from "./request-events.js";
import { bindMessageReplayUnits, closeViewSelection, prepareViewSelection } from "./view-units.js";

/** Actual adapter-public measurement, not a verdict about the opaque native request. */
export class PublicContextBudgetError extends RequestTokenBudgetError {
	readonly source: SourceSnapshotRef;
	#compactionKey?: string;
	#summaryCapacity?: (retained: ReadonlySet<string>, wrapper: string) => number | undefined;

	remainingSummaryTokens(retained: ReadonlySet<string>, wrapper: string): number | undefined {
		return this.#summaryCapacity?.(retained, wrapper);
	}

	getCompactionKey(): string | undefined {
		return this.#compactionKey;
	}

	constructor(
		source: SourceSnapshotRef,
		assessment: RequestTokenAssessment,
		readonly originalAssessment: RequestTokenAssessment,
		readonly mandatoryAssessment?: RequestTokenAssessment,
		readonly taskFrameRebaseAvailable = false,
		compactionKey?: string,
		summaryCapacity?: (retained: ReadonlySet<string>, wrapper: string) => number | undefined,
		readonly isSourceCurrent?: () => boolean,
	) {
		super(assessment);
		this.name = "PublicContextBudgetError";
		if (mandatoryAssessment?.status === "over-budget")
			this.message =
				"Context capacity exceeded: instructions, tools, mandatory evidence and output allowance cannot fit. Summarizing unrelated history cannot resolve this request.";
		this.source = Object.freeze({ ...source });
		this.#compactionKey = compactionKey;
		this.#summaryCapacity = summaryCapacity;
	}
}

// Only publicBudgetFailure can grant this authority to the exact error it creates.
// Constructing a public error or copying its descriptive fields grants nothing.
const recoveryCompactionAuthorizations = new WeakMap<PublicContextBudgetError, RecoveryCompactionAuthorization>();

export function getRecoveryCompactionAuthorization(
	error: PublicContextBudgetError | undefined,
): RecoveryCompactionAuthorization | undefined {
	return error ? recoveryCompactionAuthorizations.get(error) : undefined;
}

export interface RequestViewCandidate {
	/** Session-local Responses ID namespace; a new owner requires a fresh representation. */
	readonly responseItemIdentity?: string;
	readonly source: SourceSnapshotRef;
	readonly selectedUnitIds: readonly string[];
	readonly request: ProviderRequestRepresentation;
	readonly projection: ProviderRequestProjection;
	// Absent only for mandatory full-view admission without a configured token budget.
	readonly assessment: RequestTokenAssessment | undefined;
	readonly originalAssessment: RequestTokenAssessment | undefined;
	/** Exact public messages represented by the accepted candidate, with captured source recipes. */
	readonly publicMessages?: readonly AgentMessage[];
}

/** Root resolves only after its canonical epoch checkpoint ACK. This module owns no epoch state. */
export type RequestViewCommit = (
	candidate: RequestViewCandidate,
) => Promise<ContextEpochEntryRef | undefined> | Promise<void>;
export type RequestViewValidate = (
	request: ProviderRequestRepresentation,
	assessment: RequestTokenAssessment | undefined,
) => void;

export type RequestViewFixedPrepare = (
	request: ProviderRequestRepresentation,
	projection: ProviderRequestProjection,
	assessment: RequestTokenAssessment | undefined,
) => ContextEpochEntryRef | void | Promise<ContextEpochEntryRef | undefined> | Promise<void>;

export interface CapturedRequestViewBoundary extends CanonicalViewSelectionSource {
	readonly responseItemIdentity?: string;
	readonly messages: readonly AgentMessage[];
	/** Provider logical positions mapped to the unchanged canonical messages/units. */
	readonly providerMessageIndices: readonly number[];
	readonly providerPendingPublicMessageGroups?: readonly (readonly number[])[];
	readonly commit: RequestViewCommit;
	readonly validate?: RequestViewValidate;
	readonly fixedPrepare?: RequestViewFixedPrepare;
	readonly isSourceCurrent?: () => boolean;
}

export function captureRequestViewBoundary(
	messages: readonly AgentMessage[],
	commit: RequestViewCommit,
	validate?: RequestViewValidate,
	fixedPrepare?: RequestViewFixedPrepare,
	isSourceCurrent?: () => boolean,
): CapturedRequestViewBoundary {
	const source = getCanonicalViewSelectionSource(messages);
	if (!source) throw new Error("Request view boundary requires compiled canonical messages");
	const providerMessageIndices = messages.flatMap((message, index) => convertToLlm([message]).map(() => index));
	return {
		...source,
		messages: captureCanonicalRequestMessages(messages),
		providerMessageIndices,
		...(source.pendingPublicMessageGroups
			? {
					providerPendingPublicMessageGroups: source.pendingPublicMessageGroups.map((group) =>
						group.map((index) => providerMessageIndex(providerMessageIndices, index)),
					),
				}
			: {}),
		commit,
		validate,
		fixedPrepare,
		isSourceCurrent,
	};
}

function providerMessageIndex(indices: readonly number[], canonicalIndex: number): number {
	const index = indices.indexOf(canonicalIndex);
	if (index < 0) throw new Error("Provider projection cannot address a filtered canonical message");
	return index;
}

/** Keep canonical UI barriers while translating the native serializer's provider-only positions. */
function canonicalRequestProjection(
	boundary: CapturedRequestViewBoundary,
	projection: ProviderRequestProjection,
): ProviderRequestProjection {
	const indices = boundary.providerMessageIndices;
	if (indices.length === boundary.messages.length) return projection;
	const canonicalIndex = (index: number): number => {
		const canonical = indices[index];
		if (canonical === undefined) throw new Error("Provider projection message index is outside its captured view");
		return canonical;
	};
	return {
		...projection,
		messageIndices: projection.messageIndices.map((index) => (index === null ? null : canonicalIndex(index))),
		...(projection.optionalMessageIndices
			? { optionalMessageIndices: projection.optionalMessageIndices.map(canonicalIndex) }
			: {}),
		...(projection.generatedMessageIndices
			? { generatedMessageIndices: projection.generatedMessageIndices.map(canonicalIndex) }
			: {}),
		...(projection.publicMessageGroups
			? { publicMessageGroups: projection.publicMessageGroups.map((group) => group.map(canonicalIndex)) }
			: {}),
		...(projection.pendingPublicMessageGroups
			? {
					pendingPublicMessageGroups: projection.pendingPublicMessageGroups.map((group) =>
						group.map(canonicalIndex),
					),
				}
			: {}),
		...(projection.encodePublicWindow
			? {
					encodePublicWindow: (replacements: readonly ProviderRequestPublicMessage[]) => {
						const encoded = projection.encodePublicWindow!(
							replacements.map((replacement) => ({
								...replacement,
								messageIndex: providerMessageIndex(indices, replacement.messageIndex),
							})),
						);
						return (
							encoded && { ...encoded, projection: canonicalRequestProjection(boundary, encoded.projection) }
						);
					},
				}
			: {}),
	};
}

export function matchesRequestView(
	boundary: CapturedRequestViewBoundary,
	source: SourceSnapshotRef,
	context: Context,
): boolean {
	const expected = boundary.source;
	if (
		expected.sessionId !== source.sessionId ||
		expected.sessionFile !== source.sessionFile ||
		expected.leafId !== source.leafId ||
		expected.sourceSequence !== source.sourceSequence
	)
		return false;
	const rendered = convertToLlm([...boundary.messages]);
	return (
		boundary.messages.length === boundary.units.length &&
		rendered.length === boundary.providerMessageIndices.length &&
		JSON.stringify(rendered) === JSON.stringify(context.messages)
	);
}

/** Projection kinds describe their actual provider body, never an OpenAI-format route alias. */
function requestInputKey(
	request: ProviderRequestRepresentation,
	projection: ProviderRequestProjection,
): "input" | "messages" | undefined {
	if (
		(request.api === "openai-responses" || request.api === "openai-codex-responses") &&
		(projection.kind === "openai-responses-text-v1" || projection.kind === "openai-responses-replay-v1")
	)
		return "input";
	if (
		request.api === "openai-completions" &&
		request.provider === "deepseek" &&
		request.url === "https://api.deepseek.com/chat/completions" &&
		projection.kind === "deepseek-completions-text-tools-v1" &&
		request.body !== undefined &&
		JSON.parse(request.body).model === "deepseek-flash"
	)
		return "messages";
	return undefined;
}

/** A lower bound for compaction: fixed policy, current tail and required recorded evidence. */
function publicBudgetFailure(
	boundary: CapturedRequestViewBoundary,
	messages: readonly AgentMessage[],
	request: ProviderRequestRepresentation,
	projection: ProviderRequestProjection,
	budget: RequestTokenBudgetEvaluator,
	assessment: RequestTokenAssessment,
	original: RequestTokenAssessment,
): PublicContextBudgetError {
	const context = getCanonicalEpochContext(messages)!;
	const source = getCanonicalViewSelectionSource(messages)!;
	const toolEntries = new Set(
		context.toolContinuations?.flatMap((group) => [
			group.assistantEntryId,
			...group.calls.flatMap((call) => (call.result ? [call.result.id] : [])),
		]),
	);
	let tailSequence = -1;
	for (const reference of context.references)
		if (reference && reference.ref.kind !== "compaction")
			tailSequence = Math.max(tailSequence, reference.ref.sequence);
	const required = new Set(
		source.units.flatMap((unit, index) => {
			const reference = context.references[index];
			return ["task-frame", "resource-view", "recovery"].includes(unit.kind) ||
				unit.id === "native-selected-skill-versions" ||
				(reference && (reference.ref.sequence === tailSequence || toolEntries.has(reference.ref.entryId)))
				? [index]
				: [];
		}),
	);
	const inputKey = requestInputKey(request, projection)!;
	const body = JSON.parse(request.body!) as Record<string, unknown>;
	const input = body[inputKey];
	if (!Array.isArray(input) || input.length !== projection.messageIndices.length)
		return new PublicContextBudgetError(
			boundary.source,
			assessment,
			original,
			undefined,
			false,
			undefined,
			undefined,
			boundary.isSourceCurrent,
		);
	const graph = prepareViewSelection(source.units, boundary.limits);
	const retainedInput = (retained: ReadonlySet<string>) => {
		const roots = source.units
			.filter((_, index) => required.has(index) || retained.has(context.references[index]?.ref.entryId ?? ""))
			.map((unit) => unit.id);
		const selected = new Set(graph.close(roots).map((unit) => unit.id));
		return input.filter((_, index) => {
			const messageIndex = projection.messageIndices[index];
			return messageIndex === null || selected.has(source.units[messageIndex].id);
		});
	};
	const minimum = withRequestBody(request, JSON.stringify({ ...body, [inputKey]: retainedInput(new Set()) }));
	const error = new PublicContextBudgetError(
		boundary.source,
		assessment,
		original,
		budget.measure(minimum),
		(context.taskFrame?.messages.length ?? 0) > 1,
		JSON.stringify([
			boundary.source.sessionId,
			boundary.source.sessionFile,
			source.units.map((unit) => [unit.id, unit.sourceRevision]),
			assessment.api,
			assessment.provider,
			assessment.model,
			assessment.route,
			assessment.profile,
			assessment.availableInputTokens,
			assessment.outputReserveTokens,
		]),
		(retained, wrapper) => {
			// Meter only; this synthetic empty summary is never admitted or sent.
			const summary =
				inputKey === "messages"
					? { role: "user", content: wrapper }
					: { role: "user", content: [{ type: "input_text", text: wrapper }] };
			const kept = retainedInput(retained);
			const position = kept.findIndex((item) => item?.role !== "system" && item?.role !== "developer");
			kept.splice(position < 0 ? kept.length : position, 0, summary);
			const measured = budget.measure(withRequestBody(request, JSON.stringify({ ...body, [inputKey]: kept })));
			return measured.status === "unknown" ||
				measured.availableInputTokens === null ||
				measured.estimatedInputTokens === null
				? undefined
				: Math.floor(measured.availableInputTokens - measured.estimatedInputTokens);
		},
		boundary.isSourceCurrent,
	);
	if (projection.replayContract === "message-groups") {
		const originalContext = getCanonicalEpochContext(boundary.messages)!;
		const recoveries = boundary.units.flatMap((unit, index) =>
			unit.kind === "recovery" && originalContext.references[index] ? [originalContext.references[index]!] : [],
		);
		if (recoveries.length) {
			recoveryCompactionAuthorizations.set(error, {
				source: originalContext.source,
				recoveries,
				resourceRevision: originalContext.resourceRevision,
				// Do not extend a partial public conversion to native groups the encoder did not replace.
				publicWindow:
					messages !== boundary.messages &&
					projection.publicWindow === true &&
					boundary.units.every(
						(unit, index) =>
							!["recovery", "replay-group"].includes(unit.kind) ||
							context.references[index]?.rendering !== undefined,
					),
				isSourceCurrent: boundary.isSourceCurrent,
			});
		}
	}
	return error;
}

/** Check the actual final mapping without selecting, converting, or committing another view. */
export async function prepareFixedRequestView(
	boundary: CapturedRequestViewBoundary,
	request: ProviderRequestRepresentation,
	projection: ProviderRequestProjection,
	assessment: RequestTokenAssessment | undefined,
) {
	projection = canonicalRequestProjection(boundary, projection);
	const inputKey = requestInputKey(request, projection);
	const payload = JSON.parse(request.body!) as Record<string, unknown> | null;
	const input = inputKey && payload ? payload[inputKey] : undefined;
	if (!Array.isArray(input) || input.length !== projection.messageIndices.length)
		throw new Error("Fixed context requires its final provider projection");
	if (
		projection.kind === "openai-responses-text-v1" &&
		boundary.messages.some(
			(message) =>
				message.role === "toolResult" ||
				(message.role === "assistant" && (message.content.length !== 1 || message.content[0].type !== "text")),
		)
	)
		throw new Error("Fixed context requires its native replay adapter");
	const units = bindMessageReplayUnits(
		boundary.messages,
		boundary.units,
		boundary.limits,
		projection.replayContract ?? "complete-context",
	);
	closeViewSelection(
		units,
		units.map((unit) => unit.id),
		boundary.limits,
	);
	return await boundary.fixedPrepare!(request, projection, assessment);
}

/** Reuse the same legal omission policy for native and already-converted public requests. */
async function offerOptionalSubset(
	messages: readonly AgentMessage[],
	units: CanonicalViewSelectionSource["units"],
	selection: ReturnType<typeof prepareViewSelection>,
	request: ProviderRequestRepresentation,
	projection: ProviderRequestProjection,
	budget: RequestTokenBudgetEvaluator,
	offer: (
		ids: readonly string[],
		request: ProviderRequestRepresentation,
		projection: ProviderRequestProjection,
		assessment: RequestTokenAssessment,
	) => Promise<unknown>,
): Promise<string | undefined> {
	const inputKey = requestInputKey(request, projection);
	if (!inputKey) return;
	const payload = JSON.parse(request.body!) as Record<string, unknown>;
	const input = payload[inputKey];
	if (!Array.isArray(input) || input.length !== projection.messageIndices.length) return;
	let latestAssistant = -1;
	for (const [index, message] of messages.entries()) if (message.role === "assistant") latestAssistant = index;
	const retained = new Set(projection.messageIndices.slice(0, request.retainedPrefix?.inputItems ?? 0));
	const projectedOptional =
		projection.kind !== "openai-responses-text-v1" ? new Set(projection.optionalMessageIndices ?? []) : undefined;
	const optional = units.filter((unit, index) => {
		const message = messages[index];
		return (
			index !== latestAssistant &&
			!retained.has(index) &&
			(!projectedOptional || projectedOptional.has(index)) &&
			unit.kind === "literal" &&
			unit.authority === "assistant-public" &&
			message.role === "assistant" &&
			message.stopReason === "stop" &&
			message.content.length === 1 &&
			message.content[0].type === "text"
		);
	});
	const generatedPositions = new Map<string, number>();
	const generated =
		projection.generatedMessageIndices ??
		messages.flatMap((message, index) =>
			message.role === "assistant" &&
			message.content.some((block) => block.type === "text" && block.textSignature === undefined)
				? [index]
				: [],
		);
	for (const index of generated) generatedPositions.set(units[index].id, index);
	// All user inputs, the latest assistant, fixed/TaskFrame/recovery units and errors stay selected.
	const selected = new Set(units.map((unit) => unit.id));
	for (const unit of optional) {
		selected.delete(unit.id);
		const closed = selection.close([...selected]);
		// Normal Responses rendering uses msg_<message index> for unsigned assistants.
		// Reject any subset that would change a retained generated item ID on reconstruction.
		if (closed.some((item, index) => generatedPositions.has(item.id) && generatedPositions.get(item.id) !== index))
			continue;
		const closedIds = new Set(closed.map((item) => item.id));
		const keepItem = (index: number) => {
			const messageIndex = projection.messageIndices[index];
			return messageIndex === null || closedIds.has(units[messageIndex].id);
		};
		const body = JSON.stringify({ ...payload, [inputKey]: input.filter((_, index) => keepItem(index)) });
		const candidateRequest = { ...request, body };
		const assessment = budget.measure(candidateRequest);
		if (assessment.status !== "within-estimate") continue;
		await offer(
			closed.map((item) => item.id),
			candidateRequest,
			{
				...projection,
				messageIndices: projection.messageIndices.filter((_, index) => keepItem(index)),
				...(projection.optionalMessageIndices
					? {
							optionalMessageIndices: projection.optionalMessageIndices.filter((index) =>
								closedIds.has(units[index].id),
							),
						}
					: {}),
				...(projection.generatedMessageIndices
					? {
							generatedMessageIndices: projection.generatedMessageIndices.filter((index) =>
								closedIds.has(units[index].id),
							),
						}
					: {}),
			},
			assessment,
		);
		return body;
	}
	return;
}

/** Only the actual serializer's established replay contract authorizes historical-literal omission. */
export async function selectRequestView(
	boundary: CapturedRequestViewBoundary,
	request: ProviderRequestRepresentation,
	projection: ProviderRequestProjection,
	budget: RequestTokenBudgetEvaluator | undefined,
	allowShrink: boolean,
	finalizeMeasurement?: (
		request: ProviderRequestRepresentation,
		assessment: RequestTokenAssessment | undefined,
	) => Promise<RequestTokenAssessment | undefined>,
): Promise<string | undefined> {
	projection = canonicalRequestProjection(boundary, projection);
	let full = budget?.measure(request);
	const inputKey = requestInputKey(request, projection);
	if ((budget && full?.limitSource !== "explicit-profile") || !inputKey) return;
	if (
		!budget &&
		!boundary.requiresEpoch &&
		!boundary.recoveryContractRequested &&
		!boundary.pendingPublicMessageGroups?.length
	)
		return;
	const payload = JSON.parse(request.body!) as Record<string, unknown>;
	const input = payload[inputKey];
	if (!Array.isArray(input) || input.length !== projection.messageIndices.length) return;
	// Resolve a near-limit estimate before discarding a stable native prefix. Original
	// protected tool groups must first pass their public conversion below.
	if (
		full?.status === "over-budget" &&
		!boundary.pendingPublicMessageGroups?.length &&
		!projection.pendingPublicMessageGroups?.length
	)
		full = (await finalizeMeasurement?.(request, full)) ?? full;

	// Absence is complete-context; a profile or tool-shaped message is never group authority.
	const replayContract = projection.replayContract ?? "complete-context";
	if (
		projection.kind === "openai-responses-text-v1" &&
		boundary.messages.some(
			(message) =>
				message.role === "toolResult" ||
				(message.role === "assistant" && (message.content.length !== 1 || message.content[0].type !== "text")),
		)
	)
		return;
	const units = bindMessageReplayUnits(
		boundary.messages,
		boundary.units,
		boundary.limits,
		replayContract,
		boundary.pendingPublicMessageGroups,
	);
	const selection = prepareViewSelection(units, boundary.limits);
	const offer = async (
		selectedUnitIds: readonly string[],
		candidateRequest: ProviderRequestRepresentation,
		candidateProjection: ProviderRequestProjection,
		assessment: RequestTokenAssessment | undefined,
		publicMessages?: readonly AgentMessage[],
	) => {
		assessment = (await finalizeMeasurement?.(candidateRequest, assessment)) ?? assessment;
		if (budget && assessment) {
			if (assessment.status === "over-budget" && full)
				throw publicBudgetFailure(
					boundary,
					publicMessages ?? boundary.messages,
					candidateRequest,
					candidateProjection,
					budget,
					assessment,
					full,
				);
			budget.assert(assessment);
		}
		return boundary.commit(
			Object.freeze({
				...(boundary.responseItemIdentity ? { responseItemIdentity: boundary.responseItemIdentity } : {}),
				source: Object.freeze({ ...boundary.source }),
				selectedUnitIds: Object.freeze([...selectedUnitIds]),
				request: Object.freeze({ ...candidateRequest }),
				projection: Object.freeze({
					...candidateProjection,
					replayContract,
					messageIndices: Object.freeze([...candidateProjection.messageIndices]),
					...(candidateProjection.optionalMessageIndices
						? {
								optionalMessageIndices: Object.freeze([...candidateProjection.optionalMessageIndices]),
							}
						: {}),
					...(candidateProjection.generatedMessageIndices
						? {
								generatedMessageIndices: Object.freeze([...candidateProjection.generatedMessageIndices]),
							}
						: {}),
				}),
				assessment,
				originalAssessment: full,
				...(publicMessages ? { publicMessages } : {}),
			}),
		);
	};
	const offerPublicSubset = async (
		messages: readonly AgentMessage[],
		request: ProviderRequestRepresentation,
		projection: ProviderRequestProjection,
	): Promise<string | undefined> => {
		if (!allowShrink || !budget || replayContract !== "message-groups") return;
		const source = getCanonicalViewSelectionSource(messages)!;
		const units = bindMessageReplayUnits(messages, source.units, boundary.limits, replayContract);
		return offerOptionalSubset(
			messages,
			units,
			prepareViewSelection(units, boundary.limits),
			request,
			projection,
			budget,
			(ids, candidate, mapping, assessment) => offer(ids, candidate, mapping, assessment, messages),
		);
	};
	if (boundary.pendingPublicMessageGroups?.length) {
		if (
			replayContract !== "message-groups" ||
			!projection.publicWindow ||
			!projection.encodePublicWindow ||
			JSON.stringify(projection.pendingPublicMessageGroups) !== JSON.stringify(boundary.pendingPublicMessageGroups)
		)
			throw new Error("Original tool group requires current native adapter public conversion");
		const publicView = prepareToolContinuationWindow(boundary.messages);
		const encoded = projection.encodePublicWindow(publicView.replacements);
		if (!encoded || encoded.projection.pendingPublicMessageGroups?.length)
			throw new Error("Native adapter did not convert the whole required tool group");
		const publicSource = getCanonicalViewSelectionSource(publicView.messages)!;
		const publicUnits = bindMessageReplayUnits(
			publicView.messages,
			publicSource.units,
			boundary.limits,
			replayContract,
		);
		const closed = closeViewSelection(
			publicUnits,
			publicUnits.map((unit) => unit.id),
			boundary.limits,
		);
		let assessment = budget?.measure(encoded.request);
		if (assessment?.status === "over-budget")
			assessment = (await finalizeMeasurement?.(encoded.request, assessment)) ?? assessment;
		if (assessment && full) {
			if (assessment.status === "over-budget") {
				const subset = await offerPublicSubset(publicView.messages, encoded.request, encoded.projection);
				if (subset !== undefined) return subset;
				throw publicBudgetFailure(
					boundary,
					publicView.messages,
					encoded.request,
					encoded.projection,
					budget!,
					assessment,
					full,
				);
			}
			if (assessment.status !== "within-estimate")
				throw new Error("Tool continuation public request exceeds its token budget");
		}
		await offer(
			closed.map((unit) => unit.id),
			encoded.request,
			encoded.projection,
			assessment,
			publicView.messages,
		);
		return encoded.request.body;
	}
	if (projection.pendingPublicMessageGroups?.length)
		throw new Error("Adapter pending group has no original owned source plan");
	// Without a configured budget, admit only the exact full native view. Never shrink it.
	if (!budget) {
		const closed = selection.close(units.map((unit) => unit.id));
		await offer(
			closed.map((unit) => unit.id),
			request,
			projection,
			undefined,
		);
		return request.body;
	}
	if (!full) return;
	const offerPublicWindow = async (): Promise<string | undefined> => {
		if (
			!allowShrink ||
			replayContract !== "message-groups" ||
			!projection.publicWindow ||
			!projection.encodePublicWindow
		)
			return;
		const closed = selection.close(units.map((unit) => unit.id));
		let firstMessageIndex = 0;
		if (
			full.status === "unknown" &&
			full.unknown.length === 1 &&
			full.unknown[0] === "media, opaque or unsupported replay token coverage unknown"
		) {
			// Credited items are not part of the unknown input. Keep original projection indices.
			const firstUnmeteredItem = request.retainedPrefix?.inputItems ?? 0;
			const reasoningItemIndex = input.findIndex(
				(item, index) => index >= firstUnmeteredItem && item?.type === "reasoning",
			);
			const messageIndex = projection.messageIndices[reasoningItemIndex];
			const group =
				messageIndex == null
					? undefined
					: projection.publicMessageGroups?.find((members) => members.includes(messageIndex));
			// The adapter still accepts only complete groups; earlier meterable groups stay native.
			firstMessageIndex = group ? Math.min(...group) : 0;
		}
		const publicView = preparePublicContextWindow(boundary.messages, firstMessageIndex);
		if (!publicView) {
			// Keep the original measured refusal when no public conversion can be offered.
			// This is not a new recovery signal or permission to reprepare again.
			if (full.status === "over-budget") throw new RequestTokenBudgetError(full);
			return;
		}
		const encoded = projection.encodePublicWindow(publicView.replacements);
		if (!encoded) return;
		let assessment = budget.measure(encoded.request);
		if (assessment.status === "over-budget")
			assessment = (await finalizeMeasurement?.(encoded.request, assessment)) ?? assessment;
		if (assessment.status === "over-budget") {
			const subset = await offerPublicSubset(publicView.messages, encoded.request, encoded.projection);
			if (subset !== undefined) return subset;
			throw publicBudgetFailure(
				boundary,
				publicView.messages,
				encoded.request,
				encoded.projection,
				budget,
				assessment,
				full,
			);
		}
		if (assessment.status !== "within-estimate") return;
		await offer(
			closed.map((unit) => unit.id),
			encoded.request,
			encoded.projection,
			assessment,
			publicView.messages,
		);
		return encoded.request.body;
	};
	if (full.status === "within-estimate") {
		const closed = selection.close(units.map((unit) => unit.id));
		await offer(
			closed.map((unit) => unit.id),
			request,
			projection,
			full,
		);
		return request.body;
	}
	if (!allowShrink || replayContract !== "message-groups") return;
	if (full.status !== "over-budget") return offerPublicWindow();
	const subset = await offerOptionalSubset(boundary.messages, units, selection, request, projection, budget, offer);
	if (subset !== undefined) return subset;
	return offerPublicWindow();
}
