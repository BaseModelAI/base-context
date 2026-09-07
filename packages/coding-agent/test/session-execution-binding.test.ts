import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentOptions, type AgentTool } from "@ponythewhite/base-context-agent";
import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from "@ponythewhite/base-context-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

let faux: FauxProviderRegistration;
let dir: string;
let session: AgentSession | undefined;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "base-context-execution-binding-"));
	faux = registerFauxProvider();
});
afterEach(async () => {
	try {
		await session?.disposeAsync();
	} finally {
		session = undefined;
		faux.unregister();
		rmSync(dir, { recursive: true, force: true });
	}
});

async function createSession(
	manager: SessionManager,
	hooks: Pick<AgentOptions, "onToolInvocationStarting" | "onToolExchangeFinalized"> = {},
) {
	const agentDir = join(dir, "agent");
	const settingsManager = SettingsManager.create(dir, agentDir);
	settingsManager.applyOverrides({ canonicalContext: { maxMessages: 100, maxSourceBytes: 1048576 } });
	const model = faux.getModel();
	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	authStorage.setRuntimeApiKey(model.provider, "faux-key");
	const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
	modelRegistry.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		api: faux.api,
		models: faux.models.map((registeredModel) => ({
			id: registeredModel.id,
			name: registeredModel.name,
			api: registeredModel.api,
			reasoning: registeredModel.reasoning,
			input: registeredModel.input,
			cost: registeredModel.cost,
			contextWindow: registeredModel.contextWindow,
			maxTokens: registeredModel.maxTokens,
			baseUrl: registeredModel.baseUrl,
		})),
	});
	const schema = Type.Object({ value: Type.String() });
	const fixture: AgentTool<typeof schema> = {
		name: "fixture",
		label: "Fixture",
		description: "Return local fixture data",
		parameters: schema,
		async execute(_toolCallId, args) {
			return { content: [{ type: "text", text: "result" }], details: args };
		},
	};
	const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir, settingsManager });
	await resourceLoader.reload();
	const agent = new Agent({ initialState: { model }, ...hooks });
	session = new AgentSession({
		agent,
		sessionManager: manager,
		settingsManager,
		modelRegistry,
		resourceLoader,
		cwd: dir,
		agentDir,
		baseToolsOverride: { fixture },
		initialActiveToolNames: ["fixture"],
		allowedToolNames: ["fixture"],
		includeGoals: false,
		prewarmIpythonKernel: false,
	});
	return session;
}

it("binds direct AgentSession construction and persists before caller hooks", async () => {
	const manager = await SessionManager.create(dir, join(dir, "sessions"));
	const calls: string[] = [];
	const executionIds: string[] = [];
	const owner = await createSession(manager, {
		onToolInvocationStarting: (intent) => {
			expect(manager.getEntry(`${intent.executionId}:intent`)?.type).toBe("tool_intent");
			executionIds.push(intent.executionId);
			calls.push("caller-intent");
		},
		onToolExchangeFinalized: (finalized) => {
			expect(manager.getToolExchange(finalized.executionId)).toEqual(finalized);
			calls.push("caller-final");
		},
	});
	const canonicalOnly = { role: "user" as const, content: "Canonical-only ACKed history", timestamp: Date.now() };
	await manager.appendMessage(canonicalOnly);
	expect(
		owner.agent.state.messages.some(
			(message) => message.role === "user" && message.content === canonicalOnly.content,
		),
	).toBe(false);
	let sawCanonicalOnly = false;
	faux.setResponses([
		(context) => {
			sawCanonicalOnly = context.messages.some(
				(message) => message.role === "user" && message.content === canonicalOnly.content,
			);
			return fauxAssistantMessage(fauxToolCall("fixture", { value: "raw" }), { stopReason: "toolUse" });
		},
		fauxAssistantMessage("First turn complete."),
		fauxAssistantMessage(fauxToolCall("fixture", { value: "raw" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Second turn complete."),
	]);
	const initialize = vi.spyOn(owner, "initialize");
	await owner.agent.prompt("Exercise native loop binding with local faux");
	expect(initialize).toHaveBeenCalled();
	expect(sawCanonicalOnly).toBe(true);
	expect(owner.agent.state.errorMessage).toBeUndefined();
	expect(() => owner.agent.bindContextOwner(async () => {})).toThrow("Agent context owner is already bound");
	owner.agent.onToolInvocationStarting = (intent) => {
		expect(manager.getEntry(`${intent.executionId}:intent`)?.type).toBe("tool_intent");
		executionIds.push(intent.executionId);
		calls.push("replacement-intent");
	};
	owner.agent.onToolExchangeFinalized = (finalized) => {
		expect(manager.getToolExchange(finalized.executionId)).toEqual(finalized);
		calls.push("replacement-final");
	};
	await owner.agent.prompt("Exercise replacement hooks with local faux");
	expect(calls).toEqual(["caller-intent", "caller-final", "replacement-intent", "replacement-final"]);
	expect(owner.agent.state.errorMessage).toBeUndefined();
	expect(executionIds).toHaveLength(2);
	const journal = readFileSync(manager.getSessionFile()!, "utf8");
	for (const executionId of executionIds) expect(journal).toContain(executionId);
});

it("follows the session owner after a source-history switch", async () => {
	const manager = await SessionManager.create(dir, join(dir, "sessions"));
	const executionIds: string[] = [];
	const owner = await createSession(manager, {
		onToolInvocationStarting: (intent) => {
			expect(manager.getEntry(`${intent.executionId}:intent`)?.type).toBe("tool_intent");
			executionIds.push(intent.executionId);
		},
		onToolExchangeFinalized: (finalized) => {
			expect(manager.getToolExchange(finalized.executionId)).toEqual(finalized);
		},
	});
	await manager.appendSessionInfo("previous");
	const previousPath = manager.getSessionFile()!;
	const before = readFileSync(previousPath, "utf8");
	await manager.newSession();
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("fixture", { value: "raw" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("New history complete."),
	]);
	await owner.agent.prompt("Exercise new history with local faux");
	expect(owner.agent.state.errorMessage).toBeUndefined();
	expect(readFileSync(previousPath, "utf8")).toBe(before);
	const currentPath = manager.getSessionFile()!;
	expect(executionIds).toHaveLength(1);
	expect(readFileSync(currentPath, "utf8")).toContain(executionIds[0]);
	await owner.disposeAsync();
	const reopened = await SessionManager.open(currentPath);
	await reopened.close();

	const freshManager = await SessionManager.create(dir, join(dir, "sessions"));
	const refusedCalls: string[] = [];
	const freshOwner = await createSession(freshManager, {
		onToolInvocationStarting: () => {
			refusedCalls.push("intent");
		},
		onToolExchangeFinalized: () => {
			refusedCalls.push("final");
		},
	});
	const indexPath = join(freshManager.getSessionArtifactDir()!, "history.sqlite");
	expect(existsSync(indexPath)).toBe(false);
	mkdirSync(indexPath, { recursive: true });
	faux.setResponses([fauxAssistantMessage("Must not be consumed.")]);
	const beforeCalls = faux.state.callCount;
	const beforeResponses = faux.getPendingResponseCount();
	try {
		await freshOwner.agent.prompt("Refuse indexed history failure without fallback");
		expect(freshOwner.agent.state.errorMessage).toBeTruthy();
		expect(freshOwner.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
		expect(faux.state.callCount).toBe(beforeCalls);
		expect(faux.getPendingResponseCount()).toBe(beforeResponses);
		expect(refusedCalls).toEqual([]);
	} finally {
		rmSync(indexPath, { recursive: true, force: true });
	}
});
