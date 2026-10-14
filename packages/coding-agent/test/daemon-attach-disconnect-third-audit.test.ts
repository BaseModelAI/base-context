import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ActiveSessionState, DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import { createDaemonCommandEnvelope, type DaemonSessionSnapshot } from "../src/modes/daemon/daemon-protocol.js";

async function pendingSocketAttach() {
	const dir = mkdtempSync(join(tmpdir(), "bc-attach-disconnect-"));
	const socketPath = join(dir, "daemon.sock");
	const daemon = new AgentDaemon(socketPath, {
		defaultSessionConfig: { agentDir: dir, cwd: dir },
		createRuntime: vi.fn(),
	});
	const internals = daemon as unknown as {
		clients: Set<DaemonSocketClient>;
		sessions: Map<string, ActiveSessionState>;
		handleConnection(socket: Socket): void;
		handleLine(client: DaemonSocketClient, line: string): Promise<void>;
		createSessionSnapshot(state: ActiveSessionState): Promise<DaemonSessionSnapshot>;
	};
	const state = {
		activeSessionId: "active",
		clients: new Set(),
		pendingAttaches: 0,
		extensionUiRequests: new Map(),
		eventGeneration: "generation",
		lastEventSequence: 0,
		runtime: { metadata: { kind: "subagent" } },
	} as unknown as ActiveSessionState;
	internals.sessions.set(state.activeSessionId, state);
	let enterSnapshot!: () => void;
	const snapshotEntered = new Promise<void>((resolve) => {
		enterSnapshot = resolve;
	});
	let releaseSnapshot!: () => void;
	const snapshotGate = new Promise<void>((resolve) => {
		releaseSnapshot = resolve;
	});
	internals.createSessionSnapshot = async () => {
		enterSnapshot();
		await snapshotGate;
		return {
			activeSessionId: "active",
			summary: {},
			state: {},
			messages: [],
			lastEventSequence: 0,
		} as unknown as DaemonSessionSnapshot;
	};
	let finishCommand!: () => void;
	const commandFinished = new Promise<void>((resolve) => {
		finishCommand = resolve;
	});
	const handleLine = internals.handleLine.bind(daemon);
	internals.handleLine = async (client, line) => {
		try {
			await handleLine(client, line);
		} finally {
			finishCommand();
		}
	};
	const server = createServer((socket) => internals.handleConnection(socket));
	server.listen(socketPath);
	await once(server, "listening");
	const peer = createConnection(socketPath);
	let received = "";
	peer.on("data", (data: Buffer) => {
		received += data.toString("utf8");
	});
	await once(peer, "connect");
	peer.write(
		`${JSON.stringify(
			createDaemonCommandEnvelope(
				{ type: "attach", activeSessionId: "active", capabilities: ["slim_attach"] },
				"attach-1",
				"viewer",
			),
		)}\n`,
	);
	await snapshotEntered;
	const client = [...internals.clients][0]!;
	return {
		state,
		client,
		peer,
		internals,
		releaseSnapshot,
		commandFinished,
		getReceived: () => received,
		async cleanup() {
			releaseSnapshot();
			await commandFinished;
			const closed = client.socket.destroyed ? undefined : once(client.socket, "close");
			peer.destroy();
			await closed;
			server.close();
			await once(server, "close");
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

describe("daemon attach socket ownership", () => {
	it("publishes attachment only after the live client's snapshot completes", async () => {
		const fixture = await pendingSocketAttach();
		try {
			expect(fixture.state.pendingAttaches).toBe(1);
			expect(fixture.state.clients.size).toBe(0);
			fixture.releaseSnapshot();
			await fixture.commandFinished;
			expect(fixture.state.pendingAttaches).toBe(0);
			expect(fixture.state.clients.has(fixture.client)).toBe(true);
			expect(fixture.client.attachedActiveSessionIds.has("active")).toBe(true);
			await vi.waitFor(() => expect(fixture.getReceived()).toContain('"command":"attach","success":true'));
		} finally {
			await fixture.cleanup();
		}
	});

	it("does not publish a client whose socket closed during snapshot capture", async () => {
		const fixture = await pendingSocketAttach();
		try {
			const closed = once(fixture.client.socket, "close");
			fixture.peer.destroy();
			await closed;
			expect(fixture.internals.clients.has(fixture.client)).toBe(false);
			fixture.releaseSnapshot();
			await fixture.commandFinished;
			expect(fixture.state.pendingAttaches).toBe(0);
			expect(fixture.state.clients.has(fixture.client)).toBe(false);
			expect(fixture.client.attachedActiveSessionIds.has("active")).toBe(false);
			expect(fixture.client.capabilitiesByActiveSessionId?.has("active")).toBe(false);
			expect(fixture.internals.sessions.get("active")).toBe(fixture.state);
		} finally {
			await fixture.cleanup();
		}
	});
});
