import type { AgentMessage } from "@ponythewhite/base-context-agent";
import {
	getCanonicalEpochContext,
	getCanonicalViewSelectionSource,
	getCanonicalViewUnits,
	prepareCanonicalEpoch,
	prepareContextModeEpoch,
} from "./canonical-context.js";
import type { CompactionResult } from "./compaction/index.js";
import {
	appendContextEpoch,
	assertContextRequestContract,
	CONTEXT_SKILL_EPOCH_RENDERER,
	type ContextReplayContract,
	contextEpochRepresentation,
	contextRequestContract,
	retainedContextRequestContract,
	snapshotContextEpoch,
	UnsupportedContextEpochConfigurationError,
} from "./context-epoch.js";
import type { InferenceCoordinator } from "./inference-coordinator.js";
import { assertResourceCurrent, type OwnedResourceCapture } from "./resource-view.js";
import { sameSelectedSkills } from "./selected-skills.js";
import type { BoundCompactionSink } from "./session-manager.js";

interface CompactionCommit {
	entryId: string;
	result: CompactionResult;
}

interface SessionContextEpochOptions {
	messages: AgentMessage[];
	epochContext: NonNullable<ReturnType<typeof getCanonicalEpochContext>>;
	resource: OwnedResourceCapture;
	maxSourceBytes: number;
	contextEpochsEnabled: boolean;
	unbudgetedPublic: boolean;
	requests: InferenceCoordinator;
	compaction: BoundCompactionSink;
	isSessionCurrent(): boolean;
	adoptMessages(messages: AgentMessage[]): void;
	onCommittedFailure(commit: CompactionCommit, cause: unknown): unknown;
}

