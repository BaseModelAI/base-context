import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { DaemonAgentConnection } from "../src/modes/agent-connection/daemon-agent-connection.js";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import {
	DAEMON_DEFAULT_SERVER_CAPABILITIES,
	DAEMON_PROTOCOL_INFO,
	DAEMON_SCHEMA_REVISION,
	type DaemonResponse,
} from "../src/modes/daemon/daemon-protocol.js";
import { DaemonRoutedClient } from "../src/modes/daemon/daemon-routed-client.js";
import { DaemonWorkerClient } from "../src/modes/daemon/daemon-worker-client.js";

const handleLine = Reflect.get(AgentDaemon.prototype, "handleLine") as (
	this: object,
	client: object,
	line: string,
) => Promise<void>;
const handleWorker = Reflect.get(AgentDaemon.prototype, "handleWorkerCommand") as (
	this: object,
	client: object,
	command: object,
) => Promise<void>;

function fixture() {
	const socket = Object.assign(new EventEmitter(), { destroyed: false, end: vi.fn() });
	const client = {
		socket,
		authenticated: true,
		authenticationRole: "supervisor",
		completionWaitControllers: new Map<string, AbortController>(),
	};
	const claim = { claim: {}, ownerFingerprint: "owner" };
	const host = Object.assign(Object.create(AgentDaemon.prototype), {
		options: { worker: {} },
		supervisorClaims: new Map([[client, claim]]),
		peerClaims: new Map(),
		parseCommandAndRegisterPromptAdmission: (_client: object, line: string) => JSON.parse(line) as unknown,
		assertSupervisorClaimCurrent: vi.fn(async () => "owner"),
		write: vi.fn(),
		mutationDrain: { begin: vi.fn(), end: vi.fn() },
		handleCommand: vi.fn(),
	}) as {
		assertSupervisorClaimCurrent: ReturnType<typeof vi.fn>;
		write: ReturnType<typeof vi.fn>;
		handleCommand: ReturnType<typeof vi.fn>;
	};
	return { host, client };
}

