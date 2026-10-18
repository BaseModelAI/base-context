import type * as ChildProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompletionWaitTimeoutError } from "../src/core/completion.js";
import { SessionImportFileNotFoundError } from "../src/core/session-import-errors.js";
import { AgentRoster, type WorkerRosterEntry } from "../src/modes/daemon/agent-roster.js";
import {
	annotateDaemonWorkerStartupError,
	deserializeDaemonError,
	serializeDaemonError,
} from "../src/modes/daemon/daemon-errors.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import { DaemonWorkerProbeTimeoutError } from "../src/modes/daemon/daemon-worker-client.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof ChildProcess>()),
	spawn: mocks.spawn,
}));

afterEach(() => {
	vi.restoreAllMocks();
	mocks.spawn.mockReset();
});

describe("worker startup diagnostics", () => {
	it("preserves error identity, cause and structured classification", () => {
		const error = new CompletionWaitTimeoutError({ complete: false, elapsedMs: 20, blockers: [] });
		const cause = new Error("underlying failure");
		error.cause = cause;
		const info = serializeDaemonError(error);
		expect(annotateDaemonWorkerStartupError(error, { name: "spawn", observedAt: "2026-01-01T00:00:00.000Z" })).toBe(
			error,
		);
		expect(error).toBeInstanceOf(CompletionWaitTimeoutError);
		expect(error.cause).toBe(cause);
		expect(serializeDaemonError(error)).toEqual(info);
		expect(error.message).toContain("Completion wait timed out Worker startup: lastStartupPhase=spawn;");
		expect(error.stack).toContain("observedAt=2026-01-01T00:00:00.000Z");
	});

	it.each([true, false])("retains typed error details across transport (startup=%s)", (startup) => {
		const original = new SessionImportFileNotFoundError("/missing-session.jsonl");
		if (startup)
			annotateDaemonWorkerStartupError(original, { name: "handshake", observedAt: "2026-01-01T00:00:00.000Z" });
		const decoded = deserializeDaemonError({
			type: "response",
			command: "create",
			success: false,
			error: original.message,
			errorInfo: serializeDaemonError(original),
		});
		expect(decoded).toBeInstanceOf(SessionImportFileNotFoundError);
		expect(decoded.message).toBe(original.message);
		expect(decoded.stack).toContain(original.message);
		expect(serializeDaemonError(decoded)).toEqual(serializeDaemonError(original));
	});

	it.each([
		{ startupProgress: true, succeeds: true },
		{ startupProgress: true, succeeds: false },
		{ startupProgress: false, succeeds: false },
	])(
		"forwards observed startup progress without changing create results (startupProgress=$startupProgress, succeeds=$succeeds)",
		async ({ startupProgress, succeeds }) => {
			const observedAt = "2026-01-01T00:00:00.000Z";
			vi.spyOn(Date.prototype, "toISOString").mockReturnValue(observedAt);
			const gate = new Writable({
				write(_chunk, _encoding, callback) {
					callback();
				},
			});
			const child = Object.assign(new EventEmitter(), {
				pid: process.pid,
				stdio: [null, null, null, gate],
				unref: vi.fn(),
			});
			mocks.spawn.mockImplementation(() => {
				queueMicrotask(() => child.emit("spawn"));
				return child;
			});
			const cause = new Error("response never arrived");
			const failure = new DaemonWorkerProbeTimeoutError("create timed out", { cause });
			const workerClient = { request: vi.fn().mockRejectedValue(failure) };
			const roster = new AgentRoster((path) => path);
			let createdSummary: SessionSummary | undefined;
			const outbound: unknown[] = [];
			const client = {
				id: "creating-client",
				socket: {
					destroyed: false,
					write(line: string) {
						outbound.push(JSON.parse(line));
						return true;
					},
				},
			};
			const host = Object.assign(Object.create(DaemonSupervisor.prototype), {
				defaultSessionConfig: {},
				descriptorDir: "/unused",
				socketPath: "/unused/supervisor.sock",
				workers: new Map(),
				clients: new Set(),
				openingWorkers: new Map(),
				protocolClientIds: new WeakMap(),
				assertRecoveryAllowed: vi.fn().mockResolvedValue(undefined),
				rlmJournalScope: () => ({ sessionsDir: "/unused/sessions" }),
				persistWorker: vi.fn(),
				log: vi.fn(),
				connectWorker: vi
					.fn()
					.mockImplementation(
						async (worker: { descriptor: { rootActiveSessionId: string }; client?: typeof workerClient }) => {
							worker.client = workerClient;
							if (succeeds) {
								createdSummary = {
									id: worker.descriptor.rootActiveSessionId,
									activeSessionId: worker.descriptor.rootActiveSessionId,
									sessionId: "created-session",
									cwd: process.cwd(),
									lifecycle: "live",
									activity: "idle",
									isSessionActive: false,
									isStreaming: false,
									isCompacting: false,
									attachedClients: 0,
									messageCount: 0,
									sessionActions: { queuedCount: 0, steering: [], followUps: [] },
								};
								workerClient.request.mockResolvedValue({
									type: "response",
									command: "create",
									success: true,
									data: createdSummary,
								});
							}
							return workerClient;
						},
					),
				roster: () => roster,
				writeRosterEntry: (entry: WorkerRosterEntry) => roster.write(entry),
				subscribeWorker: vi.fn().mockResolvedValue(undefined),
				refreshWorkerSummaries: vi.fn().mockResolvedValue(undefined),
				broadcastHeartbeatsChanged: vi.fn(),
				stopWorker: vi.fn().mockResolvedValue(undefined),
			});
			const handleCommand = Reflect.get(DaemonSupervisor.prototype, "handleCommand") as (
				client: object,
				command: object,
			) => Promise<unknown>;
			const creating = handleCommand.call(host, client, {
				type: "create",
				id: "create-request",
				config: { cwd: process.cwd() },
				...(startupProgress ? { startupProgress: true } : {}),
			});
			if (succeeds) {
				const response = await creating;
				expect(response).toEqual({
					type: "response",
					command: "create",
					id: "create-request",
					success: true,
					data: { ...createdSummary, rosterStatus: "idle", workerState: "ready", workerPid: process.pid },
				});
			} else {
				await expect(creating).rejects.toBe(failure);
				expect(failure).toBeInstanceOf(DaemonWorkerProbeTimeoutError);
				expect(failure.cause).toBe(cause);
				expect(failure.message).toContain(
					`create timed out Worker startup: lastStartupPhase=handshake; observedAt=${observedAt}`,
				);
				expect(failure.message).not.toContain("lastStartupPhase=session-open");
			}
			const phases = ["admission", "spawn", "handshake", ...(succeeds ? ["session-open"] : [])];
			expect(outbound).toEqual(
				startupProgress
					? phases.map((startupPhase) => ({
							type: "session_create_progress",
							command: "create",
							id: "create-request",
							startupPhase,
							observedAt,
						}))
					: [],
			);
			expect(workerClient.request).toHaveBeenCalledWith(
				{ type: "create", config: expect.any(Object) },
				expect.any(Number),
			);
			gate.destroy();
			child.emit("close", 1, null);
		},
	);
});
