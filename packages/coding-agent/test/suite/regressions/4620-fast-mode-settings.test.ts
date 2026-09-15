import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.js";
import { createAgentSession } from "../../../src/core/sdk.js";
import { SessionManager } from "../../../src/core/session-manager.js";
import { SettingsManager } from "../../../src/core/settings-manager.js";
import { assistantMsg, createTestResourceLoader, userMsg } from "../../utilities.js";
import { createHarness, type Harness } from "../harness.js";

describe("ENG-4620 fast mode settings", () => {
	let harness: Harness | undefined;
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) {
			await session.disposeAsync();
		}
		await harness?.cleanup();
		harness = undefined;
	});

	it("uses the saved fast mode preference for new sessions", async () => {
		harness = await createHarness({
			api: "openai-responses",
			provider: "openai",
			models: [{ id: "gpt-5.5" }],
		});
		const currentHarness = harness;

		await currentHarness.session.setServiceTier("priority");
		expect(currentHarness.settingsManager.getDefaultServiceTier()).toBe("priority");

		const createSession = () =>
			createAgentSession({
				cwd: currentHarness.tempDir,
				authStorage: currentHarness.authStorage,
				model: currentHarness.getModel(),
				resourceLoader: createTestResourceLoader(),
				sessionManager: SessionManager.inMemory(currentHarness.tempDir),
				settingsManager: currentHarness.settingsManager,
			});

		const { session } = await createSession();
		sessions.push(session);
		expect(session.serviceTier).toBe("priority");

		await session.setServiceTier("default");
		const { session: nextSession } = await createSession();
		sessions.push(nextSession);
		expect(nextSession.serviceTier).toBe("default");
	});

	it("persists the preference across settings manager restarts", async () => {
		harness = await createHarness();
		const agentDir = join(harness.tempDir, "agent");
		const settingsManager = SettingsManager.create(harness.tempDir, agentDir);

		settingsManager.setDefaultServiceTier("priority");
		await settingsManager.flush();

		const reloadedSettingsManager = SettingsManager.create(harness.tempDir, agentDir);
		expect(reloadedSettingsManager.getDefaultServiceTier()).toBe("priority");
	});

	it("restores the saved preference after leaving an unsupported model", async () => {
		harness = await createHarness({
			api: "openai-responses",
			provider: "openai",
			models: [{ id: "gpt-5.5" }, { id: "gpt-4-turbo" }],
		});

		await harness.session.setServiceTier("priority");
		await harness.session.setModel(harness.getModel("gpt-4-turbo")!);

		expect(harness.session.serviceTier).toBe("default");
		expect(harness.settingsManager.getDefaultServiceTier()).toBe("priority");

		await harness.session.setModel(harness.getModel("gpt-5.5")!);
		expect(harness.session.serviceTier).toBe("priority");
	});

	it("admits fast mode with OpenAI API-key models and clamps unsupported ones", async () => {
		harness = await createHarness({
			api: "openai-responses",
			provider: "openai",
			models: [{ id: "gpt-5.5" }, { id: "gpt-4-turbo" }],
		});

		await harness.session.setServiceTier("priority");
		expect(harness.session.serviceTier).toBe("priority");

		await harness.session.setModel(harness.getModel("gpt-4-turbo")!);
		expect(harness.session.serviceTier).toBe("default");
	});

	it("returns the effective service tier when cycling models", async () => {
		harness = await createHarness({
			api: "openai-responses",
			provider: "openai",
			models: [{ id: "gpt-5.5" }, { id: "gpt-4-turbo" }],
		});

		await harness.session.setServiceTier("priority");
		const unsupportedResult = await harness.session.cycleModel();
		expect(unsupportedResult?.model.id).toBe("gpt-4-turbo");
		expect(unsupportedResult?.serviceTier).toBe("default");

		const supportedResult = await harness.session.cycleModel();
		expect(supportedResult?.model.id).toBe("gpt-5.5");
		expect(supportedResult?.serviceTier).toBe("priority");
	});

	it("preserves fast mode while navigating session history", async () => {
		harness = await createHarness({
			api: "openai-responses",
			provider: "openai",
			models: [{ id: "gpt-5.5" }],
		});

		const targetId = await harness.sessionManager.appendMessage(userMsg("first"));
		await harness.sessionManager.appendMessage(assistantMsg("reply"));
		await harness.session.setServiceTier("priority");
		await harness.sessionManager.appendMessage(userMsg("second"));

		await harness.session.navigateTree(targetId, { summarize: false });

		expect(harness.session.serviceTier).toBe("priority");
	});

	it("does not persist a temporary clamp from an unsupported model", async () => {
		harness = await createHarness({
			api: "openai-responses",
			provider: "openai",
			models: [{ id: "gpt-5.5" }, { id: "gpt-4-turbo" }],
			persistSession: true,
		});
		const currentHarness = harness;

		await currentHarness.sessionManager.appendMessage(userMsg("hello"));
		await currentHarness.session.setServiceTier("priority");
		await currentHarness.session.setModel(currentHarness.getModel("gpt-4-turbo")!);
		expect(currentHarness.session.serviceTier).toBe("default");
		expect(currentHarness.sessionManager.buildSessionContext().serviceTier).toBe("priority");
		await currentHarness.session.disposeAsync();

		const createSession = async (modelId: string) =>
			createAgentSession({
				cwd: currentHarness.tempDir,
				authStorage: currentHarness.authStorage,
				model: currentHarness.getModel(modelId),
				resourceLoader: createTestResourceLoader(),
				sessionManager: await SessionManager.open(currentHarness.sessionManager.getSessionFile()!),
				settingsManager: currentHarness.settingsManager,
			});

		const { session: supportedSession } = await createSession("gpt-5.5");
		sessions.push(supportedSession);
		expect(supportedSession.serviceTier).toBe("priority");
	});

	it("stores the preference when a new session starts on an unsupported model", async () => {
		harness = await createHarness({
			api: "openai-responses",
			provider: "openai",
			models: [{ id: "gpt-5.5" }, { id: "gpt-4-turbo" }],
		});
		const currentHarness = harness;
		let sessionManager = SessionManager.inMemory(currentHarness.tempDir);
		currentHarness.settingsManager.setDefaultServiceTier("priority");

		const createSession = (modelId: string) =>
			createAgentSession({
				cwd: currentHarness.tempDir,
				authStorage: currentHarness.authStorage,
				model: currentHarness.getModel(modelId),
				resourceLoader: createTestResourceLoader(),
				sessionManager,
				settingsManager: currentHarness.settingsManager,
			});

		const { session: unsupportedSession } = await createSession("gpt-4-turbo");
		sessions.push(unsupportedSession);
		expect(unsupportedSession.serviceTier).toBe("default");
		expect(sessionManager.buildSessionContext().serviceTier).toBe("priority");
		const nextManager = await sessionManager.forkBranch(sessionManager.getLeafId(), { persist: false });
		await unsupportedSession.disposeAsync();
		sessionManager = nextManager;

		const { session: supportedSession } = await createSession("gpt-5.5");
		sessions.push(supportedSession);
		expect(supportedSession.serviceTier).toBe("priority");
	});
});
