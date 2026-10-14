import { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import type { ExtensionUIContext } from "../src/core/extensions/index.js";
import type { ActiveSessionState, DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import { bindActiveSessionState } from "../src/modes/daemon/daemon-extension-binding.js";
import {
	setDaemonClientSessionCapabilities,
	shouldSendDaemonOutboundToClient,
} from "../src/modes/daemon/daemon-mode.js";
import type { DaemonOutbound } from "../src/modes/daemon/daemon-protocol.js";

async function bindDialogSession(currentSessionHasUi: boolean) {
	let ui!: ExtensionUIContext;
	const client: DaemonSocketClient = {
		id: "supervisor",
		socket: new Socket(),
		attachedActiveSessionIds: new Set(["interactive", "current"]),
		detachInput: () => {},
		supportsExtensionUi: false,
		capabilities: new Set(),
	};
	setDaemonClientSessionCapabilities(client, "interactive", new Set(["extension_ui"]));
	setDaemonClientSessionCapabilities(client, "current", new Set(currentSessionHasUi ? ["extension_ui"] : []));
	const session = {
		setExecEnvProvider: vi.fn(),
		subscribe: vi.fn(() => () => {}),
		bindExtensions: vi.fn(async (options: Parameters<AgentSession["bindExtensions"]>[0]) => {
			ui = options.uiContext!;
		}),
	};
	const runtime = {
		session,
		setRuntimeEnvScope: vi.fn(),
		setSubagentRuntimeHost: vi.fn(),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;
	const state: ActiveSessionState = {
		activeSessionId: "current",
		runtime,
		clients: new Set([client]),
		pendingAttaches: 0,
		extensionUiRequests: new Map(),
		eventGeneration: "generation",
		lastEventSequence: 0,
	};
	const emitted: DaemonOutbound[] = [];
	const delivered: DaemonOutbound[] = [];
	await bindActiveSessionState(state, {
		broadcast: (_state, message) => {
			emitted.push(message);
			if (shouldSendDaemonOutboundToClient(client, message)) delivered.push(message);
		},
		shutdown: () => {},
	});
	return { ui, state, client, emitted, delivered };
}

describe("daemon extension dialog session capability scope", () => {
	it("delivers and settles a dialog when its own session has an interactive client", async () => {
		const { ui, state, client, delivered } = await bindDialogSession(true);
		try {
			const answer = ui.confirm("Confirm", "Continue?");
			expect(delivered).toHaveLength(1);
			expect(state.extensionUiRequests.size).toBe(1);
			for (const request of state.extensionUiRequests.values()) request.resolve({ confirmed: true });
			await expect(answer).resolves.toBe(true);
			expect(state.extensionUiRequests.size).toBe(0);
		} finally {
			for (const request of state.extensionUiRequests.values()) request.resolve({ cancelled: true });
			client.socket.destroy();
		}
	});

	it("does not admit a dialog using another session's interactive capability", async () => {
		const { ui, state, client, emitted, delivered } = await bindDialogSession(false);
		try {
			expect(client.supportsExtensionUi).toBe(true);
			const answer = ui.confirm("Confirm", "Continue?");
			expect(delivered).toHaveLength(0);
			expect(state.extensionUiRequests.size).toBe(0);
			expect(emitted).toHaveLength(0);
			await expect(answer).resolves.toBe(false);
		} finally {
			for (const request of state.extensionUiRequests.values()) request.resolve({ cancelled: true });
			client.socket.destroy();
		}
	});
});
