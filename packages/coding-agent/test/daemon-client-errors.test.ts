import { EventEmitter } from "node:events";
import { createConnection, type Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonClient, type DaemonHello } from "../src/modes/daemon/daemon-client.js";
import {
	DAEMON_DEFAULT_SERVER_CAPABILITIES,
	DAEMON_PROTOCOL_NAME,
	DAEMON_PROTOCOL_VERSION,
	DAEMON_SCHEMA_REVISION,
} from "../src/modes/daemon/daemon-protocol.js";
import { DaemonWorkerClient, DaemonWorkerProbeTimeoutError } from "../src/modes/daemon/daemon-worker-client.js";
import { encodePrivateFrame } from "../src/modes/session-worker/private-framing.js";

vi.mock("node:net", () => ({ createConnection: vi.fn() }));

class MockSocket extends EventEmitter {
	readonly writes: Buffer[] = [];
	destroyed = false;

	write(chunk: string | Uint8Array, callback?: (error?: Error | null) => void): boolean {
		this.writes.push(Buffer.from(chunk));
		callback?.();
		return true;
	}

	end(): this {
		return this;
	}
	destroy(): this {
		this.destroyed = true;
		return this;
	}
}

const sockets: MockSocket[] = [];
const clients: Array<DaemonClient | DaemonWorkerClient> = [];

async function connect(
	client: DaemonClient | DaemonWorkerClient,
	helloOverrides: Partial<DaemonHello> = {},
): Promise<MockSocket> {
	const connected = client.connect();
	const socket = sockets.at(-1)!;
	socket.emit("connect");
	await connected;
	const hello: DaemonHello = {
		type: "daemon_hello",
		socketPath: "/tmp/e5-test.sock",
		protocol: { name: DAEMON_PROTOCOL_NAME, version: DAEMON_PROTOCOL_VERSION },
		schemaRevision: DAEMON_SCHEMA_REVISION,
		clientId: "test-client",
		serverCapabilities: DAEMON_DEFAULT_SERVER_CAPABILITIES,
		...helloOverrides,
	};
	const payload = Buffer.from(`${JSON.stringify(hello)}\n`);
	socket.emit(
		"data",
		client instanceof DaemonWorkerClient
			? encodePrivateFrame({ kind: "outbound", outboundType: "daemon_hello" }, payload)
			: payload,
	);
	return socket;
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof Error) return error;
		throw error;
	}
	throw new Error("Expected request rejection");
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(1000);
	sockets.length = 0;
	vi.mocked(createConnection).mockImplementation(() => {
		const socket = new MockSocket();
		sockets.push(socket);
		return socket as unknown as Socket;
	});
});

