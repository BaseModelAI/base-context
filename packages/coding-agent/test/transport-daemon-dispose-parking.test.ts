import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it, vi } from "vitest";
import { DaemonAgentConnection } from "../src/modes/agent-connection/daemon-agent-connection.js";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";
import {
	DAEMON_DEFAULT_SERVER_CAPABILITIES,
	DAEMON_PROTOCOL_INFO,
	DAEMON_SCHEMA_REVISION,
} from "../src/modes/daemon/daemon-protocol.js";

describe("daemon disposal after transport loss", () => {
	it.each(["detach", "complete_owned_session", "abort_side_question"])(
		"does not park %s behind a disabled reconnect loop",
		async (cutCommand) => {
			const directory = mkdtempSync(join(tmpdir(), "daemon-dispose-parking-"));
			const socketPath = join(directory, "daemon.sock");
			const sockets: Socket[] = [];
			const commands: string[] = [];
			const server = createServer((socket) => {
				sockets.push(socket);
				socket.write(
					`${JSON.stringify({
						type: "daemon_hello",
						protocol: DAEMON_PROTOCOL_INFO,
						schemaRevision: DAEMON_SCHEMA_REVISION,
						serverCapabilities: DAEMON_DEFAULT_SERVER_CAPABILITIES,
					})}\n`,
				);
				createInterface({ input: socket }).on("line", (line) => {
					const wire = JSON.parse(line) as { id: string; command: { type: string } };
					commands.push(wire.command.type);
					if (wire.command.type === cutCommand) {
						socket.destroy();
						return;
					}
					socket.write(
						`${JSON.stringify({
							type: "response",
							id: wire.id,
							command: wire.command.type,
							success: true,
							data: { id: "active-1", activeSessionId: "active-1", sessionId: "session-1" },
						})}\n`,
					);
				});
			});
			const client = new DaemonClient(socketPath);
			let timeout: ReturnType<typeof setTimeout> | undefined;
			try {
				await new Promise<void>((resolve) => server.listen(socketPath, resolve));
				await client.connect();
				await client.waitForHello();
				const recoverDaemon = vi.fn(async () => undefined);
				const connection = await DaemonAgentConnection.attach(client, "active-1", {
					directTransport: false,
					ownedSession: cutCommand === "complete_owned_session",
					closeClientOnDispose: true,
					recoverDaemon,
				});
				if (cutCommand === "abort_side_question") await connection.startSideQuestion("question-1", "question");
				await Promise.race([
					connection.dispose(),
					new Promise<never>((_resolve, reject) => {
						timeout = setTimeout(() => reject(new Error("Disposal request parked after disconnect")), 1000);
					}),
				]);
				expect(commands).toContain(cutCommand);
				expect(recoverDaemon).not.toHaveBeenCalled();
				expect(client.isConnected).toBe(false);
			} finally {
				clearTimeout(timeout);
				client.close();
				for (const socket of sockets) socket.destroy();
				await new Promise<void>((resolve) => server.close(() => resolve()));
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);
});
