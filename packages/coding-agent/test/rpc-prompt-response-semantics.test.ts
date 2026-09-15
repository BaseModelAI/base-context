import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@ponythewhite/base-context-agent";
import { fauxAssistantMessage, getModel, type Model, registerFauxProvider } from "@ponythewhite/base-context-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { DAEMON_PROTOCOL_VERSION } from "../src/modes/daemon/daemon-protocol.js";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.js";
import { createTestResourceLoader } from "./utilities.js";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	onOutput: undefined as ((line: string) => void) | undefined,
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	takeOverStdout: vi.fn(),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
		rpcIo.onOutput?.(line);
	},
}));

vi.mock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

type ParsedOutputLine = Record<string, unknown>;

function parseOutputLines(outputLines: string[]): ParsedOutputLine[] {
	return outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as ParsedOutputLine);
}

function getPromptResponses(outputLines: string[], id: string): ParsedOutputLine[] {
	return parseOutputLines(outputLines).filter(
		(record) => record.id === id && record.type === "response" && record.command === "prompt",
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function createRuntimeHost(options: { withAuth: boolean; responseDelayMs: number; model?: Model<any> }): {
	runtimeHost: AgentSessionRuntime;
	session: AgentSession;
	cleanup: () => Promise<void>;
} {
	const tempDir = join(tmpdir(), `pi-rpc-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const faux = options.model
		? undefined
		: registerFauxProvider({ api: "faux-rpc-prompt", provider: "faux-rpc-prompt" });
	faux?.setResponses([
		async () => {
			await sleep(options.responseDelayMs);
			return fauxAssistantMessage("done");
		},
	]);
	const model = options.model ?? faux!.getModel();

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: "Test",
			tools: [],
		},
	});

	const sessionManager = SessionManager.inMemory();
	const settingsManager = SettingsManager.create(tempDir, tempDir);
	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	const modelRegistry = ModelRegistry.create(authStorage, tempDir);
	if (options.withAuth) {
		authStorage.setRuntimeApiKey(model.provider, "test-key");
	}

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRegistry,
		resourceLoader: createTestResourceLoader(),
	});

	const runtimeHost = {
		session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;

	return {
		runtimeHost,
		session,
		cleanup: async () => {
			try {
				if (session.isStreaming) {
					await session.abort();
				}
			} catch {
				// ignore test cleanup failures
			}
			await session.disposeAsync();
			faux?.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true });
			}
		},
	};
}

async function startRpcMode(options: { withAuth: boolean; responseDelayMs: number; model?: Model<any> }): Promise<{
	lineHandler: (line: string) => void;
	session: AgentSession;
	cleanup: () => Promise<void>;
}> {
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;

	const { runtimeHost, session, cleanup } = createRuntimeHost(options);
	void runRpcMode(runtimeHost, DAEMON_PROTOCOL_VERSION);
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

	return { lineHandler: rpcIo.lineHandler!, session, cleanup };
}

describe("RPC prompt response semantics", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
		rpcIo.onOutput = undefined;
	});

	it("emits one failure response when prompt preflight rejects", async () => {
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: false,
			responseDelayMs: 0,
			model: {
				id: "fake-model",
				name: "Fake Model",
				api: "openai-completions",
				provider: "fake-provider",
				baseUrl: "https://example.invalid",
				reasoning: false,
				input: [],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 0,
				maxTokens: 0,
			},
		});

		try {
			lineHandler(JSON.stringify({ id: "b1", type: "prompt", message: "Hello" }));

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b1");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b1",
					type: "response",
					command: "prompt",
					success: false,
					error: expect.stringContaining(
						"No API key found for fake-provider.\n\nUse /login to log into a provider via OAuth or API key. See:",
					),
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("emits one success response when prompt preflight succeeds", async () => {
		const { lineHandler, session, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 250 });

		try {
			lineHandler(JSON.stringify({ id: "b2", type: "prompt", message: "Hello" }));

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b2");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b2",
					type: "response",
					command: "prompt",
					success: true,
				});
			});
			await vi.waitFor(() => {
				expect(parseOutputLines(rpcIo.outputLines).some((record) => record.type === "agent_start")).toBe(true);
			});
			expect(session.isStreaming).toBe(true);
		} finally {
			await cleanup();
		}
	});

	it("reports a late native request-budget failure after ACK while stdin stays open", async () => {
		const tempDir = join(tmpdir(), `rpc-native-refusal-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		const manager = await SessionManager.create(tempDir, tempDir);
		const model: Model<"openai-responses"> = {
			...getModel("openai", "gpt-4.1"),
			api: "openai-responses",
			baseUrl: "https://example.invalid/v1",
			contextWindow: 128,
			maxTokens: 16,
		};
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected diagnostic network send"));
		let session: AgentSession | undefined;
		try {
			({ session } = await createAgentSession({
				cwd: tempDir,
				agentDir: tempDir,
				sessionManager: manager,
				model,
				authStorage: AuthStorage.inMemory({ openai: { type: "api_key", key: "offline-test" } }),
				settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
				resourceLoader: createTestResourceLoader(),
				tools: [],
				includeGoals: false,
				includeCompactSkill: false,
				prewarmIpythonKernel: false,
				requestTokenBudget: {
					mode: "enforce",
					profiles: [
						{
							id: "offline-rpc-refusal",
							revision: "1",
							api: model.api,
							provider: model.provider,
							url: "https://example.invalid/v1/responses",
							model: model.id,
							authMode: "fixture-api-key",
							templateRevision: "responses-text-v1",
							replayFamily: "responses-text-v1",
							contextTokens: 128,
							outputCeilingTokens: 16,
							estimate: { tokensPerUtf8Byte: 1, templateTokens: 0, marginTokens: 16 },
						},
					],
				},
			}));
			const runtimeHost = { session, setRebindSession: vi.fn() } as unknown as AgentSessionRuntime;
			rpcIo.outputLines = [];
			rpcIo.lineHandler = undefined;
			void runRpcMode(runtimeHost, DAEMON_PROTOCOL_VERSION);
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

			const client = new RpcClient();
			rpcIo.onOutput = (line) => client["handleLine"](line);
			const failure = "Request token budget over-budget: configured context limit exceeded";
			const collected = expect(client.collectEvents()).rejects.toThrow(failure);
			const idle = expect(client.waitForIdle()).rejects.toThrow(failure);
			// Unrelated extension errors must not terminate either completion waiter.
			rpcIo.onOutput(
				JSON.stringify({
					type: "extension_error",
					extensionPath: "test-extension",
					event: "prompt_completion",
					error: "nonterminal",
				}),
			);
			rpcIo.onOutput(
				JSON.stringify({
					type: "extension_error",
					extensionPath: "<session-input>",
					event: "session_input",
					error: "nonterminal",
				}),
			);
			rpcIo.lineHandler!(JSON.stringify({ id: "late", type: "prompt", message: "Diagnostic request" }));
			await Promise.all([collected, idle]);

			const output = parseOutputLines(rpcIo.outputLines);
			expect(getPromptResponses(rpcIo.outputLines, "late")).toEqual([
				{ id: "late", type: "response", command: "prompt", success: true },
			]);
			const failures = output.filter((event) => event.type === "extension_error");
			expect(failures).toEqual([
				{
					type: "extension_error",
					extensionPath: "<session-input>",
					event: "prompt_completion",
					error: failure,
				},
			]);
			expect(output.findIndex((event) => event.type === "response")).toBeLessThan(
				output.findIndex((event) => event.type === "turn_start"),
			);
			expect(output.findIndex((event) => event.type === "turn_start")).toBeLessThan(output.indexOf(failures[0]));
			expect(
				output.some(
					(event) =>
						event.type === "agent_end" ||
						(event.type === "message_end" && (event.message as { role?: string }).role === "assistant"),
				),
			).toBe(false);
			expect(fetch).not.toHaveBeenCalled();
			expect(session.messages.some((message) => message.role === "assistant")).toBe(false);
		} finally {
			rpcIo.onOutput = undefined;
			fetch.mockRestore();
			if (session) await session.disposeAsync();
			else await manager.close();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("emits one success response when prompt is queued during streaming", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 100 });

		try {
			lineHandler(JSON.stringify({ id: "b3-start", type: "prompt", message: "Start" }));
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "b3-start")).toHaveLength(1);
			});

			rpcIo.outputLines = [];
			lineHandler(
				JSON.stringify({
					id: "b3",
					type: "prompt",
					message: "Queue this",
					streamingBehavior: "followUp",
				}),
			);

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b3");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b3",
					type: "response",
					command: "prompt",
					success: true,
				});
			});

			await sleep(150);
		} finally {
			await cleanup();
		}
	});

	it("preserves omitted global scope on RPC refine commands", async () => {
		const { lineHandler, session, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });
		const refine = vi.spyOn(session, "refine").mockResolvedValue({
			id: "refine_rpc",
			summary: "RPC refinement",
			rationale: "Test refine scope default",
			expectedOutcome: "Preserve local default",
			appliedEdits: [],
			harnessStatePath: "/tmp/harness_state.json",
			scope: "local",
		});

		try {
			lineHandler(JSON.stringify({ id: "r1", type: "refine", instructions: "record local lesson" }));

			await vi.waitFor(() => {
				expect(refine).toHaveBeenCalledWith({
					instructions: "record local lesson",
					rollbackId: undefined,
					global: undefined,
				});
				expect(parseOutputLines(rpcIo.outputLines)).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							id: "r1",
							type: "response",
							command: "refine",
							success: true,
						}),
					]),
				);
			});
		} finally {
			await cleanup();
		}
	});
});
