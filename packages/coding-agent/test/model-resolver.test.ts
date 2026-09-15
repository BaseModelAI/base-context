import type { Model } from "@ponythewhite/base-context-ai";
import { describe, expect, test, vi } from "vitest";
import { findInitialModel, resolveCliModel, resolveModelScopeFromModels } from "../src/core/model-resolver.js";

const mockModels: Model<"anthropic-messages">[] = [
	{
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 8192,
	},
	{
		id: "gpt-4o",
		name: "GPT-4o",
		api: "anthropic-messages", // Using same type for simplicity
		provider: "openai",
		baseUrl: "https://api.openai.com",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 5 },
		contextWindow: 128000,
		maxTokens: 4096,
	},
];

const mockOpenRouterModels: Model<"anthropic-messages">[] = [
	{
		id: "qwen/qwen3-coder:exacto",
		name: "Qwen3 Coder Exacto",
		api: "anthropic-messages",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
		contextWindow: 128000,
		maxTokens: 8192,
	},
	{
		id: "openai/gpt-4o:extended",
		name: "GPT-4o Extended",
		api: "anthropic-messages",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 5 },
		contextWindow: 128000,
		maxTokens: 4096,
	},
];

const allModels = [...mockModels, ...mockOpenRouterModels];

describe("resolveModelScopeFromModels", () => {
	test("resolves scope patterns against the supplied model list", () => {
		const daemonModel: Model<"anthropic-messages"> = {
			id: "daemon-only-model",
			name: "Daemon Only Model",
			api: "anthropic-messages",
			provider: "custom-catalog",
			baseUrl: "https://models.example.test/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 128000,
			maxTokens: 8192,
		};

		const result = resolveModelScopeFromModels(
			["custom-catalog/daemon-only-model:high", "openai/gpt-4o"],
			[...allModels, daemonModel],
		);

		expect(result).toHaveLength(2);
		expect(result[0]?.model).toBe(daemonModel);
		expect(result[0]?.thinkingLevel).toBe("high");
		expect(result[1]?.model.provider).toBe("openai");
		expect(result[1]?.model.id).toBe("gpt-4o");
	});

	test("resolves a thinking level after a colon-bearing model id", () => {
		const result = resolveModelScopeFromModels(["openrouter/qwen/qwen3-coder:exacto:high"], allModels);

		expect(result).toEqual([{ model: mockOpenRouterModels[0], thinkingLevel: "high" }]);
	});

	test("keeps the model, warns, and drops an invalid thinking suffix", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const result = resolveModelScopeFromModels(["sonnet:random"], allModels);

			expect(result).toEqual([{ model: mockModels[0], thinkingLevel: undefined }]);
			expect(warn).toHaveBeenCalledWith(expect.stringContaining('Invalid thinking level "random"'));
		} finally {
			warn.mockRestore();
		}
	});

	test("preserves provider-qualified selections when model names overlap", () => {
		const catalogModel: Model<"anthropic-messages"> = {
			...mockModels[0]!,
			id: "z-ai/glm-5.2",
			name: "GLM 5.2",
			provider: "custom-catalog",
			baseUrl: "https://models.example.test/v1",
		};
		const huggingFaceModel: Model<"anthropic-messages"> = {
			...catalogModel,
			id: "zai-org/GLM-5.2",
			provider: "huggingface",
			baseUrl: "https://router.huggingface.co/v1",
		};

		const result = resolveModelScopeFromModels(["huggingface/zai-org/GLM-5.2"], [catalogModel, huggingFaceModel]);

		expect(result).toEqual([{ model: huggingFaceModel, thinkingLevel: undefined }]);
	});
});

