import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VirtualTerminal } from "../../../../tui/test/virtual-terminal.js";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.js";
import { InProcessAgentConnection } from "../../../src/modes/agent-connection/in-process-agent-connection.js";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.js";
import { createInteractiveModeUiServices } from "../../../src/modes/interactive/interactive-mode-services.js";
import { initTheme } from "../../../src/modes/interactive/theme/theme.js";
import { createHarness, type Harness } from "../harness.js";

const { terminals } = vi.hoisted(() => ({ terminals: [] as VirtualTerminal[] }));
vi.mock("@ponythewhite/base-context-tui", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ponythewhite/base-context-tui")>();
	const { VirtualTerminal } = await import("../../../../tui/test/virtual-terminal.js");
	return {
		...actual,
		ProcessTerminal: class extends VirtualTerminal {
			constructor() {
				super(100, 30);
				terminals.push(this);
			}
		},
	};
});
vi.mock("../../../src/utils/tools-manager.js", () => ({
	ensureTool: async () => undefined,
	ensureToolWithStatus: async () => ({ status: "available", path: "/unused/rg" }),
	formatMissingRipgrepMessage: () => "",
}));

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("back navigation during chat startup", () => {
	let harness: Harness;
	let mode: InteractiveMode | undefined;
	beforeEach(async () => {
		initTheme("dark");
		harness = await createHarness({ settings: { onboardingShown: true, quietStartup: true } });
	});
	afterEach(async () => {
		await mode?.teardownSessionUi();
		mode = undefined;
		terminals.length = 0;
		vi.restoreAllMocks();
		await harness.cleanup();
	});

	it.each([false, true])("hands back safely with leave-during-init=%s", async (leaveDuringInit) => {
		const catalog = deferred<void>();
		const started = deferred<void>();
		const heartbeats = deferred<[]>();
		let connected = true;
		const runtime = {
			session: harness.session,
			setBeforeSessionInvalidate: () => {},
			setRebindSession: () => {},
			dispose: async () => {
				connected = false;
			},
		} as unknown as AgentSessionRuntime;
		const connection = new InProcessAgentConnection(runtime);
		const readCatalog = connection.getModelCatalog.bind(connection);
		vi.spyOn(connection, "getModelCatalog").mockImplementation(async () => {
			started.resolve();
			await catalog.promise;
			return readCatalog();
		});
		vi.spyOn(connection, "listHeartbeats").mockImplementation(() => heartbeats.promise);
		const readSnapshot = connection.getInitialSnapshot.bind(connection);
		const snapshot = vi.spyOn(connection, "getInitialSnapshot").mockImplementation(async () => {
			if (!connected) throw new Error("Cannot send get_connection_state: daemon is not connected");
			return readSnapshot();
		});
		const dispose = vi.spyOn(connection, "dispose");
		const onShutdown = vi.fn();
		mode = new InteractiveMode({
			agentConnection: connection,
			uiServices: createInteractiveModeUiServices(harness.session),
			returnToAgentsView: true,
			agentsViewOwnsStartupNotices: true,
			onShutdown,
		});
		const waitingForInput = vi.spyOn(mode, "getUserInput");
		const terminal = terminals[0]!;
		const result = mode.run().then(
			(value) => value,
			(error: unknown) => error,
		);
		await started.promise;
		if (leaveDuringInit) {
			terminal.sendInput("\x1b[D");
			terminal.sendInput("\x1b[D");
			await Promise.resolve();
			expect(dispose).not.toHaveBeenCalled();
		}
		catalog.resolve();
		if (!leaveDuringInit) {
			// The real run loop opens the chat while optional heartbeat metadata is still pending.
			await vi.waitFor(() => expect(waitingForInput).toHaveBeenCalledOnce());
			terminal.sendInput("\x1b[D");
		}
		expect(await result).toMatchObject({
			type: "agents_view",
			source: { sessionId: harness.session.sessionId, cwd: harness.sessionManager.getCwd() },
		});
		expect(snapshot).toHaveBeenCalledOnce();
		expect(dispose).toHaveBeenCalledOnce();
		expect(onShutdown).toHaveBeenCalledOnce();
		expect(connection.listHeartbeats).toHaveBeenCalledOnce();
		const write = vi.spyOn(terminal, "write");
		heartbeats.resolve([]);
		await Promise.resolve();
		await terminal.flush();
		expect(write).not.toHaveBeenCalled();
	});
});
