import { randomUUID } from "node:crypto";
import {
	assertRlmMaxSubagents,
	type RlmMaxSubagentsStatus,
	type RlmSubagentCapacity,
	type RlmSubagentCapacityReservation,
} from "../../core/rlm-max-subagents.js";
import { DaemonClient } from "./daemon-client.js";
import { deserializeDaemonError } from "./daemon-errors.js";
import type {
	DaemonRlmCapacityOperation,
	DaemonRlmCapacityOrigin,
	DaemonRlmCapacityReservation,
	DaemonRlmCapacitySnapshot,
} from "./daemon-worker-protocol.js";

/** Worker-owned slots remain visible to a replacement supervisor until release is acknowledged. */
export class DaemonRlmCapacityClient {
	private readonly reservations = new Map<string, DaemonRlmCapacityReservation>();

	constructor(private readonly options: { socketPath: string; workerToken: string; workerInstanceId: string }) {}

	snapshot(): DaemonRlmCapacitySnapshot {
		return { reservations: [...this.reservations.values()].map((record) => ({ ...record })) };
	}

	forSession(origin: DaemonRlmCapacityOrigin): RlmSubagentCapacity {
		return {
			getStatus: () => this.requestStatus({ op: "status", ...origin }),
			setMaxSubagents: (maxSubagents) => {
				assertRlmMaxSubagents(maxSubagents);
				return this.requestStatus({ op: "set", ...origin, maxSubagents });
			},
			reserve: () => this.reserve(origin),
		};
	}

	async reserveRoot(origin: DaemonRlmCapacityOrigin): Promise<RlmSubagentCapacityReservation> {
		return this.reserve(origin, true);
	}

	private async reserve(
		origin: DaemonRlmCapacityOrigin,
		residentRoot?: true,
	): Promise<RlmSubagentCapacityReservation> {
		const reservationId = randomUUID();
		const record = { ...origin, reservationId, ...(residentRoot ? { residentRoot } : {}) };
		this.reservations.set(reservationId, record);
		let released = false;
		const release = async () => {
			if (released) return;
			await this.request({ op: "release", reservationId });
			released = true;
			this.reservations.delete(reservationId);
		};
		try {
			await this.request({ op: "reserve", ...record });
			return { release };
		} catch (error) {
			try {
				await release();
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], "RLM capacity admission and cleanup failed");
			}
			throw error;
		}
	}

	private async requestStatus(operation: DaemonRlmCapacityOperation): Promise<RlmMaxSubagentsStatus> {
		const data = await this.request(operation);
		if (
			typeof data !== "object" ||
			data === null ||
			!("maxSubagents" in data) ||
			typeof data.maxSubagents !== "number"
		) {
			throw new Error("Supervisor returned invalid RLM subagent capacity status");
		}
		assertRlmMaxSubagents(data.maxSubagents);
		return { maxSubagents: data.maxSubagents };
	}

	private async request(operation: DaemonRlmCapacityOperation): Promise<unknown> {
		const client = new DaemonClient(this.options.socketPath);
		try {
			await client.connect(1000);
			await client.waitForHello(1000);
			const response = await client.request(
				{
					type: "rlm_capacity",
					workerToken: this.options.workerToken,
					workerInstanceId: this.options.workerInstanceId,
					operation,
				},
				30_000,
				{ recoverable: false },
			);
			if (!response.success) throw deserializeDaemonError(response);
			return response.data;
		} finally {
			client.close();
		}
	}
}
