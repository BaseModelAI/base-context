import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCronJobsPath } from "../src/config.js";
import { AgentCronJobStore, type AgentCronScheduler } from "../src/core/cron-jobs.js";
import type { ActiveSessionState, DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import { type DaemonCommand, type DaemonResponse, failure, success } from "../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

interface SupervisorHarness {
	workers: Map<string, unknown>;
	forwardToWorker(worker: unknown, command: DaemonCommand, timeoutMs?: number): Promise<DaemonResponse>;
	handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonResponse | undefined>;
	handleWorkerFrame(worker: unknown, frame: unknown): void;
}

const tempDirs: string[] = [];

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createSupervisorHarness(): SupervisorHarness {
	const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-heartbeats-"));
	tempDirs.push(directory);
	return new DaemonSupervisor(join(directory, "daemon.sock"), {
		defaultSessionConfig: { agentDir: directory, cwd: directory },
		descriptorDir: join(directory, "workers"),
	}) as unknown as SupervisorHarness;
}

function worker(lifecycle: "ready" | "recovering" | "failed", connected = true) {
	return {
		descriptor: { lifecycle },
		...(connected ? { client: {} } : {}),
	};
}

interface CronDaemonHarness {
	cronStore: AgentCronJobStore;
	cronScheduler: AgentCronScheduler;
	sessions: Map<string, ActiveSessionState>;
	handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonResponse | undefined>;
	rebindCronJobsToState(state: ActiveSessionState): void;
	createRuntime(command: DaemonCommand): Promise<ActiveSessionState>;
}

function createCronResumeHarness() {
	const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-cron-resume-"));
	tempDirs.push(directory);
	const daemon = new AgentDaemon(join(directory, "worker.sock"), {
		defaultSessionConfig: { agentDir: directory, cwd: directory },
		createRuntime: async () => {
			throw new Error("Cron resume must not create a runtime");
		},
	}) as unknown as CronDaemonHarness;
	const source = new AgentCronJobStore(join(directory, "source-jobs.json")).create({
		activeSessionId: "source-active",
		sessionId: "source-session",
		sessionFile: join(directory, "source.jsonl"),
		cwd: directory,
		runtimeKind: "top-level",
		prompt: "Check the imported schedule",
		scheduleText: "every 1 minute",
	});
	const sessionFile = join(directory, "destination.jsonl");
	const [imported] = daemon.cronStore.importPaused([source], {
		sessionId: "destination-session",
		sessionFile,
		cwd: directory,
	});
	const promptUntilAccepted = vi.fn(async (_prompt: string, options: { admissionCommitted?: () => void }) => {
		options.admissionCommitted?.();
	});
	const state = {
		activeSessionId: "destination-active",
		runtime: {
			cwd: directory,
			metadata: { kind: "top-level" },
			session: { sessionId: "destination-session", sessionFile, promptUntilAccepted },
		},
	} as unknown as ActiveSessionState;
	// Use the same paused-job rebind as the normal runtime binding path.
	daemon.sessions.set(state.activeSessionId, state);
	daemon.rebindCronJobsToState(state);
	const supervisor = createSupervisorHarness();
	const client = {} as DaemonSocketClient;
	const request = vi.fn(async (command: DaemonCommand) => (await daemon.handleCommand(client, command))!);
	supervisor.workers.set("destination-worker", {
		descriptor: { lifecycle: "ready" },
		client: { request },
	});
	const persisted = () =>
		new AgentCronJobStore(getCronJobsPath(directory)).list().find((job) => job.id === imported!.id);
	return { daemon, supervisor, client, imported: imported!, source, state, promptUntilAccepted, request, persisted };
}

describe("daemon supervisor scheduled jobs", () => {
	it("uses the last complete worker snapshot during recovery", async () => {
		const supervisor = createSupervisorHarness();
		const first = worker("ready");
		const second = worker("ready");
		supervisor.workers.set("first", first);
		supervisor.workers.set("second", second);
		supervisor.forwardToWorker = vi.fn(async (target, command) =>
			success(command.id, command.type, {
				heartbeats: [{ job: { id: target === first ? "heartbeat-1" : "heartbeat-2" } }],
			}),
		);

		const initial = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "list-1",
			type: "heartbeats_list",
		});
		expect(initial).toMatchObject({
			success: true,
			data: { heartbeats: [{ job: { id: "heartbeat-1" } }, { job: { id: "heartbeat-2" } }] },
		});

		second.descriptor.lifecycle = "recovering";
		delete second.client;
		const recovered = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "list-2",
			type: "heartbeats_list",
		});

		expect(recovered).toMatchObject({
			success: true,
			data: { heartbeats: [{ job: { id: "heartbeat-1" } }, { job: { id: "heartbeat-2" } }] },
		});
		expect(supervisor.forwardToWorker).toHaveBeenCalledTimes(3);
	});

	it("returns a worker failure instead of a partial catalog", async () => {
		const supervisor = createSupervisorHarness();
		const first = worker("ready");
		const second = worker("ready");
		supervisor.workers.set("first", first);
		supervisor.workers.set("second", second);
		supervisor.forwardToWorker = vi.fn(async (target, command) =>
			target === first
				? success(command.id, command.type, { heartbeats: [] })
				: failure(command.id, command.type, "worker unavailable"),
		);

		const response = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "list-2",
			type: "heartbeats_list",
		});

		expect(response).toMatchObject({ success: false, error: "worker unavailable" });
		expect(supervisor.forwardToWorker).toHaveBeenCalledTimes(2);
	});

	it("does not fall back to a snapshot after the worker reports heartbeat changes", async () => {
		const supervisor = createSupervisorHarness();
		const target = {
			...worker("ready"),
			heartbeatSnapshot: [{ job: { id: "heartbeat-1" } }],
			heartbeatSnapshotStale: false,
		};
		supervisor.workers.set("target", target);
		supervisor.forwardToWorker = vi.fn(async (_worker, command) =>
			failure(command.id, command.type, "worker unavailable"),
		);

		supervisor.handleWorkerFrame(target, {
			header: { kind: "outbound", outboundType: "heartbeats_changed" },
			payload: Buffer.alloc(0),
		});
		const response = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "list-stale",
			type: "heartbeats_list",
		});

		expect(target.heartbeatSnapshotStale).toBe(true);
		expect(response).toMatchObject({ success: false, error: "worker unavailable" });
	});

	it("fails rather than returning a partial catalog without a cached snapshot", async () => {
		const supervisor = createSupervisorHarness();
		supervisor.workers.set("ready", worker("ready"));
		supervisor.workers.set("recovering", worker("recovering", false));
		supervisor.forwardToWorker = vi.fn(async (_target, command) =>
			success(command.id, command.type, { heartbeats: [] }),
		);

		const response = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "list-3",
			type: "heartbeats_list",
		});

		expect(response).toMatchObject({
			success: false,
			error: "Cannot list heartbeats while session worker is recovering",
		});
		expect(supervisor.forwardToWorker).toHaveBeenCalledOnce();
	});

	it("skips terminally failed workers without blocking healthy heartbeats", async () => {
		const supervisor = createSupervisorHarness();
		supervisor.workers.set("healthy", worker("ready"));
		supervisor.workers.set("failed", worker("failed", false));
		supervisor.forwardToWorker = vi.fn(async (_target, command) =>
			success(command.id, command.type, { heartbeats: [{ job: { id: "heartbeat-1" } }] }),
		);

		const response = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "list-failed-worker",
			type: "heartbeats_list",
		});

		expect(response).toMatchObject({
			success: true,
			data: { heartbeats: [{ job: { id: "heartbeat-1" } }] },
		});
		expect(supervisor.forwardToWorker).toHaveBeenCalledOnce();
	});

	it("routes management by cached job ownership after a session unloads", async () => {
		const supervisor = createSupervisorHarness();
		const target = {
			...worker("ready"),
			heartbeatSnapshot: [{ job: { id: "heartbeat-1", activeSessionId: "unloaded-session" } }],
		};
		supervisor.workers.set("target", target);
		supervisor.forwardToWorker = vi.fn(async (_worker, command) =>
			success(command.id, command.type, {
				heartbeat: { id: "heartbeat-1", activeSessionId: "unloaded-session", status: "cancelled" },
			}),
		);

		const response = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "manage-1",
			type: "heartbeat_manage",
			activeSessionId: "unloaded-session",
			jobId: "heartbeat-1",
			action: "stop",
		});

		expect(response).toMatchObject({ success: true });
		expect(supervisor.forwardToWorker).toHaveBeenCalledWith(
			target,
			expect.objectContaining({ type: "heartbeat_manage", jobId: "heartbeat-1" }),
		);
		expect(target.heartbeatSnapshot).toEqual([]);
	});

	it("resumes an imported recurring cron through the bound worker and delivers its next run", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-01T12:00:00.000Z"));
		const { daemon, supervisor, client, imported, source, state, promptUntilAccepted, request, persisted } =
			createCronResumeHarness();
		expect(imported.id).not.toBe(source.id);
		expect(persisted()).toMatchObject({ status: "paused", activeSessionId: state.activeSessionId });
		expect(persisted()?.nextRunAt).toBeUndefined();
		expect(await daemon.cronScheduler.runDue()).toBe(0);
		const wake = vi.spyOn(daemon.cronScheduler, "wake");
		daemon.cronScheduler.start();
		try {
			const response = await supervisor.handleCommand(client, {
				id: "resume-imported",
				type: "cron_resume",
				jobId: imported.id,
			});
			expect(response).toMatchObject({
				id: "resume-imported",
				success: true,
				data: { job: { id: imported.id, status: "active", nextRunAt: "2026-08-01T12:01:00.000Z" } },
			});
			expect(request.mock.calls.map(([command]) => command.type)).toEqual(["cron_list", "cron_resume"]);
			expect(wake).toHaveBeenCalledOnce();
			expect(persisted()).toMatchObject({
				status: "active",
				prompt: source.prompt,
				schedule: source.schedule,
				nextRunAt: "2026-08-01T12:01:00.000Z",
			});
			await vi.advanceTimersByTimeAsync(59_999);
			expect(promptUntilAccepted).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(promptUntilAccepted).toHaveBeenCalledOnce();
			expect(promptUntilAccepted).toHaveBeenCalledWith(
				source.prompt,
				expect.objectContaining({ source: "rpc", streamingBehavior: "followUp" }),
			);
			expect(persisted()).toMatchObject({ runCount: 1, nextRunAt: "2026-08-01T12:02:00.000Z" });
		} finally {
			daemon.cronScheduler.stop();
		}
	});

	it("refuses cron resume without a bound destination and does not create a runtime", async () => {
		const { daemon, supervisor, client, imported, state, promptUntilAccepted, persisted } = createCronResumeHarness();
		daemon.sessions.delete(state.activeSessionId);
		const createRuntime = vi.spyOn(daemon, "createRuntime");
		const wake = vi.spyOn(daemon.cronScheduler, "wake");
		await expect(supervisor.handleCommand(client, { type: "cron_resume", jobId: imported.id })).rejects.toThrow(
			"Cron resume requires an already bound destination runtime",
		);
		expect(createRuntime).not.toHaveBeenCalled();
		expect(wake).not.toHaveBeenCalled();
		expect(daemon.sessions.size).toBe(0);
		expect(persisted()?.status).toBe("paused");
		expect(persisted()?.nextRunAt).toBeUndefined();
		expect(await daemon.cronScheduler.runDue()).toBe(0);
		expect(promptUntilAccepted).not.toHaveBeenCalled();
	});
});
