import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DaemonAgentConnection } from "../src/modes/agent-connection/daemon-agent-connection.js";
import type { AgentConnectionSessionWatcher } from "../src/modes/agent-connection/types.js";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";
import {
	DAEMON_DEFAULT_SERVER_CAPABILITIES,
	DAEMON_PROTOCOL_INFO,
	DAEMON_SCHEMA_REVISION,
	type DaemonCommand,
	type DaemonCommandEnvelope,
} from "../src/modes/daemon/daemon-protocol.js";
import { attachJsonlLineReader, serializeJsonLine } from "../src/modes/rpc/jsonl.js";

describe("read-only daemon observation capabilities", () => {
	it.each(["self", "other targets"] as const)(
		"keeps %s observation separate from interactive UI ownership",
		async (target) => {
			const directory = mkdtempSync(join(tmpdir(), "fourth-watch-ui-"));
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
						reply({
							id: command.activeSessionId,
							activeSessionId: command.activeSessionId,
							sessionId: command.activeSessionId,
						});
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
					} else reply();
				});
			});
			const client = new DaemonClient(socketPath);
			let primary: DaemonAgentConnection | undefined;
			const watchers: AgentConnectionSessionWatcher[] = [];
			try {
				await new Promise<void>((resolve) => server.listen(socketPath, resolve));
				await client.connect();
				await client.waitForHello();
				primary = await DaemonAgentConnection.attach(client, "primary", {
					directTransport: false,
					supportsExtensionUi: true,
					closeClientOnDispose: true,
				});
				const primaryEvent = vi.fn();
				primary.subscribe(primaryEvent);
				const targets = target === "self" ? ["primary"] : ["observed-1", "observed-2"];
				for (const activeSessionId of targets) {
					const watcher = await primary.watchSession(activeSessionId);
					expect(watcher).toBeDefined();
					watchers.push(watcher!);
					const event = vi.fn();
					watcher!.subscribe(event);
					await watcher!.getMessages();
					expect(event).toHaveBeenCalledWith({
						type: "session_event",
						event: { type: "agent_end", messages: [] },
					});
				}
				await watchers[0].close();
				if (target !== "self") {
					expect(attached.has("observed-1")).toBe(false);
					const stillObserved = vi.fn();
					watchers[1].subscribe(stillObserved);
					await watchers[1].getMessages();
					expect(stillObserved).toHaveBeenCalledWith({
						type: "session_event",
						event: { type: "agent_end", messages: [] },
					});
				}
				primaryEvent.mockClear();
				await primary.getMessages();
				expect(primaryEvent).toHaveBeenCalledWith({
					type: "session_event",
					event: { type: "agent_end", messages: [] },
				});
				const attaches = commands.filter((command) => command.type === "attach");
				expect(attaches[0]).toMatchObject({ activeSessionId: "primary", supportsExtensionUi: true });
				expect(attaches[0].capabilities).toContain("extension_ui");
				expect(attaches).toHaveLength(target === "self" ? 1 : 3);
				for (const command of attaches.slice(1)) {
					expect(command.supportsExtensionUi).toBe(false);
					expect(command.capabilities).not.toContain("extension_ui");
				}
				expect(
					commands.some((command) => command.type === "abort" || command.type === "complete_owned_session"),
				).toBe(false);
			} finally {
				await Promise.all(watchers.map((watcher) => watcher.close()));
				await primary?.dispose();
				client.close();
				for (const socket of sockets) socket.destroy();
				await new Promise<void>((resolve) => server.close(() => resolve()));
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);
});
