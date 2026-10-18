import { setTimeout as delay } from "node:timers/promises";
import type { AgentMessage } from "@ponythewhite/base-context-agent";
import type { AssistantMessage } from "@ponythewhite/base-context-ai";
import type { AgentSession } from "../core/agent-session.js";
import {
	type AgentAutonomousStatus,
	autonomousLimitReason,
	buildAutonomousGateFailureContinuation,
} from "../core/autonomous.js";
import { observeCompletion, withCompletionDeadline } from "../core/completion.js";
import {
	COMPACTION_OUTCOME_CUSTOM_TYPE,
	type CompactionOutcomeMessage,
	isCompactionOutcomeMessage,
	isSessionSlashCommandResultMessage,
	REFINEMENT_OUTCOME_CUSTOM_TYPE,
	type SessionSlashCommandResultMessage,
} from "../core/messages.js";

export function latestAutonomousGateAttempt(status: AgentAutonomousStatus): number {
	return Math.max(status.lastGateFailure?.attempt ?? 0, 0, ...Object.values(status.gateAttempts));
}

export type HeadlessTerminalResultMessage = AssistantMessage | SessionSlashCommandResultMessage;

export interface HeadlessTerminalResult {
	primary?: HeadlessTerminalResultMessage;
	compactionOutcomes: CompactionOutcomeMessage[];
}

export function selectHeadlessTerminalResult(messages: readonly AgentMessage[]): HeadlessTerminalResult {
	let index = messages.length - 1;
	const compactionOutcomes: CompactionOutcomeMessage[] = [];
	while (index >= 0) {
		const message = messages[index];
		if (isCompactionOutcomeMessage(message)) {
			compactionOutcomes.unshift(message);
			index--;
			continue;
		}
		// A corrupt outcome is still part of the terminal outcome suffix. Skip it
		// without letting it hide earlier valid outcomes or their failure status.
		if (
			message.role === "custom" &&
			(message.customType === COMPACTION_OUTCOME_CUSTOM_TYPE ||
				message.customType === REFINEMENT_OUTCOME_CUSTOM_TYPE)
		) {
			index--;
			continue;
		}
		break;
	}
	const precedingMessage = messages[index];
	const primary =
		precedingMessage?.role === "assistant" || isSessionSlashCommandResultMessage(precedingMessage)
			? precedingMessage
			: undefined;
	return { primary, compactionOutcomes };
}

function shouldContinueAutonomousGates(status: AgentAutonomousStatus): boolean {
	return (
		status.enabled &&
		status.gates.commands.length > 0 &&
		!!status.lastGateFailure &&
		latestAutonomousGateAttempt(status) <= status.gates.maxRetries &&
		!autonomousLimitReason(status)
	);
}

function autonomousProgressKey(status: AgentAutonomousStatus): string {
	return [
		latestAutonomousGateAttempt(status),
		status.continuationsUsed,
		status.turnsUsed,
		status.tokensUsed,
		status.lastGateFailure?.exitText ?? "",
	].join(":");
}

export class HeadlessContinuationBlockedError extends Error {
	readonly status = "blocked_external";

	constructor(readonly reason: string) {
		super(`blocked_external: ${reason}`);
		this.name = "HeadlessContinuationBlockedError";
	}
}

function assertContinuationReady(session: AgentSession): void {
	const continuation = session.getContinuationStatus();
	if (continuation.status === "blocked_external") {
		throw new HeadlessContinuationBlockedError(continuation.hold?.reason ?? "External continuation hold");
	}
}

export interface HeadlessCompletionOptions {
	/** Include descendant settlement and the parent turns caused by their results. */
	waitForRlmQuiescence?: boolean;
	/** End this observation only; owned work continues. */
	timeoutMs?: number;
	signal?: AbortSignal;
}

export async function waitForHeadlessCompletion(
	session: AgentSession,
	options: HeadlessCompletionOptions = {},
): Promise<AgentAutonomousStatus> {
	return withCompletionDeadline((signal) => waitForHeadlessCompletionUntilSettled(session, { ...options, signal }), {
		...options,
		getBlockers: () => session.getCompletionBlockers(),
	});
}

async function waitForHeadlessCompletionUntilSettled(
	session: AgentSession,
	options: HeadlessCompletionOptions,
): Promise<AgentAutonomousStatus> {
	let lastPromptedProgressKey: string | undefined;
	let repeatedProgressPrompts = 0;
	while (true) {
		options.signal?.throwIfAborted();
		const autonomousRevision = session.getAutonomousRevision();
		if (options.waitForRlmQuiescence) {
			await session.waitForRlmQuiescence(undefined, { waitForOwnedChildDeletion: true, signal: options.signal });
		} else await session.waitForHeadlessIdle(options.signal);
		assertContinuationReady(session);
		if (session.getAutonomousRevision() !== autonomousRevision) continue;
		const status = session.getAutonomousStatus();
		if (!shouldContinueAutonomousGates(status) || !status.lastGateFailure) {
			return status;
		}
		const progressKey = autonomousProgressKey(status);
		if (progressKey === lastPromptedProgressKey) {
			repeatedProgressPrompts++;
		} else {
			repeatedProgressPrompts = 0;
			lastPromptedProgressKey = progressKey;
		}
		if (repeatedProgressPrompts > 0) {
			await delay(Math.min(1000, repeatedProgressPrompts * 50), undefined, { signal: options.signal });
		}
		options.signal?.throwIfAborted();
		assertContinuationReady(session);
		if (session.getAutonomousRevision() !== autonomousRevision) continue;
		if (!session.recordHostAutonomousContinuation(autonomousRevision)) continue;
		await observeCompletion(
			session.prompt(
				buildAutonomousGateFailureContinuation(
					{ ...status.lastGateFailure, attempt: latestAutonomousGateAttempt(status) },
					status.gates.maxRetries,
				),
				{
					streamingBehavior: "followUp",
					internalPrompt: true,
					suppressAutonomousContinuation: true,
					autonomousRevision,
				},
			),
			options.signal,
		);
		options.signal?.throwIfAborted();
		if (
			session.getContinuationStatus().status === "blocked_external" ||
			session.getAutonomousRevision() !== autonomousRevision
		)
			continue;
		await observeCompletion(session.waitForIdle(), options.signal);
		options.signal?.throwIfAborted();
		if (
			session.getContinuationStatus().status === "blocked_external" ||
			session.getAutonomousRevision() !== autonomousRevision
		)
			continue;
		await observeCompletion(session.refreshAutonomousGates(), options.signal);
		if (
			session.getContinuationStatus().status === "blocked_external" ||
			session.getAutonomousRevision() !== autonomousRevision
		)
			continue;
		const { primary } = selectHeadlessTerminalResult(session.state.messages);
		if (primary?.role === "assistant") {
			if (primary.stopReason === "error" || primary.stopReason === "aborted") {
				const postErrorStatus = session.getAutonomousStatus();
				if (shouldContinueAutonomousGates(postErrorStatus) && postErrorStatus.lastGateFailure) {
					continue;
				}
				if (options.waitForRlmQuiescence) continue;
				return postErrorStatus;
			}
		}
	}
}
