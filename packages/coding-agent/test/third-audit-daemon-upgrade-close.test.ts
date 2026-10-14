import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DaemonAgentConnection } from "../src/modes/agent-connection/daemon-agent-connection.js";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";
import {
	DAEMON_DEFAULT_SERVER_CAPABILITIES,
	DAEMON_PROTOCOL_INFO,
	DAEMON_SCHEMA_REVISION,
	type DaemonCommand,
	type DaemonCommandEnvelope,
	type DaemonPeerTransportTicket,
} from "../src/modes/daemon/daemon-protocol.js";
import { getDaemonSocketIdentity } from "../src/modes/daemon/daemon-socket.js";
import { isDaemonWorkerFrameHeader } from "../src/modes/daemon/daemon-worker-protocol.js";
import { attachJsonlLineReader, serializeJsonLine } from "../src/modes/rpc/jsonl.js";
import { PrivateFramedChannel } from "../src/modes/session-worker/private-framing.js";

const hello = {
	type: "daemon_hello",
	protocol: DAEMON_PROTOCOL_INFO,
	schemaRevision: DAEMON_SCHEMA_REVISION,
	serverCapabilities: [...DAEMON_DEFAULT_SERVER_CAPABILITIES, "direct_peer_transport"],
};

describe("daemon direct upgrade close handoff", () => {
	it.each([false, true])(
		"keeps control-plane recovery when loss occurs during peer authentication: %s",
		async (cutSupervisor) => {
			const directory = mkdtempSync(join(tmpdir(), "third-upgrade-"));
			const supervisorPath = join(directory, "daemon.sock");
			const workerPath = join(directory, "worker.sock");
			const client = new DaemonClient(supervisorPath);
			const sockets = new Set<Socket>();
			let supervisorSocket: Socket | undefined;
			let connection: DaemonAgentConnection | undefined;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const directCommands: string[] = [];
			let finishRecovery!: () => void;
			const recovered = new Promise<void>((resolve) => {
				finishRecovery = resolve;
			});
			const recoverDaemon = vi.fn(async () => {
				finishRecovery();
			});
			const track = (socket: Socket) => {
				sockets.add(socket);
				socket.on("close", () => sockets.delete(socket));
				socket.on("error", () => undefined);
			};
			const worker = createServer((socket) => {
				track(socket);
				const channel = new PrivateFramedChannel(socket, isDaemonWorkerFrameHeader);
				void channel.send(
					{ kind: "outbound", outboundType: "daemon_hello", payloadEncoding: "jsonl" },
					Buffer.from(serializeJsonLine(hello)),
				);
				channel.onFrame((frame) => {
					if (frame.header.kind !== "command") return;
					const command = JSON.parse(frame.payload.toString("utf8")) as { id: string; type: string };
					directCommands.push(command.type);
					const reply = () =>
						channel.send(
							{ kind: "outbound", outboundType: "response", requestId: command.id, payloadEncoding: "jsonl" },
							Buffer.from(
								serializeJsonLine({
									type: "response",
									id: command.id,
									command: command.type,
									success: true,
									data:
										command.type === "attach"
											? { id: "active-1", activeSessionId: "active-1", sessionId: "session-1" }
											: undefined,
								}),
							),
						);
					if (cutSupervisor && command.type === "peer_auth") {
						const unsubscribe = client.onClose(() => {
							unsubscribe();
							void reply();
						});
						supervisorSocket?.destroy();
					} else void reply();
				});
			});
			const supervisor = createServer((socket) => {
				track(socket);
				supervisorSocket = socket;
				socket.write(serializeJsonLine(hello));
				attachJsonlLineReader(socket, (line) => {
					const wire = JSON.parse(line) as DaemonCommandEnvelope | DaemonCommand;
					const command = wire.type === "command" ? wire.command : wire;
					if (command.type === "ack_result") return;
					const ticket: DaemonPeerTransportTicket = {
						purpose: "session_client",
						socketPath: workerPath,
						socketIdentity: getDaemonSocketIdentity(workerPath)!,
						workerInstanceId: "worker-1",
						activeSessionId: "active-1",
						grantId: "grant-1",
						token: "test-token",
						expiresAt: new Date(Date.now() + 10_000).toISOString(),
					};
					socket.write(
						serializeJsonLine({
							type: "response",
							id: wire.id,
							command: command.type,
							success: true,
							data: command.type === "get_direct_worker_transport" ? ticket : undefined,
						}),
					);
				});
			});
			try {
				await new Promise<void>((resolve) => worker.listen(workerPath, resolve));
				await new Promise<void>((resolve) => supervisor.listen(supervisorPath, resolve));
				await client.connect();
				await client.waitForHello();
				connection = await DaemonAgentConnection.attach(client, "active-1", {
					recoverDaemon,
					closeClientOnDispose: true,
				});
				expect(directCommands).toEqual(["peer_auth", "attach"]);
				if (cutSupervisor) {
					const outcome = await Promise.race([
						recovered.then(() => "recovering"),
						new Promise<string>((resolve) => {
							timer = setTimeout(() => resolve("pending"), 500);
						}),
					]);
					expect(outcome).toBe("recovering");
					await client.waitForHello();
				} else expect(recoverDaemon).not.toHaveBeenCalled();
				expect(client.isConnected).toBe(true);
			} finally {
				if (timer) clearTimeout(timer);
				await connection?.dispose();
				client.close();
				for (const socket of sockets) socket.destroy();
				await Promise.all(
					[worker, supervisor].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
				);
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);
});
