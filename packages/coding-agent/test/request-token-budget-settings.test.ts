import { readFileSync } from "node:fs";
import { RequestTokenBudget } from "@ponythewhite/base-context-ai";
import { describe, expect, it } from "vitest";
import { InMemorySettingsStorage, type Settings, SettingsManager } from "../src/core/settings-manager.js";

const example: Settings = JSON.parse(
	readFileSync(new URL("../examples/request-token-budget.json", import.meta.url), "utf8"),
);

describe("request token budget settings", () => {
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