/** Bind one captured request's epoch ACK, adoption, and final provider projection. */
export function bindSessionContextEpoch({
	messages,
	epochContext,
	resource,
	maxSourceBytes,
	contextEpochsEnabled,
	unbudgetedPublic,
	requests,
	compaction,
	isSessionCurrent,
	adoptMessages,
	onCommittedFailure,
}: SessionContextEpochOptions): void {
	let committed = epochContext.checkpoint;
	let committedEntry = epochContext.checkpointEntry;
	const fixed =
		epochContext.mode === "off" || (committed?.policyOnly === true && !contextEpochsEnabled && !unbudgetedPublic);
	let requestContract = fixed ? retainedContextRequestContract(committed) : undefined;
	const nativeTail = messages.some(
		(message) =>
			message.role === "toolResult" ||
			(message.role === "assistant" &&
				message.content.some((part) => part.type !== "text" || part.textSignature !== undefined)),
	);
	let accepted: string | undefined;
	let acceptedBody: string | undefined;
	let acceptedResponseIdentity: string | undefined;
	let acceptedReplayContract: ContextReplayContract | undefined;
	let acknowledged: CompactionCommit | undefined;
	const commitFailure = (cause: unknown) => {
		if (!acknowledged) return cause;
		return onCommittedFailure(acknowledged, cause);
	};
	requests.bindRequestViewBoundary(
		messages,
		async (candidate) => {
			if (fixed) throw new Error("Context selection is disabled while context.mode is off");
			if (
				epochContext.toolContinuations?.length &&
				(!candidate.publicMessages ||
					JSON.stringify(getCanonicalEpochContext(candidate.publicMessages)?.toolContinuations) !==
						JSON.stringify(epochContext.toolContinuations) ||
					candidate.projection.pendingPublicMessageGroups?.length)
			)
				throw new Error("Tool continuation requires its exact public candidate before epoch ACK");
			assertResourceCurrent(resource);
			let representation: string;
			try {
				representation = contextEpochRepresentation(
					candidate.request,
					candidate.assessment,
					maxSourceBytes,
					unbudgetedPublic,
					candidate.responseItemIdentity,
				);
			} catch (error) {
				if (
					error instanceof UnsupportedContextEpochConfigurationError &&
					!contextEpochsEnabled &&
					!candidate.assessment &&
					!committed &&
					!acknowledged &&
					!epochContext.taskFrameRebased &&
					!epochContext.selectedSkills?.length &&
					!epochContext.toolContinuations?.length &&
					!candidate.publicMessages
				) {
					const source = getCanonicalViewSelectionSource(messages)!;
					const selected = new Set(candidate.selectedUnitIds);
					if (
						source.recoveryContractRequested &&
						!source.requiresEpoch &&
						!source.pendingPublicMessageGroups?.length &&
						isSessionCurrent() &&
						compaction.isCurrent() &&
						JSON.stringify(candidate.source) === JSON.stringify(source.source) &&
						candidate.selectedUnitIds.length === source.units.length &&
						selected.size === source.units.length &&
						source.units.every((unit) => selected.has(unit.id))
					) {
						// Optional capture only. Keep the unchanged full-native offer; grant no epoch or omission.
						return;
					}
				}
				throw error;
			}
			const replayContract =
				"replayContract" in candidate.projection && candidate.projection.replayContract === "message-groups"
					? "message-groups"
					: "complete-context";
			const publicWindow = "publicWindow" in candidate.projection && candidate.projection.publicWindow === true;
			const selection = JSON.stringify([
				representation,
				replayContract,
				publicWindow,
				candidate.publicMessages !== undefined,
				candidate.selectedUnitIds,
			]);
			acceptedResponseIdentity = candidate.responseItemIdentity;
			if (accepted !== undefined) {
				if (accepted !== selection) throw new Error("Captured epoch request selection changed after acceptance");
				return committedEntry;
			}
			// Stable request settings do not cover recovery added after the committed source.
			const recoverySourceSequence = committed?.source.sourceSequence ?? -1;
			const hasUncoveredRecovery = getCanonicalViewUnits(messages)!.some((unit, index) => {
				const reference = epochContext.references[index];
				return unit.kind === "recovery" && (!reference || reference.ref.sequence > recoverySourceSequence);
			});
			if (
				!candidate.publicMessages &&
				!hasUncoveredRecovery &&
				committed?.representation === representation &&
				committed.replayContract === replayContract &&
				(committed.publicWindow === true) === publicWindow &&
				committed.taskFrame?.material === epochContext.taskFrame?.material &&
				committed.resourceRevision === epochContext.resourceRevision &&
				sameSelectedSkills(committed.selectedSkills, epochContext.selectedSkills) &&
				candidate.selectedUnitIds.length === messages.length
			) {
				accepted = selection;
				acceptedBody = candidate.request.body;
				return committedEntry;
			}
			const prepared = prepareCanonicalEpoch(
				candidate.publicMessages ?? messages,
				candidate.selectedUnitIds,
				representation,
				maxSourceBytes,
				replayContract,
				publicWindow,
			);
			if (JSON.stringify(prepared.checkpoint.source) !== JSON.stringify(candidate.source))
				throw new Error("Context epoch candidate does not match its captured source");
			const tokensBefore = candidate.originalAssessment?.estimatedInputTokens ?? null;
			const result: CompactionResult = {
				summary: "",
				firstKeptEntryId: prepared.checkpoint.literalTailId,
				tokensBefore,
			};
			// This is the sole commit. A resolved append is already canonical even if adoption fails.
			const entryId = await compaction[appendContextEpoch](prepared.checkpoint, tokensBefore);
			acknowledged = { entryId, result };
			try {
				assertResourceCurrent(resource);
				if (!isSessionCurrent() || !compaction.isCurrent())
					throw new Error("Context epoch source changed before adoption");
				adoptMessages(prepared.messages);
				committed = prepared.checkpoint;
				committedEntry = { sessionId: epochContext.source.sessionId, entryId };
				accepted = selection;
				acceptedBody = candidate.request.body;
				return committedEntry;
			} catch (cause) {
				throw commitFailure(cause);
			}
		},
		(request, assessment) => {
			try {
				assertResourceCurrent(resource);
				if (!sameSelectedSkills(committed?.selectedSkills, epochContext.selectedSkills))
					throw new Error("Selected skill versions require a committed epoch boundary");
				if (fixed) {
					if (
						(requestContract || committed?.pendingRequestContract || nativeTail || acceptedBody !== undefined) &&
						(acceptedBody === undefined || request.body !== acceptedBody)
					)
						throw new Error("Fixed context requires a compatible final provider projection");
					if (requestContract) {
						if (!acceptedReplayContract) throw new Error("Fixed context has no accepted replay projection");
						assertContextRequestContract(requestContract, request, acceptedReplayContract);
					}
					return;
				}
				if (epochContext.taskFrameRebased && acceptedBody === undefined)
					throw new Error("Task frame rebase requires a committed epoch boundary");
				if (!committed) return;
				if (acceptedBody === undefined || request.body !== acceptedBody)
					throw new Error("Committed context epoch requires a compatible final provider projection");
				if (
					contextEpochRepresentation(
						request,
						assessment,
						maxSourceBytes,
						unbudgetedPublic,
						acceptedResponseIdentity,
					) !== committed.representation
				)
					throw new Error("Context epoch representation changed without a committed boundary");
				if (committed.resourceRevision !== epochContext.resourceRevision)
					throw new Error("Context epoch resource revision requires a committed boundary");
				if (committed.taskFrame?.material !== epochContext.taskFrame?.material)
					throw new Error("Context epoch task revision requires a committed boundary");
			} catch (cause) {
				throw commitFailure(cause);
			}
		},
		fixed
			? async (request, projection) => {
					try {
						assertResourceCurrent(resource);
						if (!requestContract && nativeTail)
							throw new Error("Retained native context has no accepted request contract");
						const replayContract = projection.replayContract ?? "complete-context";
						const skillChange = !sameSelectedSkills(committed?.selectedSkills, epochContext.selectedSkills);
						if (
							skillChange &&
							committed?.selectedSkills?.some(
								(skill) =>
									!sameSelectedSkills(
										[skill],
										epochContext.selectedSkills?.filter((item) => item.name === skill.name),
									),
							)
						)
							throw new Error("Fixed context cannot replace a selected skill version");
						if ((!requestContract && committed?.pendingRequestContract) || skillChange) {
							// Existing policy-only ACK: bind first selections, without changing fixed views or mode.
							const base =
								committed ?? prepareContextModeEpoch(messages, epochContext.mode, maxSourceBytes).checkpoint;
							if (base.version !== 5) throw new Error("Fixed skill selection requires its policy checkpoint");
							const nextContract = requestContract ?? contextRequestContract(request, replayContract);
							const checkpoint = snapshotContextEpoch(
								{
									...base,
									renderer: epochContext.selectedSkills?.length ? CONTEXT_SKILL_EPOCH_RENDERER : base.renderer,
									...(epochContext.selectedSkills?.length
										? { selectedSkills: epochContext.selectedSkills }
										: {}),
									source: epochContext.source,
									requestContract: nextContract,
									pendingRequestContract: undefined,
								},
								maxSourceBytes,
							);
							const entryId = await compaction[appendContextEpoch](checkpoint, null);
							acknowledged = {
								entryId,
								result: {
									summary: "",
									firstKeptEntryId: checkpoint.literalTailId,
									tokensBefore: null,
								},
							};
							committed = checkpoint;
							committedEntry = { sessionId: epochContext.source.sessionId, entryId };
							requestContract = nextContract;
							assertResourceCurrent(resource);
							if (!isSessionCurrent() || !compaction.isCurrent())
								throw new Error("Context contract source changed before acceptance");
						}
						if (!sameSelectedSkills(committed?.selectedSkills, epochContext.selectedSkills))
							throw new Error("Fixed context selected skill versions changed after acceptance");
						if (requestContract) assertContextRequestContract(requestContract, request, replayContract);
						if (acceptedBody !== undefined && request.body !== acceptedBody)
							throw new Error("Fixed context changed after acceptance");
						acceptedBody = request.body;
						acceptedReplayContract = replayContract;
						return committedEntry;
					} catch (cause) {
						throw commitFailure(cause);
					}
				}
			: undefined,
		compaction.isCurrent,
	);
}
