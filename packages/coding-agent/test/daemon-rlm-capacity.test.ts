import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";
import { DAEMON_PROTOCOL_INFO, success } from "../src/modes/daemon/daemon-protocol.js";
import { DaemonRlmCapacityClient } from "../src/modes/daemon/daemon-rlm-capacity.js";
import { createDeferred } from "./suite/scheduling.js";

describe("daemon worker RLM capacity", () => {
	beforeEach(() => {
		vi.spyOn(DaemonClient.prototype, "connect").mockResolvedValue();
		vi.spyOn(DaemonClient.prototype, "waitForHello").mockResolvedValue({
			type: "daemon_hello",
			socketPath: "fixture",
			protocol: DAEMON_PROTOCOL_INFO,
			clientId: "fixture",
			serverCapabilities: [],
		});
		vi.spyOn(DaemonClient.prototype, "close").mockImplementation(() => {});
	});
	afterEach(() => vi.restoreAllMocks());

	it("reports authoritative values and includes in-flight and idle reservations until release", async () => {
		const gate = createDeferred<void>();
		const requested = createDeferred<void>();
		const request = vi.spyOn(DaemonClient.prototype, "request").mockImplementation(async (command) => {
			if (command.type === "rlm_capacity" && command.operation.op === "reserve") {
				requested.resolve();
				await gate.promise;
			}
			return success(undefined, "rlm_capacity", { maxSubagents: 7 });
		});
		const client = new DaemonRlmCapacityClient({
			socketPath: "fixture",
			workerToken: "fixture",
			workerInstanceId: "worker-1",
		});
		const family = client.forSession({ sessionId: "root", sessionFile: "/fixture/root.jsonl" });
		expect(await family.getStatus()).toEqual({ maxSubagents: 7 });
		expect(await family.setMaxSubagents(7)).toEqual({ maxSubagents: 7 });
		const pending = family.reserve();
		await requested.promise;
		expect(client.snapshot().reservations).toHaveLength(1);
		gate.resolve();
		const reservation = await pending;
		expect(client.snapshot().reservations).toHaveLength(1);
		await reservation.release();
		expect(client.snapshot().reservations).toEqual([]);
		const root = await client.reserveRoot({ sessionId: "resumed", sessionFile: "/fixture/child.jsonl" });
		expect(client.snapshot().reservations).toEqual([
			expect.objectContaining({ residentRoot: true, sessionId: "resumed" }),
		]);
		await root.release();
		expect(client.snapshot().reservations).toEqual([]);
		expect(request).toHaveBeenLastCalledWith(
			expect.objectContaining({ operation: expect.objectContaining({ op: "release" }) }),
			30000,
			{ recoverable: false },
		);
	});

	it("releases uncertain admission by the same id and retains unacknowledged cleanup for recovery", async () => {
		const request = vi
			.spyOn(DaemonClient.prototype, "request")
			.mockRejectedValueOnce(new Error("connection lost"))
			.mockResolvedValue(success(undefined, "rlm_capacity"));
		const client = new DaemonRlmCapacityClient({
			socketPath: "fixture",
			workerToken: "fixture",
			workerInstanceId: "worker-1",
		});
		const family = client.forSession({ sessionId: "root" });
		await expect(family.reserve()).rejects.toThrow("connection lost");
		expect(client.snapshot().reservations).toEqual([]);
		const commands = request.mock.calls.map(([command]) => command);
		const first = commands[0];
		if (first.type !== "rlm_capacity" || first.operation.op !== "reserve") throw new Error("Missing reserve request");
		expect(commands[1]).toMatchObject({
			type: "rlm_capacity",
			operation: { op: "release", reservationId: first.operation.reservationId },
		});
		request.mockRejectedValue(new Error("supervisor unavailable"));
		await expect(family.reserve()).rejects.toThrow("RLM capacity admission and cleanup failed");
		expect(client.snapshot().reservations).toHaveLength(1);
	});
});
