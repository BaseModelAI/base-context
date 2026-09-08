import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	type Context,
	fauxAssistantMessage,
	type Message,
	registerFauxProvider,
	type ToolCall,
} from "@ponythewhite/base-context-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { defineTool } from "../src/core/extensions/types.js";
import * as kernelBootstrap from "../src/core/kernel/bootstrap.js";
import {
	AGENT_MESSAGE_DISPLAY_MIME,
	ATTACHMENT_DISPLAY_MIME,
	DIFF_DISPLAY_MIME,
	type HostRequestHandlers,
	ReplKernelManager,
} from "../src/core/kernel/index.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createBashToolDefinition } from "../src/core/tools/bash.js";
import { createTestResourceLoader } from "./utilities.js";

function resolveReplPython(): string | null {
	const candidates = [
		process.env.BASE_CONTEXT_KERNEL_PYTHON,
		resolve(__dirname, "..", "..", "..", "prime-agent-runtime", ".venv", "bin", "python"),
		join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python"),
	].filter((p): p is string => Boolean(p));
	for (const python of candidates) {
		if (!existsSync(python)) continue;
		const check = spawnSync(python, ["-c", "import rlm.repl, dill"], { encoding: "utf8" });
		if (check.status === 0) return python;
	}
	return null;
}

const python = resolveReplPython();
const describeIf = python ? describe : describe.skip;

