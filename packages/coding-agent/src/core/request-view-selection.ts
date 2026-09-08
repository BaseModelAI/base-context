import type { AgentMessage } from "@ponythewhite/base-context-agent";
import type {
	Context,
	ProviderRequestProjection,
	ProviderRequestRepresentation,
	RequestTokenAssessment,
	RequestTokenBudgetEvaluator,
} from "@ponythewhite/base-context-ai";
import { type CanonicalViewSelectionSource, getCanonicalViewSelectionSource } from "./canonical-context.js";
import { convertToLlm } from "./messages.js";
import type { SourceSnapshotRef } from "./request-events.js";
import { bindMessageReplayUnits, closeViewSelection } from "./view-units.js";

export interface RequestViewCandidate {
	readonly source: SourceSnapshotRef;
	readonly selectedUnitIds: readonly string[];
	readonly request: ProviderRequestRepresentation;
	readonly projection: ProviderRequestProjection;
	readonly assessment: RequestTokenAssessment;
	readonly originalAssessment: RequestTokenAssessment;
}

/** Root resolves only after its canonical epoch checkpoint ACK. This module owns no epoch state. */
export type RequestViewCommit = (candidate: RequestViewCandidate) => Promise<void>;
export type RequestViewValidate = (
	request: ProviderRequestRepresentation,
	assessment: RequestTokenAssessment | undefined,
) => void;

export interface CapturedRequestViewBoundary extends CanonicalViewSelectionSource {
	readonly messages: readonly AgentMessage[];
	readonly commit: RequestViewCommit;
	readonly validate?: RequestViewValidate;
}

export function captureRequestViewBoundary(
	messages: readonly AgentMessage[],
	commit: RequestViewCommit,
	validate?: RequestViewValidate,
): CapturedRequestViewBoundary {
	const source = getCanonicalViewSelectionSource(messages);
	if (!source) throw new Error("Request view boundary requires compiled canonical messages");
	return { ...source, messages: structuredClone(messages), commit, validate };
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
	return rendered.length === boundary.units.length && JSON.stringify(rendered) === JSON.stringify(context.messages);
}

/** Only the serializer's narrow text projection authorizes this historical-literal choice. */
export async function selectRequestView(
	boundary: CapturedRequestViewBoundary,
	request: ProviderRequestRepresentation,
	projection: ProviderRequestProjection,
	budget: RequestTokenBudgetEvaluator,
	allowShrink: boolean,
): Promise<string | undefined> {
	const full = budget.measure(request);
	if (
		full.limitSource !== "explicit-profile" ||
		request.api !== "openai-responses" ||
		projection.kind !== "openai-responses-text-v1"
	)
		return;
	const payload = JSON.parse(request.body!) as Record<string, unknown>;
	const input = payload.input;
	if (!Array.isArray(input) || input.length !== projection.messageIndices.length) return;

	// Generic/opaque projections never reach this policy. Intrinsic TaskFrame dependencies remain intact.
	const units = bindMessageReplayUnits(boundary.messages, boundary.units, boundary.limits, "message-groups");
	const offer = async (
		selectedUnitIds: readonly string[],
		candidateRequest: ProviderRequestRepresentation,
		candidateProjection: ProviderRequestProjection,
		assessment: RequestTokenAssessment,
	) =>
		boundary.commit(
			Object.freeze({
				source: Object.freeze({ ...boundary.source }),
				selectedUnitIds: Object.freeze([...selectedUnitIds]),
				request: Object.freeze({ ...candidateRequest }),
				projection: Object.freeze({
					kind: candidateProjection.kind,
					messageIndices: Object.freeze([...candidateProjection.messageIndices]),
				}),
				assessment,
				originalAssessment: full,
			}),
		);
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
	if (!allowShrink || full.status !== "over-budget") return;
	let latestAssistant = -1;
	for (const [index, message] of boundary.messages.entries())
		if (message.role === "assistant") latestAssistant = index;
	const optional = units.filter((unit, index) => {
		const message = boundary.messages[index];
		return (
			index !== latestAssistant &&
			unit.kind === "literal" &&
			unit.authority === "assistant-public" &&
			message.role === "assistant" &&
			message.stopReason === "stop" &&
			message.content.length === 1 &&
			message.content[0].type === "text"
		);
	});
	const generatedPositions = new Map<string, number>();
	for (const [index, message] of boundary.messages.entries()) {
		if (
			message.role === "assistant" &&
			message.content[0].type === "text" &&
			message.content[0].textSignature === undefined
		)
			generatedPositions.set(units[index].id, index);
	}
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
		const body = JSON.stringify({ ...payload, input: input.filter((_, index) => keepItem(index)) });
		const candidateRequest = { ...request, body };
		const assessment = budget.measure(candidateRequest);
		if (assessment.status !== "within-estimate") continue;
		await offer(
			closed.map((item) => item.id),
			candidateRequest,
			{ kind: projection.kind, messageIndices: projection.messageIndices.filter((_, index) => keepItem(index)) },
			assessment,
		);
		return body;
	}
	return;
}
