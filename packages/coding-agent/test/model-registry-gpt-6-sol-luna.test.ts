import { expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";

it("offers GPT-6 Sol and Luna in the API-key and subscription model pickers", () => {
	const authStorage = AuthStorage.inMemory({
		openai: { type: "api_key", key: "test-openai-key" },
		"openai-codex": {
			type: "oauth",
			access: "test-codex-access",
			refresh: "test-codex-refresh",
			expires: Date.now() + 3600000,
		},
	});
	const registry = ModelRegistry.inMemory(authStorage);
	const available = registry.getAvailable();

	for (const provider of ["openai", "openai-codex"] as const) {
		for (const id of ["gpt-6-sol", "gpt-6-luna"] as const) {
			const model = registry.find(provider, id);
			expect(model).toBeDefined();
			expect(available.filter((candidate) => candidate.provider === provider && candidate.id === id)).toEqual([
				model,
			]);
		}
	}
});
