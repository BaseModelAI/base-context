import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@ponythewhite/base-context-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AuthSourceToken, AuthStorage } from "../src/core/auth-storage.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.js";

describe("createAgentSession session manager defaults", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-sdk-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("uses agentDir for the default persisted session path", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			tools: [],
			includeGoals: false,
			prewarmIpythonKernel: false,
		});

		const expectedSessionDir = join(agentDir, "sessions");
		const sessionFile = session.sessionManager.getSessionFile()!;
		const restoredModel = getModel("openai", "gpt-5.6-sol");
		try {
			expect(session.sessionManager.getSessionDir()).toBe(expectedSessionDir);
			expect(sessionFile.startsWith(`${expectedSessionDir}/`)).toBe(true);
			await session.sessionManager.appendMessage({ role: "user", content: "Canonical-only input", timestamp: 1 });
			// Historical data only. Error assistants remain model-setting producers.
			await session.sessionManager.appendMessage({
				role: "assistant",
				content: [],
				api: restoredModel.api,
				provider: restoredModel.provider,
				model: restoredModel.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "error",
				errorMessage: "Historical failure",
				timestamp: 2,
			});
			await session.sessionManager.appendThinkingLevelChange("off");
		} finally {
			await session.disposeAsync();
		}

		const reopened = await SessionManager.open(sessionFile);
		const liveContext = vi.spyOn(reopened, "buildSessionContext").mockImplementation(() => {
			throw new Error("Persistent SDK bootstrap must use captured history");
		});
		const { session: resumed } = await createAgentSession({
			cwd,
			agentDir,
			sessionManager: reopened,
			authStorage: AuthStorage.inMemory({ openai: { type: "api_key", key: "offline-fixture-key" } }),
			tools: [],
			includeGoals: false,
			prewarmIpythonKernel: false,
		});
		try {
			expect(resumed.model?.id).toBe(restoredModel.id);
			expect(resumed.model?.provider).toBe(restoredModel.provider);
			expect(resumed.messages[0]).toMatchObject({ role: "user", content: "Canonical-only input" });
			expect(resumed.thinkingLevel).toBe("off");
			expect((await reopened.readEntries()).filter((entry) => entry.type === "thinking_level_change")).toHaveLength(
				2,
			);
			expect((await reopened.readEntries()).filter((entry) => entry.type === "service_tier_change")).toHaveLength(1);
			expect(liveContext).not.toHaveBeenCalled();
		} finally {
			await resumed.disposeAsync();
		}
	});

	it("keeps an unavailable session selection instead of using another saved model", async () => {
		const sessionManager = SessionManager.inMemory(cwd);
		await sessionManager.appendModelChange("openai", "unavailable-model");
		await sessionManager.appendMessage({ role: "user", content: "Existing session", timestamp: 1 });
		const { session, modelFallbackMessage } = await createAgentSession({
			cwd,
			agentDir,
			sessionManager,
			authStorage: AuthStorage.inMemory({ anthropic: { type: "api_key", key: "offline-fixture-key" } }),
			settingsManager: SettingsManager.inMemory({
				defaultProvider: "anthropic",
				defaultModel: "claude-sonnet-4-5",
			}),
			tools: [],
			includeGoals: false,
			prewarmIpythonKernel: false,
		});
		try {
			expect(session.model).toBeUndefined();
			expect(session.agent.state.model).toBeUndefined();
			expect(modelFallbackMessage).toContain("Could not restore model openai/unavailable-model");
			expect(modelFallbackMessage).not.toContain("Using");
		} finally {
			await session.disposeAsync();
		}
	});

	it.each([false, true])(
		"keeps an explicit unselected model without restoring saved choices (session=%s)",
		async (savedSession) => {
			const sessionManager = SessionManager.inMemory(cwd);
			if (savedSession) {
				await sessionManager.appendModelChange("openai", "gpt-4o-mini");
				await sessionManager.appendMessage({ role: "user", content: "Existing session", timestamp: 1 });
			}
			const { session } = await createAgentSession({
				cwd,
				agentDir,
				model: null,
				sessionManager,
				authStorage: AuthStorage.inMemory({ openai: { type: "api_key", key: "offline-fixture-key" } }),
				settingsManager: SettingsManager.inMemory({ defaultProvider: "openai", defaultModel: "gpt-4o-mini" }),
				tools: [],
				includeGoals: false,
				prewarmIpythonKernel: false,
			});
			try {
				expect(session.model).toBeUndefined();
				expect(session.agent.state.model).toBeUndefined();
			} finally {
				await session.disposeAsync();
			}
		},
	);

	it("keeps a supported saved model selected when its provider needs authentication", async () => {
		const authStorage = AuthStorage.inMemory();
		const { session, modelFallbackMessage } = await createAgentSession({
			cwd,
			agentDir,
			sessionManager: SessionManager.inMemory(cwd),
			authStorage,
			settingsManager: SettingsManager.inMemory({
				defaultProvider: "openai",
				defaultModel: "gpt-4o-mini",
			}),
			tools: [],
			includeGoals: false,
			prewarmIpythonKernel: false,
		});
		try {
			expect(session.model?.provider).toBe("openai");
			expect(session.model?.id).toBe("gpt-4o-mini");
			expect(modelFallbackMessage).toContain("openai/gpt-4o-mini needs authentication");
			expect(authStorage.hasAuth("openai")).toBe(false);
			const transport = vi.spyOn(globalThis, "fetch");
			try {
				await expect(session.prompt("hello")).rejects.toThrow("No API key found for openai");
				expect(transport).not.toHaveBeenCalled();
			} finally {
				transport.mockRestore();
			}
		} finally {
			await session.disposeAsync();
		}
	});

	it("marks the native request's auth source stale without invalidating a replacement credential", async () => {
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey("openai", "offline-original-key");
		const extensionsResult = await createTestExtensionsResult(
			[
				(api) => {
					api.on("message_end", (event) => {
						if (event.message.role === "assistant") {
							return { message: { ...event.message, content: [{ type: "text", text: "Replaced result" }] } };
						}
					});
				},
			],
			cwd,
		);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: getModel("openai", "gpt-4o-mini"),
			authStorage,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.inMemory({ retry: { enabled: true, provider: { maxRetries: 0 } } }),
			resourceLoader: createTestResourceLoader({ extensionsResult }),
			tools: [],
			includeGoals: false,
			prewarmIpythonKernel: false,
		});
		const sourceTokens: AuthSourceToken[] = [];
		const resolveAuth = session.modelRegistry.getApiKeyAndHeaders.bind(session.modelRegistry);
		const authLookup = vi.spyOn(session.modelRegistry, "getApiKeyAndHeaders").mockImplementation(async (model) => {
			const auth = await resolveAuth(model);
			if (auth.ok && auth.sourceToken) sourceTokens.push(auth.sourceToken);
			return auth;
		});
		const markSource = vi.spyOn(authStorage, "markAuthSourceStale");
		const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			authStorage.setRuntimeApiKey("openai", "offline-replacement-key");
			return new Response(JSON.stringify({ error: { message: "Invalid API key", type: "authentication_error" } }), {
				status: 401,
				headers: { "content-type": "application/json" },
			});
		});
		try {
			await session.prompt("hello");
			await session.waitForIdle();
			expect(transport).toHaveBeenCalledOnce();
			expect(authLookup).toHaveBeenCalledOnce();
			expect(sourceTokens).toMatchObject([{ provider: "openai", source: "runtime" }]);
			expect(markSource).toHaveBeenCalledExactlyOnceWith(sourceTokens[0]);
			const assistant = session.messages
				.slice()
				.reverse()
				.find((message) => message.role === "assistant");
			expect(assistant?.content).toEqual([{ type: "text", text: "Replaced result" }]);
			await expect(authStorage.getApiKey("openai")).resolves.toBe("offline-replacement-key");
			expect(session.isRetrying).toBe(false);
			expect(session.agent.state.isStreaming).toBe(false);
		} finally {
			transport.mockRestore();
			await session.disposeAsync();
		}
	});

	it("keeps an explicit sessionManager override", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const sessionManager = SessionManager.inMemory(cwd);
		await sessionManager.appendMessage({ role: "user", content: "Existing session", timestamp: 1 });
		await sessionManager.appendThinkingLevelChange("off");
		await sessionManager.appendServiceTierChange("default");
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			sessionManager,
			tools: [],
			includeGoals: false,
			prewarmIpythonKernel: false,
		});

		expect(session.sessionManager).toBe(sessionManager);
		expect(session.sessionManager.isPersisted()).toBe(false);
		expect(session.thinkingLevel).toBe("off");
		expect(sessionManager.getEntries().filter((entry) => entry.type === "thinking_level_change")).toHaveLength(1);
		expect(sessionManager.getEntries().filter((entry) => entry.type === "service_tier_change")).toHaveLength(1);

		await session.disposeAsync();
	});

	it("derives cwd from an explicit sessionManager when cwd is omitted", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const sessionCwd = join(tempDir, "session-project");
		mkdirSync(sessionCwd, { recursive: true });
		const sessionManager = SessionManager.inMemory(sessionCwd);
		const { session } = await createAgentSession({
			agentDir,
			model: model!,
			sessionManager,
			tools: ["ipython"],
		});

		expect(session.sessionManager).toBe(sessionManager);
		expect(session.systemPrompt).toContain(`Working directory: ${sessionCwd}`);

		const ipythonTool = session.agent.state.tools.find((tool) => tool.name === "ipython");
		expect(ipythonTool).toBeTruthy();
		const result = await ipythonTool!.execute("test", { code: "import os\nprint(os.getcwd())" });
		const output = result.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("");

		expect(realpathSync(output.trim())).toBe(realpathSync(sessionCwd));

		session.dispose();
	}, 120_000);
});
