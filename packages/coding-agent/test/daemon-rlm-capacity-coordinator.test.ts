import { describe, expect, test } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";
import { DaemonRlmCapacityCoordinator } from "../src/modes/daemon/daemon-rlm-capacity-coordinator.js";

describe("daemon family subagent capacity", () => {
	test("shares the limit across workers and lowers it without removing existing leases", async () => {
		const settings = SettingsManager.inMemory();
		const capacity = new DaemonRlmCapacityCoordinator(settings);
		expect(capacity.getStatus("family")).toEqual({ maxSubagents: 4 });
		for (let index = 0; index < 4; index++) {
			capacity.reserve(index < 2 ? "first-worker" : "second-worker", String(index), "family");
		}
		expect(() => capacity.reserve("third-worker", "extra", "family")).toThrow(/limit reached/);
		await capacity.setMaxSubagents("family", 2);
		expect(settings.getRlmMaxSubagents()).toBe(2);
		capacity.release("first-worker", "0");
		capacity.release("first-worker", "1");
		expect(() => capacity.reserve("third-worker", "extra", "family")).toThrow(/limit reached/);
		capacity.release("second-worker", "2");
		expect(capacity.reserve("third-worker", "extra", "family")).toEqual({ maxSubagents: 2 });
		// An unrelated main has its own family occupancy, using the saved preference.
		expect(capacity.reserve("fourth-worker", "child", "other-family")).toEqual({ maxSubagents: 2 });
	});

	test("restores above-limit residents without granting an uncertain pending admission", async () => {
		const capacity = new DaemonRlmCapacityCoordinator(SettingsManager.inMemory());
		await capacity.setMaxSubagents("family", 0);
		capacity.restore("survivor", "idle-child", "family");
		capacity.restore("survivor", "pending-child", "family");
		expect(() => capacity.reserve("survivor", "pending-child", "family")).toThrow(/limit reached/);
		await capacity.setMaxSubagents("family", 1);
		expect(() => capacity.reserve("new-worker", "new-child", "family")).toThrow(/limit reached/);
		capacity.release("survivor", "pending-child");
		expect(() => capacity.reserve("new-worker", "new-child", "family")).toThrow(/limit reached/);
		// Only actual worker disposal releases its remaining resident claims.
		capacity.releaseOwner("survivor");
		expect(capacity.reserve("new-worker", "new-child", "family")).toEqual({ maxSubagents: 1 });
		expect(() => capacity.reserve("new-worker", "new-child", "different-family")).toThrow(/another family/);
	});
});
