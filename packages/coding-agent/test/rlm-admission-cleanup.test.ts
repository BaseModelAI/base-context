import { join } from "node:path";
import { fauxAssistantMessage } from "@ponythewhite/base-context-ai";
import { describe, expect, it, vi } from "vitest";
import { AgentSessionRuntime, createAgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import type { CreateRlmSubagentRuntimeOptions, RlmSubagentRuntime } from "../src/core/rlm-runtime.js";
import { SessionManager } from "../src/core/session-manager.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import { waitForHeadlessCompletion } from "../src/modes/headless-completion.js";
import { createHarness } from "./suite/harness.js";

const spawn = Reflect.get(AgentDaemon.prototype, "createRlmSubagentRuntime") as (
	this: object,
	parent: object,
	options: CreateRlmSubagentRuntimeOptions,
) => Promise<RlmSubagentRuntime>;

describe("native child admission cleanup", () => {
	it.each([false, true])(
		"settles pre-factory runtime rejection only after cleanup (cleanupFails=%s)",
		async (cleanupFails) => {
			const harness = await createHarness({ settings: { autoRefine: { enabled: false } } });
			const manager = await SessionManager.create(
				join(harness.tempDir, "missing-cwd"),
				join(harness.tempDir, "child"),
			);
			const factory = vi.fn(async () => {
				throw new Error("Factory must not run");
			});
			try {
				await harness.session.setRlmMaxSubagents(1);
				const admission = await harness.session.reserveRlmChildAdmission();
				admission.claimFactory();
				if (cleanupFails) vi.spyOn(manager, "close").mockRejectedValueOnce(new Error("close failed"));
				await expect(
					createAgentSessionRuntime(factory, {
						cwd: harness.tempDir,
						agentDir: harness.tempDir,
						sessionManager: manager,
						sessionOptions: { rlmChildAdmission: admission },
					}),
				).rejects.toThrow(
					cleanupFails ? "Runtime creation and cleanup failed" : "working directory does not exist",
				);
				expect(factory).not.toHaveBeenCalled();
				await admission.settle();
				if (cleanupFails) {
					await expect(harness.session.reserveRlmChildAdmission()).rejects.toThrow("resident child limit reached");
				} else {
					const next = await harness.session.reserveRlmChildAdmission();
					await next.settle();
				}
			} finally {
				vi.restoreAllMocks();
				await manager.close();
				await harness.cleanup();
			}
		},
	);

	it("releases capacity after daemon family rejection and admits a later child", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: false }, autoRefine: { enabled: false } },
		});
		const parent = harness.session;
		const state = { activeSessionId: "parent", runtime: { session: parent } };
		const factory = vi.fn();
		const host = Object.assign(Object.create(AgentDaemon.prototype), {
			sessions: new Map([[state.activeSessionId, state]]),
			pendingSessionNames: new Set(),
			assertFamilySessionNameAvailable: async () => {
				throw new Error("family name rejected");
			},
			createAdmittedRlmSubagentRuntime: factory,
		});
		parent.setSubagentRuntimeHost({
			createRlmSubagentRuntime: (options) => spawn.call(host, state, options),
			deleteRlmSubagentRuntime: async () => {},
		});
		try {
			await parent.setRlmMaxSubagents(1);
			harness.setResponses([
				fauxAssistantMessage("Read failure."),
				fauxAssistantMessage("Child finished."),
				fauxAssistantMessage("Read result."),
			]);
			await parent.runRlmChild("Rejected task", { name: "worker" });
			await waitForHeadlessCompletion(parent, { waitForRlmQuiescence: true, timeoutMs: 3000 });
			expect(factory).not.toHaveBeenCalled();
			parent.setSubagentRuntimeHost();
			const retry = await parent.runRlmChild("Complete the task", { name: "retry-worker" });
			await waitForHeadlessCompletion(parent, { waitForRlmQuiescence: true, timeoutMs: 3000 });
			expect((await parent.listRlmSubagents()).subagents).toContainEqual(
				expect.objectContaining({ rlm_child_id: retry.rlm_child_id, status: "completed" }),
			);
		} finally {
			await harness.cleanup();
		}
	});

	it.each(["inline", "hosted", "daemon"])("releases capacity when %s child journal creation fails", async (kind) => {
		const harness = await createHarness({
			settings: { compaction: { enabled: false }, autoRefine: { enabled: false } },
		});
		const parent = harness.session;
		if (kind === "hosted") {
			const host: AgentSessionRuntime = Object.assign(Object.create(AgentSessionRuntime.prototype), {
				_services: { agentDir: harness.tempDir },
			});
			parent.setSubagentRuntimeHost(host);
		} else if (kind === "daemon") {
			const state = { activeSessionId: "parent", runtime: { session: parent } };
			const host: AgentDaemon = Object.assign(Object.create(AgentDaemon.prototype), {
				sessions: new Map([[state.activeSessionId, state]]),
				pendingSessionNames: new Set(),
				assertFamilySessionNameAvailable: async () => {},
			});
			parent.setSubagentRuntimeHost({
				createRlmSubagentRuntime: (options) => spawn.call(host, state, options),
				deleteRlmSubagentRuntime: async () => {},
			});
		}
		try {
			await parent.setRlmMaxSubagents(1);
			harness.setResponses([fauxAssistantMessage("Read failure.")]);
			const create = vi
				.spyOn(SessionManager, "create")
				.mockRejectedValueOnce(new Error("cannot create child journal"));
			await parent.runRlmChild("Rejected task", { name: "worker" });
			await waitForHeadlessCompletion(parent, { waitForRlmQuiescence: true, timeoutMs: 3000 });
			create.mockRestore();
			const admission = await parent.reserveRlmChildAdmission();
			await admission.settle();
		} finally {
			vi.restoreAllMocks();
			await harness.cleanup();
		}
	});

	it("retains capacity when child journal creation reports failed physical cleanup", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: false }, autoRefine: { enabled: false } },
		});
		try {
			await harness.session.setRlmMaxSubagents(1);
			harness.setResponses([fauxAssistantMessage("Read cleanup failure.")]);
			vi.spyOn(SessionManager, "create").mockRejectedValueOnce(
				new AggregateError(
					[new Error("create failed"), new Error("close failed")],
					"Session creation and cleanup failed",
				),
			);
			await harness.session.runRlmChild("Rejected task", { name: "worker" });
			await waitForHeadlessCompletion(harness.session, { waitForRlmQuiescence: true, timeoutMs: 3000 });
			await expect(harness.session.reserveRlmChildAdmission()).rejects.toThrow("resident child limit reached");
		} finally {
			vi.restoreAllMocks();
			await harness.cleanup();
		}
	});
});
