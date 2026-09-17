import type { AgentSession } from "./agent-session.js";
import type { SettingsManager } from "./settings-manager.js";

export const DEFAULT_RLM_MAX_SUBAGENTS = 4;

export interface RlmMaxSubagentsStatus {
	maxSubagents: number;
}

export function assertRlmMaxSubagents(value: number): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error("The maximum number of concurrent subagents must be a non-negative safe integer.");
	}
}

export interface RlmSubagentCapacityReservation {
	release(): Promise<void>;
}

/** A hosted root may itself be a resumed subagent. Bind before constructor setup can fail. */
export interface RlmRootAdmission extends RlmSubagentCapacityReservation {
	readonly session: AgentSession | undefined;
	bind(session: AgentSession): void;
}

/** One shared admission authority for a root family, including pending creations. */
export interface RlmSubagentCapacity {
	getStatus(): Promise<RlmMaxSubagentsStatus>;
	setMaxSubagents(maxSubagents: number): Promise<RlmMaxSubagentsStatus>;
	reserve(): Promise<RlmSubagentCapacityReservation>;
}

export class LocalRlmSubagentCapacity implements RlmSubagentCapacity {
	private maxSubagents: number;
	private readonly reservations = new Set<symbol>();
	private changes: Promise<unknown> = Promise.resolve();

	constructor(private readonly settings: SettingsManager) {
		this.maxSubagents = settings.getRlmMaxSubagents();
	}

	async getStatus(): Promise<RlmMaxSubagentsStatus> {
		return { maxSubagents: this.maxSubagents };
	}

	setMaxSubagents(maxSubagents: number): Promise<RlmMaxSubagentsStatus> {
		assertRlmMaxSubagents(maxSubagents);
		const change = this.changes.then(async () => {
			await this.settings.flush();
			for (const { error } of this.settings.drainErrors("global")) {
				console.warn(`Warning: Earlier global settings write failed: ${error.message}`);
			}
			this.settings.setRlmMaxSubagents(maxSubagents);
			await this.settings.flush();
			const errors = this.settings.drainErrors("global");
			if (errors.length > 0) throw new Error(errors.map(({ error }) => error.message).join("; "));
			this.maxSubagents = maxSubagents;
			return this.getStatus();
		});
		this.changes = change.catch(() => undefined);
		return change;
	}

	async reserve(): Promise<RlmSubagentCapacityReservation> {
		if (this.reservations.size >= this.maxSubagents) {
			throw new Error(
				`RLM resident child limit reached (maximum ${this.maxSubagents} concurrent subagents); dispose or passivate an existing child first`,
			);
		}
		const token = Symbol();
		this.reservations.add(token);
		return {
			release: async () => {
				this.reservations.delete(token);
			},
		};
	}
}
