import { type Api, getApiProvider, type Model } from "@ponythewhite/base-context-ai";
import { resetOAuthProviders } from "@ponythewhite/base-context-ai/oauth";
import { afterEach, expect, it, vi } from "vitest";
import { AuthStorage, type AuthStorageBackend } from "../src/core/auth-storage.js";
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

it("supports registered non-Prime OAuth and ordinary API keys", async () => {
	const storage = AuthStorage.inMemory({ anthropic: { type: "api_key", key: "sk-ant-api-test" } });
	const registry = ModelRegistry.inMemory(storage);
	expect(getProviderAuthContract("anthropic").oauth).toBe("supported");
	expect(getProviderAuthContract("prime-intellect").oauth).toBe("unsupported");
	expect(isProviderApiKeyAllowed("anthropic", "sk-ant-api-test")).toBe(true);
	expect(isProviderApiKeyAllowed("openai", "sk-openai-test")).toBe(true);
	await expect(registry.getApiKeyAndHeaders(model)).resolves.toMatchObject({ ok: true, apiKey: "sk-ant-api-test" });

	const credentials = { type: "oauth" as const, access: "access", refresh: "refresh", expires: Date.now() + 60_000 };
	storage.set("custom-provider", credentials);
	expect(getProviderAuthContract("custom-provider").oauth).toBe("unsupported");
	const modifyModels = vi.fn((models: Model<Api>[]) => models);
	registry.registerProvider("custom-provider", {
		baseUrl: model.baseUrl,
		api: model.api,
		models: [model],
		oauth: {
			name: "Custom Provider",
			login: vi.fn(async () => credentials),
			refreshToken: vi.fn(async () => credentials),
			getApiKey: (credential) => credential.access,
			modifyModels,
		},
	});
	const registeredModel = registry.find("custom-provider", model.id)!;
	expect(getProviderAuthContract("custom-provider").oauth).toBe("supported");
	expect(registry.hasConfiguredAuth(registeredModel)).toBe(true);
	expect(registry.isUsingOAuth(registeredModel)).toBe(true);
	await expect(registry.getApiKeyAndHeaders(registeredModel)).resolves.toMatchObject({ ok: true, apiKey: "access" });
	expect(modifyModels).toHaveBeenCalledOnce();
	storage.markAuthStale("custom-provider");
	registry.registerProvider("custom-provider", { apiKey: "custom-api-key" });
	expect(registry.hasConfiguredAuth(registeredModel)).toBe(true);
	await expect(registry.getApiKeyAndHeaders(registeredModel)).resolves.toMatchObject({
		ok: true,
		apiKey: "custom-api-key",
		sourceToken: { source: "models_json_key" },
	});

	for (const provider of ["anthropic", "github-copilot", "openai-codex"]) {
		storage.set(provider, credentials);
		const subscriptionModel = registry.getAll().find((entry) => entry.provider === provider)!;
		expect(subscriptionModel).toBeDefined();
		expect(registry.hasConfiguredAuth(subscriptionModel)).toBe(true);
		expect(registry.isUsingOAuth(subscriptionModel)).toBe(true);
		await expect(registry.getApiKeyAndHeaders(subscriptionModel)).resolves.toMatchObject({
			ok: true,
			apiKey: "access",
		});
	}
});

it("keeps the existing Codex SDK exception read-only and limited to its native route", async () => {
	const codexModel: Model<Api> = {
		...model,
		provider: "openai-codex",
		api: "openai-codex-responses",
		baseUrl: "https://chatgpt.com/backend-api/codex",
	};
	const hostCredential = { type: "oauth", access: "host-access-dummy", expires: Date.now() + 60_000 };
	let current = JSON.stringify({ "openai-codex": hostCredential, "renamed-codex": hostCredential });
	const backend: AuthStorageBackend = {
		withLock(fn) {
			const { result, next } = fn(current);
			expect(next).toBeUndefined();
			return result;
		},
		withLockAsync: vi.fn(async () => {
			throw new Error("Borrowed host storage must not use async callbacks");
		}),
	};
	const nativeStream = getApiProvider("openai-codex-responses")!.streamSimple;
	const subscriptionStorage = AuthStorage.fromStorage(backend, {
		existingOpenAICodexSubscription: true,
	});
	const subscriptionRegistry = ModelRegistry.inMemory(subscriptionStorage);
	expect(subscriptionRegistry.hasConfiguredAuth(codexModel)).toBe(true);
	expect(subscriptionRegistry.isUsingOAuth(codexModel)).toBe(true);
	await expect(subscriptionRegistry.getApiKeyAndHeaders(codexModel)).resolves.toMatchObject({
		ok: true,
		apiKey: hostCredential.access,
	});
	for (const deniedModel of [
		{ ...codexModel, provider: "renamed-codex" },
		{ ...codexModel, api: "openai-responses" as const },
		{ ...codexModel, baseUrl: "https://provider.test/codex" },
	]) {
		expect(subscriptionRegistry.hasConfiguredAuth(deniedModel)).toBe(false);
		expect(subscriptionRegistry.isUsingOAuth(deniedModel)).toBe(false);
		await expect(subscriptionRegistry.getApiKeyAndHeaders(deniedModel)).resolves.toMatchObject({ ok: false });
	}
	await expect(
		subscriptionRegistry.getApiKeyAndHeaders({
			...codexModel,
			headers: { Authorization: `Bearer ${hostCredential.access}` },
		}),
	).resolves.toMatchObject({ ok: false });
	subscriptionStorage.setRuntimeApiKey("openai-codex", hostCredential.access);
	await expect(subscriptionRegistry.getApiKeyAndHeaders(codexModel)).resolves.toMatchObject({ ok: false });
	subscriptionStorage.removeRuntimeApiKey("openai-codex");
	for (const config of [
		{ apiKey: hostCredential.access },
		{ authHeader: true },
		{ headers: { Authorization: `Bearer ${hostCredential.access}` } },
	]) {
		const configuredRegistry = ModelRegistry.inMemory(subscriptionStorage);
		configuredRegistry.registerProvider("openai-codex", config);
		await expect(configuredRegistry.getApiKeyAndHeaders(codexModel)).resolves.toMatchObject({ ok: false });
	}
	current = JSON.stringify({ "openai-codex": { type: "api_key", key: hostCredential.access } });
	subscriptionStorage.reload();
	subscriptionStorage.setFallbackResolver(() => hostCredential.access);
	expect(subscriptionRegistry.hasConfiguredAuth(codexModel)).toBe(false);
	expect(subscriptionRegistry.isUsingOAuth(codexModel)).toBe(false);
	await expect(subscriptionRegistry.getApiKeyAndHeaders(codexModel)).resolves.toMatchObject({ ok: false });
	expect(backend.withLockAsync).not.toHaveBeenCalled();
	expect(getApiProvider("openai-codex-responses")!.streamSimple).toBe(nativeStream);
});
