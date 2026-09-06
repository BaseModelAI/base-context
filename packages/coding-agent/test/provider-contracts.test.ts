import type { Api, Model } from "@ponythewhite/base-context-ai";
import { resetOAuthProviders } from "@ponythewhite/base-context-ai/oauth";
import { afterEach, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { getProviderAuthContract, isProviderApiKeyAllowed } from "../src/core/provider-contracts.js";

const model: Model<Api> = {
	id: "contract-model",
	name: "Contract Model",
	provider: "anthropic",
	api: "anthropic-messages",
	baseUrl: "https://provider.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

afterEach(() => resetOAuthProviders());

it("keeps ordinary API keys usable without claiming OAuth validation", async () => {
	const storage = AuthStorage.inMemory({ anthropic: { type: "api_key", key: "sk-ant-api-test" } });
	const registry = ModelRegistry.inMemory(storage);
	expect(getProviderAuthContract("anthropic").oauth).toBe("unvalidated");
	expect(isProviderApiKeyAllowed("anthropic", "sk-ant-api-test")).toBe(true);
	expect(isProviderApiKeyAllowed("openai", "sk-openai-test")).toBe(true);
	expect(isProviderApiKeyAllowed("prime-inference", "prime-test-key")).toBe(true);
	expect(registry.hasConfiguredAuth(model)).toBe(true);
	await expect(registry.getApiKeyAndHeaders(model)).resolves.toMatchObject({
		ok: true,
		apiKey: "sk-ant-api-test",
	});
});

it("does not validate OAuth by registration, token relabeling, headers, or protocol aliases", async () => {
	const credentials = { type: "oauth" as const, access: "access", refresh: "refresh", expires: 0 };
	const storage = AuthStorage.inMemory({ "unvalidated-provider": credentials });
	const registry = ModelRegistry.inMemory(storage);
	const oauth = {
		name: "Unvalidated Provider",
		login: vi.fn(async () => credentials),
		refreshToken: vi.fn(async () => credentials),
		getApiKey: vi.fn(() => credentials.access),
		modifyModels: vi.fn((models: Model<Api>[]) => models),
	};
	registry.registerProvider("unvalidated-provider", {
		baseUrl: model.baseUrl,
		api: model.api,
		oauth,
		models: [model],
	});
	const registeredModel = registry.find("unvalidated-provider", model.id)!;
	expect(getProviderAuthContract("unvalidated-provider").oauth).toBe("unvalidated");
	expect(storage.getOAuthProviders()).toEqual([]);
	expect(registry.hasConfiguredAuth(registeredModel)).toBe(false);
	expect(registry.isUsingOAuth(registeredModel)).toBe(false);
	await expect(registry.getApiKeyAndHeaders(registeredModel)).resolves.toMatchObject({ apiKey: undefined });
	for (const callback of Object.values(oauth).filter((value) => typeof value === "function")) {
		expect(callback).not.toHaveBeenCalled();
	}
	expect(storage.get("unvalidated-provider")).toEqual(credentials);

	const subscriptionToken = "sk-ant-oat-test";
	registry.registerProvider("anthropic", { apiKey: subscriptionToken });
	expect(registry.getProviderAuthStatus("anthropic")).toEqual({ configured: false });
	await expect(registry.getApiKeyAndHeaders(model)).resolves.toMatchObject({ ok: false });
	registry.registerProvider("anthropic", {
		apiKey: "sk-ant-api-test",
		headers: { Authorization: `Bearer ${subscriptionToken}` },
	});
	await expect(registry.getApiKeyAndHeaders(model)).resolves.toMatchObject({ ok: false });

	storage.setRuntimeApiKey("renamed-anthropic", subscriptionToken);
	await expect(registry.getApiKeyAndHeaders({ ...model, provider: "renamed-anthropic" })).resolves.toMatchObject({
		ok: false,
	});
	for (const deniedModel of [
		{ ...model, provider: "github-copilot", api: "openai-completions" as const },
		{ ...model, provider: "openai-codex", api: "openai-codex-responses" as const },
		{ ...model, provider: "renamed-codex", api: "openai-codex-responses" as const },
	]) {
		storage.setRuntimeApiKey(deniedModel.provider, "subscription-access-token");
		expect(registry.hasConfiguredAuth(deniedModel)).toBe(false);
		await expect(registry.getApiKeyAndHeaders(deniedModel)).resolves.toMatchObject({ ok: false });
	}
});
