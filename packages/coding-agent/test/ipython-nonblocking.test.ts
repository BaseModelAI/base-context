import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@ponythewhite/base-context-agent";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@ponythewhite/base-context-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import {
	createDeferred,
	type ExecuteResult,
	type KernelClient,
	type KernelExecutionHandle,
} from "../src/core/kernel/index.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { IpythonKernelProvisioner } from "../src/core/tools/ipython.js";
import { createTestResourceLoader } from "./utilities.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

function controlledSession(responses: Parameters<ReturnType<typeof registerFauxProvider>["setResponses"]>[0]) {
	const cwd = mkdtempSync(join(tmpdir(), "ipython-pending-"));
	const faux = registerFauxProvider({ api: "faux-pending", provider: "faux-pending" });
	faux.setResponses(responses);
	const model = faux.getModel();
	const agent = new Agent({ getApiKey: () => "local-faux", initialState: { model, systemPrompt: "Test", tools: [] } });
	const auth = AuthStorage.create(join(cwd, "auth.json"));
	auth.setRuntimeApiKey(model.provider, "local-faux");
	const session = new AgentSession({
		agent,
		cwd,
		sessionManager: SessionManager.inMemory(),
		settingsManager: SettingsManager.create(cwd, cwd),
		modelRegistry: ModelRegistry.create(auth, cwd),
		resourceLoader: createTestResourceLoader(),
	});
	const result = createDeferred<ExecuteResult>();
	const physical = createDeferred<void>();
	const admitted = createDeferred<void>();
	const namespace = { sentinel: 41 };
	const interrupt = vi.fn(async () => {});
	const handle: KernelExecutionHandle = {
		id: "native-cell-1",
		settled: physical.promise,
		interrupt,
		snapshot: () => ({ stdout: "started", stderr: "", durationMs: 1000 }),
	};
	const execute = vi.fn<KernelClient["execute"]>(async (_code, options) => {
		if (execute.mock.calls.length === 1) {
			options?.onExecutionStarted?.(handle);
			admitted.resolve();
			return result.promise;
		}
		namespace.sentinel++;
		return { stdout: "", stderr: "", result: String(namespace.sentinel), status: "ok", durationMs: 1 };
	});
	const kernel: KernelClient = {
		ownerSessionId: session.sessionId,
		isRunning: true,
		execute,
		start: async () => {},
		shutdown: async () => true,
		restart: vi.fn(async () => {}),
		kill: vi.fn(async () => {}),
		disposeSync: () => {},
		snapshotState: async () => null,
		pruneOversizedVariables: async () => null,
		restoreState: async () => null,
		listNamespaceNames: async () => [],
	};
	const ensure = vi.spyOn(IpythonKernelProvisioner.prototype, "ensure").mockResolvedValue(kernel);
	vi.spyOn(IpythonKernelProvisioner.prototype, "hasRunningKernel", "get").mockReturnValue(true);
	const prune = vi
		.spyOn(IpythonKernelProvisioner.prototype, "pruneOversizedVariables")
		.mockImplementation(async () => {
			throw new Error("A pending cell must not probe the Python FIFO");
		});
	const names = vi.spyOn(IpythonKernelProvisioner.prototype, "listNamespaceNames").mockImplementation(async () => {
		throw new Error("A pending cell must not probe the Python FIFO");
	});
	cleanups.push(async () => {
		result.resolve({ stdout: "", stderr: "", status: "aborted", durationMs: 1 });
		physical.resolve();
		session.requestAbort();
		await session.disposeAsync();
		faux.unregister();
		rmSync(cwd, { recursive: true, force: true });
	});
	return { session, kernel, execute, ensure, prune, names, result, physical, admitted, interrupt, namespace };
}

function tool(name: string, args: Record<string, unknown>) {
	return fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
}

