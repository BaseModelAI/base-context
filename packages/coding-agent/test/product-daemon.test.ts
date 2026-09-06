import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ensureInteractiveDaemonRunning } from "../src/cli/daemon-launch.js";
import { probeDaemon } from "../src/cli/daemon-ps.js";
import { DaemonClient, DaemonProtocolMismatchError } from "../src/modes/daemon/daemon-client.js";
import {
	createDaemonCommandEnvelope,
	DAEMON_PROTOCOL_INFO,
	isDaemonCommandEnvelope,
} from "../src/modes/daemon/daemon-protocol.js";
import { defaultDaemonSocketPath } from "../src/modes/daemon/daemon-socket.js";

let root: string | undefined;
afterEach(() => {
	vi.unstubAllEnvs();
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

test("separates default daemon sockets by product home and accepts its own command plane", () => {
	root = mkdtempSync(join(tmpdir(), "base-context-daemon-"));
	vi.stubEnv("BASE_CONTEXT_HOME", join(root, "first"));
	const first = defaultDaemonSocketPath();
	vi.stubEnv("BASE_CONTEXT_HOME", join(root, "second"));
	expect(defaultDaemonSocketPath()).not.toBe(first);
	expect(first).toMatch(/(?:base-context|bc)-/);
	expect(isDaemonCommandEnvelope(createDaemonCommandEnvelope({ type: "list" }, "one"))).toBe(true);
	expect(DAEMON_PROTOCOL_INFO.name).toBe("base-context.daemon");
});

test("rejects an upstream hello without sending a command or changing its daemon", async () => {
	root = mkdtempSync(join(tmpdir(), "base-context-daemon-"));
	vi.stubEnv("BASE_CONTEXT_HOME", root);
	const path =
		process.platform === "win32" ? `\\\\.\\pipe\\base-context-test-${process.pid}` : join(root, "peer.sock");
	const received: string[] = [];
	const server = createServer((socket) => {
		socket.on("data", (data) => received.push(data.toString()));
		socket.write(
			`${JSON.stringify({ type: "daemon_hello", protocol: { name: "prime-agent.daemon", version: 7 } })}\n`,
		);
	});
	await new Promise<void>((resolve) => server.listen(path, resolve));
	const client = new DaemonClient(path);
	try {
		await client.connect();
		await expect(client.waitForHello()).rejects.toBeInstanceOf(DaemonProtocolMismatchError);
		await expect(ensureInteractiveDaemonRunning(path)).rejects.toBeInstanceOf(DaemonProtocolMismatchError);
		await expect(probeDaemon(path)).rejects.toBeInstanceOf(DaemonProtocolMismatchError);
		expect(received).toEqual([]);
		expect(server.listening).toBe(true);
		const oldEnvelope = {
			...createDaemonCommandEnvelope({ type: "list" }, "old"),
			protocol: { name: "prime-agent.daemon", version: 7 },
		};
		expect(isDaemonCommandEnvelope(oldEnvelope)).toBe(false);
	} finally {
		client.close();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
