import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@ponythewhite/base-context-ai";
import {
	emptyGoalState,
	GOAL_STATE_CUSTOM_TYPE,
	type GoalState,
	type GoalStatus,
	goalTokenDeltaForUsage,
	isPersistedGoalState,
	normalizeGoalState,
	validateGoalBudget,
	validateGoalObjective,
} from "./goals.js";
import type { CapturedNativeGoalWrite } from "./session-entry-origin.js";
import type { SessionManager } from "./session-manager.js";

export interface GoalStateSnapshot {
	goal: GoalState;
	goalRevision: number;
	accountingStartedAt: number | undefined;
}

/** A continuation retains its source and checks Session's control ownership across awaited writes. */
export interface GoalStateWriteOwner extends GoalStateSnapshot {
	manager: SessionManager;
	assertCurrent(): void;
}

/** Owns goal state, accounting, and durable publication. Session owns admission and continuation scheduling. */
export class SessionGoals {
	private _goalState: GoalState = emptyGoalState();
	private _goalStateRevision = 0;
	private _goalAccountingStartedAt: number | undefined;
	private _goalAccountedAssistantMessages = new WeakSet<AssistantMessage>();

	constructor(
		private readonly _getManager: () => SessionManager,
		private readonly _onChange: () => void,
	) {}

	get state(): Readonly<GoalState> {
		return this._goalState;
	}

	capture(): GoalStateSnapshot {
		return {
			goal: this._goalState,
			goalRevision: this._goalStateRevision,
			accountingStartedAt: this._goalAccountingStartedAt,
		};
	}

	isCurrent(owner: GoalStateSnapshot): boolean {
		return (
			this._goalStateRevision === owner.goalRevision &&
			this._goalState === owner.goal &&
			this._goalAccountingStartedAt === owner.accountingStartedAt
		);
	}

	restore(goal: GoalState): void {
		this._goalState = goal;
		this._goalAccountingStartedAt = goal.status === "active" ? Date.now() : undefined;
	}

	// Used only after a continuation's compensating write has retained its Session owner.
	restoreAccountingClock(startedAt: number | undefined): void {
		this._goalAccountingStartedAt = startedAt;
	}

