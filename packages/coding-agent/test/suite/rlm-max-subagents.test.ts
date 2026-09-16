import { fauxAssistantMessage } from "@ponythewhite/base-context-ai";
import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.js";
import { LocalRlmSubagentCapacity } from "../../src/core/rlm-max-subagents.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { createHarness } from "./harness.js";
import { createDeferred } from "./scheduling.js";

describe("root-family subagent capacity", () => {
	it("reserves concurrent native creations and keeps idle descendants counted when lowering", async () => {
		const harness = await createHarness({ rlmMaxDepth: 3 });
		try {
			expect(await harness.session.getRlmMaxSubagentsStatus()).toEqual({ maxSubagents: 4 });
			harness.setResponses(Array.from({ length: 6 }, () => fauxAssistantMessage("done")));
			const starts = await Promise.allSettled(
				Array.from({ length: 5 }, (_, i) => harness.session.runRlmChild(`task ${i}`, { name: `worker-${i}` })),
			);
			const handles = starts.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
			expect(handles).toHaveLength(4);
			expect(starts.filter((result) => result.status === "rejected")).toHaveLength(1);
			await harness.session.waitForRlmQuiescence();
			const first = harness.session.getRlmChildSession(handles[0].rlm_child_id)!;
			await expect(first.runRlmChild("nested over capacity")).rejects.toThrow("resident child limit");
			await harness.session.setRlmMaxSubagents(0);
			for (const handle of handles)
				expect(harness.session.getRlmChildSession(handle.rlm_child_id)?.hasRlmParentAdmission).toBe(true);
			await expect(harness.session.runRlmChild("blocked by zero")).rejects.toThrow("resident child limit");
			await harness.session.getRlmChildSession(handles[1].rlm_child_id)!.disposeAsync();
			await harness.session.setRlmMaxSubagents(4);
			await expect(first.runRlmChild("nested after cleanup", { name: "nested-worker" })).resolves.toHaveProperty(
				"rlm_child_id",
			);
			await harness.session.waitForRlmQuiescence();
			await expect(harness.session.runRlmChild("root still full")).rejects.toThrow("resident child limit");
		} finally {
			await harness.cleanup();
		}
	});

	it("persists safe integer limits, restores them, and releases rejected setup reservations", async () => {
		const harness = await createHarness();
		try {
			const settings = SettingsManager.create(harness.tempDir, harness.tempDir);
			const capacity = new LocalRlmSubagentCapacity(settings);
			await capacity.setMaxSubagents(0);
			expect(SettingsManager.create(harness.tempDir, harness.tempDir).getRlmMaxSubagents()).toBe(0);
			await expect(capacity.reserve()).rejects.toThrow("resident child limit");
			for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
				expect(() => settings.setRlmMaxSubagents(value)).toThrow("safe integer");
			}
			await expect(capacity.setMaxSubagents(Number.MAX_SAFE_INTEGER)).resolves.toEqual({
				maxSubagents: Number.MAX_SAFE_INTEGER,
			});
			await harness.session.setRlmMaxSubagents(1);
			await expect(
				harness.session.runRlmChild("invalid model", { model: "missing/provider-model" }),
			).rejects.toThrow();
			harness.setResponses([fauxAssistantMessage("done")]);
			await expect(harness.session.runRlmChild("capacity released", { name: "recovered" })).resolves.toHaveProperty(
				"rlm_child_id",
			);
			let bound: AgentSession | undefined;
			const release = vi.fn(async () => {});
			const resumed = await createHarness({
				rlmRootAdmission: {
					get session() {
						return bound;
					},
					bind: (session) => {
						bound = session;
					},
					release,
				},
			});
			const closing = createDeferred<void>();
			const allowClose = createDeferred<void>();
			const close = resumed.sessionManager.close.bind(resumed.sessionManager);
			vi.spyOn(resumed.sessionManager, "close").mockImplementation(async () => {
				closing.resolve();
				await allowClose.promise;
				await close();
			});
			try {
				expect(bound).toBe(resumed.session);
				expect(resumed.session.hasRlmParentAdmission).toBe(false);
				const disposal = resumed.session.disposeAsync();
				await closing.promise;
				expect(release).not.toHaveBeenCalled();
				allowClose.resolve();
				await disposal;
				expect(release).toHaveBeenCalledOnce();
			} finally {
				allowClose.resolve();
				await resumed.cleanup();
			}
		} finally {
			await harness.cleanup();
		}
	});
});
