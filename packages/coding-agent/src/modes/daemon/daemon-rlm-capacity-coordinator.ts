import { LocalRlmSubagentCapacity, type RlmMaxSubagentsStatus } from "../../core/rlm-max-subagents.js";
import type { SettingsManager } from "../../core/settings-manager.js";

interface CapacityClaim {
	family: string;
	restored: boolean;
}

/** Live leases only: inactive session catalog rows never consume capacity. */
export class DaemonRlmCapacityCoordinator {
	private readonly claims = new Map<string, Map<string, CapacityClaim>>();
	private readonly limits = new Map<string, number>();
	private readonly preference: LocalRlmSubagentCapacity;
	private defaultLimit: number;

	constructor(settings: SettingsManager) {
		this.preference = new LocalRlmSubagentCapacity(settings);
		this.defaultLimit = settings.getRlmMaxSubagents();
	}

	getStatus(family: string): RlmMaxSubagentsStatus {
		let maxSubagents = this.limits.get(family);
		if (maxSubagents === undefined) {
			maxSubagents = this.defaultLimit;
			this.limits.set(family, maxSubagents);
		}
		return { maxSubagents };
	}

	async setMaxSubagents(family: string, maxSubagents: number): Promise<RlmMaxSubagentsStatus> {
		const status = await this.preference.setMaxSubagents(maxSubagents);
		this.defaultLimit = status.maxSubagents;
		this.limits.set(family, status.maxSubagents);
		return status;
	}

	reserve(owner: string, id: string, family: string): RlmMaxSubagentsStatus {
		const existing = this.claims.get(owner)?.get(id);
		if (existing && existing.family !== family) throw new Error("RLM capacity reservation belongs to another family");
		const status = this.getStatus(family);
		if (existing && !existing.restored) return status;
		let occupied = 0;
		for (const claims of this.claims.values()) {
			for (const claim of claims.values()) {
				if (claim.family === family && claim !== existing) occupied++;
			}
		}
		if (occupied >= status.maxSubagents) {
			throw new Error(
				`RLM resident child limit reached (maximum ${status.maxSubagents} concurrent subagents); dispose or passivate an existing child first`,
			);
		}
		this.put(owner, id, { family, restored: false });
		return status;
	}

	/** Recovery retains existing claims even when the configured ceiling was lowered. */
	restore(owner: string, id: string, family: string): void {
		const existing = this.claims.get(owner)?.get(id);
		if (existing) {
			if (existing.family !== family) throw new Error("RLM capacity reservation belongs to another family");
			return;
		}
		this.put(owner, id, { family, restored: true });
	}

	release(owner: string, id: string): void {
		const claims = this.claims.get(owner);
		claims?.delete(id);
		if (claims?.size === 0) this.claims.delete(owner);
	}

	releaseOwner(owner: string): void {
		this.claims.delete(owner);
	}

	private put(owner: string, id: string, claim: CapacityClaim): void {
		let claims = this.claims.get(owner);
		if (!claims) {
			claims = new Map();
			this.claims.set(owner, claims);
		}
		claims.set(id, claim);
	}
}
