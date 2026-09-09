import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@ponythewhite/base-context-ai";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.js";
import { AuthStorage } from "../../src/core/auth-storage.js";
import { ModelRegistry } from "../../src/core/model-registry.js";
import { writeRawStdout } from "../../src/core/output-guard.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import type { AgentConnection, AgentConnectionEventListener } from "../../src/modes/agent-connection/types.js";
import { DAEMON_PROTOCOL_VERSION } from "../../src/modes/daemon/daemon-protocol.js";
import { runRpcMode, runRpcModeWithConnection } from "../../src/modes/rpc/rpc-mode.js";

let listener: AgentConnectionEventListener = () => {};
let resolveExtensionUi: (() => void) | undefined;
let slowWatcherCount = 0;
let activePrompt: Promise<void> | undefined;

const heartbeat = {
	id: "heartbeat-1",
	status: "active" as const,
	source: "heartbeat" as const,
	activeSessionId: "root-session",
	sessionId: "root",
	sessionFile: "/tmp/root.jsonl",
	cwd: "/tmp",
	prompt: "check status",
	schedule: { kind: "interval" as const, expression: "every 1h", intervalMs: 3_600_000 },
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	runCount: 0,
};

const connection = {
	subscribe(next: AgentConnectionEventListener) {
		listener = next;
		return () => {};
	},
	async prompt(message: string) {
		if (message === "async-eof") {
			activePrompt = (async () => {
				await listener({ type: "session_event", event: { type: "agent_start" } });
				await new Promise((resolve) => setTimeout(resolve, 50));
				await listener({ type: "session_event", event: { type: "agent_end", messages: [] } });
			})();
			return;
		}
		if (message === "extension-ui") {
			await new Promise<void>((resolve) => {
				resolveExtensionUi = resolve;
				void listener({
					type: "extension_ui_request",
					request: {
						id: "extension-ui-1",
						method: "confirm",
						payload: { title: "Confirm", message: "Continue?" },
					},
				});
			});
		}
		await listener({ type: "session_event", event: { type: "agent_start" } });
		await new Promise((resolve) => setTimeout(resolve, 10));
	},
	async respondToExtensionUiRequest(id: string) {
		if (id === "extension-ui-1") {
			resolveExtensionUi?.();
			resolveExtensionUi = undefined;
		}
	},
	async getAvailableModels() {
		await new Promise((resolve) => setTimeout(resolve, 25));
		return [];
	},
	async waitForIdle() {
		await activePrompt;
	},
	async getLastAssistantText() {
		return undefined;
	},
	async setSessionName(name: string) {
		if (name !== name.trim()) {
			throw new Error("Session name was not trimmed");
		}
	},
	async listCronJobs() {
		return [heartbeat];
	},
	async listHeartbeats() {
		return [{ job: heartbeat }];
	},
	async getAgentMessageStatus() {
		return {
			paused: false,
			maxMessageChars: 16384,
			maxPendingPerSession: 20,
			rateLimitCapacity: 3,
			rateLimitRefillMs: 1000,
		};
	},
	async sendAgentMessage(targetActiveSessionId: string, message: string) {
		return {
			id: "message-1",
			source: "agent_message" as const,
			target: { activeSessionId: targetActiveSessionId, sessionId: "target" },
			message,
			deliveryStatus: "delivered" as const,
			deliveredAt: "2026-01-01T00:00:00.000Z",
			deliveryMode: "auto" as const,
		};
	},
	async watchSession(activeSessionId: string) {
		const watcherIndex = activeSessionId === "slow-child" ? slowWatcherCount++ : -1;
		return {
			async getMessages() {
				if (watcherIndex === 0) {
					await new Promise((resolve) => setTimeout(resolve, 30));
				}
				return [{ role: "user" as const, content: "child message", timestamp: 1 }];
			},
			subscribe(next: AgentConnectionEventListener) {
				void next({ type: "session_event", event: { type: "agent_start" } });
				return () => {};
			},
			async getToolDefinition() {
				return undefined;
			},
			async close() {},
		};
	},
	async dispose() {},
} as unknown as AgentConnection;

async function runNativeRefineEof(mode: "main" | "review", root: string): Promise<never> {
	const faux = registerFauxProvider();
	const model = faux.getModel();
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(model.provider, "faux-key");
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	modelRegistry.registerProvider(model.provider, {
		api: faux.api,
		apiKey: "faux-key",
		baseUrl: model.baseUrl,
		models: faux.models.map(({ id, name, api, reasoning, input, cost, contextWindow, maxTokens, baseUrl }) => ({
			id,
			name,
			api,
			reasoning,
			input,
			cost,
			contextWindow,
			maxTokens,
			baseUrl,
		})),
	});
	const services = await createAgentSessionServices({
		cwd: root,
		agentDir: root,
		authStorage,
		modelRegistry,
		telemetryDisabled: true,
		settingsManager: SettingsManager.inMemory({ autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } }),
		resourceLoaderOptions: {
			noContextFiles: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noExtensions: true,
			bundledSkillsDir: null,
		},
	});
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ sessionManager, sessionStartEvent }) => ({
		...(await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			model,
			tools: [],
			serializedRefine: false,
			prewarmIpythonKernel: false,
			telemetryDisabled: true,
		})),
		services,
		diagnostics: services.diagnostics,
	});
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: root,
		agentDir: root,
		sessionManager: await SessionManager.create(root, join(root, "sessions")),
	});
	let releaseAccepted!: () => void;
	const acceptedRelease = new Promise<void>((resolve) => {
		releaseAccepted = resolve;
	});
	let announceReview!: () => void;
	const reviewStarted = new Promise<void>((resolve) => {
		announceReview = resolve;
	});
	let acceptedAborted = false;
	faux.setResponses(
		mode === "main"
			? [
					async (_context, options) => {
						await acceptedRelease;
						acceptedAborted = options?.signal?.aborted ?? false;
						return fauxAssistantMessage("native eof accepted main");
					},
				]
			: [
					fauxAssistantMessage("pre-close main"),
					async (_context, options) => {
						announceReview();
						await acceptedRelease;
						acceptedAborted = options?.signal?.aborted ?? false;
						return fauxAssistantMessage(
							JSON.stringify({
								shouldRefine: true,
								rationale: "approved before close",
								instructions: "plan after review",
							}),
						);
					},
				],
	);
	const closeAdmission = runtime.closeAutoRefineAdmission.bind(runtime);
	let closed = false;
	runtime.closeAutoRefineAdmission = () => {
		closeAdmission();
		if (!closed) {
			closed = true;
			writeRawStdout(`${JSON.stringify({ type: "fixture_native_eof", calls: faux.state.callCount })}\n`);
			releaseAccepted();
		}
	};
	const dispose = runtime.dispose.bind(runtime);
	runtime.dispose = async (options) => {
		await dispose(options);
		writeRawStdout(
			`${JSON.stringify({ type: "fixture_native_disposed", calls: faux.state.callCount, acceptedAborted })}\n`,
		);
	};
	if (mode === "review") {
		const prelude = runtime.session.prompt("Admit an ordinary automatic review before EOF");
		await Promise.race([reviewStarted, prelude.then(() => reviewStarted)]);
	}
	return runRpcMode(runtime, DAEMON_PROTOCOL_VERSION);
}

const nativeMode = process.argv[2];
if (nativeMode === "main" || nativeMode === "review") {
	await runNativeRefineEof(nativeMode, process.argv[3]);
} else {
	await runRpcModeWithConnection(connection, DAEMON_PROTOCOL_VERSION);
}