describe("worker completion observation", () => {
	it("drops the worker response timer without closing the shared transport", async () => {
		vi.useFakeTimers();
		try {
			const client = new DaemonWorkerClient("/unused");
			const channel = { send: vi.fn(() => new Promise<void>(() => {})), close: vi.fn() };
			const socket = { destroyed: false, destroy: vi.fn() };
			Reflect.set(client, "channel", channel);
			Reflect.set(client, "socket", socket);
			const request = Reflect.get(client, "requestWire") as (
				command: object,
				timeoutMs: number,
				signal: AbortSignal,
			) => Promise<DaemonResponse>;
			const controller = new AbortController();
			const pending = request.call(
				client,
				{ type: "wait_for_headless_completion", activeSessionId: "session" },
				86_400_000,
				controller.signal,
			);
			const cause = new Error("Observation disconnected");
			const rejection = expect(pending).rejects.toBe(cause);
			controller.abort(cause);
			await rejection;
			expect((Reflect.get(client, "pending") as Map<string, unknown>).size).toBe(0);
			expect(vi.getTimerCount()).toBe(0);
			expect(channel.close).not.toHaveBeenCalled();
			expect(socket.destroy).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("registers before the fence wait so a later cancel cannot overtake admission", async () => {
		const { host, client } = fixture();
		let release = () => {};
		host.assertSupervisorClaimCurrent.mockImplementationOnce(
			() =>
				new Promise<string>((resolve) => {
					release = () => resolve("owner");
				}),
		);
		const pending = handleLine.call(
			host,
			client,
			JSON.stringify({ type: "wait_for_headless_completion", activeSessionId: "session", waitId: "wait-1" }),
		);
		expect(client.completionWaitControllers.has("wait-1")).toBe(true);
		await handleLine.call(host, client, JSON.stringify({ type: "worker_cancel_completion_wait", waitId: "wait-1" }));
		await pending;
		expect(host.handleCommand).not.toHaveBeenCalled();
		expect(client.completionWaitControllers.size).toBe(0);
		expect(client.socket.listenerCount("close")).toBe(0);
		release();
	});
	it.each(["wait-1", undefined])("bounds worker admission with optional waitId=%s", async (waitId) => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		try {
			const { host, client } = fixture();
			let release = () => {};
			host.assertSupervisorClaimCurrent.mockImplementationOnce(
				() =>
					new Promise<string>((resolve) => {
						release = () => resolve("owner");
					}),
			);
			const pending = handleLine.call(
				host,
				client,
				JSON.stringify({
					id: "bounded",
					type: "wait_for_headless_completion",
					activeSessionId: "session",
					waitId,
					timeoutMs: 20,
				}),
			);
			await vi.advanceTimersByTimeAsync(20);
			expect(host.write).toHaveBeenCalledWith(
				client,
				expect.objectContaining({
					id: "bounded",
					success: false,
					errorInfo: {
						code: "completion_wait_timeout",
						complete: false,
						elapsedMs: 20,
						blockers: [{ kind: "worker_admission", id: "session" }],
					},
				}),
			);
			await pending;
			expect(host.handleCommand).not.toHaveBeenCalled();
			expect(client.socket.end).not.toHaveBeenCalled();
			expect(client.completionWaitControllers.size).toBe(0);
			expect(client.socket.listenerCount("close")).toBe(0);
			expect(vi.getTimerCount()).toBe(0);
			release();
		} finally {
			vi.useRealTimers();
		}
	});

	it("disconnects an untimed ownership-fence observer without an optional waitId", async () => {
		const { host, client } = fixture();
		let release = () => {};
		host.assertSupervisorClaimCurrent.mockImplementationOnce(
			() =>
				new Promise<string>((resolve) => {
					release = () => resolve("owner");
				}),
		);
		const settled = vi.fn();
		const pending = handleLine
			.call(host, client, JSON.stringify({ type: "wait_for_headless_completion", activeSessionId: "session" }))
			.then(settled);
		try {
			client.socket.destroyed = true;
			client.socket.emit("close");
			await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce(), { timeout: 100 });
			expect(host.handleCommand).not.toHaveBeenCalled();
			expect(client.socket.listenerCount("close")).toBe(0);
			expect(client.completionWaitControllers.size).toBe(0);
		} finally {
			release();
			await pending;
		}
	});

	it("does not cancel another supervisor client's observation", async () => {
		const { host, client } = fixture();
		const controller = new AbortController();
		client.completionWaitControllers.set("wait-1", controller);
		const outsider = { ...client, completionWaitControllers: new Map() };
		await handleWorker.call(host, outsider, { type: "worker_cancel_completion_wait", waitId: "wait-1" });
		expect(controller.signal.aborted).toBe(false);
		expect(host.write).toHaveBeenCalledWith(outsider, expect.objectContaining({ success: false }));
	});
});

function publicConnection() {
	const supervisor = new DaemonClient("/unused");
	const socket = Object.assign(new EventEmitter(), {
		destroyed: false,
		write: vi.fn(),
		destroy: vi.fn(),
		end: vi.fn(),
	});
	Reflect.set(supervisor, "socket", socket);
	Reflect.set(supervisor, "helloMessage", {
		type: "daemon_hello",
		protocol: DAEMON_PROTOCOL_INFO,
		schemaRevision: DAEMON_SCHEMA_REVISION,
		serverCapabilities: DAEMON_DEFAULT_SERVER_CAPABILITIES,
	});
	const direct = new DaemonWorkerClient("/unused-worker");
	const routed = new DaemonRoutedClient(supervisor, direct);
	const connection = Object.assign(Object.create(DaemonAgentConnection.prototype), {
		client: routed,
		activeSessionId: "session",
		definitiveRequestErrors: new WeakSet(),
	}) as DaemonAgentConnection;
	return { supervisor, direct, socket, connection };
}

describe("public completion observation", () => {
	it.each(["response", "handshake"])("bounds a silent %s through the connection and routed client", async (phase) => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
		try {
			const { supervisor, socket, connection } = publicConnection();
			// Hold a transport handshake while retaining the connection's negotiated diagnostic support.
			if (phase === "handshake") {
				vi.spyOn(supervisor, "supportsServerCapability").mockReturnValue(true);
				Reflect.set(supervisor, "helloMessage", undefined);
			}
			const request = connection.waitForHeadlessCompletion({ timeoutMs: 20 });
			const rejection = expect(request).rejects.toMatchObject({
				diagnostics: {
					complete: false,
					elapsedMs: 1020,
					blockers: [{ kind: "supervisor_response", id: "session" }],
				},
			});
			await vi.advanceTimersByTimeAsync(1020);
			await rejection;
			expect((Reflect.get(supervisor, "pendingRequests") as Map<string, unknown>).size).toBe(0);
			expect((Reflect.get(supervisor, "helloWaiters") as Set<unknown>).size).toBe(0);
			expect(vi.getTimerCount()).toBe(0);
			expect(socket.destroy).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("deducts handshake time before forwarding the completion budget", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
		try {
			const { supervisor, socket, connection } = publicConnection();
			const hello = supervisor.hello!;
			vi.spyOn(supervisor, "supportsServerCapability").mockReturnValue(true);
			Reflect.set(supervisor, "helloMessage", undefined);
			const pending = connection.waitForHeadlessCompletion({ timeoutMs: 20 });
			await vi.advanceTimersByTimeAsync(10);
			const handleLine = Reflect.get(supervisor, "handleLine") as (line: string) => void;
			handleLine.call(supervisor, JSON.stringify(hello));
			await vi.advanceTimersByTimeAsync(0);
			const envelope = JSON.parse(socket.write.mock.calls[0]![0] as string) as { command: { timeoutMs: number } };
			expect(envelope.command.timeoutMs).toBe(10);
			const rejection = expect(pending).rejects.toMatchObject({
				diagnostics: { complete: false, elapsedMs: 20, blockers: [{ kind: "descendants", id: "child" }] },
			});
			await vi.advanceTimersByTimeAsync(10);
			handleLine.call(
				supervisor,
				JSON.stringify({
					type: "response",
					id: "daemon_1",
					command: "wait_for_headless_completion",
					success: false,
					error: "Completion wait timed out",
					errorInfo: {
						code: "completion_wait_timeout",
						complete: false,
						elapsedMs: 10,
						blockers: [{ kind: "descendants", id: "child" }],
					},
				}),
			);
			await rejection;
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each(["supervisor", "direct"] as const)(
		"includes %s response delivery in observed elapsed time",
		async (route) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
			try {
				const { supervisor, direct, connection } = publicConnection();
				if (route === "direct") {
					Reflect.set(direct, "helloMessage", supervisor.hello);
					Reflect.set(direct, "socket", { destroyed: false });
					Reflect.set(direct, "channel", { send: vi.fn().mockResolvedValue(undefined) });
				}
				const pending = connection.waitForHeadlessCompletion({ timeoutMs: 20 });
				const rejection = expect(pending).rejects.toMatchObject({
					diagnostics: { complete: false, elapsedMs: 80, blockers: [{ kind: "descendants", id: "child" }] },
				});
				await vi.advanceTimersByTimeAsync(80);
				const response = {
					type: "response",
					id: route === "direct" ? "worker_1" : "daemon_1",
					command: "wait_for_headless_completion",
					success: false,
					error: "Completion wait timed out",
					errorInfo: {
						code: "completion_wait_timeout",
						complete: false,
						elapsedMs: 20,
						blockers: [{ kind: "descendants", id: "child" }],
					},
				};
				if (route === "direct") {
					const handleFrame = Reflect.get(direct, "handleFrame") as (frame: object) => void;
					handleFrame.call(direct, {
						header: { kind: "outbound", outboundType: "response", requestId: response.id },
						payload: Buffer.from(JSON.stringify(response)),
					});
				} else {
					const handleLine = Reflect.get(supervisor, "handleLine") as (line: string) => void;
					handleLine.call(supervisor, JSON.stringify(response));
				}
				await rejection;
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				vi.useRealTimers();
			}
		},
	);

	it.each([true, false])("preserves server completion responses (success=%s)", async (success) => {
		const { supervisor, connection } = publicConnection();
		const response = success
			? {
					type: "response",
					id: "daemon_1",
					command: "wait_for_headless_completion",
					success: true,
					data: { enabled: false },
				}
			: {
					type: "response",
					id: "daemon_1",
					command: "wait_for_headless_completion",
					success: false,
					error: "Completion wait timed out",
					errorInfo: {
						code: "completion_wait_timeout",
						complete: false,
						elapsedMs: 20,
						blockers: [{ kind: "descendants", id: "child" }],
					},
				};
		const pending = connection.waitForHeadlessCompletion({ timeoutMs: 20 });
		const result = success
			? expect(pending).resolves.toEqual(response.data)
			: expect(pending).rejects.toMatchObject({ diagnostics: { blockers: [{ kind: "descendants", id: "child" }] } });
		const handleLine = Reflect.get(supervisor, "handleLine") as (line: string) => void;
		handleLine.call(supervisor, JSON.stringify(response));
		await result;
		expect((Reflect.get(supervisor, "pendingRequests") as Map<string, unknown>).size).toBe(0);
	});

	it("drops an untimed observer on disconnect rather than replaying it", async () => {
		vi.useFakeTimers();
		try {
			const { supervisor, socket, connection } = publicConnection();
			supervisor.enableRequestRecovery();
			const pending = connection.waitForHeadlessCompletion();
			const rejection = expect(pending).rejects.toThrow("disconnected");
			const notifyClosed = Reflect.get(supervisor, "notifyClosed") as (socket: object, error: Error) => void;
			notifyClosed.call(supervisor, socket, new Error("disconnected"));
			await rejection;
			expect((Reflect.get(supervisor, "pendingRequests") as Map<string, unknown>).size).toBe(0);
			expect(vi.getTimerCount()).toBe(0);
			expect(socket.destroy).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});
