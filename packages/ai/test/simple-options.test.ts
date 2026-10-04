import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { buildBaseOptions } from "../src/providers/simple-options.js";

describe("buildBaseOptions", () => {
	const model = getModel("deepseek", "deepseek-flash");

	it("uses DeepSeek native defaults without changing other providers", () => {
		expect(buildBaseOptions(model).maxTokens).toBeUndefined();
		expect(buildBaseOptions({ ...model, provider: "other-provider" }).maxTokens).toBe(32000);
	});

	it("preserves an explicit output limit", () => {
		expect(buildBaseOptions(model, { maxTokens: 8192 }).maxTokens).toBe(8192);
	});
});
