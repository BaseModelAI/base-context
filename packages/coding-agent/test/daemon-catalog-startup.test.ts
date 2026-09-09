import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";

type CatalogFixtureSend = (
	request: { id: string; command: string; operations?: string[] },
	callback?: (error: Error | null) => void,
) => boolean;

const spawnState = vi.hoisted(() => ({
	args: [] as string[],
	child: undefined as
		| (EventEmitter & {
				connected: boolean;
				send: Mock<CatalogFixtureSend>;
				disconnect: Mock<() => void>;
		  })
		| undefined,
}));

vi.mock("node:child_process", () => ({
	spawn(_command: string, args: string[], _options: SpawnOptions): ChildProcess {
		spawnState.args = args;
		const child = Object.assign(new EventEmitter(), {
			connected: true,
			disconnect: vi.fn<() => void>(),
			kill: vi.fn(),
			send: vi.fn<CatalogFixtureSend>(() => true),
		});
		spawnState.child = child;
		return child as unknown as ChildProcess;
	},
}));

import { DaemonCatalogClient, isDaemonCatalogSourcePath } from "../src/modes/daemon/daemon-catalog-process.js";

afterEach(() => {
	vi.useRealTimers();
	spawnState.args = [];
	spawnState.child = undefined;
});

describe("daemon catalog startup", () => {
	it("does not mistake an ancestor src directory for the package source tree", () => {
		const packageDir = "/usr/src/app/packages/coding-agent";

		expect(isDaemonCatalogSourcePath(`${packageDir}/dist/modes/daemon/daemon-catalog-process.js`, packageDir)).toBe(
			false,
		);
		expect(isDaemonCatalogSourcePath(`${packageDir}/src/modes/daemon/daemon-catalog-process.ts`, packageDir)).toBe(
			true,
		);
	});

	it("uses the dedicated entrypoint and allows a cold start past five seconds", async () => {
		vi.useFakeTimers();
		const client = new DaemonCatalogClient(() => {});
		await expect(client.rename("unused", "x".repeat(1024 * 1024))).rejects.toThrow("JSON byte limit exceeded");
		expect(spawnState.child).toBeUndefined();
		const starting = client.start();

		expect(spawnState.args.some((arg) => /daemon-catalog-entry\.(?:js|ts)$/.test(arg))).toBe(true);
		const child = spawnState.child!;
		const operations = ["accepted"];
		const interrupted = client.markInterrupted("unused", "fixture", operations);
		operations.push("not-in-the-captured-request");
		const reads = Array.from({ length: 31 }, () => client.list());
		await expect(client.list()).rejects.toThrow("pending request limit exceeded (32)");
		expect(child.send).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(6000);
		spawnState.child?.emit("message", { type: "ready" });
		await expect(starting).resolves.toBeUndefined();
		await vi.advanceTimersByTimeAsync(0);
		expect(child.send).toHaveBeenCalledTimes(32);
		expect(child.send.mock.calls[0][0]).toMatchObject({ command: "mark_interrupted", operations: ["accepted"] });
		await expect(client.list()).rejects.toThrow("pending request limit exceeded (32)");
		for (const [request] of child.send.mock.calls) {
			child.emit("message", { type: "response", id: request.id, success: true, data: { sessions: [] } });
		}
		await interrupted;
		await Promise.all(reads);

		// Each request fits alone; their combined UTF-8 payload does not. Counts are not reset.
		const name = "é".repeat(262144);
		const large = client.rename("unused", name);
		await expect(client.rename("unused", name)).rejects.toThrow("JSON byte limit exceeded");
		await vi.advanceTimersByTimeAsync(0);
		expect(child.send).toHaveBeenCalledTimes(33);
		child.emit("message", { type: "response", id: child.send.mock.calls[32][0].id, success: true });
		await large;

		const stopping = client.stop();
		await vi.advanceTimersByTimeAsync(0);
		expect(child.send).toHaveBeenCalledTimes(34);
		const shutdown = child.send.mock.calls[33][0];
		expect(shutdown.command).toBe("shutdown");
		child.emit("message", { type: "response", id: shutdown.id, success: true });
		await stopping;
		expect(child.disconnect).toHaveBeenCalledOnce();
	});

	it("rejects immediately when the catalog exits during startup", async () => {
		vi.useFakeTimers();
		const client = new DaemonCatalogClient(() => {});
		const starting = client.start();

		spawnState.child?.emit("exit", 1, null);
		await expect(starting).rejects.toThrow(/exited during startup/);
	});
});
