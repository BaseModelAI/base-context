import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.js";
import { ModelRegistry } from "../../../src/core/model-registry.js";

function codexAccessToken(accountId: string): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64url");
	return `header.${payload}.signature`;
}

describe("issue #702 codex model discovery client version", () => {
	const tempDirs: string[] = [];
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir) {
				rmSync(dir, { recursive: true, force: true });
			}
		}
	});

	it("discovers authorized GPT-6 models with a supported Codex client version", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "codex-client-version-"));
		tempDirs.push(tempDir);
		const authPath = join(tempDir, "auth.json");
		writeFileSync(
			authPath,
			JSON.stringify({
				"openai-codex": {
					type: "oauth",
					access: codexAccessToken("account-123"),
					refresh: "refresh-token",
					expires: Date.now() + 60 * 60 * 1000,
					accountId: "account-123",
				},
			}),
		);

		const registry = ModelRegistry.create(AuthStorage.create(authPath), join(tempDir, "models.json"));
		const authorizedIds = ["gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol"];
		for (const id of [...authorizedIds, "gpt-6-astra"]) {
			expect(registry.find("openai-codex", id)).toBeDefined();
		}
		const unknownId = "unknown-codex-model";
		expect(registry.find("openai-codex", unknownId)).toBeUndefined();

		const requestedUrls: string[] = [];
		globalThis.fetch = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
			requestedUrls.push(input instanceof Request ? input.url : input.toString());
			return new Response(JSON.stringify({ models: [...authorizedIds, unknownId].map((slug) => ({ slug })) }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof globalThis.fetch;

		const executable = await registry.getExecutableModels();

		expect(requestedUrls).toHaveLength(1);
		const discoveryUrl = new URL(requestedUrls[0]!);
		expect(discoveryUrl.pathname).toBe("/backend-api/codex/models");
		// Codex models.json requires 0.155.0 for GPT-6 Sol and Luna.
		expect(discoveryUrl.searchParams.get("client_version")).toBe("0.155.0");

		const executableIds = executable.filter((model) => model.provider === "openai-codex").map((model) => model.id);
		expect(executableIds.sort()).toEqual([...authorizedIds].sort());
		expect(executableIds).not.toContain("gpt-6-astra");
		expect(executableIds).not.toContain(unknownId);
	});
});
