import type { Api, Model } from "@ponythewhite/base-context-ai";
import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";

const apiKey = "fake-runtime-key";
const otherKey = "fake-header-key";
const model: Model<Api> = {
	id: "test-model",
	name: "Test model",
	api: "openai-completions",
	provider: "test-provider",
	baseUrl: "https://example.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 1024,
};

function setup(requestModel = model) {
	const storage = AuthStorage.inMemory();
	storage.setRuntimeApiKey(requestModel.provider, apiKey);
	return { storage, registry: ModelRegistry.inMemory(storage) };
}

describe("request auth header attribution", () => {
	it("attributes the API key actually sent, including generated bearer headers", async () => {
		for (const authHeader of [false, true]) {
			const { storage, registry } = setup();
			registry.registerProvider(model.provider, {
				headers: authHeader ? { Authorization: `Bearer ${otherKey}` } : { "X-Test": "request" },
				authHeader,
			});
			const auth = await registry.getApiKeyAndHeaders(model);
			if (!auth.ok) throw new Error(auth.error);
			const client = new OpenAI({ apiKey: auth.apiKey, defaultHeaders: auth.headers, maxRetries: 0 });
			const request = await client.buildRequest({ method: "post", path: "/chat/completions", body: {} });
			expect(new Headers(request.req.headers).get("authorization")).toBe(`Bearer ${apiKey}`);
			expect(auth.sourceToken?.source).toBe("runtime");
			expect(registry.markProviderAuthSourceStale(auth.sourceToken!)).toBe(true);
			expect(storage.hasAuth(model.provider)).toBe(false);
		}
	});

	it("does not mark an unused API key stale when provider or model Authorization wins", async () => {
		for (const location of ["provider", "model"] as const) {
			const { storage, registry } = setup();
			const headers = { aUtHoRiZaTiOn: `Bearer ${otherKey}` };
			if (location === "provider") registry.registerProvider(model.provider, { headers });
			const requestModel = location === "model" ? { ...model, headers } : model;
			const auth = await registry.getApiKeyAndHeaders(requestModel);
			if (!auth.ok) throw new Error(auth.error);
			const client = new OpenAI({ apiKey: auth.apiKey, defaultHeaders: auth.headers, maxRetries: 0 });
			const request = await client.buildRequest({ method: "post", path: "/chat/completions", body: {} });
			expect(new Headers(request.req.headers).get("authorization")).toBe(`Bearer ${otherKey}`);
			expect(auth.sourceToken).toBeUndefined();
			if (auth.sourceToken) registry.markProviderAuthSourceStale(auth.sourceToken);
			expect(storage.hasAuth(model.provider)).toBe(true);
		}
	});

	it("attributes subscription tokens only when their bearer header is effective", async () => {
		for (const [provider, api] of [
			["anthropic", "anthropic-messages"],
			["github-copilot", "anthropic-messages"],
			["openai-codex", "openai-codex-responses"],
		] as const) {
			const token = provider === "anthropic" ? "sk-ant-oat-test" : "codex-access-test";
			const storage = AuthStorage.inMemory({
				[provider]: { type: "oauth", access: token, refresh: "refresh", expires: Date.now() + 60_000 },
			});
			const registry = ModelRegistry.inMemory(storage);
			for (const effective of [true, false]) {
				const auth = await registry.getApiKeyAndHeaders({
					...model,
					provider,
					api,
					headers: { Authorization: `Bearer ${effective ? token : otherKey}` },
				});
				if (!auth.ok) throw new Error(auth.error);
				// Native Codex sets Authorization after custom headers; Anthropic permits overrides.
				expect(Boolean(auth.sourceToken)).toBe(api === "openai-codex-responses" || effective);
			}
		}
	});

	it.each([
		["openai-responses", "test-provider", "Authorization", `Bearer ${otherKey}`, false],
		["anthropic-messages", "test-provider", "X-Api-Key", otherKey, false],
		["azure-openai-responses", "test-provider", "Api-Key", otherKey, false],
		["google-generative-ai", "test-provider", "X-Goog-Api-Key", otherKey, false],
		["google-vertex", "test-provider", "X-Goog-Api-Key", otherKey, false],
		["mistral-conversations", "test-provider", "Authorization", `Bearer ${otherKey}`, false],
		["openai-completions", "cloudflare-ai-gateway", "cf-aig-authorization", `Bearer ${otherKey}`, true],
		["openai-responses", "cloudflare-ai-gateway", "cf-aig-authorization", `Bearer ${otherKey}`, true],
		["anthropic-messages", "cloudflare-ai-gateway", "cf-aig-authorization", `Bearer ${otherKey}`, false],
	])("respects %s / %s auth-header precedence", async (api, provider, header, value, attributed) => {
		const requestModel: Model<Api> = { ...model, api, provider, headers: { [header]: value } };
		const { storage, registry } = setup(requestModel);
		const auth = await registry.getApiKeyAndHeaders(requestModel);
		if (!auth.ok) throw new Error(auth.error);
		expect(Boolean(auth.sourceToken)).toBe(attributed);
		if (auth.sourceToken) registry.markProviderAuthSourceStale(auth.sourceToken);
		expect(storage.hasAuth(provider)).toBe(!attributed);
	});
});