describe("owned nonblocking IPython execution", () => {
	it("yields to the model, preserves one cell and drains its completion turn before headless completion", async () => {
		const receivedPending = createDeferred<void>();
		const receivedFinal = createDeferred<void>();
		const fixture = controlledSession([
			tool("ipython", { code: "sentinel = 41; slow_work()" }),
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("native-cell-1");
				return tool("ipython", { action: "status", execution_id: "native-cell-1" });
			},
			() => {
				receivedPending.resolve();
				return fauxAssistantMessage("Waiting for the same cell.");
			},
			tool("ipython", { action: "status", execution_id: "native-cell-1" }),
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("final-output");
				receivedFinal.resolve();
				return tool("ipython", { code: "sentinel += 1; sentinel" });
			},
			fauxAssistantMessage("Collected the result; state preserved."),
		]);
		const prompt = fixture.session.prompt("Run the work.");
		await fixture.admitted.promise;
		await receivedPending.promise;
		await prompt;
		expect(fixture.execute).toHaveBeenCalledTimes(1);
		expect(fixture.session.isSessionActive).toBe(true);
		await (
			fixture.session as unknown as { _syncKernelStateAfterCompaction(): Promise<void> }
		)._syncKernelStateAfterCompaction();
		expect(fixture.prune).not.toHaveBeenCalled();
		expect(fixture.names).not.toHaveBeenCalled();
		let localFinished = false;
		let familyFinished = false;
		const local = fixture.session.waitForHeadlessIdle().then(() => {
			localFinished = true;
		});
		const family = fixture.session.waitForRlmQuiescence().then(() => {
			familyFinished = true;
		});
		await fixture.session.waitForIdle();
		expect(localFinished).toBe(false);
		expect(familyFinished).toBe(false);
		fixture.result.resolve({
			stdout: "final-output",
			stderr: "",
			result: "41",
			status: "ok",
			durationMs: 1200,
			diffs: [{ path: "example.py", oldStr: "", newStr: "sentinel = 41" }],
			backgroundOutput: "separate background",
		});
		fixture.physical.resolve();
		await receivedFinal.promise;
		await Promise.all([local, family]);
		expect(fixture.execute).toHaveBeenCalledTimes(2);
		expect(fixture.namespace.sentinel).toBe(42);
		expect(fixture.interrupt).not.toHaveBeenCalled();
		expect(fixture.kernel.kill).not.toHaveBeenCalled();
		expect(fixture.kernel.restart).not.toHaveBeenCalled();
		expect(fixture.session.isSessionActive).toBe(false);
	});

	it("keeps an early-aborted execution owned until native idle and does not wake an aborted session", async () => {
		const fixture = controlledSession([
			tool("ipython", { code: "slow_work()" }),
			fauxAssistantMessage("Waiting for the cell."),
		]);
		await fixture.session.prompt("Run the work.");
		const ipython = fixture.session.agent.state.tools.find((entry) => entry.name === "ipython")!;
		await ipython.execute("interrupt", { action: "interrupt", execution_id: "native-cell-1" });
		expect(fixture.interrupt).toHaveBeenCalledTimes(1);
		fixture.result.resolve({ stdout: "partial", stderr: "", status: "aborted", durationMs: 1000 });
		const status = await ipython.execute("status", { action: "status", execution_id: "native-cell-1" });
		expect(status.details).toMatchObject({ status: "pending", executionId: "native-cell-1" });
		const rejected = await ipython.execute("second-code", { code: "must_not_run()" });
		expect(rejected.isError).toBe(true);
		expect(fixture.execute).toHaveBeenCalledTimes(1);
		expect(fixture.ensure).toHaveBeenCalledTimes(1);
		expect(fixture.session.isSessionActive).toBe(true);
		fixture.session.requestAbort();
		const messagesBeforeSettlement = fixture.session.agent.state.messages.length;
		let finished = false;
		const idle = fixture.session.waitForHeadlessIdle().then(() => {
			finished = true;
		});
		await fixture.session.waitForIdle();
		expect(finished).toBe(false);
		fixture.physical.resolve();
		await idle;
		expect(fixture.session.agent.state.messages).toHaveLength(messagesBeforeSettlement);
		expect(fixture.session.isSessionActive).toBe(false);
		expect(fixture.interrupt).toHaveBeenCalledTimes(2);
		const ready = await ipython.execute("ready-code", { code: "must_not_run()" });
		expect(ready.details).toMatchObject({ status: "ready" });
		const final = await ipython.execute("collect", { action: "status", execution_id: "native-cell-1" });
		expect(final.details).toMatchObject({ status: "aborted", stdout: "partial" });
		expect(fixture.execute).toHaveBeenCalledTimes(1);
		expect(fixture.kernel.kill).not.toHaveBeenCalled();
		expect(fixture.kernel.restart).not.toHaveBeenCalled();
	});
});