describe("resolveCliModel", () => {
	test("resolves --model provider/id without --provider", () => {
		const registry = {
			getAll: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliModel: "openai/gpt-4o",
			modelRegistry: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openai");
		expect(result.model?.id).toBe("gpt-4o");
	});

	test("resolves fuzzy patterns within an explicit provider", () => {
		const registry = {
			getAll: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliProvider: "openai",
			cliModel: "4o",
			modelRegistry: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openai");
		expect(result.model?.id).toBe("gpt-4o");
	});

	test("supports --model <pattern>:<thinking> (without explicit --thinking)", () => {
		const registry = {
			getAll: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliProvider: "anthropic",
			cliModel: "sonnet:high",
			modelRegistry: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.id).toBe("claude-sonnet-4-5");
		expect(result.thinkingLevel).toBe("high");
	});

	test("keeps nested model ids on the explicitly selected gateway provider", () => {
		const registry = {
			getAll: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliModel: "openrouter/openai/gpt-4o:extended",
			modelRegistry: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openrouter");
		expect(result.model?.id).toBe("openai/gpt-4o:extended");
	});

	test("does not strip invalid :suffix as thinking level in --model (treat as raw id)", () => {
		const registry = {
			getAll: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliProvider: "openai",
			cliModel: "gpt-4o:extended",
			modelRegistry: registry,
		});

		expect(result.model).toBeUndefined();
		expect(result.error).toContain("openai/gpt-4o:extended");
	});

	test("rejects unlisted model ids instead of fabricating a model", () => {
		const registry = {
			getAll: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliProvider: "openrouter",
			cliModel: "openrouter/openai/ghost-model",
			modelRegistry: registry,
		});

		expect(result.model).toBeUndefined();
		expect(result.error).toContain("openrouter/openai/ghost-model");
	});

	test("returns a clear error when there are no models", () => {
		const registry = {
			getAll: () => [],
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliProvider: "openai",
			cliModel: "gpt-4o",
			modelRegistry: registry,
		});

		expect(result.model).toBeUndefined();
		expect(result.error).toContain("No models available");
	});

	test("prefers provider/model split over gateway model with matching id", () => {
		const zaiModel: Model<"anthropic-messages"> = {
			id: "glm-5",
			name: "GLM-5",
			api: "anthropic-messages",
			provider: "zai",
			baseUrl: "https://open.bigmodel.cn/api/paas/v4",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 128000,
			maxTokens: 8192,
		};
		const gatewayModel: Model<"anthropic-messages"> = {
			id: "zai/glm-5",
			name: "GLM-5",
			api: "anthropic-messages",
			provider: "vercel-ai-gateway",
			baseUrl: "https://ai-gateway.vercel.sh",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 128000,
			maxTokens: 8192,
		};
		const registry = {
			getAll: () => [...allModels, zaiModel, gatewayModel],
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliModel: "zai/glm-5",
			modelRegistry: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("zai");
		expect(result.model?.id).toBe("glm-5");
	});

	test("resolves provider-prefixed fuzzy patterns (openrouter/qwen -> openrouter model)", () => {
		const registry = {
			getAll: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliModel: "openrouter/qwen",
			modelRegistry: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openrouter");
		expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
	});
});

describe("explicit initial model selection", () => {
	const registry = {
		getAll: () => allModels,
		find: (provider: string, id: string) => allModels.find((model) => model.provider === provider && model.id === id),
		hasConfiguredAuth: () => false,
		refreshAvailableModels: async () => allModels,
	} as unknown as Parameters<typeof findInitialModel>[0]["modelRegistry"];

	test("accepts an explicit supported provider/model and keeps the default thinking level", async () => {
		const result = await findInitialModel({
			cliModel: "openai/gpt-4o",
			scopedModels: [],
			isContinuing: false,
			modelRegistry: registry,
		});
		expect(result.model).toBe(mockModels[1]);
		expect(result.thinkingLevel).toBe("medium");
	});

	test("does not choose a model merely because providers or model scopes are available", async () => {
		for (const scopedModels of [[], [{ model: mockModels[0] }], allModels.map((model) => ({ model }))]) {
			const result = await findInitialModel({ scopedModels, isContinuing: false, modelRegistry: registry });
			expect(result.model).toBeUndefined();
		}
		const cli = resolveCliModel({ cliModel: "gpt-4o", modelRegistry: registry });
		expect(cli.model).toBeUndefined();
		expect(cli.error).toContain("Choose a provider");
	});

	test("keeps the saved explicit model when its authentication still needs setup", async () => {
		const result = await findInitialModel({
			defaultProvider: "anthropic",
			defaultModelId: "claude-sonnet-4-5",
			defaultThinkingLevel: "high",
			scopedModels: [],
			isContinuing: false,
			modelRegistry: registry,
		});
		expect(result.model).toBe(mockModels[0]);
		expect(result.thinkingLevel).toBe("high");
	});

	test("does not reconstruct an unlisted saved model or select another provider", async () => {
		const result = await findInitialModel({
			defaultProvider: "anthropic",
			defaultModelId: "unlisted-model",
			scopedModels: [],
			isContinuing: false,
			modelRegistry: registry,
		});
		expect(result.model).toBeUndefined();
		const changedProvider = await findInitialModel({
			cliProvider: "openai",
			defaultProvider: "anthropic",
			defaultModelId: "claude-sonnet-4-5",
			scopedModels: [],
			isContinuing: false,
			modelRegistry: registry,
		});
		expect(changedProvider.model).toBeUndefined();
		await expect(
			findInitialModel({
				cliModel: "anthropic/unlisted-model",
				scopedModels: [],
				isContinuing: false,
				modelRegistry: registry,
			}),
		).rejects.toThrow("not found");
	});
});
