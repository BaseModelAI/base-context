import { describe, expect, it } from "vitest";
import { createAgentSession } from "../../../src/core/sdk.js";
import { SessionManager } from "../../../src/core/session-manager.js";
import { SettingsManager } from "../../../src/core/settings-manager.js";
import { createHarness } from "../harness.js";

describe("SDK restoration of persisted branch controls", () => {
	it.each([true, false])("restores model and thinking settings when messages=%s", async (withMessage) => {
		const harness = await createHarness({
			persistSession: true,
			rlmDepth: 0,
			models: [
				{ id: "default-model", name: "Default", reasoning: true },
				{ id: "selected-model", name: "Selected", reasoning: true },
			],
		});
		try {
			const selectedModel = harness.getModel("selected-model")!;
			await harness.session.setModel(selectedModel);
			await harness.session.setThinkingLevel("high");
			if (withMessage) {
				await harness.sessionManager.appendMessage({ role: "user", content: "Saved input", timestamp: 1 });
			}
			const sessionFile = harness.sessionManager.getSessionFile()!;
			await harness.session.disposeAsync();
			const manager = await SessionManager.open(sessionFile);
			const before = await manager.readEntries();
			const { session } = await createAgentSession({
				cwd: harness.tempDir,
				agentDir: harness.tempDir,
				sessionManager: manager,
				authStorage: harness.authStorage,
				modelRegistry: harness.session.modelRegistry,
				resourceLoader: harness.session.resourceLoader,
				settingsManager: SettingsManager.inMemory({
					defaultProvider: selectedModel.provider,
					defaultModel: "default-model",
					defaultThinkingLevel: "low",
				}),
				tools: [],
				includeGoals: false,
				prewarmIpythonKernel: false,
				rlmDepth: 0,
			});
			try {
				expect(session.model?.id).toBe(selectedModel.id);
				expect(session.thinkingLevel).toBe("high");
				expect((await manager.readEntries()).filter((entry) => entry.type === "model_change")).toEqual(
					before.filter((entry) => entry.type === "model_change"),
				);
				expect((await manager.readEntries()).filter((entry) => entry.type === "thinking_level_change")).toEqual(
					before.filter((entry) => entry.type === "thinking_level_change"),
				);
			} finally {
				await session.disposeAsync();
			}
		} finally {
			await harness.cleanup();
		}
	});
});
