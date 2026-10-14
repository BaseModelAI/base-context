import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DaemonAgentConnection } from "../src/modes/agent-connection/daemon-agent-connection.js";
import type { AgentConnectionEvent, AgentConnectionSessionWatcher } from "../src/modes/agent-connection/types.js";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";
import {
	DAEMON_DEFAULT_SERVER_CAPABILITIES,
	DAEMON_PROTOCOL_INFO,
	DAEMON_SCHEMA_REVISION,
	type DaemonCommand,
	type DaemonCommandEnvelope,
} from "../src/modes/daemon/daemon-protocol.js";
import { attachJsonlLineReader, serializeJsonLine } from "../src/modes/rpc/jsonl.js";

describe("daemon self-watch subscription ownership", () => {
	it.each(["close", "rebind"] as const)("keeps the primary ownership on watcher %s", async (action) => {
		const directory = mkdtempSync(join(tmpdir(), "third-self-watch-"));
		const socketPath = join(directory, "daemon.sock");
		const sockets = new Set<Socket>();
		const attached = new Set<string>();
		const commands: DaemonCommand[] = [];
		const server = createServer((socket) => {
			sockets.add(socket);
			socket.on("close", () => sockets.delete(socket));
			socket.on("error", () => undefined);
			const output = (value: object) => socket.write(serializeJsonLine(value));
			output({
				type: "daemon_hello",
				protocol: DAEMON_PROTOCOL_INFO,
				schemaRevision: DAEMON_SCHEMA_REVISION,
				serverCapabilities: DAEMON_DEFAULT_SERVER_CAPABILITIES,
			});
			attachJsonlLineReader(socket, (line) => {
				const wire = JSON.parse(line) as DaemonCommandEnvelope | DaemonCommand;
				const command = wire.type === "command" ? wire.command : wire;
				commands.push(command);
				if (command.type === "ack_result") return;
				const reply = (data?: unknown) =>
					output({ type: "response", id: wire.id, command: command.type, success: true, data });
				if (command.type === "attach") {
					attached.add(command.activeSessionId);
					reply({ id: command.activeSessionId, activeSessionId: command.activeSessionId, sessionId: "session-1" });
				} else if (command.type === "detach") {
					if (command.activeSessionId) attached.delete(command.activeSessionId);
					reply();
				} else if (command.type === "get_messages") {
					if (attached.has(command.activeSessionId))
						output({
							type: "session_event",
							activeSessionId: command.activeSessionId,
							event: { type: "agent_end", messages: [] },
						});
					reply({ messages: [] });
				} else if (command.type === "switch_session") {
					output({
						type: "response",
						id: wire.id,
						command: command.type,
						success: false,
						error: "Session already active",
						errorInfo: {
							code: "session_already_active",
							sessionPath: command.sessionPath,
							activeSessionId: "active-2",
						},
					});
				} else if (command.type === "reattach") {
					attached.delete(command.activeSessionId);
					attached.add(command.targetActiveSessionId);
					reply({
						activeSessionId: command.targetActiveSessionId,
						snapshot: {
							summary: { sessionId: "session-2" },
							state: { sessionId: "session-2" },
							messages: [],
						},
					});
				} else reply();
			});
		});
		const client = new DaemonClient(socketPath);
		let primary: DaemonAgentConnection | undefined;
		let watcher: AgentConnectionSessionWatcher | undefined;
		try {
			await new Promise<void>((resolve) => server.listen(socketPath, resolve));
			await client.connect();
			await client.waitForHello();
			primary = await DaemonAgentConnection.attach(client, "active-1", {
				directTransport: false,
				closeClientOnDispose: true,
				ownedSession: action === "close",
			});
			const primaryEvents: AgentConnectionEvent[] = [];
			primary.subscribe((event) => {
				primaryEvents.push(event);
			});
			watcher = await primary.watchSession("active-1");
			expect(watcher).toBeDefined();
			const observed = vi.fn();
			watcher!.subscribe(observed);
			await watcher!.getMessages();
			expect(observed).toHaveBeenCalledWith({ type: "session_event", event: { type: "agent_end", messages: [] } });
			observed.mockClear();
			primaryEvents.length = 0;
			if (action === "close") {
				await watcher!.close();
				await primary.getMessages();
				expect(primaryEvents).toContainEqual({ type: "session_event", event: { type: "agent_end", messages: [] } });
				expect(observed).not.toHaveBeenCalled();
			} else {
				await primary.switchSession("/tmp/already-active.jsonl");
				expect(observed).toHaveBeenCalledWith(expect.objectContaining({ type: "closed" }));
				await expect(watcher!.getMessages()).rejects.toThrow("closed");
				await watcher!.close();
				expect(attached.has("active-2")).toBe(true);
			}
			expect(commands.filter((command) => command.type === "attach")).toHaveLength(1);
			expect(
				commands.some(
					(command) =>
						command.type === "detach" || command.type === "complete_owned_session" || command.type === "abort",
				),
			).toBe(false);
		} finally {
			await watcher?.close();
			await primary?.dispose();
			client.close();
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