	loadResidentState(): GoalState {
		const branch = this._getManager().getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (
				entry.type === "custom" &&
				entry.customType === GOAL_STATE_CUSTOM_TYPE &&
				this._getManager().getEntryRetention(entry.id) !== "retained-import" &&
				isPersistedGoalState(entry.data)
			) {
				return normalizeGoalState(entry.data);
			}
		}
		return emptyGoalState();
	}

	private async _persistGoalState(
		goal: GoalState,
		nativeGoalWrite?: CapturedNativeGoalWrite,
		continuationOwner?: GoalStateWriteOwner,
	): Promise<void> {
		const manager = continuationOwner?.manager ?? this._getManager();
		if (continuationOwner) continuationOwner.assertCurrent();
		if (nativeGoalWrite) await nativeGoalWrite(goal);
		else await manager.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, goal);
		// Accepted writes stay on their source. Do not admit a flush on a replacement after the ACK.
		if (continuationOwner) continuationOwner.assertCurrent();
		// Force flush so the goal state is durable before the first assistant response.
		await manager.flushNow();
	}

	async set(
		next: GoalState,
		options: {
			persist?: boolean;
			nativeGoalWrite?: CapturedNativeGoalWrite;
			continuationOwner?: GoalStateWriteOwner;
		} = {},
	): Promise<GoalState> {
		const owner = options.continuationOwner;
		if (owner) owner.assertCurrent();
		// A newer goal write invalidates a continuation before that write's awaited publication.
		this._goalStateRevision++;
		if (owner) owner.goalRevision = this._goalStateRevision;
		const normalized = normalizeGoalState({
			...next,
			updatedAt: Date.now(),
		});
		if (options.persist !== false) {
			await this._persistGoalState(normalized, options.nativeGoalWrite, owner);
		}
		if (owner) owner.assertCurrent();
		this._goalState = normalized;
		if (normalized.status === "active") {
			this._goalAccountingStartedAt ??= Date.now();
		} else {
			this._goalAccountingStartedAt = undefined;
		}
		if (owner) {
			owner.goal = normalized;
			owner.accountingStartedAt = this._goalAccountingStartedAt;
		}
		this._onChange();
		return normalized;
	}

	withCurrentWallClock(now = Date.now()): GoalState {
		if (this._goalState.status !== "active" || !this._goalAccountingStartedAt) {
			return this._goalState;
		}
		const elapsedSeconds = Math.floor((now - this._goalAccountingStartedAt) / 1000);
		if (elapsedSeconds <= 0) {
			return this._goalState;
		}
		return {
			...this._goalState,
			timeUsedSeconds: this._goalState.timeUsedSeconds + elapsedSeconds,
		};
	}

	withAccountedWallClock(): GoalState {
		const now = Date.now();
		const goal = this.withCurrentWallClock(now);
		if (goal !== this._goalState) {
			this._goalAccountingStartedAt = now;
		}
		return goal;
	}

	prepareNewGoal(objectiveText: string, tokenBudget: number | undefined): GoalState {
		const objective = validateGoalObjective(objectiveText);
		const budget = validateGoalBudget(tokenBudget);
		const now = Date.now();
		const goal: GoalState = {
			active: true,
			status: "active",
			goalId: randomUUID(),
			objective,
			tokenBudget: budget,
			tokensUsed: 0,
			timeUsedSeconds: 0,
			continuationsUsed: 0,
			createdAt: now,
			updatedAt: now,
		};
		this._goalAccountingStartedAt = now;
		return goal;
	}

	async pause(reason = "Paused by user", nativeGoalWrite?: CapturedNativeGoalWrite): Promise<void> {
		if (this._goalState.status !== "active") {
			this._onChange();
			return;
		}
		const goal = this.withAccountedWallClock();
		await this.set(
			{
				...goal,
				active: false,
				status: "paused",
				lastReason: reason,
				lastError: undefined,
			},
			{ nativeGoalWrite },
		);
	}

	async resume(nativeGoalWrite?: CapturedNativeGoalWrite): Promise<boolean> {
		if (!this._goalState.objective) {
			this._onChange();
			return false;
		}
		if (this._goalState.status !== "paused" && this._goalState.status !== "budget_limited") {
			this._onChange();
			return false;
		}
		const exhausted =
			this._goalState.tokenBudget !== undefined && this._goalState.tokensUsed >= this._goalState.tokenBudget;
		const nextStatus: GoalStatus = exhausted ? "budget_limited" : "active";
		await this.set(
			{
				...this._goalState,
				active: nextStatus === "active",
				status: nextStatus,
				lastReason: exhausted ? "Goal token budget already reached" : undefined,
				lastError: undefined,
			},
			{ nativeGoalWrite },
		);
		return nextStatus === "active";
	}

	async finishWithError(errorMessage: string, continuationOwner?: GoalStateWriteOwner): Promise<void> {
		if (continuationOwner) continuationOwner.assertCurrent();
		if (!this._goalState.objective || this._goalState.status !== "active") {
			return;
		}
		const goal = this.withAccountedWallClock();
		if (continuationOwner) continuationOwner.accountingStartedAt = this._goalAccountingStartedAt;
		await this.set(
			{
				...goal,
				active: false,
				status: "error",
				lastReason: errorMessage,
				lastError: errorMessage,
			},
			{ continuationOwner },
		);
	}

	async accountUsage(message: AssistantMessage, owner?: GoalStateWriteOwner): Promise<boolean> {
		if (owner) owner.assertCurrent();
		if (!this._goalState.objective) {
			return false;
		}
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			return false;
		}
		if (this._goalAccountedAssistantMessages.has(message)) {
			return false;
		}
		// Usage is attributed at the assistant message's message_end, which fires
		// before that turn's ipython cell runs. goal.complete() only arrives later
		// over the kernel host bridge, so the completing turn is always accounted
		// while the goal is still active. Only count turns spent pursuing the goal;
		// post-completion turns (e.g. a closing summary) must not be attributed.
		if (this._goalState.status !== "active") {
			return false;
		}
		this._goalAccountedAssistantMessages.add(message);
		const tokenDelta = goalTokenDeltaForUsage(message.usage);
		const goal = this.withAccountedWallClock();
		if (owner) owner.accountingStartedAt = this._goalAccountingStartedAt;
		const nextGoal: GoalState = {
			...goal,
			tokensUsed: goal.tokensUsed + tokenDelta,
		};
		const budgetReached = nextGoal.tokenBudget !== undefined && nextGoal.tokensUsed >= nextGoal.tokenBudget;
		if (!budgetReached) {
			await this.set(nextGoal, { continuationOwner: owner });
			return false;
		}
		await this.set(
			{
				...nextGoal,
				active: false,
				status: "budget_limited",
				lastReason: `Reached ${nextGoal.tokenBudget} token goal budget`,
				lastError: undefined,
			},
			{ continuationOwner: owner },
		);
		return true;
	}
}
