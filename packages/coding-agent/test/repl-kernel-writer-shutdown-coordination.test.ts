import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createDeferred, type KernelExecutionHandle, ReplKernelManager } from "../src/core/kernel/index.js";

type KernelInternals = {
	state: string;
	child: ChildProcess;
	wireChild: (child: ChildProcess) => void;
	writeLine: (request: Record<string, unknown>) => Promise<void>;
	inFlightHostRequests: Set<Promise<void>>;
};

describe("failed kernel writer retirement", () => {
	it.each([false, true])("preserves concurrent shutdown ownership: %s", async (shuttingDown) => {
		const manager = new ReplKernelManager({ cwd: process.cwd() });
		const internals = manager as unknown as KernelInternals;
		const child = Object.assign(new EventEmitter(), {
			exitCode: null,
			signalCode: null,
			pid: undefined,
			stdin: new PassThrough(),
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			kill: vi.fn(() => true),
		}) as unknown as ChildProcess;
		const write = createDeferred<void>();
		const writing = createDeferred<void>();
		const drain = createDeferred<void>();
		Object.assign(internals, {
			state: "running",
			child,
			writeLine: (request: Record<string, unknown>) => {
				if (request.type === "execute") {
					writing.resolve();
					return write.promise;
				}
				return Promise.resolve();
			},
		});
		internals.wireChild(child);
		let execution: KernelExecutionHandle | undefined;
		const result = manager.execute("possibly_sent()", {
			onExecutionStarted: (handle) => {
				execution = handle;
			},
		});
		const rejected = expect(result).rejects.toThrow("write EPIPE");
		await writing.promise;
		if (shuttingDown) internals.inFlightHostRequests.add(drain.promise);
		const shutdown = shuttingDown ? manager.shutdown({ drainHostRequests: true }) : undefined;
		try {
			write.reject(new Error("write EPIPE"));
			await rejected;
			expect(child.kill).toHaveBeenCalledWith("SIGKILL");
			let settled = false;
			void execution!.settled.then(() => {
				settled = true;
			});
			await Promise.resolve();
			expect(settled).toBe(false);
			expect(internals.state).toBe(shuttingDown ? "shutdown" : "idle");
		} finally {
			drain.resolve();
			child.emit("exit", null, "SIGKILL");
			await shutdown;
			await manager.kill();
		}
	});
});
