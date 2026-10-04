import { describe, expect, it } from "vitest";
import {
	getCodexContextPolicy,
	getModel,
	getModels,
	getUsableContextWindow,
	type KnownProvider,
} from "../src/index.js";

const cases = [
	{
		model: getModel("deepseek", "deepseek-flash"),
		nominalContextWindow: 1048576,
		usableContextWindow: 996147,
		autoCompactTokenLimit: 943718,
	},
	{
		model: getModel("openai-codex", "gpt-6.1-sol"),
		nominalContextWindow: 272000,
		usableContextWindow: 258400,
		autoCompactTokenLimit: 244800,
	},
	{
		model: getModel("openai-codex", "gpt-6-astra"),
		nominalContextWindow: 272000,
		usableContextWindow: 258400,
		autoCompactTokenLimit: 244800,
	},
];

describe("Codex context policy", () => {
	it.each(cases)(
		"sets registry defaults and separate limits for $model.provider/$model.id",
		({ model, ...limits }) => {
			expect(model.contextWindow).toBe(limits.nominalContextWindow);
			expect(getModels(model.provider as KnownProvider).find((candidate) => candidate.id === model.id)).toBe(model);
			expect(getCodexContextPolicy(model)).toEqual({ ...limits, postTurnCompactThresholdPercent: 0 });
			expect(getUsableContextWindow(model)).toBe(limits.usableContextWindow);
		},
	);

	it("derives limits from explicit nominal overrides without changing model objects", () => {
		for (const { model, nominalContextWindow } of cases) {
			const overriddenModel = Object.freeze({ ...model, contextWindow: 123457 });
			expect(getCodexContextPolicy(overriddenModel)).toEqual({
				nominalContextWindow: 123457,
				usableContextWindow: 117284,
				autoCompactTokenLimit: 111111,
				postTurnCompactThresholdPercent: 0,
			});
			expect(getUsableContextWindow(overriddenModel)).toBe(117284);
			expect(overriddenModel.contextWindow).toBe(123457);
			expect(model.contextWindow).toBe(nominalContextWindow);
		}
	});

	it("leaves other providers and model IDs unchanged", () => {
		const unrelated = [
			{ model: getModel("openai", "gpt-6.1-sol"), contextWindow: 1050000 },
			{ model: getModel("openai", "gpt-6-astra"), contextWindow: 1050000 },
			{ model: getModel("openai-codex", "gpt-6-sol"), contextWindow: 872000 },
			{ model: getModel("deepseek", "deepseek-v4-flash"), contextWindow: 1000000 },
		];
		for (const { model, contextWindow } of unrelated) {
			expect(model.contextWindow).toBe(contextWindow);
			expect(getCodexContextPolicy(model)).toBeUndefined();
			expect(getUsableContextWindow(model)).toBe(contextWindow);
		}
	});
});
