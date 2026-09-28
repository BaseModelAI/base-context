import type { AgentTool } from "@ponythewhite/base-context-agent";
import { fauxAssistantMessage, fauxToolCall } from "@ponythewhite/base-context-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../../src/core/agent-session.js";
import { JOB_WATCH_STATE, type JobWatchController } from "../../src/core/job-watch.js";
import type { HostRequestHandlers } from "../../src/core/kernel/index.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { createHarness, getAssistantTexts, type Harness } from "./harness.js";

const harnesses: Harness[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const harness of harnesses.splice(0).reverse()) await harness.cleanup();
});
const toolCall = (code: string) => fauxAssistantMessage(fauxToolCall("ipython", { code }), { stopReason: "toolUse" });
async function fixture(goal = false, persistSession = false) {
	let session: AgentSession;
	let handlers: HostRequestHandlers;
	let watch: Record<string, unknown>;
	const tool: AgentTool = {
		name: "ipython",
		label: "ipython",
		description: "Local host-bridge fixture",
		parameters: Type.Object({ code: Type.String() }),
		execute: async (_id, params) => {
			const code = (params as { code: string }).code;
			if (code === "watch")
				watch = await handlers["job_watch.watch"]({
					resource_id: "local-handle",
					job_id: "local-job",
					completion_source: "handle",
					notify: "changes",
					fields: ["updates"],
				});
			if (code === "watch" || code === "park") await handlers["job_watch.park"]({ ids: [watch.id] });
			if (code === "goal.complete") await session.handleGoalHostRequest("goal.complete");
			return { content: [{ type: "text", text: "ready" }], details: {} };
		},
	};
	const harness = await createHarness({
		tools: [tool],
		persistSession,
		autonomous: { enabled: true, maxContinuations: 3, maxTurns: 100 },
		settings: { compaction: { enabled: true, keepRecentTokens: 1 } },
		extensionFactories: [
			(pi) => {
				pi.on("session_before_compact", async (event) => ({
					compaction: {
						summary: "Parked watch retained by native metadata.",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						details: {},
					},
				}));
			},
		],
	});
	harnesses.push(harness);
	session = harness.session;
	handlers = Reflect.get(session, "_createKernelHostHandlers").call(session);
	harness.setResponses([toolCall("watch"), fauxAssistantMessage("Waiting for selected job evidence.")]);
	await session.prompt(goal ? "/goal finish two jobs" : "Start this job and wait for evidence.");
	const observation = async (updates: number, state = "running") =>
		handlers["job_watch.observation"]({
			id: watch.id,
			generation: watch.generation,
			result: {
				source: "handle",
				observation: {
					observed_at: new Date().toISOString(),
					job_id: "local-job",
					state,
					progress: { updates },
					attention: [],
					evidence: ["job.json"],
				},
			},
		});
	return {
		harness,
		handlers,
		observation,
		watch: () => watch,
		isParked: () => Reflect.get(session, "_jobWatchController").isParked() as boolean,
	};
}
function eventCount(harness: Harness) {
	return harness.session.messages.filter(
		(message) => message.role === "custom" && message.customType === "job_watch_event",
	).length;
}

