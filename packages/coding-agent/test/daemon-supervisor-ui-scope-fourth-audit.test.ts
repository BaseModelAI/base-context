import { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import { AgentRoster, workerRosterEntryFromSummary } from "../src/modes/daemon/agent-roster.js";
import { CompactAssistantStreamReconstructor } from "../src/modes/daemon/compact-session-stream.js";
import {
	DAEMON_PROTOCOL_INFO,
	type DaemonAttachResult,
	type DaemonCommand,
	type DaemonResponse,
} from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import type { DaemonWorkerFrameHeader } from "../src/modes/daemon/daemon-worker-protocol.js";
import type { PrivateFrame } from "../src/modes/session-worker/private-framing.js";

interface SupervisorFixture {
	handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonResponse | undefined>;
	handleWorkerFrame(worker: unknown, frame: PrivateFrame<DaemonWorkerFrameHeader>): void;
	subscribeWorker(worker: unknown, activeSessionId: string): Promise<void>;
	drainClientCatchups(client: DaemonSocketClient): Promise<void>;
}

function fixture() {
	const summaries = new Map(
		["main", "watched"].map((id) => [
			id,
			{
				id,
				activeSessionId: id,
				sessionId: `saved-${id}`,
				cwd: "/tmp",
				messageCount: 0,
				lifecycle: "live",
				activity: "idle",
				isSessionActive: false,
				isStreaming: false,
				isCompacting: false,
				attachedClients: 0,
				sessionActions: { queuedCount: 0, steering: [], followUps: [] },
			} satisfies SessionSummary,
		]),
	);
	const snapshots = new Map(
		[...summaries].map(([id, summary]) => [
			id,
			{
				protocol: DAEMON_PROTOCOL_INFO,
				activeSessionId: id,
				snapshot: { summary, messages: [], lastEventSequence: 0 },
				replay: { status: "complete", toSequence: 0 },
				lastEventSequence: 0,
				client: { id: "worker", capabilities: [] },
			} as unknown as DaemonAttachResult,
		]),
	);
	const subscriptions = new Map<string, boolean>();
	const worker = {
		descriptor: { workerId: "worker", rootActiveSessionId: "main", lifecycle: "ready" },
		intentionalStop: false,
		summaries,
		snapshotCache: new Map(snapshots),
		transcriptCaches: new Map(),
		snapshotGenerations: new Map(),
		snapshotLoads: new Map(),
		client: {
			request: vi.fn(async (command: { activeSessionId: string }) => ({
				success: true,
				data: snapshots.get(command.activeSessionId),
			})),
			requestWorker: vi.fn(async (command: { activeSessionId: string; supportsExtensionUi: boolean }) => {
				subscriptions.set(command.activeSessionId, command.supportsExtensionUi);
				return { success: true };
			}),
		},
	};
	const client: DaemonSocketClient = {
		id: "viewer",
		socket: new Socket(),
		attachedActiveSessionIds: new Set(),
		capabilities: new Set(),
		supportsExtensionUi: false,
		detachInput: () => {},
	};
	const roster = new AgentRoster(
		(path) => path,
		() => {},
	);
	for (const summary of summaries.values()) roster.write(workerRosterEntryFromSummary(summary), "worker");
	const sent: string[] = [];
	const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
		workers: new Map([["worker", worker]]),
		clients: new Set([client]),
		rosterStore: roster,
		protocolClientIds: new WeakMap(),
		streamReconstructor: new CompactAssistantStreamReconstructor(),
		write: vi.fn(() => true),
		writeSerialized: vi.fn((_client: DaemonSocketClient, data: Uint8Array) => {
			sent.push(Buffer.from(data).toString());
			return true;
		}),
		log: vi.fn(),
	}) as SupervisorFixture;
	const attach = (id: string, ui: boolean) =>
		supervisor.handleCommand(client, {
			type: "attach",
			activeSessionId: id,
			capabilities: ["attach_snapshot", "event_sequence", "slim_attach"],
			supportsExtensionUi: ui,
		});
	const emitUi = (id: string) =>
		supervisor.handleWorkerFrame(worker, {
			header: { kind: "outbound", outboundType: "extension_ui_request", activeSessionId: id },
			payload: Buffer.from(
				JSON.stringify({
					type: "extension_ui_request",
					activeSessionId: id,
					id: `dialog-${id}`,
					method: "confirm",
					payload: { title: "Continue?" },
				}),
			),
		});
	return { supervisor, client, worker, subscriptions, sent, attach, emitUi };
}

describe("supervisor attachment UI scope", () => {
	it("subscribes and forwards UI for an interactive attachment", async () => {
		const f = fixture();
		await f.attach("main", true);
		expect(f.subscriptions.get("main")).toBe(true);
		f.emitUi("main");
		expect(f.sent).toHaveLength(1);
		f.client.socket.destroy();
	});

	it("keeps primary UI enabled when a read-only watcher attaches and catches up", async () => {
		const f = fixture();
		await f.attach("main", true);
		await f.attach("watched", false);
		f.emitUi("main");
		f.emitUi("watched");
		expect(f.sent.map((line) => JSON.parse(line).activeSessionId)).toEqual(["main"]);
		await f.supervisor.subscribeWorker(f.worker, "main");
		expect(f.subscriptions.get("main")).toBe(true);
		expect(f.subscriptions.get("watched")).toBe(false);
		f.client.catchupActiveSessionIds = new Set(["main", "watched"]);
		await f.supervisor.drainClientCatchups(f.client);
		expect(f.subscriptions.get("main")).toBe(true);
		expect(f.subscriptions.get("watched")).toBe(false);
		f.client.socket.destroy();
	});
});
