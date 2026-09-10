import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentOutputLimitError } from "@ponythewhite/base-context-agent";
import { type Model, RequestTokenBudgetError, registerFauxProvider } from "@ponythewhite/base-context-ai";
import { Type } from "typebox";
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
import type { NativeRecoveryInput } from "../src/core/selective-recovery.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { Skill } from "../src/core/skills.js";
import { createSyntheticSourceInfo } from "../src/core/source-info.js";
import type { TaskStateSourceRef } from "../src/core/task-state.js";
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
		const skillFixtures: Skill[] = [];
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
			resourceLoaderOptions: {
				noExtensions: true,
				noPromptTemplates: true,
				noThemes: true,
				noSkills: true,
				skillsOverride: () => ({ skills: skillFixtures, diagnostics: [] }),
			},
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
		let freshOff = false;
		let toolContinuationPhase: "intent" | "resumed" | undefined;
		let lateStateEntryId: string | undefined;
		let skillRequest: NativeRecoveryInput | undefined;
		type DisplaySource = Pick<TaskStateSourceRef, "sessionId" | "entryId" | "field" | "revision">;
		const epochFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
			const epochs = await epochManager.readBranchHistory(async (history) => {
				const ids: string[] = [];
				for await (const item of history.iterateEntries({ maxEntries: 64, maxSourceBytes: 2 * 1024 * 1024 }))
					if (item.source.qualification === "native-context-epoch" && item.entry.type === "compaction") {
						const checkpoint = readContextEpoch(item.entry.details, 2 * 1024 * 1024);
						if (checkpoint?.representation || checkpoint?.requestContract) ids.push(item.source.id);
					}
				return ids;
			});
			expect(epochs.length).toBeGreaterThan(0);
			const admitted = (await epochManager.readEntries())
				.filter((entry) => entry.type === "request")
				.map((entry) => entry.request)
				.filter((event) => event.type === "attempt_admitted")
				.at(-1);
			expect(admitted).toBeDefined();
			if (summarizing) expect(admitted?.contextEpoch).toBeUndefined();
			else
				expect(admitted?.contextEpoch).toEqual({ sessionId: epochManager.getSessionId(), entryId: epochs.at(-1) });
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
			// The model selects recovery coordinates from the actual provider-facing frame.
			const providerBody = JSON.parse(init!.body as string) as {
				input: Array<{ content?: Array<{ type: string; text?: string }> }>;
			};
			const displayedSources: DisplaySource[] = [];
			for (const input of providerBody.input) {
				for (const part of input.content ?? []) {
					if (part.type !== "input_text" || !part.text?.startsWith("Recorded task context.")) continue;
					const frame = JSON.parse(part.text.slice(part.text.indexOf("\n") + 1)) as {
						rows?: Array<{ source: DisplaySource }>;
						changed?: Array<{ source: DisplaySource }>;
					};
					displayedSources.push(...[...(frame.rows ?? []), ...(frame.changed ?? [])].map((row) => row.source));
					expect(part.text).not.toContain('"locator"');
					expect(part.text).not.toContain('"sessionFile"');
				}
			}
			const displayed = firstInput ? displayedSources.find((source) => source.entryId === firstInput.id) : undefined;
			if (firstInput)
				expect(displayed).toEqual({
					sessionId: epochManager.getSessionId(),
					entryId: firstInput.id,
					field: "/nativeOrigin/submitted/text",
					revision: expect.any(String),
				});
			const recoveryRequest = {
				action: "recover",
				ref: displayed?.entryId,
				sourceSessionId: displayed?.sessionId,
				field: displayed?.field,
				revision: displayed?.revision,
				need: requestRecovery ? "Also preserve Bar.txt." : "Preserve Foo.txt.",
			};
			const selectedSkillRequest = skillRequest;
			skillRequest = undefined;
			if (selectedSkillRequest?.action === "skill")
				expect(init!.body).toContain("Select a matching skill with the prime_context tool");
			const item = selectedSkillRequest
				? {
						type: "function_call",
						id: `fc_skill_${bodies.length}`,
						call_id: `call_skill_${bodies.length}`,
						name: "prime_context",
						status: "completed",
						arguments: JSON.stringify(selectedSkillRequest),
					}
				: toolContinuationPhase === "intent"
					? {
							type: "function_call",
							id: "fc_pending_effect",
							call_id: "call_pending_effect",
							name: "pending_effect",
							status: "completed",
							arguments: JSON.stringify({ value: "MODEL_ARGUMENT" }),
						}
					: freshOff && bodies.length === 9
						? {
								type: "function_call",
								id: "fc_fresh_off",
								call_id: "call_fresh_off",
								name: "fresh_echo",
								status: "completed",
								arguments: "{}",
							}
						: firstInput
							? {
									type: "function_call",
									id: requestRecovery ? "fc_request_recovery" : "fc_epoch_recovery",
									call_id: requestRecovery ? "call_request_recovery" : "call_epoch_recovery",
									name: "prime_context",
									status: "completed",
									arguments: JSON.stringify({
										action: "batch",
										requests: [
											recoveryRequest,
											{ ...recoveryRequest, revision: "not-the-recorded-revision" },
										],
									}),
								}
							: {
									type: "message",
									id: `msg_epoch_${bodies.length + summaryBodies.length}`,
									role: "assistant",
									status: "completed",
									content: [{ type: "output_text", text: "OK", annotations: [] }],
								};
			const opaqueTail =
				!summarizing && (bodies.length === 3 || requestRecovery || toolContinuationPhase === "intent");
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
			if (freshOff && bodies.length === 10)
				lateStateEntryId = await epochManager.appendCustomEntry("epoch-association-late-state", {});
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
			expect(firstBody.tools).toContainEqual(
				expect.objectContaining({
					name: "prime_context",
					parameters: expect.objectContaining({
						type: "object",
						properties: expect.objectContaining({
							action: { type: "string", enum: ["read", "search", "recover", "batch", "skill"] },
							requests: expect.objectContaining({
								items: expect.objectContaining({
									properties: expect.objectContaining({
										action: { type: "string", enum: ["read", "search", "recover"] },
									}),
								}),
							}),
						}),
					}),
				}),
			);
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
			expect(JSON.parse(originalRecovery.content[0].text).results[1]).toMatchObject({
				status: "unavailable",
				reason: "revision_mismatch",
				records: [],
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
			// Switch the actual owner after the existing public checkpoint, not a helper-only flag.
			const protectedPrompt = epochSession.agent.state.systemPrompt;
			await epochSession.setContextMode("off");
			const offId = epochManager.getLeafId();
			if (!offId) throw new Error("Expected the context mode ACK");
			const offRecord = await epochManager.readBranchHistory((history) =>
				history.hydrateEntry(offId, 2 * 1024 * 1024),
			);
			expect(offRecord?.source.qualification).toBe("native-context-epoch");
			if (offRecord?.entry.type !== "compaction") throw new Error("Expected the policy checkpoint");
			const offCheckpoint = readContextEpoch(offRecord.entry.details, 2 * 1024 * 1024);
			expect(offCheckpoint).toMatchObject({ version: 5, mode: "off", policyOnly: true, representation: null });
			expect(offCheckpoint?.includeSummary).toBeUndefined();
			expect(offRecord.entry.tokensBefore).toBeNull();
			expect(offCheckpoint?.continuation?.kind).toBe("portable-checkpoint");
			await epochSession.setContextMode("off");
			expect(epochManager.getLeafId()).toBe(offId);
			await epochSession.prompt("Continue without context optimization.");
			expect(bodies).toHaveLength(8);
			expect(summaryBodies).toHaveLength(1);
			expect(epochSession.agent.state.systemPrompt).toBe(protectedPrompt);
			const offBody = bodies.at(-1)!;
			expect(offBody).toContain("Foo.txt");
			expect(offBody).toContain("Bar.txt");
			expect(offBody).not.toContain("OPAQUE_REQUEST_CANONICAL_ONLY");
			expect(offBody).not.toContain("OPAQUE_TAIL_CANONICAL_ONLY");
			const offView = await epochManager.readBranchHistory((history) =>
				new CanonicalContextCompiler().compile(
					history.branchContext,
					epochSession!.settingsManager.getCanonicalContextLimits(),
				),
			);
			expect(getCanonicalEpochContext(offView)?.checkpoint?.source).toEqual(offCheckpoint?.source);
			expect(getCanonicalEpochContext(offView)?.taskFrame).toBeUndefined();
			expect(getCanonicalEpochContext(offView)?.resourceRevision).toBeUndefined();
			for (const message of publicRequestMessages) expect(offView).toContainEqual(message);
			await epochSession.disposeAsync({ kernelSnapshot: false });
			await epochManager.close();
			epochManager = await SessionManager.open(epochFile);
			({ session: epochSession } = await createAgentSessionFromServices({
				...epochOptions,
				sessionManager: epochManager,
			}));
			expect(epochSession.contextMode).toBe("off");
			expect(epochManager.getLeafId()).not.toBeNull();
			// The final native budget still refuses an oversized mandatory input; no selector or send.
			await expect(epochSession.prompt("Required input. ".repeat(30000))).rejects.toBeInstanceOf(
				RequestTokenBudgetError,
			);
			expect(bodies).toHaveLength(8);
			const stillOff = await epochManager.readBranchHistory((history) =>
				history.branchContext.contextManifest({ limit: 1 }),
			);
			if (stillOff.selection !== "known") throw new Error("Expected the retained policy checkpoint");
			expect(stillOff.summaryRef?.entryId).toBe(offId);
			// A genuinely fresh settings-seeded off owner accepts its first native contract once.
			await epochSession.disposeAsync({ kernelSnapshot: false });
			await epochManager.close();
			epochManager = await SessionManager.create(epochDir, join(epochDir, "fresh-off"));
			freshOff = true;
			({ session: epochSession } = await createAgentSessionFromServices({
				...epochOptions,
				services: {
					...epochServices,
					settingsManager: SettingsManager.inMemory({
						context: { mode: "off" },
						compaction: { enabled: false },
						autoRefine: { enabled: false },
						retry: { enabled: false },
					}),
				},
				sessionManager: epochManager,
				tools: ["fresh_echo"],
				customTools: [
					{
						name: "fresh_echo",
						label: "Fresh echo",
						description: "Return a native fixture result.",
						parameters: Type.Object({}),
						execute: async () => ({
							content: [{ type: "text" as const, text: "fresh native result" }],
							details: {},
						}),
					},
				],
			}));
			const pendingId = epochManager.getLeafId();
			if (!pendingId) throw new Error("Expected the fresh off policy ACK");
			const pending = await epochManager.readBranchHistory((history) =>
				history.hydrateEntry(pendingId, 2 * 1024 * 1024),
			);
			if (pending?.entry.type !== "compaction") throw new Error("Expected the fresh policy checkpoint");
			expect(pending.source.qualification).toBe("native-context-epoch");
			expect(readContextEpoch(pending.entry.details, 2 * 1024 * 1024)).toMatchObject({
				mode: "off",
				pendingRequestContract: true,
				representation: null,
			});
			await epochSession.prompt("Run the fresh echo tool.");
			expect(bodies).toHaveLength(10);
			expect(epochsAtSend.at(-2)).not.toBe(pendingId);
			expect(epochsAtSend.at(-1)).toBe(epochsAtSend.at(-2));
			const acceptedId = epochsAtSend.at(-1)!;
			const accepted = await epochManager.readBranchHistory((history) =>
				history.hydrateEntry(acceptedId, 2 * 1024 * 1024),
			);
			if (accepted?.entry.type !== "compaction") throw new Error("Expected the once-only native contract ACK");
			const freshCheckpoint = readContextEpoch(accepted.entry.details, 2 * 1024 * 1024);
			expect(freshCheckpoint).toMatchObject({
				mode: "off",
				representation: null,
				requestContract: {
					api: model.api,
					provider: model.provider,
					route: "https://api.openai.com/v1/responses",
					model: model.id,
					replayContract: "message-groups",
				},
			});
			expect(freshCheckpoint?.pendingRequestContract).toBeUndefined();
			expect(freshCheckpoint?.views).toEqual([]);
			expect(accepted.entry.tokensBefore).toBeNull();
			const freshRequests = (await epochManager.readEntries())
				.filter((entry) => entry.type === "request")
				.map((entry) => entry.request);
			const admissions = freshRequests.filter((event) => event.type === "attempt_admitted");
			const settlements = freshRequests.filter((event) => event.type === "attempt_settled");
			expect(admissions).toHaveLength(2);
			expect(settlements).toHaveLength(2);
			for (const admission of admissions) {
				expect(admission.contextEpoch).toEqual({ sessionId: epochManager.getSessionId(), entryId: acceptedId });
				expect(settlements.find((event) => event.attemptId === admission.attemptId)?.contextEpoch).toEqual(
					admission.contextEpoch,
				);
			}
			expect(admissions[0].source.leafId).not.toBe(acceptedId);
			expect(lateStateEntryId).toEqual(expect.any(String));
			expect(lateStateEntryId).not.toBe(acceptedId);
			expect(epochManager.getLeafId()).not.toBe(acceptedId);
			expect(bodies.at(-1)).toContain("fresh native result");
			expect(epochSession.contextMode).toBe("off");
			expect(summaryBodies).toHaveLength(1);

			// Genuine selected-owner ACK, then a controlled stop before execution/finalization.
			await epochSession.disposeAsync({ kernelSnapshot: false });
			await epochManager.close();
			epochManager = await SessionManager.create(epochDir, join(epochDir, "pending-native-tool"));
			freshOff = false;
			toolContinuationPhase = "intent";
			let executions = 0;
			let executionId: string | undefined;
			let assistantEntryId: string | undefined;
			const pendingOptions: typeof epochOptions = {
				...epochOptions,
				tools: ["pending_effect"],
				customTools: [
					{
						name: "pending_effect",
						label: "Pending effect",
						description: "Offline effect fixture.",
						parameters: Type.Object({ value: Type.String() }),
						execute: async () => {
							executions++;
							return { content: [{ type: "text" as const, text: "effect finalized" }], details: {} };
						},
					},
				],
			};
			({ session: epochSession } = await createAgentSessionFromServices({
				...pendingOptions,
				sessionManager: epochManager,
			}));
			epochSession.agent.beforeToolCall = async ({ args }) => {
				if (args && typeof args === "object" && "value" in args) args.value = "PRIVATE_EXECUTED_ARGUMENT";
				return undefined;
			};
			const afterAckStop = new AgentOutputLimitError({
				kind: "output_limit",
				limit: "messages",
				maxMessages: 1,
				maxSourceBytes: 1,
			});
			epochSession.agent.onToolInvocationStarting = async (invocation) => {
				executionId = invocation.executionId;
				expect(invocation.originalInput).toEqual({ value: "MODEL_ARGUMENT" });
				expect(invocation.executedInput).toEqual({ value: "PRIVATE_EXECUTED_ARGUMENT" });
				const intent = await epochManager.readBranchHistory((history) =>
					history.hydrateEntry(`${invocation.executionId}:intent`, 2 * 1024 * 1024),
				);
				if (intent?.entry.type !== "tool_intent") throw new Error("Expected the original owner intent ACK");
				expect(intent.source.qualification).toBe("native-tool-execution");
				assistantEntryId = intent.entry.assistant?.entryId;
				expect(intent.entry.assistant).toEqual({
					sessionId: epochManager.getSessionId(),
					sessionFile: epochManager.getSessionFile(),
					entryId: expect.any(String),
				});
				throw afterAckStop;
			};
			await expect(epochSession.prompt("Request the fixture tool. Preserve EXACT_USER_CONTENT.")).rejects.toBe(
				afterAckStop,
			);
			expect(executions).toBe(0);
			if (!executionId || !assistantEntryId) throw new Error("Expected captured original execution references");
			expect(await epochManager.readEntry(executionId)).toBeUndefined();
			const pendingFile = epochManager.getSessionFile()!;
			await epochSession.disposeAsync({ kernelSnapshot: false });
			await epochManager.close();
			epochManager = await SessionManager.open(pendingFile);
			toolContinuationPhase = "resumed";
			({ session: epochSession } = await createAgentSessionFromServices({
				...pendingOptions,
				sessionManager: epochManager,
				contextMode: "off",
			}));
			// Accepted source mode wins over this creation preference.
			expect(epochSession.contextMode).toBe("on");
			let rawPendingBody = "";
			let payloadCalls = 0;
			epochSession.agent.onPayload = (payload) => {
				payloadCalls++;
				rawPendingBody = JSON.stringify(payload);
			};
			await epochSession.prompt("Continue with the recorded outcome. Preserve EXACT_RESUMED_CONTENT.");
			expect(payloadCalls).toBe(1);
			expect(rawPendingBody).toContain('"function_call"');
			expect(rawPendingBody).toContain("MODEL_ARGUMENT");
			expect(rawPendingBody).toContain("OPAQUE_TAIL_CANONICAL_ONLY");
			expect(rawPendingBody).not.toContain("No result provided");
			const publicToolBody = bodies.at(-1)!;
			expect(publicToolBody).toContain("outcome_unknown");
			expect(publicToolBody).toContain(executionId);
			expect(publicToolBody).toContain("EXACT_USER_CONTENT");
			expect(publicToolBody).toContain("EXACT_RESUMED_CONTENT");
			for (const privateOrNative of [
				"PRIVATE_EXECUTED_ARGUMENT",
				"MODEL_ARGUMENT",
				"OPAQUE_TAIL_CANONICAL_ONLY",
				'"function_call"',
				"No result provided",
			])
				expect(publicToolBody).not.toContain(privateOrNative);
			const raw = JSON.parse(rawPendingBody) as {
				input: Array<{ role?: string; content?: Array<{ type: string; text?: string }> }>;
				instructions?: string;
			};
			const displayed = JSON.parse(publicToolBody) as typeof raw;
			expect(displayed.instructions).toEqual(raw.instructions);
			expect(displayed.input.filter((item) => item.role === "system" || item.role === "developer")).toEqual(
				raw.input.filter((item) => item.role === "system" || item.role === "developer"),
			);
			const toolEpochId = epochsAtSend.at(-1)!;
			const toolEpoch = await epochManager.readEntry(toolEpochId);
			if (toolEpoch?.type !== "compaction") throw new Error("Expected accepted native public tool epoch");
			expect(readContextEpoch(toolEpoch.details, 2 * 1024 * 1024)).toMatchObject({
				version: 6,
				renderer: "native-canonical-epoch/6",
				publicWindow: true,
				toolContinuations: [
					{
						assistantEntryId,
						calls: [{ executionId, intent: { id: `${executionId}:intent` }, outcome: "outcome_unknown" }],
					},
				],
			});
			const pendingRequests = (await epochManager.readEntries())
				.filter((entry) => entry.type === "request")
				.map((entry) => entry.request);
			const resumedAdmission = pendingRequests.filter((event) => event.type === "attempt_admitted").at(-1)!;
			expect(resumedAdmission.contextEpoch).toEqual({
				sessionId: epochManager.getSessionId(),
				entryId: toolEpochId,
			});
			expect(
				pendingRequests.find(
					(event) => event.type === "attempt_settled" && event.attemptId === resumedAdmission.attemptId,
				)?.contextEpoch,
			).toEqual(resumedAdmission.contextEpoch);
			expect(await epochManager.readEntry(executionId)).toBeUndefined();
			expect(executions).toBe(0);
			expect(bodies).toHaveLength(12);
			const firstToolLiteral = displayed.input
				.flatMap((item) => item.content ?? [])
				.find(
					(part) => part.type === "input_text" && part.text?.startsWith("Recorded tool continuation data."),
				)?.text;
			expect(typeof firstToolLiteral).toBe("string");
			// One ordinary continuation changes the tail/receipts, not the unchanged tool fact.
			await epochSession.prompt("Continue normally. Preserve EXACT_RESUMED_CONTENT.");
			expect(payloadCalls).toBe(2);
			const followingBody = JSON.parse(bodies.at(-1)!) as typeof raw;
			const followingToolLiteral = followingBody.input
				.flatMap((item) => item.content ?? [])
				.find(
					(part) => part.type === "input_text" && part.text?.startsWith("Recorded tool continuation data."),
				)?.text;
			expect(followingToolLiteral).toBe(firstToolLiteral);
			const followingEpochId = epochsAtSend.at(-1)!;
			expect(followingEpochId).not.toBe(toolEpochId);
			const followingRequests = (await epochManager.readEntries())
				.filter((entry) => entry.type === "request")
				.map((entry) => entry.request);
			const followingAdmission = followingRequests.filter((event) => event.type === "attempt_admitted").at(-1)!;
			expect(followingAdmission.contextEpoch).toEqual({
				sessionId: epochManager.getSessionId(),
				entryId: followingEpochId,
			});
			expect(
				followingRequests.find(
					(event) => event.type === "attempt_settled" && event.attemptId === followingAdmission.attemptId,
				)?.contextEpoch,
			).toEqual(followingAdmission.contextEpoch);
			expect(await epochManager.readEntry(executionId)).toBeUndefined();
			expect(executions).toBe(0);
			expect(bodies).toHaveLength(13);

			// Same native fake-SSE fixture: advertised selection -> real producer -> source -> epoch ACK.
			await epochSession.disposeAsync({ kernelSnapshot: false });
			await epochManager.close();
			epochManager = await SessionManager.create(epochDir, join(epochDir, "selected-skill-native"));
			toolContinuationPhase = undefined;
			const skillPath = join(epochDir, "VERSION-SKILL.md");
			writeFileSync(
				skillPath,
				"---\nname: version-fixture\ndescription: Skill version fixture\n---\nSKILL_VERSION_A",
			);
			skillFixtures.push({
				name: "version-fixture",
				description: "Skill version fixture",
				kind: "markdown",
				filePath: skillPath,
				baseDir: epochDir,
				disableModelInvocation: false,
				sourceInfo: createSyntheticSourceInfo("skill-version-fixture", { source: "test" }),
			});
			({ session: epochSession } = await createAgentSessionFromServices({
				...epochOptions,
				sessionManager: epochManager,
			}));
			await epochSession.reload();
			skillRequest = { action: "skill", name: "version-fixture" };
			await epochSession.prompt("Select the version-fixture skill through the advertised read route.");
			expect(bodies.at(-1)).toContain("SKILL_VERSION_A");
			expect(bodies.at(-1)).toContain("Selected Skill versions (canonical source references)");
			expect(epochsAtSend.at(-1)).not.toBe(epochsAtSend.at(-2));
			const selectedEpoch = await epochManager.readEntry(epochsAtSend.at(-1)!);
			if (selectedEpoch?.type !== "compaction") throw new Error("Expected selected skill epoch ACK");
			const firstSkill = readContextEpoch(selectedEpoch.details, 2 * 1024 * 1024)?.selectedSkills?.[0];
			expect(firstSkill?.name).toBe("version-fixture");
			if (!firstSkill) throw new Error("Expected original selected source reference");
			const originalSkill = await epochManager.readBranchHistory((history) =>
				history.hydrateEntry(firstSkill.view.ref.entryId, 1024 * 1024),
			);
			expect(originalSkill?.source.qualification).toBe("native-recovery");
			expect(originalSkill?.entry).toMatchObject({
				type: "custom_message",
				content: expect.stringContaining("SKILL_VERSION_A"),
				details: { baseContextSelectedSkill: { descriptor: { name: "version-fixture", filePath: skillPath } } },
			});

			// Changed-file edge: fixed/off must reuse the selected version.
			await epochSession.setContextMode("off");
			writeFileSync(
				skillPath,
				"---\nname: version-fixture\ndescription: Skill version fixture\n---\nSKILL_VERSION_B",
			);
			await epochSession.prompt("/skill:version-fixture Keep the explicit user argument.");
			expect(bodies.at(-1)).toContain("SKILL_VERSION_A");
			expect(bodies.at(-1)).not.toContain("SKILL_VERSION_B");
			expect(bodies.at(-1)).toContain("Keep the explicit user argument.");

			// A real accepted new-epoch boundary permits a fresh explicit capture, never silent drift.
			// Disabling model recovery hides the catalog, but must not disable host-owned /skill admission.
			await epochSession.setContextMode("on");
			skillFixtures[0].disableModelInvocation = true;
			await epochSession.reload();
			epochSession.setActiveToolsByName([]);
			const beforeNewVersion = epochManager.getLeafId();
			await epochSession.prompt("/skill:version-fixture Use the newly selected version.");
			expect(bodies.at(-1)).toContain("SKILL_VERSION_B");
			expect(bodies.at(-1)).not.toContain("<available_skills>");
			expect(
				await epochSession.recoverNativeHistory({ action: "read", ref: firstSkill.view.ref.entryId }),
			).toMatchObject({ status: "not_authorized" });
			expect(epochsAtSend.at(-1)).not.toBe(beforeNewVersion);
			const replacementEpoch = await epochManager.readEntry(epochsAtSend.at(-1)!);
			if (replacementEpoch?.type !== "compaction") throw new Error("Expected replacement skill epoch ACK");
			const secondSkill = readContextEpoch(replacementEpoch.details, 2 * 1024 * 1024)?.selectedSkills?.[0];
			expect(secondSkill?.view.ref.entryId).not.toBe(firstSkill.view.ref.entryId);
			expect(await epochManager.readEntry(firstSkill.view.ref.entryId)).toMatchObject({
				content: expect.stringContaining("SKILL_VERSION_A"),
			});

			// Cold recovery still reads the original source, not the now-changed file or a private body cache.
			const skillSessionFile = epochManager.getSessionFile()!;
			await epochSession.disposeAsync({ kernelSnapshot: false });
			await epochManager.close();
			epochManager = await SessionManager.open(skillSessionFile);
			({ session: epochSession } = await createAgentSessionFromServices({
				...epochOptions,
				sessionManager: epochManager,
			}));
			skillRequest = { action: "read", ref: firstSkill.view.ref.entryId };
			await epochSession.prompt("Recover the original selected skill source.");
			const recoveredSkill = epochSession.messages
				.filter((message) => message.role === "toolResult" && message.toolName === "prime_context")
				.at(-1);
			if (recoveredSkill?.role !== "toolResult" || recoveredSkill.content[0]?.type !== "text")
				throw new Error("Expected actual native selected source recovery");
			expect(JSON.parse(recoveredSkill.content[0].text).results[0].records).toContainEqual(
				expect.objectContaining({
					ref: firstSkill.view.ref.entryId,
					field: "/content",
					text: expect.stringContaining("SKILL_VERSION_A"),
				}),
			);
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
