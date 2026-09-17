import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateAgentSessionRuntimeFactory } from "../../../src/core/agent-session-runtime.js";
import type { ExtensionFactory } from "../../../src/core/extensions/types.js";
import { DaemonClient } from "../../../src/modes/daemon/daemon-client.js";
import { AgentDaemon } from "../../../src/modes/daemon/daemon-mode.js";
import type { SessionSummary } from "../../../src/modes/daemon/daemon-session-list.js";
import { createHarness, type Harness } from "../harness.js";

describe("issue #1922 abandoned daemon drafts", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		try {
			while (cleanups.length > 0) await cleanups.pop()?.();
		} finally {
			vi.restoreAllMocks();
		}
	});

	async function createDaemon(extensionFactory?: ExtensionFactory) {
		const directory = mkdtempSync(join(tmpdir(), "bc-draft-"));
		const harnesses: Harness[] = [];
		const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
			const harness = await createHarness({
				sessionManager: options.sessionManager,
				extensionFactories: extensionFactory ? [extensionFactory] : undefined,
			});
			harnesses.push(harness);
			return {
				session: harness.session,
				extensionsResult: harness.session.resourceLoader.getExtensions(),
				services: {
					cwd: options.cwd,
					agentDir: options.agentDir,
					modelRegistry: harness.session.modelRegistry,
					authStorage: harness.authStorage,
					settingsManager: harness.settingsManager,
				} as Awaited<ReturnType<CreateAgentSessionRuntimeFactory>>["services"],
				diagnostics: [],
			};
		};
		const socketPath = join(directory, "daemon.sock");
		const daemon = new AgentDaemon(socketPath, {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			createRuntime,
		});
		const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		await daemon.start();
		const client = new DaemonClient(socketPath);
		const secondClient = new DaemonClient(socketPath);
		await client.connect();
		await secondClient.connect();
		cleanups.push(async () => {
			await client.request({ type: "shutdown" });
			await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
			client.close();
			secondClient.close();
			for (const harness of harnesses) await harness.cleanup();
			rmSync(directory, { recursive: true, force: true });
		});
		return { client, secondClient, harnesses, log };
	}

	it("observes teardown rejections after detach and after busy work ends, keeping another session live", async () => {
		let releaseBash!: () => void;
		const bashGate = new Promise<void>((resolve) => {
			releaseBash = resolve;
		});
		const fixture = await createDaemon((pi) => {
			pi.on("user_bash", async () => {
				await bashGate;
				return { result: { output: "", exitCode: 0, cancelled: false, truncated: false } };
			});
		});
		const survivor = await fixture.client.request({ type: "create", noSession: true, name: "survivor" });
		if (!survivor.success) throw new Error(survivor.error);
		const survivorId = (survivor.data as SessionSummary).activeSessionId!;
		for (const trigger of ["detach", "bash-end"]) {
			const created = await fixture.client.request({ type: "create", noSession: true });
			if (!created.success) throw new Error(created.error);
			const activeSessionId = (created.data as SessionSummary).activeSessionId!;
			const session = fixture.harnesses.at(-1)!.session;
			expect(session.sessionManager.hasUserContent()).toBe(false);
			expect((await fixture.client.request({ type: "attach", activeSessionId })).success).toBe(true);
			const dispose = session.disposeAsync.bind(session);
			const rejection = vi.spyOn(session, "disposeAsync").mockImplementationOnce(async (options) => {
				await dispose(options);
				throw new Error(`draft ${trigger} teardown failed`);
			});
			const bash = trigger === "bash-end" ? session.runUserBash("blocked", { transient: true }) : undefined;
			expect((await fixture.client.request({ type: "detach", activeSessionId })).success).toBe(true);
			if (bash) {
				expect(rejection).not.toHaveBeenCalled();
				releaseBash();
				await bash;
			}
			await vi.waitFor(() =>
				expect(fixture.log).toHaveBeenCalledWith(
					expect.stringContaining(`failed to discard abandoned empty draft ${activeSessionId}`),
				),
			);
			expect(rejection).toHaveBeenCalledOnce();
			expect(
				(await fixture.client.request({ type: "get_connection_state", activeSessionId: survivorId })).success,
			).toBe(true);
			expect((await fixture.client.request({ type: "get_connection_state", activeSessionId })).success).toBe(false);
		}
	});

	it("keeps an empty draft alive while a second public attach is pending", async () => {
		const fixture = await createDaemon();
		const created = await fixture.client.request({ type: "create", noSession: true });
		if (!created.success) throw new Error(created.error);
		const activeSessionId = (created.data as SessionSummary).activeSessionId!;
		const session = fixture.harnesses[0].session;
		expect((await fixture.client.request({ type: "attach", activeSessionId })).success).toBe(true);
		const dispose = vi.spyOn(session, "disposeAsync");
		let enteredAttach!: () => void;
		let releaseAttach!: () => void;
		const entered = new Promise<void>((resolve) => {
			enteredAttach = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			releaseAttach = resolve;
		});
		const getContextUsage = session.getContextUsage.bind(session);
		vi.spyOn(session, "getContextUsage").mockImplementationOnce(async () => {
			enteredAttach();
			await gate;
			return getContextUsage();
		});
		const attaching = fixture.secondClient.request({ type: "attach", activeSessionId });
		await entered;
		expect((await fixture.client.request({ type: "detach", activeSessionId })).success).toBe(true);
		expect(dispose).not.toHaveBeenCalled();
		releaseAttach();
		expect((await attaching).success).toBe(true);
		expect((await fixture.secondClient.request({ type: "get_connection_state", activeSessionId })).success).toBe(
			true,
		);
		expect(dispose).not.toHaveBeenCalled();
		expect((await fixture.secondClient.request({ type: "detach", activeSessionId })).success).toBe(true);
		await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
	});
});