afterEach(() => {
	for (const client of clients.splice(0)) client.close();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("daemon request errors", () => {
	it("reports the latest observed create milestone without extending the timeout", async () => {
		const client = new DaemonClient("/tmp/e5-daemon.sock");
		clients.push(client);
		const socket = await connect(client);
		const onProgress = vi.fn();
		const pending = rejection(client.request({ type: "create" }, 40, { onProgress }));
		await vi.advanceTimersByTimeAsync(0);
		const wire = JSON.parse(socket.writes[0].toString());
		expect(wire.command.startupProgress).toBe(true);
		for (const startupPhase of ["spawn", "handshake"]) {
			socket.emit(
				"data",
				`${JSON.stringify({
					type: "session_create_progress",
					command: "create",
					id: wire.id,
					startupPhase,
					observedAt: "2026-10-18T12:00:00.000Z",
				})}\n`,
			);
		}
		expect(onProgress).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(40);
		const error = await pending;
		expect(error.message).toContain("elapsedMs: 40");
		expect(error.message).toContain("lastStartupPhase: handshake");
		expect(error.message).toContain("startupPhaseObservedAt: 2026-10-18T12:00:00.000Z");
		expect(socket.writes).toHaveLength(1);
	});

	it.each([
		{ schemaRevision: 52 },
		{
			serverCapabilities: DAEMON_DEFAULT_SERVER_CAPABILITIES.filter(
				(capability) => capability !== "session_create_progress",
			),
		},
	])("creates normally without optional progress on an older daemon: %j", async (helloOverrides) => {
		const client = new DaemonClient("/tmp/e5-old-daemon.sock");
		clients.push(client);
		const socket = await connect(client, helloOverrides);
		const pending = client.request({ type: "create" }, 40);
		await vi.advanceTimersByTimeAsync(0);
		const wire = JSON.parse(socket.writes[0].toString());
		expect(wire.command).not.toHaveProperty("startupProgress");
		socket.emit(
			"data",
			`${JSON.stringify({ type: "response", command: "create", id: wire.id, success: true, data: { activeSessionId: "created" } })}\n`,
		);
		await expect(pending).resolves.toMatchObject({ success: true, data: { activeSessionId: "created" } });
	});

	it.each([
		{ type: "continuation_status", activeSessionId: "session" },
		{ type: "block_continuation", activeSessionId: "session", reason: "input missing" },
		{ type: "resume_continuation", activeSessionId: "session" },
		{ type: "set_autonomous_gates", activeSessionId: "session", commands: ["CaseSensitiveGate"] },
	] as const)("gates $type before sending to an older daemon", async (command) => {
		const request =
			command.type === "set_autonomous_gates" ? { ...command, commands: [...command.commands] } : command;
		for (const helloOverrides of [
			{ schemaRevision: 52 },
			{
				serverCapabilities: DAEMON_DEFAULT_SERVER_CAPABILITIES.filter(
					(capability) => capability !== "continuation_control",
				),
			},
		]) {
			const client = new DaemonClient("/tmp/e5-old-daemon.sock");
			clients.push(client);
			const socket = await connect(client, helloOverrides);
			await expect(client.request(request)).rejects.toMatchObject({ capability: "continuation_control" });
			expect(socket.writes).toHaveLength(0);
		}
		const client = new DaemonClient("/tmp/e5-new-daemon.sock");
		clients.push(client);
		const socket = await connect(client);
		const pending = client.request(request);
		await vi.advanceTimersByTimeAsync(0);
		const wire = JSON.parse(socket.writes[0].toString());
		expect(wire.command).toMatchObject(request);
		socket.emit(
			"data",
			`${JSON.stringify({ type: "response", command: command.type, id: wire.id, success: true })}\n`,
		);
		await expect(pending).resolves.toMatchObject({ success: true });
	});
	it.each(["explicit", "socket"] as const)(
		"preserves the first %s worker close cause for pending requests",
		async (source) => {
			const client = new DaemonWorkerClient("/tmp/e5-worker.sock");
			clients.push(client);
			const socket = await connect(client);
			const pending = rejection(client.request({ type: "create" }));
			await vi.advanceTimersByTimeAsync(0);
			expect(socket.writes).toHaveLength(1);
			const cause = new Error("snapshot-cache failed: ENOSPC");
			if (source === "explicit") client.close(cause);
			else socket.emit("error", cause);
			client.close(new Error("later cleanup error"));
			socket.emit("close");
			expect(await pending).toBe(cause);
			await expect(client.waitForHello()).rejects.toBe(cause);
			await expect(client.request({ type: "create" })).rejects.toBe(cause);
		},
	);

	it("keeps the generic fallback for a deliberate worker close without a cause", async () => {
		const client = new DaemonWorkerClient("/tmp/e5-worker.sock");
		clients.push(client);
		await connect(client);
		const pending = rejection(client.request({ type: "create" }));
		await vi.advanceTimersByTimeAsync(0);
		client.close();
		expect((await pending).message).toBe("Daemon worker client closed");
	});

	it("includes worker request identity, endpoint and actual elapsed time on a delayed timeout", async () => {
		const client = new DaemonWorkerClient("/tmp/e5-worker.sock");
		clients.push(client);
		await connect(client);
		const pending = rejection(client.request({ type: "create" }, 40));
		await vi.advanceTimersByTimeAsync(0);
		vi.setSystemTime(1250);
		await vi.advanceTimersByTimeAsync(40);
		const error = await pending;
		expect(error).toBeInstanceOf(DaemonWorkerProbeTimeoutError);
		expect(error.message).toContain("response to create");
		expect(error.message).toContain("Request ID: worker_1; elapsedMs: 290");
		expect(error.message).toContain("lastStartupPhase: unknown");
		expect(error.message).toContain("Socket: /tmp/e5-worker.sock");
	});

	it("drops only optional progress when an existing create reconnects to a pre-progress daemon", async () => {
		const client = new DaemonClient("/tmp/e5-daemon.sock");
		clients.push(client);
		const socket = await connect(client);
		client.enableRequestRecovery();
		const pending = rejection(client.request({ type: "create" }, 40));
		await vi.advanceTimersByTimeAsync(20);
		const original = JSON.parse(socket.writes[0].toString());
		expect(original.command.startupProgress).toBe(true);
		socket.destroy();
		socket.emit("close");
		const replacement = await connect(client, { schemaRevision: 52 });
		const replay = JSON.parse(replacement.writes[0].toString());
		const { startupProgress: _startupProgress, ...command } = original.command;
		expect(replay).toEqual({ ...original, command });
		await vi.advanceTimersByTimeAsync(40);
		expect((await pending).message).toContain("elapsedMs: 60");
		expect(replacement.writes).toHaveLength(1);
	});

	it("reports total elapsed daemon request time across an existing reconnect timeout re-arm", async () => {
		const client = new DaemonClient("/tmp/e5-daemon.sock");
		clients.push(client);
		const socket = await connect(client);
		client.enableRequestRecovery();
		const pending = rejection(client.request({ type: "create" }, 40));
		await vi.advanceTimersByTimeAsync(20);
		socket.destroy();
		socket.emit("close");
		await vi.advanceTimersByTimeAsync(250);
		const replacement = await connect(client);
		expect(replacement.writes).toEqual(socket.writes);
		await vi.advanceTimersByTimeAsync(40);
		const error = await pending;
		expect(error.message).toContain('Timed out after 310ms waiting for the Base Context daemon response to "create"');
		expect(error.message).toContain("Request ID: daemon_1; elapsedMs: 310");
		expect(error.message).toContain("lastStartupPhase: unknown");
		expect(error.message).toContain("Socket: /tmp/e5-daemon.sock");
		expect(error.message).toContain("Daemon log:");
	});

	it.each([
		{ name: "public", create: () => new DaemonClient("/tmp/e5-large.sock") },
		{ name: "worker", create: () => new DaemonWorkerClient("/tmp/e5-large.sock") },
	])("chunks $name response timeouts above Node's timer limit", async ({ create }) => {
		const client = create();
		clients.push(client);
		await connect(client);
		const limit = 2_147_483_647;
		const pending = rejection(client.request({ type: "create" }, limit + 25));
		const settled = vi.fn();
		void pending.then(settled);
		await vi.advanceTimersByTimeAsync(limit);
		expect(settled).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(25);
		expect((await pending).message).toContain(`elapsedMs: ${limit + 25}`);
	});

	it.each([
		{ name: "public", create: () => new DaemonClient("/tmp/e5-capability.sock") },
		{ name: "worker", create: () => new DaemonWorkerClient("/tmp/e5-capability.sock") },
	])("gates optional worker status interest on the $name transport before sending", async ({ create }) => {
		for (const helloOverrides of [
			{ schemaRevision: 51 },
			{
				serverCapabilities: DAEMON_DEFAULT_SERVER_CAPABILITIES.filter(
					(capability) => capability !== "status_summary_interest",
				),
			},
		]) {
			const client = create();
			clients.push(client);
			const socket = await connect(client, helloOverrides);
			await expect(
				client.requestWorker({ type: "worker_set_status_summary_interest", observed: true }),
			).rejects.toMatchObject({
				capability: "status_summary_interest",
			});
			expect(socket.writes).toHaveLength(0);
			client.close();
		}

		const client = create();
		clients.push(client);
		const socket = await connect(client);
		const pending = rejection(client.requestWorker({ type: "worker_set_status_summary_interest", observed: true }));
		await vi.advanceTimersByTimeAsync(0);
		expect(socket.writes).toHaveLength(1);
		client.close();
		await pending;
	});
});
