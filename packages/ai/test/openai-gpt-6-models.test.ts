import { describe, expect, it } from "vitest";
import { clampThinkingLevel, getModel, getModels, getSupportedThinkingLevels } from "../src/models.js";

const cases = [
	{
		id: "gpt-6-sol",
		name: "GPT-6 Sol",
		cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
		supportsApiOff: true,
	},
	{
		id: "gpt-6-luna",
		name: "GPT-6 Luna",
		cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
		supportsApiOff: true,
	},
	{
		id: "gpt-6.1-sol",
		name: "GPT-6.1 Sol",
		cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
		supportsApiOff: false,
	},
] as const;

describe("GPT-6 and GPT-6.1 catalog", () => {
	for (const provider of ["openai", "openai-codex"] as const) {
		it.each(cases)(`registers $id for ${provider}`, ({ id, name, cost, supportsApiOff }) => {
			const model = getModel(provider, id);
			const isCodex = provider === "openai-codex";

			expect(getModels(provider).filter((candidate) => candidate.id === id)).toEqual([model]);
			expect(model).toMatchObject({
				id,
				name,
				provider,
				api: isCodex ? "openai-codex-responses" : "openai-responses",
				baseUrl: isCodex ? "https://chatgpt.com/backend-api" : "https://api.openai.com/v1",
				reasoning: true,
				input: ["text", "image"],
				cost,
				contextWindow: isCodex ? 872000 : 1050000,
				maxTokens: 128000,
			});
			expect(getSupportedThinkingLevels(model)).toEqual(
				!isCodex && supportsApiOff
					? ["off", "low", "medium", "high", "xhigh", "max"]
					: ["low", "medium", "high", "xhigh", "max"],
			);
		});
	}

	it("only offers off for GPT-6 API models and excludes unsupported minimal efforts", () => {
		for (const { id, supportsApiOff } of cases) {
			const apiModel = getModel("openai", id);
			const codexModel = getModel("openai-codex", id);

			expect(apiModel.thinkingLevelMap?.off).toBe(supportsApiOff ? "none" : null);
			expect(clampThinkingLevel(apiModel, "off")).toBe(supportsApiOff ? "off" : "low");
			expect(codexModel.thinkingLevelMap?.off).toBeNull();
			expect(clampThinkingLevel(codexModel, "off")).toBe("low");
			for (const model of [apiModel, codexModel]) {
				expect(clampThinkingLevel(model, "minimal")).toBe("low");
				expect(model.thinkingLevelMap?.max).toBe("max");
			}
		}
	});
});
