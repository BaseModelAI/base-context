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
} from "../src/modes/daemon/daemon-protocol.js";
import { attachJsonlLineReader, serializeJsonLine } from "../src/modes/rpc/jsonl.js";

describe("initial daemon attach ownership", () => {
	it.each([false, true])("settles the initial attach when the socket is cut: %s", async (cutAttach) => {
		const directory = mkdtempSync(join(tmpdir(), "third-attach-"));
		const socketPath = join(directory, "daemon.sock");
		const sockets = new Set<Socket>();
		const commands: string[] = [];
		const server = createServer((socket) => {
			sockets.add(socket);
			socket.on("close", () => sockets.delete(socket));
			socket.on("error", () => undefined);
			socket.write(
				serializeJsonLine({
					type: "daemon_hello",
					protocol: DAEMON_PROTOCOL_INFO,
					schemaRevision: DAEMON_SCHEMA_REVISION,
					serverCapabilities: DAEMON_DEFAULT_SERVER_CAPABILITIES,
				}),
			);
			attachJsonlLineReader(socket, (line) => {
				const wire = JSON.parse(line) as DaemonCommandEnvelope | DaemonCommand;
				const command = wire.type === "command" ? wire.command : wire;
				commands.push(command.type);
				if (command.type === "ack_result") return;
				if (cutAttach && command.type === "attach") {
					socket.destroy();
					return;
				}
				socket.write(
					serializeJsonLine({
						type: "response",
						id: wire.id,
						command: command.type,
						success: true,
						data:
							command.type === "attach"
								? { id: "active-1", activeSessionId: "active-1", sessionId: "session-1" }
								: undefined,
					}),
				);
			});
		});
		const client = new DaemonClient(socketPath);
		const recoverDaemon = vi.fn(async () => undefined);
		let connection: DaemonAgentConnection | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let attach: Promise<{ status: string; error?: unknown }> | undefined;
		try {
			await new Promise<void>((resolve) => server.listen(socketPath, resolve));
			await client.connect();
			await client.waitForHello();
			attach = DaemonAgentConnection.attach(client, "active-1", {
				recoverDaemon,
				directTransport: false,
				closeClientOnDispose: true,
			}).then(
				(result) => {
					connection = result;
					return { status: "attached" };
				},
				(error: unknown) => ({ status: "rejected", error }),
			);
			const outcome = await Promise.race([
				attach,
				new Promise<{ status: string }>((resolve) => {
					timer = setTimeout(() => resolve({ status: "pending" }), 500);
				}),
			]);
			expect(outcome.status).toBe(cutAttach ? "rejected" : "attached");
			if (cutAttach) {
				expect(outcome).toMatchObject({
					error: expect.objectContaining({ message: expect.stringContaining("closed") }),
				});
				expect(client.isConnected).toBe(false);
			}
			expect(recoverDaemon).not.toHaveBeenCalled();
			expect(commands.filter((type) => type === "attach")).toHaveLength(1);
		} finally {
			if (timer) clearTimeout(timer);
			await connection?.dispose();
			client.close();
			await attach;
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
