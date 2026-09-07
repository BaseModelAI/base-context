import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Agent,
	type AgentContext,
	type AgentLoopConfig,
	type AgentMessage,
	type AgentOptions,
	type FinalizedToolExchange,
	type ToolInvocation,
} from "@ponythewhite/base-context-agent";
import { getModel } from "@ponythewhite/base-context-ai";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

vi.mock("../../agent/src/agent-loop.js", () => ({
	runAgentLoop: async (_messages: AgentMessage[], _context: AgentContext, config: AgentLoopConfig) => {
		expect(config.beforeContextBuild).toBeTypeOf("function");
		await config.beforeContextBuild!();
		const intent = invocation(`bound-execution-${++executionSerial}`);
		await config.onToolInvocationStarting?.(intent);
		await config.onToolExchangeFinalized?.(exchange(intent));
	},
	runAgentLoopContinue: vi.fn(),
}));

let executionSerial = 0;
let dir: string;
let session: AgentSession | undefined;
beforeEach(() => {
	executionSerial = 0;
	dir = mkdtempSync(join(tmpdir(), "base-context-execution-binding-"));
});
afterEach(async () => {
	try {
		await session?.disposeAsync();
	} finally {
		session = undefined;
		rmSync(dir, { recursive: true, force: true });
	}
});

async function createSession(
	manager: SessionManager,
	hooks: Pick<AgentOptions, "onToolInvocationStarting" | "onToolExchangeFinalized"> = {},
) {
	const agentDir = join(dir, "agent");
	const settingsManager = SettingsManager.create(dir, agentDir);
	const modelRegistry = ModelRegistry.create(
		AuthStorage.create(join(agentDir, "auth.json")),
		join(agentDir, "models.json"),
	);
	const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir, settingsManager });
	await resourceLoader.reload();
	const agent = new Agent({ initialState: { model: getModel("anthropic", "claude-sonnet-4-5") }, ...hooks });
	session = new AgentSession({
		agent,
		sessionManager: manager,
		settingsManager,
		modelRegistry,
		resourceLoader,
		cwd: dir,
		agentDir,
		initialActiveToolNames: [],
		allowedToolNames: [],
		includeGoals: false,
		prewarmIpythonKernel: false,
	});
	return session;
}

function invocation(id: string): ToolInvocation {
	return {
		executionId: id,
		sourceOrder: 0,
		toolCallId: id,
		toolName: "fixture",
		originalInput: { value: "raw" },
		executedInput: { value: "executed" },
		toolExecution: "sequential",
	};
}
function exchange(intent: ToolInvocation): FinalizedToolExchange {
	return {
		...intent,
		executionOutcome: "completed",
		cancellationRequested: false,
		result: {
			role: "toolResult",
			toolCallId: intent.toolCallId,
			toolName: intent.toolName,
			content: [{ type: "text", text: "result" }],
			isError: false,
			timestamp: 1,
		},
	};
}

it("binds direct AgentSession construction and persists before caller hooks", async () => {
	const manager = await SessionManager.create(dir, join(dir, "sessions"));
	const calls: string[] = [];
	const owner = await createSession(manager, {
		onToolInvocationStarting: (intent) => {
			expect(manager.getEntry(`${intent.executionId}:intent`)?.type).toBe("tool_intent");
			calls.push("caller-intent");
		},
		onToolExchangeFinalized: (finalized) => {
			expect(manager.getToolExchange(finalized.executionId)).toEqual(finalized);
			calls.push("caller-final");
		},
	});
	const initialize = vi.spyOn(owner, "initialize");
	await owner.agent.prompt("Exercise native loop binding without a provider");
	expect(initialize).toHaveBeenCalled();
	expect(() => owner.agent.bindContextOwner(async () => {})).toThrow("Agent context owner is already bound");
	owner.agent.onToolInvocationStarting = (intent) => {
		expect(manager.getEntry(`${intent.executionId}:intent`)?.type).toBe("tool_intent");
		calls.push("replacement-intent");
	};
	owner.agent.onToolExchangeFinalized = (finalized) => {
		expect(manager.getToolExchange(finalized.executionId)).toEqual(finalized);
		calls.push("replacement-final");
	};
	await owner.agent.prompt("Exercise replacement hooks without a provider");
	expect(calls).toEqual(["caller-intent", "caller-final", "replacement-intent", "replacement-final"]);
	expect(readFileSync(manager.getSessionFile()!, "utf8")).toContain("bound-execution");
});

it("follows the session owner after a source-history switch", async () => {
	const manager = await SessionManager.create(dir, join(dir, "sessions"));
	const owner = await createSession(manager);
	await manager.appendSessionInfo("previous");
	const previousPath = manager.getSessionFile()!;
	const before = readFileSync(previousPath, "utf8");
	await manager.newSession();
	await owner.agent.prompt("Exercise new history without a provider");
	expect(readFileSync(previousPath, "utf8")).toBe(before);
	const currentPath = manager.getSessionFile()!;
	expect(readFileSync(currentPath, "utf8")).toContain("bound-execution");
	await owner.disposeAsync();
	const reopened = await SessionManager.open(currentPath);
	await reopened.close();
});
