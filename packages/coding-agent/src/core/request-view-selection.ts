import type { AgentMessage } from "@ponythewhite/base-context-agent";
import {
	type Context,
	type ProviderRequestProjection,
	type ProviderRequestPublicMessage,
	type ProviderRequestRepresentation,
	type RequestTokenAssessment,
	RequestTokenBudgetError,
	type RequestTokenBudgetEvaluator,
} from "@ponythewhite/base-context-ai";
import {
	type CanonicalViewSelectionSource,
	captureCanonicalRequestMessages,
	getCanonicalViewSelectionSource,
	preparePublicContextWindow,
	prepareToolContinuationWindow,
} from "./canonical-context.js";
import { convertToLlm } from "./messages.js";
import type { ContextEpochEntryRef, SourceSnapshotRef } from "./request-events.js";
import { bindMessageReplayUnits, closeViewSelection } from "./view-units.js";

/** Actual adapter-public measurement, not a verdict about the opaque native request. */
export class PublicContextBudgetError extends RequestTokenBudgetError {
	readonly source: SourceSnapshotRef;

	constructor(
		source: SourceSnapshotRef,
		assessment: RequestTokenAssessment,
		readonly originalAssessment: RequestTokenAssessment,
	) {
		super(assessment);
		this.name = "PublicContextBudgetError";
		this.source = Object.freeze({ ...source });
	}
}

export interface RequestViewCandidate {
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
	readonly messages: readonly AgentMessage[];
	/** Provider logical positions mapped to the unchanged canonical messages/units. */
	readonly providerMessageIndices: readonly number[];
	readonly providerPendingPublicMessageGroups?: readonly (readonly number[])[];
	readonly commit: RequestViewCommit;
	readonly validate?: RequestViewValidate;
	readonly fixedPrepare?: RequestViewFixedPrepare;
}

export function captureRequestViewBoundary(
	messages: readonly AgentMessage[],
	commit: RequestViewCommit,
	validate?: RequestViewValidate,
	fixedPrepare?: RequestViewFixedPrepare,
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

/** Only the actual serializer's established replay contract authorizes historical-literal omission. */
export async function selectRequestView(
	boundary: CapturedRequestViewBoundary,
	request: ProviderRequestRepresentation,
	projection: ProviderRequestProjection,
	budget: RequestTokenBudgetEvaluator | undefined,
	allowShrink: boolean,
): Promise<string | undefined> {
	projection = canonicalRequestProjection(boundary, projection);
	const full = budget?.measure(request);
	const inputKey = requestInputKey(request, projection);
	if ((budget && full?.limitSource !== "explicit-profile") || !inputKey) return;
	if (!budget && !boundary.pendingPublicMessageGroups?.length) return;
	const payload = JSON.parse(request.body!) as Record<string, unknown>;
	const input = payload[inputKey];
	if (!Array.isArray(input) || input.length !== projection.messageIndices.length) return;

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
	const offer = async (
		selectedUnitIds: readonly string[],
		candidateRequest: ProviderRequestRepresentation,
		candidateProjection: ProviderRequestProjection,
		assessment: RequestTokenAssessment | undefined,
		publicMessages?: readonly AgentMessage[],
	) =>
		boundary.commit(
			Object.freeze({
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
		const assessment = budget?.measure(encoded.request);
		if (assessment && full) {
			if (assessment.status === "over-budget") throw new PublicContextBudgetError(boundary.source, assessment, full);
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
	// Unbudgeted admission above retains every source unit; it never selects a smaller view.
	if (!budget || !full) return;
	const offerPublicWindow = async (): Promise<string | undefined> => {
		if (
			!allowShrink ||
			replayContract !== "message-groups" ||
			!projection.publicWindow ||
			!projection.encodePublicWindow
		)
			return;
		const closed = closeViewSelection(
			units,
			units.map((unit) => unit.id),
			boundary.limits,
		);
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
		const assessment = budget.measure(encoded.request);
		if (assessment.status === "over-budget") throw new PublicContextBudgetError(boundary.source, assessment, full);
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
		const closed = closeViewSelection(
			units,
			units.map((unit) => unit.id),
			boundary.limits,
		);
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
	let latestAssistant = -1;
	for (const [index, message] of boundary.messages.entries())
		if (message.role === "assistant") latestAssistant = index;
	const retained = new Set(projection.messageIndices.slice(0, request.retainedPrefix?.inputItems ?? 0));
	const projectedOptional =
		projection.kind !== "openai-responses-text-v1" ? new Set(projection.optionalMessageIndices ?? []) : undefined;
	const optional = units.filter((unit, index) => {
		const message = boundary.messages[index];
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
		boundary.messages.flatMap((message, index) =>
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
		const closed = closeViewSelection(units, [...selected], boundary.limits);
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
	return offerPublicWindow();
}
