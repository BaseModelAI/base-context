import type * as ChildProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompletionWaitTimeoutError } from "../src/core/completion.js";
import { SessionImportFileNotFoundError } from "../src/core/session-import-errors.js";
import {
	annotateDaemonWorkerStartupError,
	deserializeDaemonError,
	serializeDaemonError,
} from "../src/modes/daemon/daemon-errors.js";
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

	it("reports the acknowledged handshake when a fake session-open request times out", async () => {
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
		const host = Object.assign(Object.create(DaemonSupervisor.prototype), {
			defaultSessionConfig: {},
			descriptorDir: "/unused",
			socketPath: "/unused/supervisor.sock",
			workers: new Map(),
			assertRecoveryAllowed: vi.fn().mockResolvedValue(undefined),
			rlmJournalScope: () => ({ sessionsDir: "/unused/sessions" }),
			persistWorker: vi.fn(),
			log: vi.fn(),
			connectWorker: vi.fn().mockResolvedValue(workerClient),
			stopWorker: vi.fn().mockResolvedValue(undefined),
		});
		const launch = Reflect.get(DaemonSupervisor.prototype, "launchWorker") as (command: object) => Promise<unknown>;
		await expect(launch.call(host, { type: "create", config: { cwd: process.cwd() } })).rejects.toBe(failure);
		expect(failure).toBeInstanceOf(DaemonWorkerProbeTimeoutError);
		expect(failure.cause).toBe(cause);
		expect(failure.message).toMatch(/create timed out Worker startup: lastStartupPhase=handshake; observedAt=\d{4}-/);
		expect(failure.message).not.toContain("lastStartupPhase=session-open");
		gate.destroy();
		child.emit("close", 1, null);
	});
});
