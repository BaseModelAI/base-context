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
		usePrimeCliConfig: false,
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