describeIf("ReplKernelManager execute (real runtime)", () => {
	let dir = "";
	let manager: ReplKernelManager | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prime-agent-repl-execute-"));
	});

	afterEach(async () => {
		await manager?.shutdown({ snapshot: true, drainHostRequests: true });
		manager = undefined;
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
			dir = "";
		}
	});

	it("streams stdout/stderr, returns results, and persists state across cells", async () => {
		manager = new ReplKernelManager({ python: python as string, cwd: dir });
		const chunks: { name: string; text: string }[] = [];
		const first = await manager.execute("import sys\nx = 21\nprint('to-out')\nsys.stderr.write('to-err\\n')", {
			onStream: (chunk, name) => chunks.push({ name, text: chunk }),
		});
		expect(first.status).toBe("ok");
		expect(first.stdout).toContain("to-out");
		expect(first.stderr).toContain("to-err");
		expect(chunks.some((c) => c.name === "stdout" && c.text.includes("to-out"))).toBe(true);

		const second = await manager.execute("x * 2");
		expect(second.status).toBe("ok");
		expect(second.result).toBe("42");

		// Keep the real SDK tools/provisioner/host bridge. Replace only interpreter discovery:
		// this file already requires an installed runtime; never auto-install a kernel here.
		const interpreter = vi.spyOn(kernelBootstrap, "ensureKernelPython").mockResolvedValue(python as string);
		let session: AgentSession | undefined;
		let sessionManager: SessionManager | undefined;
		let faux: ReturnType<typeof registerFauxProvider> | undefined;
		try {
			faux = registerFauxProvider();
			sessionManager = await SessionManager.create(dir, join(dir, "native-recovery-happy"));
			const sourceRef = await sessionManager.appendMessage({
				role: "user",
				content: "before\nPreserve Foo.txt.\nafter",
				timestamp: 1,
			});
			const model = faux.getModel();
			const authStorage = AuthStorage.inMemory();
			authStorage.setRuntimeApiKey(model.provider, "faux-key");
			const modelRegistry = ModelRegistry.inMemory(authStorage);
			modelRegistry.registerProvider(model.provider, {
				baseUrl: model.baseUrl,
				apiKey: "faux-key",
				api: faux.api,
				models: faux.models.map((registered) => ({
					id: registered.id,
					name: registered.name,
					api: registered.api,
					reasoning: registered.reasoning,
					input: registered.input,
					cost: registered.cost,
					contextWindow: registered.contextWindow,
					maxTokens: registered.maxTokens,
					baseUrl: registered.baseUrl,
				})),
			});
			({ session } = await createAgentSession({
				cwd: dir,
				agentDir: dir,
				sessionManager,
				model,
				tools: ["bash", "ipython", "prime_context"],
				customTools: [defineTool(createBashToolDefinition(dir))],
				authStorage,
				modelRegistry,
				settingsManager: SettingsManager.inMemory({
					compaction: { enabled: false },
					autoRefine: { enabled: false },
					retry: { enabled: false },
				}),
				resourceLoader: createTestResourceLoader(),
				includeGoals: false,
				includeCompactSkill: false,
				prewarmIpythonKernel: false,
			}));
			const source = await sessionManager.readBranchHistory((history) => history.get(sourceRef));
			expect(source).toBeDefined();
			const native = session.agent.state.tools.find((tool) => tool.name === "prime_context")!;
			expect(session.getActiveToolNames()).toEqual(["bash", "ipython", "prime_context"]);
			expect(native.parameters.type).toBe("object");
			const recover = vi.spyOn(session, "recoverNativeHistory"); // call-through, not a source stub
			const captured = vi.spyOn(sessionManager, "readBranchHistory");
			const request = { action: "recover", ref: sourceRef, revision: source!.revision, need: "Preserve Foo.txt." };
			const calls: ToolCall[] = [
				{ type: "toolCall", id: "recovery-direct", name: "prime_context", arguments: request },
				{
					type: "toolCall",
					id: "recovery-cell",
					name: "ipython",
					// Assignment only: the cell does not print or display the selected Python variable.
					arguments: { code: `selected = await rlm.prime_context(${JSON.stringify(request)})` },
				},
			];
			let nextContext: Message[] = [];
			// The registered local-simulation provider keeps the owned native dispatcher intact.
			faux.setResponses([
				...calls.map((call) => (context: Context) => {
					nextContext = structuredClone(context.messages);
					return fauxAssistantMessage([call], { stopReason: "toolUse" });
				}),
				(context: Context) => {
					nextContext = structuredClone(context.messages);
					return fauxAssistantMessage("done");
				},
			]);
			await session.prompt("Run the two recovery calls.");
			expect(recover).toHaveBeenCalledTimes(2);
			expect(recover.mock.calls[1][1]).toBeInstanceOf(AbortSignal);
			expect(captured).toHaveBeenCalled();
			const results = session.messages.filter((message) => message.role === "toolResult");
			const direct = results.find((message) => message.toolCallId === "recovery-direct")!;
			const cell = results.find((message) => message.toolCallId === "recovery-cell")!;
			expect(direct.isError).toBe(false);
			expect(cell.isError).toBe(false);
			expect(cell.content[0]).toEqual({ type: "text", text: "" });
			expect(cell.content).toHaveLength(2);
			for (const block of [direct.content[0], cell.content[1]]) {
				expect(block.type).toBe("text");
				if (block.type !== "text") throw new Error("Expected public recovery text");
				const response = JSON.parse(block.text);
				expect(response.results[0]).toMatchObject({ status: "partial", reason: "need_window" });
				expect(response.results[0].records).toEqual([
					{
						ref: sourceRef,
						revision: source!.revision,
						sourceSessionId: sessionManager.getSessionId(),
						kind: "message",
						field: "/message/content",
						startLine: 2,
						endLine: 2,
						text: "Preserve Foo.txt.",
					},
				]);
			}
			expect(
				nextContext.find((message) => message.role === "toolResult" && message.toolCallId === "recovery-cell"),
			).toMatchObject({ content: cell.content });
			// Read the actual finalized result through the pinned canonical branch, with
			// its own entry ref/revision, not a native-looking details/provenance marker.
			const finalized = await sessionManager.readBranchHistory(async (history) => {
				for await (const item of history.iterateEntries({ maxEntries: 64, maxSourceBytes: 1024 * 1024 })) {
					if (
						item.entry.type === "message" &&
						item.entry.message.role === "toolResult" &&
						item.entry.message.toolCallId === "recovery-cell"
					)
						return item;
				}
				return undefined;
			});
			expect(finalized?.entry).toMatchObject({ message: { content: cell.content } });
			expect(finalized!.source.id).not.toBe(sourceRef);
			expect(finalized!.source.revision).toBeTruthy();
			const reread = await native.execute(
				"read-finalized-cell",
				{
					action: "read",
					ref: finalized!.source.id,
					revision: finalized!.source.revision,
					field: "/message/content/1/text",
				},
				new AbortController().signal,
			);
			const block = reread.content[0];
			if (block.type !== "text") throw new Error("Expected finalized recovery text");
			expect(JSON.parse(block.text).results[0].records[0]).toMatchObject({
				ref: finalized!.source.id,
				revision: finalized!.source.revision,
				text: cell.content[1].type === "text" ? cell.content[1].text : "",
			});
		} finally {
			try {
				await session?.disposeAsync({ kernelSnapshot: false });
			} finally {
				try {
					await sessionManager?.close();
				} finally {
					faux?.unregister();
					interpreter.mockRestore();
				}
			}
		}
	}, 30_000);

	it("reports cell errors with a clean traceback", async () => {
		manager = new ReplKernelManager({ python: python as string, cwd: dir });
		const r = await manager.execute("def boom():\n    raise ValueError('nope')\nboom()");
		expect(r.status).toBe("error");
		expect(r.error?.ename).toBe("ValueError");
		expect(r.error?.evalue).toBe("nope");
		expect(r.error?.traceback.join("")).toContain("raise ValueError('nope')");
	}, 30_000);

	it("parses emitted display payloads into diffs, attachments, and sent messages", async () => {
		manager = new ReplKernelManager({ python: python as string, cwd: dir });
		const code = [
			"from rlm import emit",
			`emit({${JSON.stringify(DIFF_DISPLAY_MIME)}: {"path": "/tmp/f.py", "old_str": "a", "new_str": "b", "start_line": 3}})`,
			`emit({${JSON.stringify(ATTACHMENT_DISPLAY_MIME)}: {"mime_type": "image/png", "data": "aGVsbG8=", "path": "/tmp/i.png"}})`,
			`emit({${JSON.stringify(AGENT_MESSAGE_DISPLAY_MIME)}: {"id": "m1", "message": "hi", "deliveryStatus": "delivered", "receiverRole": "parent", "target": {"activeSessionId": "a", "sessionId": "s"}}})`,
		].join("\n");
		const r = await manager.execute(code);
		expect(r.status).toBe("ok");
		expect(r.diffs).toEqual([{ path: "/tmp/f.py", oldStr: "a", newStr: "b", startLine: 3 }]);
		expect(r.attachments).toEqual([{ mimeType: "image/png", data: "aGVsbG8=", path: "/tmp/i.png" }]);
		expect(r.sentAgentMessages).toEqual([
			{
				id: "m1",
				message: "hi",
				deliveryStatus: "delivered",
				receiverRole: "parent",
				target: { activeSessionId: "a", sessionId: "s" },
			},
		]);
	}, 30_000);

	it("round-trips host requests through hostHandlers, including error replies", async () => {
		const hostHandlers: HostRequestHandlers = {
			"test.echo": async (payload) => ({ echoed: payload.value, cell: payload.cellSourceCode }),
			"test.fail": async () => {
				throw new Error("handler exploded");
			},
		};
		manager = new ReplKernelManager({ python: python as string, cwd: dir, hostHandlers });

		const ok = await manager.execute(
			"import rlm\nreply = await rlm.host_request('test.echo', {'value': 7})\nreply['echoed']",
		);
		expect(ok.status).toBe("ok");
		expect(ok.result).toBe("7");

		const cellSource = await manager.execute("reply['cell']");
		expect(cellSource.status).toBe("ok");
		expect(cellSource.result).toContain("test.echo");

		const failed = await manager.execute("import rlm\nawait rlm.host_request('test.fail')");
		expect(failed.status).toBe("error");
		expect(failed.error?.ename).toBe("RuntimeError");
		expect(failed.error?.evalue).toBe("handler exploded");

		const unknown = await manager.execute("import rlm\nawait rlm.host_request('test.unknown')");
		expect(unknown.status).toBe("error");
		expect(unknown.error?.evalue).toContain('host request type "test.unknown" is not available');

		const interpreter = vi.spyOn(kernelBootstrap, "ensureKernelPython").mockResolvedValue(python as string);
		try {
			// One existing edge case: explicit restriction, same-name custom replacement,
			// and an old real Python task resumed inside a later admitted ipython cell.
			for (const mode of ["restricted", "replacement", "stale"] as const) {
				let session: AgentSession | undefined;
				let sessionManager: SessionManager | undefined;
				let faux: ReturnType<typeof registerFauxProvider> | undefined;
				try {
					faux = registerFauxProvider();
					sessionManager = await SessionManager.create(dir, join(dir, `native-recovery-${mode}`));
					const ref = await sessionManager.appendMessage({
						role: "user",
						content: "DO-NOT-RECOVER-FROM-DENIED-CELL",
						timestamp: 1,
					});
					const model = faux.getModel();
					const authStorage = AuthStorage.inMemory();
					authStorage.setRuntimeApiKey(model.provider, "faux-key");
					const modelRegistry = ModelRegistry.inMemory(authStorage);
					modelRegistry.registerProvider(model.provider, {
						baseUrl: model.baseUrl,
						apiKey: "faux-key",
						api: faux.api,
						models: faux.models.map((registered) => ({
							id: registered.id,
							name: registered.name,
							api: registered.api,
							reasoning: registered.reasoning,
							input: registered.input,
							cost: registered.cost,
							contextWindow: registered.contextWindow,
							maxTokens: registered.maxTokens,
							baseUrl: registered.baseUrl,
						})),
					});
					const replacement = defineTool({
						name: "prime_context",
						label: "custom recovery",
						description: "Not the owned reader",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text" as const, text: "custom-only" }], details: {} }),
					});
					({ session } = await createAgentSession({
						cwd: dir,
						agentDir: dir,
						sessionManager,
						model,
						tools: mode === "restricted" ? ["ipython"] : ["bash", "ipython", "prime_context"],
						customTools: [
							defineTool(createBashToolDefinition(dir)),
							...(mode === "replacement" ? [replacement] : []),
						],
						authStorage,
						modelRegistry,
						settingsManager: SettingsManager.inMemory({
							compaction: { enabled: false },
							autoRefine: { enabled: false },
							retry: { enabled: false },
						}),
						resourceLoader: createTestResourceLoader(),
						includeGoals: false,
						includeCompactSkill: false,
						prewarmIpythonKernel: false,
					}));
					expect(session.getActiveToolNames()).toEqual(
						mode === "restricted" ? ["ipython"] : ["bash", "ipython", "prime_context"],
					);
					const recover = vi.spyOn(session, "recoverNativeHistory"); // leave actual admission intact
					const request = JSON.stringify({ action: "read", ref });
					const calls: ToolCall[] =
						mode === "stale"
							? [
									{
										type: "toolCall",
										id: "old-cell",
										name: "ipython",
										arguments: {
											code: [
												"import asyncio",
												"gate = asyncio.Event()",
												"async def late_recovery():",
												"    await gate.wait()",
												`    return await rlm.prime_context(${request})`,
												"pending_recovery = asyncio.create_task(late_recovery())",
											].join("\n"),
										},
									},
									{
										type: "toolCall",
										id: "denied-cell",
										name: "ipython",
										arguments: {
											code: "gate.set()\ndenied = await pending_recovery\nprint(denied['status'], denied['reason'])",
										},
									},
								]
							: [
									{
										type: "toolCall",
										id: "denied-direct",
										name: "prime_context",
										arguments: mode === "replacement" ? {} : { action: "read", ref },
									},
									{
										type: "toolCall",
										id: "denied-cell",
										name: "ipython",
										arguments: {
											code: `denied = await rlm.prime_context(${request})\nprint(denied['status'], denied['reason'])`,
										},
									},
								];
					let nextContext: Message[] = [];
					// The registered local-simulation provider keeps the owned native dispatcher intact.
					faux.setResponses([
						...calls.map((call) => (context: Context) => {
							nextContext = structuredClone(context.messages);
							return fauxAssistantMessage([call], { stopReason: "toolUse" });
						}),
						(context: Context) => {
							nextContext = structuredClone(context.messages);
							return fauxAssistantMessage("done");
						},
					]);
					await session.prompt("Run the denied recovery calls.");
					const results = session.messages.filter((message) => message.role === "toolResult");
					const cell = results.find((message) => message.toolCallId === "denied-cell")!;
					expect(cell.isError).toBe(false); // the wrapper received a refusal, not a traceback
					expect(JSON.stringify(cell.content)).not.toContain("DO-NOT-RECOVER-FROM-DENIED-CELL");
					expect(
						nextContext.find((message) => message.role === "toolResult" && message.toolCallId === "denied-cell"),
					).toMatchObject({ content: cell.content });
					if (mode === "stale") {
						expect(recover).not.toHaveBeenCalled(); // old ContextVar cellId rejected before the reader
						expect(cell.content).toEqual([{ type: "text", text: "not_authorized active_cell_required\n" }]);
					} else {
						expect(recover).toHaveBeenCalledOnce();
						const direct = results.find((message) => message.toolCallId === "denied-direct")!;
						expect(direct.isError).toBe(mode === "restricted");
						if (mode === "replacement") expect(direct.content).toEqual([{ type: "text", text: "custom-only" }]);
						expect(cell.content[0]).toEqual({
							type: "text",
							text: "not_authorized native_recovery_not_enabled\n",
						});
						expect(cell.content).toHaveLength(2);
						const refusal = cell.content[1];
						if (refusal.type !== "text") throw new Error("Expected body-free refusal text");
						expect(JSON.parse(refusal.text)).toMatchObject({
							status: "not_authorized",
							reason: "native_recovery_not_enabled",
							results: [],
							sources: [],
						});
					}
				} finally {
					try {
						await session?.disposeAsync({ kernelSnapshot: false });
					} finally {
						try {
							await sessionManager?.close();
						} finally {
							faux?.unregister();
						}
					}
				}
			}
		} finally {
			interpreter.mockRestore();
		}
	}, 30_000);

	it("dispose sends the protocol shutdown so live bash children die with the kernel", async () => {
		manager = new ReplKernelManager({ python: python as string, cwd: dir });
		const r = await manager.execute("from rlm import bash\nh = bash('sleep 600')\nh.pid");
		expect(r.status).toBe("ok");
		const pid = Number(r.result);
		expect(Number.isInteger(pid)).toBe(true);
		await manager.shutdown({ snapshot: true, drainHostRequests: true });
		let alive = true;
		for (let i = 0; i < 100; i++) {
			try {
				process.kill(pid, 0);
			} catch {
				alive = false;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		expect(alive).toBe(false);
	}, 30_000);

	it("surfaces unattributed background output separately from cell stdout", async () => {
		manager = new ReplKernelManager({ python: python as string, cwd: dir });
		const first = await manager.execute(
			[
				"import threading, time",
				"def late():",
				"    time.sleep(0.5)",
				"    print('SECRET-thread', flush=True)",
				"threading.Thread(target=late, daemon=True).start()",
			].join("\n"),
		);
		expect(first.status).toBe("ok");

		const second = await manager.execute("import time\ntime.sleep(1.0)\nprint('own-output')");
		expect(second.status).toBe("ok");
		expect(second.stdout).toContain("own-output");
		expect(second.stdout).not.toContain("SECRET-thread");
		expect(second.backgroundOutput ?? "").toContain("SECRET-thread");
	}, 30_000);
});