describe("job-watch real AgentSession autonomous compatibility", () => {
	it("parks autonomous-only continuation, ignores twenty unchanged checks, and releases exactly once on selected evidence", async () => {
		const f = await fixture();
		const { harness } = f;
		expect(harness.session.goalState.active).toBe(false);
		expect(f.isParked()).toBe(true);
		const accounting = harness.session.getAutonomousStatus();
		expect(accounting.continuationsUsed).toBe(0);
		expect(accounting.turnsUsed).toBe(2);
		for (let i = 0; i < 20; i++) await f.observation(1);
		expect(getAssistantTexts(harness).filter(Boolean)).toHaveLength(1);
		expect(harness.session.getAutonomousStatus()).toEqual(accounting);
		harness.setResponses([toolCall("park"), fauxAssistantMessage("One selected update; waiting again.")]);
		await f.observation(2);
		await harness.session.waitForIdle();
		expect(eventCount(harness)).toBe(1);
		expect(f.isParked()).toBe(true);
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(0);
		await f.observation(2);
		await harness.session.waitForIdle();
		expect(eventCount(harness)).toBe(1);
	});
	it("runs unrelated user and follow-up input without turning parking into a thread-wide lock", async () => {
		const f = await fixture();
		const { harness } = f;
		harness.setResponses([
			fauxAssistantMessage("Answered the unrelated user."),
			fauxAssistantMessage("Handled the queued work."),
		]);
		await harness.session.prompt("Unrelated question");
		await harness.session.followUp("Unrelated queued work");
		await harness.session.waitForIdle();
		expect(getAssistantTexts(harness)).toContain("Handled the queued work.");
		expect(f.isParked()).toBe(true);
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(0);
	});
	it("does not let goal plus autonomous continuation override a parked wait", async () => {
		const f = await fixture(true);
		const { harness } = f;
		expect(harness.session.goalState).toMatchObject({ active: true, status: "active", continuationsUsed: 0 });
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(0);
		harness.setResponses([fauxAssistantMessage("Answered while the goal remains active.")]);
		await harness.session.prompt("An unrelated question");
		expect(harness.session.goalState).toMatchObject({ active: true, status: "active", continuationsUsed: 0 });
		expect(f.isParked()).toBe(true);
	});
	it("holds evidence through explicit cancellation and admits it once when user input resumes", async () => {
		const f = await fixture();
		const { harness } = f;
		await f.observation(1);
		await harness.session.abort();
		await f.observation(2);
		expect(eventCount(harness)).toBe(0);
		expect(harness.session.queuedActionCount).toBe(1);
		expect(Reflect.get(harness.session, "_jobWatchController").snapshot().watches[0].pending).toHaveLength(1);
		harness.setResponses([toolCall("park"), fauxAssistantMessage("Resumed safely.")]);
		await harness.session.prompt("Continue now");
		await harness.session.waitForIdle();
		expect(eventCount(harness)).toBe(1);
		expect(f.isParked()).toBe(true);
	});
	it("keeps queued old-goal evidence identifiable without releasing or restarting the new goal owner", async () => {
		const f = await fixture(true);
		const { harness } = f;
		await f.observation(1);
		const oldGoal = harness.session.goalState.goalId;
		await harness.session.abort();
		await f.observation(2);
		expect(harness.session.queuedActionCount).toBe(1);
		await harness.session.handleGoalHostRequest("goal.complete");
		await harness.session.handleGoalHostRequest("goal.create", { objective: "new independent goal" });
		const newGoal = harness.session.goalState.goalId;
		const watch = await f.handlers["job_watch.watch"]({
			resource_id: "new-resource",
			job_id: "new-job",
			completion_source: "handle",
		});
		await f.handlers["job_watch.park"]({ ids: [watch.id] });
		harness.setResponses([
			fauxAssistantMessage("Earlier evidence belongs to the old goal; waiting for the new job."),
		]);
		harness.session.resumeQueuedWork();
		await harness.session.waitForIdle();
		const event = harness.session.messages.find(
			(message) => message.role === "custom" && message.customType === "job_watch_event",
		);
		expect(JSON.stringify(event)).toContain(oldGoal);
		expect(harness.session.goalState).toMatchObject({ goalId: newGoal, active: true, continuationsUsed: 0 });
		expect(f.isParked()).toBe(true);
	});
	it("preserves explicit autonomous off while parked and never spends continuation budget on checks", async () => {
		const f = await fixture();
		const { harness } = f;
		await harness.session.prompt("/autonomous off");
		await f.observation(1);
		expect(harness.session.getAutonomousStatus()).toMatchObject({
			enabled: false,
			continuationsUsed: 0,
			turnsUsed: 2,
		});
		expect(f.isParked()).toBe(true);
		expect(eventCount(harness)).toBe(0);
	});
	it("excludes only watch bookkeeping from the exact 0/1 content guard, not real content or branch changes", async () => {
		const f = await fixture(true, true);
		const manager = f.harness.sessionManager;
		const owns = manager.captureCompactionContentOwner();
		await manager.appendCustomEntry(
			JOB_WATCH_STATE,
			Reflect.get(f.harness.session, "_jobWatchController").snapshot(),
		);
		expect(owns()).toBe(true);
		expect(owns(1)).toBe(false);
		await manager.appendCustomMessageEntry("real_note", "real model-visible content", true);
		expect(owns()).toBe(false);
		expect(owns(1)).toBe(true);
		await manager.appendCustomMessageEntry("another_note", "another real message", true);
		expect(owns(1)).toBe(false);
	});
	it("preserves an autonomous-only parked owner across real compaction and rejects its old branch handler", async () => {
		const f = await fixture(false, true);
		const { harness } = f;
		const before = harness.session.getAutonomousStatus();
		const first = (await harness.sessionManager.readEntries()).find((entry) => entry.type === "message")!;
		harness.setResponses([fauxAssistantMessage("Some unrelated work to provide a removable prefix.")]);
		await harness.session.prompt("Additional work before compacting");
		const usage = harness.session.getAutonomousStatus();
		await harness.session.compact();
		expect((await harness.sessionManager.readEntries()).some((entry) => entry.type === "compaction")).toBe(true);
		expect(f.isParked()).toBe(true);
		expect(eventCount(harness)).toBe(0);
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(before.continuationsUsed);
		expect(harness.session.getAutonomousStatus().turnsUsed).toBe(usage.turnsUsed);
		await f.observation(1);
		expect(eventCount(harness)).toBe(0);
		const owns = harness.sessionManager.captureCompactionContentOwner();
		await harness.sessionManager.branchTo(first.id);
		expect(owns()).toBe(false);
		expect(f.isParked()).toBe(false);
		expect(await f.observation(2)).toMatchObject({ ignored: true });
		const fresh = await f.handlers["job_watch.watch"]({
			resource_id: "new-resource",
			job_id: "new-job",
			completion_source: "handle",
		});
		expect(fresh.id).not.toBe(f.watch().id);
		await f.handlers["job_watch.park"]({ ids: [fresh.id] });
		expect(f.isParked()).toBe(true);
		await f.observation(3);
		expect(eventCount(harness)).toBe(0);
	});
	it("restores only the same session's native probe declaration and parked autonomous owner", async () => {
		const f = await fixture(false, true);
		const { harness } = f;
		await f.handlers["job_watch.unregister"]({ id: f.watch().id });
		const remote = await f.handlers["job_watch.watch"]({
			resource_id: "remote",
			job_id: "remote",
			completion_source: "probe",
			probe_command: "read-only-summary",
			interval: "5m",
		});
		await f.handlers["job_watch.park"]({ ids: [remote.id] });
		await harness.sessionManager.flushNow();
		const file = harness.sessionManager.getSessionFile()!;
		await harness.session.disposeAsync();
		const reopened = await SessionManager.open(file);
		let checks = 0;
		const provisioner = {
			ensure: async () => ({
				jobWatchProbe: async () => {
					checks++;
					return {
						source: "probe",
						observation: {
							observed_at: new Date().toISOString(),
							job_id: "remote",
							state: "running",
							progress: {},
							attention: [],
							evidence: ["remote.json"],
						},
					};
				},
			}),
			dispose: async () => {},
			manager: undefined,
		};
		const getController = Reflect.get(AgentSession.prototype, "_getJobWatchController");
		vi.spyOn(
			AgentSession.prototype as unknown as { _getJobWatchController: () => JobWatchController },
			"_getJobWatchController",
		).mockImplementation(function (this: AgentSession) {
			Reflect.set(this, "_ipythonKernelProvisioner", provisioner);
			return getController.call(this);
		});
		const fresh = await createHarness({
			sessionManager: reopened,
			tools: [],
			autonomous: { enabled: true, maxTurns: 100 },
		});
		harnesses.push(fresh);
		const controller = Reflect.get(fresh.session, "_jobWatchController");
		await controller.runDue();
		expect(checks).toBe(1);
		expect(controller.isParked()).toBe(true);
		expect(eventCount(fresh)).toBe(0);
		expect(controller.status(remote.id).generation).not.toBe(remote.generation);
		expect(fresh.session.getAutonomousStatus().continuationsUsed).toBe(0);
	});
	it("restores a clean suspended queue with the original event ID and delivers it once", async () => {
		const f = await fixture(false, true);
		const { harness } = f;
		await harness.session.abort();
		await f.observation(1, "succeeded");
		const pending = Reflect.get(harness.session, "_jobWatchController").snapshot().watches[0].pending;
		expect(pending).toHaveLength(1);
		const eventId = pending[0].id;
		const file = harness.sessionManager.getSessionFile()!;
		await harness.session.disposeAsync({ kernelSnapshot: false });
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const reopened = await SessionManager.open(file);
		const fresh = await createHarness({
			sessionManager: reopened,
			tools: [],
			autonomous: { enabled: true, maxTurns: 1 },
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						await gate;
					});
				},
			],
		});
		harnesses.push(fresh);
		fresh.setResponses([fauxAssistantMessage("Retained completion delivered.")]);
		release();
		await fresh.session.waitForIdle();
		expect(eventCount(fresh)).toBe(1);
		const event = fresh.session.messages.find(
			(message) => message.role === "custom" && message.customType === "job_watch_event",
		);
		expect(JSON.stringify(event)).toContain(eventId);
		expect(JSON.stringify(event)).not.toContain("delivery_unknown");
		expect(Reflect.get(fresh.session, "_jobWatchController").snapshot().watches[0].pending).toHaveLength(0);
	});
	it("keeps session bootstrap available when optional watch metadata exceeds its existing source cap", async () => {
		const f = await fixture(false, true);
		const file = f.harness.sessionManager.getSessionFile()!;
		await f.harness.session.disposeAsync({ kernelSnapshot: false });
		const writer = await SessionManager.open(file);
		await writer.appendCustomEntry(JOB_WATCH_STATE, { version: 1, padding: "x".repeat(10000) });
		await writer.close();
		const warnings: unknown[] = [];
		vi.spyOn(
			AgentSession.prototype as unknown as { _surfaceSessionInputError: (error: unknown) => void },
			"_surfaceSessionInputError",
		).mockImplementation((error) => {
			warnings.push(error);
		});
		const fresh = await createHarness({
			sessionManager: await SessionManager.open(file),
			tools: [],
			settings: { canonicalContext: { maxSourceBytes: 4096 } },
		});
		harnesses.push(fresh);
		expect(warnings.map(String).join("\n")).toContain("optional job-watch state exceeds the existing source budget");
		expect(Reflect.get(fresh.session, "_jobWatchController")).toBeUndefined();
		expect(fresh.settingsManager.getCanonicalContextLimits().maxSourceBytes).toBe(4096);
	});
	it("allows watch bookkeeping during real goal prompt preparation without weakening content ownership", async () => {
		const f = await fixture(true, true);
		const { harness } = f;
		const original = Reflect.get(harness.session, "_readHarnessSnapshot").bind(harness.session);
		let writes = 0;
		vi.spyOn(
			harness.session as unknown as { _readHarnessSnapshot: (...args: unknown[]) => Promise<unknown> },
			"_readHarnessSnapshot",
		).mockImplementation(async (...args) => {
			const result = await original(...args);
			await harness.sessionManager.appendCustomEntry(
				JOB_WATCH_STATE,
				Reflect.get(harness.session, "_jobWatchController").snapshot(),
			);
			writes++;
			return result;
		});
		harness.setResponses([fauxAssistantMessage("The next real request was admitted.")]);
		await harness.session.prompt("Check the active goal without waking the job");
		expect(writes).toBeGreaterThan(0);
		expect(getAssistantTexts(harness)).toContain("The next real request was admitted.");
		expect(f.isParked()).toBe(true);
	});
});
