import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshOpenAICodexToken } from "../src/utils/oauth/openai-codex.js";

describe("OpenAI Codex OAuth", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("does not write token refresh failures to stderr", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (): Promise<Response> => {
				return new Response(
					JSON.stringify({
						error: {
							message: "Could not validate your token. Please try signing in again.",
							type: "invalid_request_error",
						},
					}),
					{ status: 401, statusText: "Unauthorized", headers: { "Content-Type": "application/json" } },
				);
			}),
		);

		await expect(refreshOpenAICodexToken("invalid-refresh-token")).rejects.toThrow(
			/OpenAI Codex token refresh failed \(401\).*Could not validate your token/,
		);
		expect(consoleError).not.toHaveBeenCalled();
	});
});

describe("OAuth CLI", () => {
	const tsxLoader = createRequire(import.meta.url).resolve("tsx/esm");
	const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
	const registryUrl = new URL("../src/utils/oauth/index.ts", import.meta.url).href;

	it("lists subscription providers and saves caller-owned credentials after browser login", () => {
		const cwd = mkdtempSync(join(tmpdir(), "base-context-ai-oauth-"));
		try {
			const listed = spawnSync(process.execPath, ["--import", tsxLoader, cliPath, "list"], {
				cwd,
				encoding: "utf8",
			});
			expect(listed.status, listed.stderr).toBe(0);
			for (const provider of ["anthropic", "github-copilot", "openai-codex"]) {
				expect(listed.stdout).toContain(provider);
			}
			expect(listed.stdout).not.toMatch(/prime-intellect|unavailable|unvalidated/);

			const authPath = join(cwd, "auth.json");
			const existing = { example: { type: "api_key", key: "existing-test-key" } };
			writeFileSync(authPath, JSON.stringify(existing), { mode: 0o600 });
			const preload = join(cwd, "mock-oauth.mjs");
			writeFileSync(
				preload,
				`import { getOAuthProvider, registerOAuthProvider } from ${JSON.stringify(registryUrl)};
registerOAuthProvider({
	...getOAuthProvider("openai-codex"),
	async login(callbacks) {
		callbacks.onAuth({ url: "https://example.invalid/oauth/authorize", instructions: "Finish in your browser" });
		callbacks.onProgress("Exchanging authorization code for tokens...");
		return { access: "test-access", refresh: "test-refresh", expires: 123456789, accountId: "test-account" };
	},
});`,
			);
			const result = spawnSync(
				process.execPath,
				["--import", tsxLoader, "--import", pathToFileURL(preload).href, cliPath, "login", "openai-codex"],
				{ cwd, encoding: "utf8" },
			);
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toContain("https://example.invalid/oauth/authorize");
			expect(result.stdout).toContain("Finish in your browser");
			expect(result.stdout).toContain("Credentials saved to auth.json");
			expect(JSON.parse(readFileSync(authPath, "utf8"))).toEqual({
				...existing,
				"openai-codex": {
					type: "oauth",
					access: "test-access",
					refresh: "test-refresh",
					expires: 123456789,
					accountId: "test-account",
				},
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("rejects the removed Prime login without writing credentials", () => {
		const cwd = mkdtempSync(join(tmpdir(), "base-context-ai-oauth-"));
		try {
			const result = spawnSync(process.execPath, ["--import", tsxLoader, cliPath, "login", "prime-intellect"], {
				cwd,
				encoding: "utf8",
			});
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("Unknown provider: prime-intellect");
			expect(existsSync(join(cwd, "auth.json"))).toBe(false);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
