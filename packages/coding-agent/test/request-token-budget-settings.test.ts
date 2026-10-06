import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel, RequestTokenBudget, RequestTokenBudgetError } from "@ponythewhite/base-context-ai";
import { describe, expect, it, vi } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { SessionManager } from "../src/core/session-manager.js";
import { InMemorySettingsStorage, type Settings, SettingsManager } from "../src/core/settings-manager.js";

const example: Settings = JSON.parse(
	readFileSync(new URL("../examples/request-token-budget.json", import.meta.url), "utf8"),
);

describe("request token budget settings", () => {
	it("loads the documented project profile through the CLI services and enforces the native route", async () => {
		const root = mkdtempSync(join(tmpdir(), "base-context-budget-settings-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(cwd, ".base-context"), { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
		writeFileSync(join(cwd, ".base-context", "settings.json"), JSON.stringify(example));
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey("openai", "test-key");
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			authStorage,
			resourceLoaderOptions: { noPromptTemplates: true, noThemes: true, noContextFiles: true },
		});
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(cwd),
		});
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Offline transport reached"));
		try {
			const model = getModel("openai", "gpt-4.1");
			expect(session.model?.id).toBe(model.id);
			expect(session.requests.getRequestTokenBudgetOptions()).toEqual(example.requestTokenBudget);
			const result = await session.requests.complete(
				model,
				{ messages: [] },
				{ apiKey: "test-key", maxRetries: 0 },
				{ purpose: "main" },
			);
			expect(result.stopReason).toBe("error");
			expect(fetch).toHaveBeenCalledOnce();
			expect(String(fetch.mock.calls[0][0])).toBe(example.requestTokenBudget!.profiles[0].url);
			await expect(
				session.requests.complete(
					{ ...model, id: "uncovered-model" },
					{ messages: [] },
					{ apiKey: "test-key", maxRetries: 0 },
					{ purpose: "main" },
				),
			).rejects.toBeInstanceOf(RequestTokenBudgetError);
			expect(fetch).toHaveBeenCalledOnce();
		} finally {
			fetch.mockRestore();
			await session.disposeAsync();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("opts in with the documented profile and leaves ordinary settings unchanged", () => {
		expect(SettingsManager.inMemory().getRequestTokenBudget()).toBeUndefined();
		const settings = SettingsManager.inMemory(example);
		const options = settings.getRequestTokenBudget()!;
		const profile = options.profiles[0];
		const assessment = new RequestTokenBudget(options).measure({
			api: profile.api,
			provider: profile.provider,
			url: profile.url,
			body: JSON.stringify({
				model: profile.model,
				max_output_tokens: 1024,
				input: [{ role: "user", content: "Hello" }],
			}),
		});
		expect(assessment.status).toBe("within-estimate");
		expect(assessment.counter).toBe("openai-o200k-base-estimate");
		Object.assign(profile, { revision: "changed" });
		expect(settings.getRequestTokenBudget()).toEqual(example.requestTokenBudget);
	});

	it("uses project settings over global settings", () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify(example));
		storage.withLock("project", () => JSON.stringify({ requestTokenBudget: { mode: "observe" } }));
		expect(SettingsManager.fromStorage(storage).getRequestTokenBudget()).toEqual({
			...example.requestTokenBudget,
			mode: "observe",
		});
	});

	it("rejects an invalid route with a settings-specific error", () => {
		const invalid = structuredClone(example);
		Object.assign(invalid.requestTokenBudget!.profiles[0], { url: "https://api.openai.com/v1/responses?secret=no" });
		expect(() => SettingsManager.inMemory(invalid).getRequestTokenBudget()).toThrow("Invalid requestTokenBudget");
	});
});

describe("native retry settings", () => {
	it("keeps the default unlimited and accepts explicit zero or finite limits", () => {
		expect(SettingsManager.inMemory().getRetrySettings().maxRetries).toBe(Number.POSITIVE_INFINITY);
		for (const maxRetries of [0, 2]) {
			expect(SettingsManager.inMemory({ retry: { maxRetries } }).getRetrySettings().maxRetries).toBe(maxRetries);
		}
	});

	it("rejects negative or fractional retry counts", () => {
		for (const maxRetries of [-1, 1.5]) {
			expect(() => SettingsManager.inMemory({ retry: { maxRetries } }).getRetrySettings()).toThrow(
				"retry.maxRetries",
			);
		}
	});
});
