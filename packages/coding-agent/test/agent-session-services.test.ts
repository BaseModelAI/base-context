import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Model, RequestTokenBudgetError, registerFauxProvider } from "@ponythewhite/base-context-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_MESSAGE_SKILL_NAME, type AgentSessionMessageController } from "../src/core/agent-messages.js";
import { AGENT_OBSERVE_SKILL_NAME, type AgentObserveController } from "../src/core/agent-observe.js";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import {
	CanonicalContextCompiler,
	getCanonicalEpochContext,
	getCanonicalViewUnits,
} from "../src/core/canonical-context.js";
import { readContextEpoch } from "../src/core/context-epoch.js";
import { PUBLIC_CONTEXT_RENDERER } from "../src/core/public-context.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createSyntheticSourceInfo } from "../src/core/source-info.js";
import { emptyUsage } from "../src/core/usage.js";

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
			baseUrl: "https://api.openai.com/v1",
			reasoning: false,
			input: ["text"],
			contextWindow: 300_000,
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
		let epochManager = await SessionManager.create(epochDir, join(epochDir, "sessions"));
		await epochManager.appendMessage({
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			content: [{ type: "text", text: "OPTIONAL_PRIOR_LITERAL ".repeat(4000), textSignature: "msg_optional_prior" }],
			stopReason: "stop",
			usage: emptyUsage(),
			timestamp: 1,
		});
		const epochsAtSend: string[] = [];
		const bodies: string[] = [];
		const summaryBodies: string[] = [];
		let summarizing = false;
		const epochFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
			const epochs = await epochManager.readBranchHistory(async (history) => {
				const ids: string[] = [];
				for await (const item of history.iterateEntries({ maxEntries: 64, maxSourceBytes: 2 * 1024 * 1024 }))
					if (
						item.source.qualification === "native-context-epoch" &&
						item.entry.type === "compaction" &&
						readContextEpoch(item.entry.details, 2 * 1024 * 1024)?.representation
					)
						ids.push(item.source.id);
				return ids;
			});
			expect(epochs.length).toBeGreaterThan(0);
			if (summarizing) expect(epochs.at(-1)).toBe(epochsAtSend.at(-1));
			else epochsAtSend.push(epochs.at(-1)!);
			expect(typeof init?.body).toBe("string");
			(summarizing ? summaryBodies : bodies).push(init!.body as string);
			const requestRecovery = !summarizing && bodies.length === 4;
			const firstInput =
				bodies.length === 1 || requestRecovery
					? (await epochManager.readBranch()).find(
							(entry) =>
								entry.type === "message" &&
								entry.message.role === "user" &&
								(!requestRecovery || JSON.stringify(entry.message.content).includes("Also preserve Bar.txt.")),
						)
					: undefined;
			const item = firstInput
				? {
						type: "function_call",
						id: requestRecovery ? "fc_request_recovery" : "fc_epoch_recovery",
						call_id: requestRecovery ? "call_request_recovery" : "call_epoch_recovery",
						name: "prime_context",
						status: "completed",
						arguments: JSON.stringify({
							action: "recover",
							ref: firstInput.id,
							field: "/nativeOrigin/submitted/text",
							need: requestRecovery ? "Also preserve Bar.txt." : "Preserve Foo.txt.",
						}),
					}
				: {
						type: "message",
						id: `msg_epoch_${bodies.length + summaryBodies.length}`,
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "OK", annotations: [] }],
					};
			const opaqueTail = !summarizing && (bodies.length === 3 || requestRecovery);
			const reasoning = {
				type: "reasoning",
				id: requestRecovery ? "rs_opaque_request" : "rs_opaque_tail",
				summary: [],
				encrypted_content: requestRecovery ? "OPAQUE_REQUEST_CANONICAL_ONLY" : "OPAQUE_TAIL_CANONICAL_ONLY",
			};
			const sse = [
				...(opaqueTail
					? [
							{ type: "response.output_item.added", output_index: 0, item: reasoning },
							{ type: "response.output_item.done", output_index: 0, item: reasoning },
						]
					: []),
				{
					type: "response.output_item.added",
					output_index: opaqueTail ? 1 : 0,
					item: { ...item, status: "in_progress", content: [] },
				},
				{ type: "response.output_item.done", output_index: opaqueTail ? 1 : 0, item },
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
		const epochOptions: Omit<Parameters<typeof createAgentSessionFromServices>[0], "sessionManager"> = {
			services: epochServices,
			model,
			tools: ["prime_context"],
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
						url: "https://api.openai.com/v1/responses",
						model: model.id,
						authMode: "fixture-api-key",
						templateRevision: "responses-text-v1",
						replayFamily: "responses-text-v1",
						contextTokens: 300_000,
						outputCeilingTokens: 16,
						estimate: { tokensPerUtf8Byte: 1, templateTokens: 8, marginTokens: 16 },
					},
				],
			},
		};
		let epochSession: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
		try {
			({ session: epochSession } = await createAgentSessionFromServices({
				...epochOptions,
				sessionManager: epochManager,
			}));
			await epochSession.prompt("Preserve Foo.txt.");
			await epochSession.prompt(`Also preserve Bar.txt.\n${"New required context. ".repeat(12000)}`);
			expect(epochsAtSend).toHaveLength(3);
			// A same-task tool continuation may reuse its ACK; eviction must commit a new boundary.
			expect(epochsAtSend[2]).not.toBe(epochsAtSend[1]);
			expect(bodies).toHaveLength(3);
			expect(bodies[0]).toContain("OPTIONAL_PRIOR_LITERAL");
			expect(bodies[1]).toContain("OPTIONAL_PRIOR_LITERAL");
			expect(bodies[2]).not.toContain("OPTIONAL_PRIOR_LITERAL");
			const firstBody = JSON.parse(bodies[0]);
			const secondBody = JSON.parse(bodies[1]);
			// The acknowledged prefix stays literal during the same-task tool continuation.
			expect(secondBody.input.slice(0, firstBody.input.length)).toEqual(firstBody.input);
			// An ordinary summary consumes selected historical views, then the next main request commits a new epoch.
			summarizing = true;
			const originalRecovery = epochSession.messages.find(
				(message) => message.role === "toolResult" && message.toolName === "prime_context",
			);
			expect(originalRecovery).toBeDefined();
			if (originalRecovery?.role !== "toolResult" || originalRecovery.content[0]?.type !== "text")
				throw new Error("Expected native selected recovery data");
			expect(originalRecovery.isError).toBe(false);
			expect(JSON.parse(originalRecovery.content[0].text).results[0].records[0]).toMatchObject({
				text: "Preserve Foo.txt.",
			});
			const summary = await epochSession.compact();
			summarizing = false;
			const afterSummary = await epochManager.readBranchHistory((history) =>
				new CanonicalContextCompiler().compile(
					history.branchContext,
					epochSession!.settingsManager.getCanonicalContextLimits(),
				),
			);
			expect(afterSummary.filter((message) => message.role === "compactionSummary")).toHaveLength(1);
			const publicRecovery = afterSummary.find(
				(message) =>
					message.role === "custom" &&
					message.customType === PUBLIC_CONTEXT_RENDERER &&
					typeof message.content === "string" &&
					message.content.includes("call_epoch_recovery") &&
					message.content.includes('"role":"toolResult"'),
			);
			expect(publicRecovery?.role).toBe("custom");
			if (publicRecovery?.role !== "custom" || typeof publicRecovery.content !== "string")
				throw new Error("Expected public recovery evidence");
			const publicData = JSON.parse(publicRecovery.content.slice(publicRecovery.content.indexOf("\n") + 1));
			expect(publicData).toMatchObject({
				role: originalRecovery.role,
				toolCallId: originalRecovery.toolCallId,
				toolName: originalRecovery.toolName,
				isError: originalRecovery.isError,
				content: originalRecovery.content,
			});
			expect(getCanonicalEpochContext(afterSummary)?.checkpoint?.continuation?.kind).toBe("harness-summary");
			expect(JSON.stringify(afterSummary)).not.toContain("OPAQUE_TAIL_CANONICAL_ONLY");
			const archived = await epochManager.readBranch();
			expect(
				archived.some(
					(entry) =>
						entry.type === "message" && JSON.stringify(entry.message).includes("OPAQUE_TAIL_CANONICAL_ONLY"),
				),
			).toBe(true);
			expect(
				archived.some(
					(entry) =>
						entry.type === "message" && JSON.stringify(entry.message) === JSON.stringify(originalRecovery),
				),
			).toBe(true);
			expect(getCanonicalViewUnits(afterSummary)?.filter((unit) => unit.kind === "recovery")).toHaveLength(1);
			expect(
				afterSummary.some((message) => message.role === "compactionSummary" && message.summary === summary.summary),
			).toBe(true);
			const epochFile = epochManager.getSessionFile()!;
			await epochSession.disposeAsync({ kernelSnapshot: false });
			await epochManager.close();
			epochManager = await SessionManager.open(epochFile);
			({ session: epochSession } = await createAgentSessionFromServices({
				...epochOptions,
				sessionManager: epochManager,
			}));
			expect(summaryBodies).toHaveLength(1);
			expect(summaryBodies[0]).toContain("Preserve Foo.txt.");
			expect(summaryBodies[0]).not.toContain("OPTIONAL_PRIOR_LITERAL");
			await epochSession.prompt("Continue with both files.");
			expect(epochsAtSend).toHaveLength(5);
			expect(epochsAtSend[3]).not.toBe(epochsAtSend[2]);
			expect(bodies).toHaveLength(5);
			expect(bodies[3]).toContain("Foo.txt.");
			expect(bodies[3]).toContain("Bar.txt.");
			expect(bodies[3]).toContain("call_epoch_recovery");
			expect(bodies[3]).not.toContain("OPTIONAL_PRIOR_LITERAL");
			expect(epochSession.messages).toContainEqual(publicRecovery);
			expect(bodies[3]).not.toContain("OPAQUE_TAIL_CANONICAL_ONLY");
			const publicBody = JSON.parse(bodies[3]);
			expect(
				publicBody.input.some(
					(item: { type?: string }) =>
						item.type === "function_call" || item.type === "function_call_output" || item.type === "reasoning",
				),
			).toBe(false);
			expect(
				publicBody.input.some(
					(item: { role?: string; content?: unknown }) =>
						item.role === "user" && JSON.stringify(item.content).includes("Also preserve Bar.txt."),
				),
			).toBe(true);
			// A new opaque/tool response has no accepted recovery prefix. The actual next request
			// switches to public data without another summarizer call, before ACK/adoption/send.
			expect(epochsAtSend[4]).not.toBe(epochsAtSend[3]);
			expect(bodies[4]).toContain("call_request_recovery");
			expect(bodies[4]).toContain("Also preserve Bar.txt.");
			expect(bodies[4]).not.toContain("OPAQUE_REQUEST_CANONICAL_ONLY");
			const portableBody = JSON.parse(bodies[4]);
			expect(
				portableBody.input.some((item: { type?: string }) =>
					["reasoning", "function_call", "function_call_output"].includes(item.type ?? ""),
				),
			).toBe(false);
			const portableEntries = await epochManager.readBranch();
			const portableControl = portableEntries.find((entry) => entry.id === epochsAtSend[4]);
			expect(portableControl).toMatchObject({ type: "compaction", tokensBefore: null });
			if (portableControl?.type !== "compaction") throw new Error("Expected public request epoch");
			expect(portableControl.usage).toBeUndefined();
			expect(readContextEpoch(portableControl.details, 2 * 1024 * 1024)?.continuation?.kind).toBe(
				"portable-checkpoint",
			);
			const requestedRecovery = portableEntries.find(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolCallId.includes("call_request_recovery"),
			);
			expect(requestedRecovery?.type).toBe("message");
			if (
				requestedRecovery?.type !== "message" ||
				requestedRecovery.message.role !== "toolResult" ||
				requestedRecovery.message.content[0]?.type !== "text"
			)
				throw new Error("Expected new native recovery");
			expect(JSON.parse(requestedRecovery.message.content[0].text).results[0].records[0].text).toBe(
				"Also preserve Bar.txt.",
			);
			expect(JSON.stringify(portableEntries)).toContain("OPAQUE_REQUEST_CANONICAL_ONLY");
			const publicRequestMessages = epochSession.messages.filter(
				(message) => message.role === "custom" && message.customType === PUBLIC_CONTEXT_RENDERER,
			);
			for (const message of publicRequestMessages) {
				if (message.role !== "custom") throw new Error("Expected adopted public history");
				expect(
					portableBody.input.some(
						(item: { content?: unknown }) =>
							JSON.stringify(item.content) === JSON.stringify([{ type: "input_text", text: message.content }]),
					),
				).toBe(true);
			}
			await epochSession.disposeAsync({ kernelSnapshot: false });
			await epochManager.close();
			epochManager = await SessionManager.open(epochFile);
			({ session: epochSession } = await createAgentSessionFromServices({
				...epochOptions,
				sessionManager: epochManager,
			}));
			const reopenedPublic = await epochManager.readBranchHistory((history) =>
				new CanonicalContextCompiler().compile(
					history.branchContext,
					epochSession!.settingsManager.getCanonicalContextLimits(),
				),
			);
			for (const message of publicRequestMessages) expect(reopenedPublic).toContainEqual(message);
			expect(getCanonicalEpochContext(reopenedPublic)?.checkpoint?.continuation?.kind).toBe("portable-checkpoint");
			expect(summaryBodies).toHaveLength(1);
			// Native fork and retained import must rebuild the public cutoff and recipes in the destination.
			const sourceManager = epochManager;
			for (const retained of [false, true]) {
				const destination = retained
					? await SessionManager.importRetainedFrom(
							sourceManager.getSessionFile()!,
							epochDir,
							join(epochDir, "public-import"),
						)
					: await sourceManager.forkBranch(sourceManager.getLeafId(), {
							sessionDir: join(epochDir, "public-fork"),
						});
				let copiedSession: typeof epochSession | undefined;
				try {
					epochManager = destination;
					const copied = await destination.readBranchHistory((history) =>
						new CanonicalContextCompiler().compile(
							history.branchContext,
							epochSession!.settingsManager.getCanonicalContextLimits(),
						),
					);
					const checkpoint = getCanonicalEpochContext(copied)!.checkpoint!;
					expect(checkpoint.publicWindow).toBeUndefined();
					expect(checkpoint.continuation?.kind).toBe("portable-checkpoint");
					const copiedControls = (await destination.readBranch()).filter((entry) => entry.type === "compaction");
					expect(copiedControls.at(-1)?.tokensBefore).toBeNull();
					expect(copiedControls.at(-1)?.usage).toBeUndefined();
					for (const message of publicRequestMessages) expect(copied).toContainEqual(message);
					expect(checkpoint.continuation?.publicTailThrough).toMatchObject({
						sessionId: destination.getSessionId(),
						sessionFile: destination.getSessionFile(),
						persistent: true,
					});
					for (const view of checkpoint.views) {
						expect(view.source.sessionId).toBe(destination.getSessionId());
						expect(view.ref.locator.path).toBe(destination.getSessionFile());
					}
					expect(copied).toContainEqual(publicRecovery);
					expect(getCanonicalViewUnits(copied)?.filter((unit) => unit.kind === "recovery")).toHaveLength(
						retained ? 0 : 2,
					);
					expect(JSON.stringify(await destination.readBranch())).toContain("OPAQUE_TAIL_CANONICAL_ONLY");
					({ session: copiedSession } = await createAgentSessionFromServices({
						...epochOptions,
						sessionManager: destination,
					}));
					await copiedSession.prompt("Continue from the public checkpoint.");
					expect(bodies.at(-1)).toContain("call_epoch_recovery");
					expect(bodies.at(-1)).not.toContain("OPAQUE_TAIL_CANONICAL_ONLY");
					expect(bodies.at(-1)).not.toContain("OPTIONAL_PRIOR_LITERAL");
				} finally {
					epochManager = sourceManager;
					try {
						await copiedSession?.disposeAsync({ kernelSnapshot: false });
					} finally {
						await destination.close();
					}
				}
			}
			expect(bodies).toHaveLength(7);
			expect(summaryBodies).toHaveLength(1);
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
