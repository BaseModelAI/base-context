import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Model, RequestTokenBudgetError, registerFauxProvider } from "@ponythewhite/base-context-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_MESSAGE_SKILL_NAME, type AgentSessionMessageController } from "../src/core/agent-messages.js";
import { AGENT_OBSERVE_SKILL_NAME, type AgentObserveController } from "../src/core/agent-observe.js";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createSyntheticSourceInfo } from "../src/core/source-info.js";

describe("createAgentSessionFromServices", () => {
	const cleanupPaths: string[] = [];
	const unregisters: Array<() => void> = [];

	afterEach(() => {
		vi.unstubAllEnvs();
		while (unregisters.length > 0) {
			unregisters.pop()?.();
		}
		while (cleanupPaths.length > 0) {
			const path = cleanupPaths.pop();
			if (path && existsSync(path)) {
				rmSync(path, { recursive: true, force: true });
			}
		}
	});

	it("shows the telemetry disclosure independently of the Herdr reporter", async () => {
		vi.stubEnv("DO_NOT_TRACK", "0");
		vi.stubEnv("BASE_CONTEXT_TELEMETRY", "1");
		const tempDir = join(tmpdir(), `pi-session-telemetry-notice-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		cleanupPaths.push(tempDir);
		const settingsManager = SettingsManager.inMemory();

		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			settingsManager,
			noBuiltinHerdrReporter: true,
			resourceLoaderOptions: { noPromptTemplates: true, noThemes: true },
		});

		expect(services.diagnostics).toContainEqual(
			expect.objectContaining({
				type: "info",
				message: expect.stringContaining("Base Context analytics are opt-in"),
			}),
		);
		expect(settingsManager.getTelemetryNoticeShown()).toBe(true);
	});

	it("honors an explicit daemon-carried telemetry opt-out", async () => {
		vi.stubEnv("DO_NOT_TRACK", "0");
		vi.stubEnv("BASE_CONTEXT_TELEMETRY", "1");
		const tempDir = join(tmpdir(), `pi-session-daemon-telemetry-opt-out-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		cleanupPaths.push(tempDir);
		const settingsManager = SettingsManager.inMemory();
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			settingsManager,
			telemetryDisabled: true,
			resourceLoaderOptions: { noPromptTemplates: true, noThemes: true },
		});

		expect(services.diagnostics).not.toContainEqual(
			expect.objectContaining({ message: expect.stringContaining("Base Context analytics are opt-in") }),
		);
		expect(settingsManager.getTelemetryNoticeShown()).toBe(false);

		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: await SessionManager.create(tempDir, join(tempDir, "sessions")),
			telemetryDisabled: true,
			requestTokenBudget: { mode: "enforce", profiles: [] },
		});
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unbudgeted service request sent"));
		try {
			expect(existsSync(join(tempDir, "telemetry.json"))).toBe(false);
			const model: Model<"openai-responses"> = {
				id: "offline-services",
				name: "Offline services",
				api: "openai-responses",
				provider: "openai",
				baseUrl: "https://example.invalid/v1",
				reasoning: false,
				input: ["text"],
				contextWindow: 1024,
				maxTokens: 16,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			};
			await expect(
				session.requests.complete(
					model,
					{ messages: [] },
					{ apiKey: "offline-services-key", maxRetries: 0 },
					{ purpose: "main" },
				),
			).rejects.toBeInstanceOf(RequestTokenBudgetError);
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
			await session.disposeAsync();
		}

		// Actual service -> AgentSession -> final native body -> canonical epoch ACK.
		const epochDir = join(tempDir, "epoch-native");
		mkdirSync(epochDir);
		const epochServices = await createAgentSessionServices({
			cwd: epochDir,
			agentDir: epochDir,
			authStorage: AuthStorage.inMemory(),
			telemetryDisabled: true,
			settingsManager: SettingsManager.inMemory({
				compaction: { enabled: false, reserveTokens: 16, keepRecentTokens: 4 },
				autoRefine: { enabled: false },
				retry: { enabled: false },
			}),
			resourceLoaderOptions: { noExtensions: true, noPromptTemplates: true, noThemes: true },
		});
		const model: Model<"openai-responses"> = {
			id: "offline-epoch-services",
			name: "Offline epoch services",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://example.invalid/v1",
			reasoning: false,
			input: ["text"],
			contextWindow: 500_000,
			maxTokens: 16,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		epochServices.modelRegistry.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "offline-epoch-key",
			api: model.api,
			models: [
				{
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					cost: model.cost,
				},
			],
		});
		const epochManager = await SessionManager.create(epochDir, join(epochDir, "sessions"));
		const epochsAtSend: string[] = [];
		const bodies: string[] = [];
		const summaryBodies: string[] = [];
		let summarizing = false;
		const epochFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
			const epochs = await epochManager.readBranchHistory(async (history) => {
				const ids: string[] = [];
				for await (const item of history.iterateEntries({ maxEntries: 64, maxSourceBytes: 2 * 1024 * 1024 }))
					if (item.source.qualification === "native-context-epoch") ids.push(item.source.id);
				return ids;
			});
			expect(epochs).toHaveLength(summarizing ? 2 : bodies.length + 1);
			if (!summarizing) epochsAtSend.push(epochs.at(-1)!);
			expect(typeof init?.body).toBe("string");
			(summarizing ? summaryBodies : bodies).push(init!.body as string);
			const item = {
				type: "message",
				id: `msg_epoch_${bodies.length + summaryBodies.length}`,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "OK", annotations: [] }],
			};
			const sse = [
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { ...item, status: "in_progress", content: [] },
				},
				{ type: "response.output_item.done", output_index: 0, item },
				{
					type: "response.completed",
					response: {
						id: `resp_epoch_${bodies.length + summaryBodies.length}`,
						model: model.id,
						status: "completed",
						usage: {
							input_tokens: 10,
							output_tokens: 1,
							total_tokens: 11,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				},
			]
				.map((event) => `data: ${JSON.stringify(event)}\n\n`)
				.join("");
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		});
		let epochSession: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
		try {
			({ session: epochSession } = await createAgentSessionFromServices({
				services: epochServices,
				sessionManager: epochManager,
				model,
				tools: [],
				noTools: "all",
				includeGoals: false,
				includeCompactSkill: false,
				prewarmIpythonKernel: false,
				telemetryDisabled: true,
				requestTokenBudget: {
					mode: "enforce",
					profiles: [
						{
							id: "offline-epoch",
							revision: "1",
							api: model.api,
							provider: model.provider,
							url: "https://example.invalid/v1/responses",
							model: model.id,
							authMode: "fixture-api-key",
							templateRevision: "responses-text-v1",
							replayFamily: "responses-text-v1",
							contextTokens: 500_000,
							outputCeilingTokens: 16,
							estimate: { tokensPerUtf8Byte: 1, templateTokens: 8, marginTokens: 16 },
						},
					],
				},
			}));
			await epochSession.prompt("Preserve Foo.txt.");
			await epochSession.prompt("Also preserve Bar.txt.");
			expect(new Set(epochsAtSend).size).toBe(2);
			expect(bodies).toHaveLength(2);
			const firstBody = JSON.parse(bodies[0]);
			const secondBody = JSON.parse(bodies[1]);
			// The original task frame and input remain literal prefix items after the next ACK.
			expect(secondBody.input.slice(0, firstBody.input.length)).toEqual(firstBody.input);
			// An ordinary summary consumes selected historical views, then the next main request commits a new epoch.
			summarizing = true;
			await epochSession.compact();
			summarizing = false;
			expect(summaryBodies).toHaveLength(1);
			expect(summaryBodies[0]).toContain("Preserve Foo.txt.");
			await epochSession.prompt("Continue with both files.");
			expect(new Set(epochsAtSend).size).toBe(3);
			expect(bodies).toHaveLength(3);
			expect(bodies[2]).toContain("Foo.txt.");
			expect(bodies[2]).toContain("Bar.txt.");
		} finally {
			try {
				await epochSession?.disposeAsync({ kernelSnapshot: false });
			} finally {
				epochFetch.mockRestore();
				await epochManager.close();
			}
		}
	});

	it("does not install top-level telemetry for a resumed child session", async () => {
		vi.stubEnv("DO_NOT_TRACK", "0");
		vi.stubEnv("BASE_CONTEXT_TELEMETRY", "1");
		const tempDir = join(tmpdir(), `pi-session-child-telemetry-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		cleanupPaths.push(tempDir);
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			settingsManager: SettingsManager.inMemory({ telemetry: { noticeShown: true } }),
			resourceLoaderOptions: { noPromptTemplates: true, noThemes: true },
		});
		const sessionManager = await SessionManager.create(tempDir, join(tempDir, "sessions"));
		await sessionManager.newSession({ rlmDepth: 1 });

		const { session } = await createAgentSessionFromServices({ services, sessionManager });
		try {
			expect(session.rlmDepth).toBe(1);
			expect(existsSync(join(tempDir, "telemetry.json"))).toBe(false);
		} finally {
			await session.disposeAsync();
		}
		const invalidManager = await SessionManager.create(tempDir, join(tempDir, "invalid-budget"));
		try {
			await expect(
				createAgentSessionFromServices({
					services,
					sessionManager: invalidManager,
					telemetryDisabled: true,
					// Invalid runtime configuration must reach the SDK validator, not disappear in the factory.
					requestTokenBudget: { mode: "invalid" as "enforce", profiles: [] },
				}),
			).rejects.toThrow("Invalid request token budget mode");
		} finally {
			await invalidManager.close();
		}
	});

	it("advertises enabled generic MCP servers and refreshes the prompt on reload", async () => {
		const tempDir = join(tmpdir(), `pi-session-mcp-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const projectDir = join(tempDir, "project");
		const agentDir = join(tempDir, "agent");
		mkdirSync(join(projectDir, ".prime", "agent"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		cleanupPaths.push(tempDir);

		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				mcpServers: {
					zebra: { type: "http", url: "https://secret.example/mcp", headers: { Authorization: "secret" } },
					filesystem: {
						type: "stdio",
						command: "/secret/bin/filesystem",
						args: ["/private/data"],
						cwd: "/secret/cwd",
						env: { TOKEN: { env: "FILESYSTEM_SECRET" } },
					},
					disabled: { type: "stdio", command: "disabled-secret", enabled: false },
					linear: { type: "stdio", command: "reserved-secret" },
				},
			}),
		);
		writeFileSync(
			join(projectDir, ".prime", "agent", "settings.json"),
			JSON.stringify({ mcpServers: { projectOnly: { type: "stdio", command: "project-secret" } } }),
		);

		const settingsManager = SettingsManager.create(projectDir, agentDir);
		const services = await createAgentSessionServices({
			cwd: projectDir,
			agentDir,
			settingsManager,
			resourceLoaderOptions: { noPromptTemplates: true, noThemes: true },
		});
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: await SessionManager.create(projectDir, join(tempDir, "sessions")),
		});

		try {
			const initialPrompt = session.systemPrompt;
			expect(initialPrompt).toContain(
				"Generic MCP connections are accessed through the pre-imported Python `mcp` object in the Python REPL, not as top-level native tool namespaces or installed Python skills.",
			);
			expect(initialPrompt).toContain("Enabled generic MCP servers: `filesystem`, `zebra`.");
			expect(initialPrompt).toContain('await mcp.list_tools("filesystem")');
			expect(initialPrompt).toContain('await mcp.call_tool("filesystem", "<tool>", arguments)');
			for (const hidden of [
				"disabled",
				"projectOnly",
				"https://secret.example/mcp",
				"Authorization",
				"/secret/bin/filesystem",
				"/private/data",
				"/secret/cwd",
				"FILESYSTEM_SECRET",
				"reserved-secret",
			]) {
				expect(initialPrompt).not.toContain(hidden);
			}
			expect(initialPrompt).not.toContain("Enabled generic MCP servers: `linear`");

			const rebuildRuntime = vi.spyOn(
				session as unknown as { _rebuildRuntimeForAcpMcpServers(): void },
				"_rebuildRuntimeForAcpMcpServers",
			);
			session.replaceAcpMcpServers(
				[
					{
						name: "task",
						type: "http",
						url: "https://task-secret.example/mcp",
						headers: { Authorization: "Bearer task-secret" },
					},
				],
				"owner-a",
			);
			expect(session.systemPrompt).toContain("Enabled generic MCP servers: `filesystem`, `zebra`.");
			expect(session.systemPrompt).not.toContain('await mcp.list_tools("task")');
			expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["mcp_list_tools_task", "mcp_call_task"]));
			expect(session.systemPrompt).not.toContain("task-secret");
			rebuildRuntime.mockClear();
			const waitForIdle = vi.spyOn(session.agent, "waitForIdle");
			await session.releaseAcpMcpServers("unknown-owner", ["task"]);
			expect(waitForIdle).not.toHaveBeenCalled();
			const originalProvisioner = Reflect.get(session, "_ipythonKernelProvisioner");
			const execute = vi.fn(async (_code: string) => ({ status: "ok" }));
			Reflect.set(session, "_ipythonKernelProvisioner", { manager: { isRunning: true, execute } });
			await session.releaseAcpMcpServers("owner-a", ["task"]);
			Reflect.set(session, "_ipythonKernelProvisioner", originalProvisioner);
			expect(rebuildRuntime).not.toHaveBeenCalled();
			expect(execute).toHaveBeenCalledOnce();
			expect(execute.mock.calls[0]?.[0]).toContain("await _prime_mcp.reload(_prime_mcp_name)");
			expect(execute.mock.calls[0]?.[0]).toContain('["task"]');
			expect(session.systemPrompt).toContain("Enabled generic MCP servers: `filesystem`, `zebra`.");
			expect(session.getAllTools().map((tool) => tool.name)).not.toContain("mcp_call_task");
			expect(session.getActiveToolNames()).not.toContain("mcp_call_task");

			settingsManager.setGlobalMcpServer("added", { type: "stdio", command: "new-secret" });
			settingsManager.removeGlobalMcpServer("filesystem");
			await settingsManager.flush();
			await session.reload();

			expect(session.systemPrompt).toContain("Enabled generic MCP servers: `added`, `zebra`.");
			expect(session.systemPrompt).toContain('await mcp.list_tools("added")');
			expect(session.systemPrompt).not.toContain('await mcp.list_tools("filesystem")');
			expect(session.systemPrompt).not.toContain("new-secret");
		} finally {
			await session.disposeAsync();
		}
	});

	it("forwards daemon-backed agent message controllers into AgentSession", async () => {
		const tempDir = join(tmpdir(), `pi-session-services-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		cleanupPaths.push(tempDir);

		const faux = registerFauxProvider();
		unregisters.push(() => faux.unregister());

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			resourceLoaderOptions: {
				noPromptTemplates: true,
				noThemes: true,
				skillsOverride: () => ({
					skills: [
						{
							name: AGENT_MESSAGE_SKILL_NAME,
							description: "hidden agent message skill",
							filePath: "<test:agent-message>",
							baseDir: tempDir,
							sourceInfo: createSyntheticSourceInfo("<test:agent-message>", { source: "test" }),
							disableModelInvocation: true,
							kind: "python" as const,
							python: {
								importName: "agent_message",
								packagePath: tempDir,
								pyprojectPath: join(tempDir, "pyproject.toml"),
							},
						},
					],
					diagnostics: [],
				}),
			},
		});
		services.modelRegistry.registerProvider(faux.getModel().provider, {
			baseUrl: faux.getModel().baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models,
		});

		const agentMessageController: AgentSessionMessageController = {
			listAgents: () => ({
				current: { activeSessionId: "current", sessionId: "session-current", runtimeKind: "top-level" },
				agents: [
					{
						activeSessionId: "worker",
						sessionId: "session-worker",
						runtimeKind: "top-level",
						cwd: tempDir,
						isStreaming: false,
						unfinishedActionCount: 0,
					},
				],
			}),
			sendAgentMessage: async () => {
				throw new Error("not used");
			},
		};

		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: await SessionManager.create(tempDir, join(tempDir, "sessions")),
			model: faux.getModel(),
			agentMessageController,
		});

		try {
			expect(() => session.handleAgentMessageHostRequest("agent_message.list")).toThrow(
				"unknown agent message request",
			);
			expect(
				(
					session as unknown as {
						_createKernelHostHandlers(): Record<string, unknown>;
					}
				)._createKernelHostHandlers(),
			).not.toHaveProperty("agent_message.send");
		} finally {
			await session.disposeAsync();
		}
	});

	it("hides daemon-backed orchestration skills unless their host bridges are available", async () => {
		const tempDir = join(tmpdir(), `pi-session-skills-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		cleanupPaths.push(tempDir);

		const authStorage = AuthStorage.inMemory();
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			resourceLoaderOptions: {
				noPromptTemplates: true,
				noThemes: true,
			},
		});

		const createSession = async (options: Parameters<typeof createAgentSessionFromServices>[0]) => {
			const { session } = await createAgentSessionFromServices(options);
			return session;
		};
		const visibleSkillNames = (session: unknown) =>
			(
				session as {
					_modelVisibleSkills(): Array<{ name: string }>;
				}
			)
				._modelVisibleSkills()
				.map((skill) => skill.name);
		const kernelHostHandlers = (session: unknown) =>
			(
				session as {
					_createKernelHostHandlers(): Record<string, unknown>;
				}
			)._createKernelHostHandlers();

		const withoutControllers = await createSession({
			services,
			sessionManager: await SessionManager.create(tempDir, join(tempDir, "sessions-without")),
		});
		try {
			expect(visibleSkillNames(withoutControllers)).not.toContain(AGENT_MESSAGE_SKILL_NAME);
			expect(visibleSkillNames(withoutControllers)).not.toContain(AGENT_OBSERVE_SKILL_NAME);
		} finally {
			await withoutControllers.disposeAsync();
		}

		const agentObserveController: AgentObserveController = {
			listAgents: () => ({
				current: {
					activeSessionId: "current",
					sessionId: "session-current",
					runtimeKind: "top-level",
					cwd: tempDir,
					status: "idle",
					isCurrent: true,
					isStreaming: false,
					isCompacting: false,
					attachedClients: 1,
					messageCount: 0,
					queuedCount: 0,
					isSessionActive: false,
				},
				agents: [],
			}),
			getAgent: () => {
				throw new Error("not used");
			},
			recentMessages: () => {
				throw new Error("not used");
			},
		};
		const withControllers = await createSession({
			services,
			sessionManager: await SessionManager.create(tempDir, join(tempDir, "sessions-with")),
			agentObserveController,
		});
		try {
			expect(visibleSkillNames(withControllers)).toContain(AGENT_OBSERVE_SKILL_NAME);
			expect(visibleSkillNames(withControllers)).not.toContain(AGENT_MESSAGE_SKILL_NAME);
		} finally {
			await withControllers.disposeAsync();
		}

		const agentMessageController: AgentSessionMessageController = {
			listAgents: () => ({
				current: { activeSessionId: "current", sessionId: "session-current" },
				agents: [],
			}),
			sendAgentMessage: async () => {
				throw new Error("not used");
			},
		};
		const withMessageController = await createSession({
			services,
			sessionManager: await SessionManager.create(tempDir, join(tempDir, "sessions-with-message")),
			agentMessageController,
		});
		try {
			expect(visibleSkillNames(withMessageController)).toContain(AGENT_MESSAGE_SKILL_NAME);
			expect(kernelHostHandlers(withMessageController)).toHaveProperty("agent_message.send");
		} finally {
			await withMessageController.disposeAsync();
		}
	});
});
