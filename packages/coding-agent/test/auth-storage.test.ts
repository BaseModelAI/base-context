import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerOAuthProvider, resetOAuthProviders } from "@ponythewhite/base-context-ai/oauth";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage, type AuthStorageBackend, FileAuthStorageBackend } from "../src/core/auth-storage.js";
import * as providerContracts from "../src/core/provider-contracts.js";

describe("AuthStorage", () => {
	let tempDir: string;
	let authJsonPath: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-auth-storage-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		authJsonPath = join(tempDir, "auth.json");
		for (const name of [
			"ANTHROPIC_API_KEY",
			"ANTHROPIC_OAUTH_TOKEN",
			"COPILOT_GITHUB_TOKEN",
			"GH_TOKEN",
			"GITHUB_TOKEN",
		]) {
			vi.stubEnv(name, "");
		}
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Provider calls are not allowed in these tests"));
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		resetOAuthProviders();
	});

	function writeAuthJson(data: Record<string, unknown>) {
		writeFileSync(authJsonPath, JSON.stringify(data));
	}

	function toShPath(value: string): string {
		return value.replace(/\\/g, "/").replace(/"/g, '\\"');
	}

	describe("API key resolution", () => {
		test("literal API key is returned directly", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "sk-ant-literal-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("sk-ant-literal-key");
		});

		test("apiKey with ! prefix executes command and uses stdout", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo test-api-key-from-command" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("test-api-key-from-command");
		});

		test("apiKey with ! prefix trims whitespace from command output", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo '  spaced-key  '" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("spaced-key");
		});

		test("apiKey with ! prefix handles multiline output (uses trimmed result)", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!printf 'line1\\nline2'" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("line1\nline2");
		});

		test("apiKey with ! prefix returns undefined on command failure", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!exit 1" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey with ! prefix returns undefined on nonexistent command", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!nonexistent-command-12345" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey with ! prefix returns undefined on empty output", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!printf ''" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey as environment variable name resolves to env value", async () => {
			const originalEnv = process.env.TEST_AUTH_API_KEY_12345;
			process.env.TEST_AUTH_API_KEY_12345 = "env-api-key-value";

			try {
				writeAuthJson({
					anthropic: { type: "api_key", key: "TEST_AUTH_API_KEY_12345" },
				});

				authStorage = AuthStorage.create(authJsonPath);
				const apiKey = await authStorage.getApiKey("anthropic");

				expect(apiKey).toBe("env-api-key-value");
			} finally {
				if (originalEnv === undefined) {
					delete process.env.TEST_AUTH_API_KEY_12345;
				} else {
					process.env.TEST_AUTH_API_KEY_12345 = originalEnv;
				}
			}
		});

		test("ambient environment credentials count as available auth", async () => {
			const originalAwsProfile = process.env.AWS_PROFILE;
			process.env.AWS_PROFILE = "pi-test-profile";

			try {
				authStorage = AuthStorage.inMemory();

				expect(authStorage.hasAuth("amazon-bedrock")).toBe(true);
				await expect(authStorage.getApiKey("amazon-bedrock")).resolves.toBe("<authenticated>");
				expect(authStorage.getAuthStatus("amazon-bedrock")).toEqual({
					configured: false,
					source: "environment",
					label: "ambient credentials",
				});
			} finally {
				if (originalAwsProfile === undefined) {
					delete process.env.AWS_PROFILE;
				} else {
					process.env.AWS_PROFILE = originalAwsProfile;
				}
			}
		});

		test("changed ambient environment credential no longer matches stale auth marker", async () => {
			const originalAwsProfile = process.env.AWS_PROFILE;
			process.env.AWS_PROFILE = "stale-profile";

			try {
				authStorage = AuthStorage.inMemory();
				expect(authStorage.markAuthStale("amazon-bedrock")).toBe(true);
				expect(authStorage.hasAuth("amazon-bedrock")).toBe(false);
				await expect(authStorage.getApiKey("amazon-bedrock")).resolves.toBeUndefined();

				process.env.AWS_PROFILE = "fresh-profile";

				expect(authStorage.hasAuth("amazon-bedrock")).toBe(true);
				await expect(authStorage.getApiKey("amazon-bedrock")).resolves.toBe("<authenticated>");
			} finally {
				if (originalAwsProfile === undefined) {
					delete process.env.AWS_PROFILE;
				} else {
					process.env.AWS_PROFILE = originalAwsProfile;
				}
			}
		});

		test("apiKey as literal value is used directly when not an env var", async () => {
			delete process.env.literal_api_key_value;

			writeAuthJson({
				anthropic: { type: "api_key", key: "literal_api_key_value" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("literal_api_key_value");
		});

		test("stored credential updates do not revive stale runtime auth", async () => {
			authStorage = AuthStorage.inMemory();
			authStorage.setRuntimeApiKey("anthropic", "runtime-key");
			expect(authStorage.markAuthStale("anthropic")).toBe(true);

			authStorage.set("anthropic", { type: "api_key", key: "stored-key" });

			expect(authStorage.getAuthStatus("anthropic")).toEqual({ configured: true, source: "stored" });
			await expect(authStorage.getApiKey("anthropic")).resolves.toBe("stored-key");

			authStorage.remove("anthropic");

			expect(authStorage.getAuthStatus("anthropic")).toEqual({
				configured: false,
				source: "stale",
				label: "expired",
			});
			await expect(authStorage.getApiKey("anthropic")).resolves.toBeUndefined();
		});

		test("changed command-backed stored key no longer matches stale auth marker", async () => {
			const tokenFile = join(tempDir, "command-token");
			writeFileSync(tokenFile, "stale-key");
			const tokenPath = toShPath(tokenFile);
			writeAuthJson({
				anthropic: { type: "api_key", key: `!sh -c 'cat "${tokenPath}"'` },
			});

			authStorage = AuthStorage.create(authJsonPath);
			await expect(authStorage.getApiKey("anthropic")).resolves.toBe("stale-key");
			expect(authStorage.markAuthStale("anthropic")).toBe(true);
			expect(authStorage.hasAuth("anthropic")).toBe(false);
			await expect(authStorage.getApiKey("anthropic")).resolves.toBeUndefined();

			writeFileSync(tokenFile, "fresh-key");

			expect(authStorage.hasAuth("anthropic")).toBe(true);
			await expect(authStorage.getApiKey("anthropic")).resolves.toBe("fresh-key");
			expect(authStorage.getAuthStatus("anthropic")).toEqual({ configured: true, source: "stored" });
		});

		test("apiKey command can use shell features like pipes", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo 'hello world' | tr ' ' '-'" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("hello-world");
		});

		describe("caching", () => {
			test("command is only executed once per process", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeAuthJson({
					anthropic: { type: "api_key", key: command },
				});

				authStorage = AuthStorage.create(authJsonPath);

				await authStorage.getApiKey("anthropic");
				await authStorage.getApiKey("anthropic");
				await authStorage.getApiKey("anthropic");

				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(1);
			});

			test("cache persists across AuthStorage instances", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeAuthJson({
					anthropic: { type: "api_key", key: command },
				});

				const storage1 = AuthStorage.create(authJsonPath);
				await storage1.getApiKey("anthropic");

				const storage2 = AuthStorage.create(authJsonPath);
				await storage2.getApiKey("anthropic");

				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(1);
			});

			test("different commands are cached separately", async () => {
				writeAuthJson({
					anthropic: { type: "api_key", key: "!echo key-anthropic" },
					openai: { type: "api_key", key: "!echo key-openai" },
				});

				authStorage = AuthStorage.create(authJsonPath);

				const keyA = await authStorage.getApiKey("anthropic");
				const keyB = await authStorage.getApiKey("openai");

				expect(keyA).toBe("key-anthropic");
				expect(keyB).toBe("key-openai");
			});

			test("failed commands are cached (not retried)", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; exit 1'`;
				writeAuthJson({
					anthropic: { type: "api_key", key: command },
				});

				authStorage = AuthStorage.create(authJsonPath);

				const key1 = await authStorage.getApiKey("anthropic");
				const key2 = await authStorage.getApiKey("anthropic");

				expect(key1).toBeUndefined();
				expect(key2).toBeUndefined();

				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(1);
			});

			test("environment variables are not cached (changes are picked up)", async () => {
				const envVarName = "TEST_AUTH_KEY_CACHE_TEST_98765";
				const originalEnv = process.env[envVarName];

				try {
					process.env[envVarName] = "first-value";

					writeAuthJson({
						anthropic: { type: "api_key", key: envVarName },
					});

					authStorage = AuthStorage.create(authJsonPath);

					const key1 = await authStorage.getApiKey("anthropic");
					expect(key1).toBe("first-value");

					process.env[envVarName] = "second-value";

					const key2 = await authStorage.getApiKey("anthropic");
					expect(key2).toBe("second-value");
				} finally {
					if (originalEnv === undefined) {
						delete process.env[envVarName];
					} else {
						process.env[envVarName] = originalEnv;
					}
				}
			});
		});
	});

	describe("OAuth distribution capability", () => {
		test("persists registered non-Prime logins and refreshes expired credentials", async () => {
			for (const providerId of ["anthropic", "github-copilot", "openai-codex", "custom-oauth", "mcp:custom"]) {
				const credentials = { access: "saved-access", refresh: "saved-refresh", expires: Date.now() + 60_000 };
				const refreshed = { access: "new-access", refresh: "new-refresh", expires: Date.now() + 120_000 };
				const login = vi.fn(async () => credentials);
				const refreshToken = vi.fn(async () => refreshed);
				registerOAuthProvider({
					id: providerId,
					name: providerId,
					login,
					refreshToken,
					getApiKey: (credential) => credential.access,
				});
				authStorage = AuthStorage.create(authJsonPath);
				expect(authStorage.getOAuthProviders().some((provider) => provider.id === providerId)).toBe(true);
				const callbacks = { onAuth: vi.fn(), onPrompt: vi.fn() };
				await authStorage.login(providerId, callbacks);
				expect(login).toHaveBeenCalledWith(callbacks);
				expect(JSON.parse(readFileSync(authJsonPath, "utf8"))[providerId]).toEqual({
					type: "oauth",
					...credentials,
				});
				authStorage = AuthStorage.create(authJsonPath);
				expect(authStorage.getAuthStatus(providerId)).toEqual({ configured: true, source: "stored" });
				await expect(authStorage.getApiKey(providerId)).resolves.toBe(credentials.access);
				expect(refreshToken).not.toHaveBeenCalled();
				authStorage.set(providerId, { type: "oauth", ...credentials, expires: 0 });
				const expiredSource = authStorage.getCurrentAuthSourceToken(providerId);
				const result = await authStorage.getApiKeyWithSourceToken(providerId);
				expect(result.apiKey).toBe(refreshed.access);
				expect(result.sourceToken?.source).toBe("stored");
				expect(result.sourceToken).not.toEqual(expiredSource);
				expect(refreshToken).toHaveBeenCalledOnce();
				expect(JSON.parse(readFileSync(authJsonPath, "utf8"))[providerId]).toEqual({ type: "oauth", ...refreshed });
			}
			expect(globalThis.fetch).not.toHaveBeenCalled();
		});

		test("keeps the existing Codex SDK mode read-only without login or refresh", async () => {
			const login = vi.fn();
			const refreshToken = vi.fn();
			registerOAuthProvider({
				id: "openai-codex",
				name: "Codex",
				login,
				refreshToken,
				getApiKey: (cred) => cred.access,
			});
			for (const fresh of [true, false]) {
				const credential = {
					type: "oauth",
					access: "host-access-dummy",
					expires: Date.now() + (fresh ? 60_000 : -60_000),
				};
				const current = JSON.stringify({ "openai-codex": credential });
				const backend: AuthStorageBackend = {
					withLock(fn) {
						const { result, next } = fn(current);
						expect(next).toBeUndefined();
						return result;
					},
					withLockAsync: vi.fn(async () => {
						throw new Error("Read-only storage must not refresh");
					}),
				};
				authStorage = AuthStorage.fromStorage(backend, { existingOpenAICodexSubscription: true });
				expect(authStorage.getOAuthProviders()).toEqual([]);
				await expect(authStorage.login("openai-codex", { onAuth: vi.fn(), onPrompt: vi.fn() })).rejects.toThrow(
					"read-only",
				);
				if (fresh) {
					expect(authStorage.hasAuth("openai-codex")).toBe(true);
					await expect(authStorage.getApiKey("openai-codex")).resolves.toBe(credential.access);
				} else {
					await expect(authStorage.getApiKey("openai-codex")).rejects.toThrow("has expired");
				}
				expect(() => authStorage.set("openai-codex", { type: "api_key", key: "dummy" })).toThrow("read-only");
				expect(() => authStorage.remove("openai-codex")).toThrow("read-only");
				expect(() => authStorage.removeVerified("openai-codex")).toThrow("read-only");
				expect(authStorage.getAll()).toEqual({ "openai-codex": credential });
				expect(backend.withLockAsync).not.toHaveBeenCalled();
			}
			expect(login).not.toHaveBeenCalled();
			expect(refreshToken).not.toHaveBeenCalled();
		});

		test("keeps Prime and unregistered OAuth unavailable without blocking ordinary API keys", async () => {
			const login = vi.fn();
			const refreshToken = vi.fn();
			registerOAuthProvider({
				id: "prime-intellect",
				name: "Prime",
				login,
				refreshToken,
				getApiKey: () => "unused",
			});
			for (const providerId of ["prime-intellect", "unregistered-provider"]) {
				const credential = { type: "oauth" as const, access: "access", refresh: "refresh", expires: 0 };
				authStorage = AuthStorage.inMemory({ [providerId]: credential });
				expect(authStorage.hasAuth(providerId)).toBe(false);
				await expect(authStorage.getApiKey(providerId)).resolves.toBeUndefined();
				await expect(authStorage.login(providerId, { onAuth: vi.fn(), onPrompt: vi.fn() })).rejects.toThrow(
					providerContracts.getProviderAuthContract(providerId).guidance,
				);
				expect(authStorage.get(providerId)).toEqual(credential);
			}
			expect(login).not.toHaveBeenCalled();
			expect(refreshToken).not.toHaveBeenCalled();
			vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "sk-ant-oat-test");
			authStorage = AuthStorage.inMemory();
			await expect(authStorage.getApiKey("anthropic")).resolves.toBe("sk-ant-oat-test");
			expect(authStorage.getAuthStatus("anthropic").label).toBe("ANTHROPIC_OAUTH_TOKEN");
			authStorage.setRuntimeApiKey("anthropic", "runtime-api-key");
			await expect(authStorage.getApiKey("anthropic")).resolves.toBe("runtime-api-key");
			expect(globalThis.fetch).not.toHaveBeenCalled();
		});
	});

	describe("login ownership", () => {
		const credentials = { access: "late-access", refresh: "refresh", expires: 4_000_000_000_000 };
		const callbacks = { onAuth: vi.fn(), onPrompt: vi.fn() };

		function pendingLogin(providerId: string) {
			let resolve!: (value: typeof credentials) => void;
			const promise = new Promise<typeof credentials>((done) => {
				resolve = done;
			});
			registerOAuthProvider({
				id: providerId,
				name: providerId,
				login: () => promise,
				refreshToken: async () => credentials,
				getApiKey: (credential) => credential.access,
			});
			return () => resolve(credentials);
		}

		test.each(["custom-oauth", "mcp:custom"])(
			"peer logout revokes %s login with and without an existing credential",
			async (providerId) => {
				for (const initiallyPresent of [false, true]) {
					writeAuthJson(initiallyPresent ? { [providerId]: { type: "oauth", ...credentials } } : {});
					authStorage = AuthStorage.create(authJsonPath);
					const finish = pendingLogin(providerId);
					const login = authStorage.login(providerId, callbacks);
					const peer = AuthStorage.create(authJsonPath);
					expect(peer.list()).toEqual(initiallyPresent ? [providerId] : []);
					if (initiallyPresent) peer.logout(providerId);
					else peer.removeVerified(providerId);
					peer.set("openai", { type: "api_key", key: "other-provider" });
					finish();
					await expect(login).rejects.toThrow("Login cancelled");
					expect(JSON.parse(readFileSync(authJsonPath, "utf8"))).toEqual({
						openai: { type: "api_key", key: "other-provider" },
					});
				}
			},
		);

		test("logout in a separate process revokes an initially absent login", async () => {
			authStorage = AuthStorage.create(authJsonPath);
			const finish = pendingLogin("mcp:custom");
			const login = authStorage.login("mcp:custom", callbacks);
			const child = spawnSync(
				process.execPath,
				[
					"--import",
					"tsx",
					"--input-type=module",
					"--eval",
					`import { AuthStorage } from "./src/core/auth-storage.ts";
					AuthStorage.create(${JSON.stringify(authJsonPath)}).removeVerified("mcp:custom");`,
				],
				{ cwd: process.cwd(), encoding: "utf8" },
			);
			finish();
			await expect(login).rejects.toThrow("Login cancelled");
			expect(child.status, child.stderr).toBe(0);
			expect(JSON.parse(readFileSync(authJsonPath, "utf8"))).toEqual({});
		});

		test("superseded login cleanup leaves the newer attempt and other provider writes intact", async () => {
			authStorage = AuthStorage.create(authJsonPath);
			const finishOld = pendingLogin("mcp:custom");
			const oldLogin = authStorage.login("mcp:custom", callbacks);
			const finishNew = pendingLogin("mcp:custom");
			const peer = AuthStorage.create(authJsonPath);
			const newLogin = peer.login("mcp:custom", callbacks);
			peer.set("openai", { type: "api_key", key: "other-provider" });
			finishOld();
			await expect(oldLogin).rejects.toThrow("superseded");
			finishNew();
			await expect(newLogin).resolves.toBeUndefined();
			expect(JSON.parse(readFileSync(authJsonPath, "utf8"))).toEqual({
				"mcp:custom": { type: "oauth", ...credentials },
				openai: { type: "api_key", key: "other-provider" },
			});
		});

		test("explicit peer replacement survives an older login completion", async () => {
			authStorage = AuthStorage.create(authJsonPath);
			const finish = pendingLogin("custom-oauth");
			const login = authStorage.login("custom-oauth", callbacks);
			const peer = AuthStorage.create(authJsonPath);
			peer.set("custom-oauth", { type: "api_key", key: "newer-key" });
			finish();
			await expect(login).rejects.toThrow("Login cancelled");
			expect(AuthStorage.create(authJsonPath).getAll()).toEqual({
				"custom-oauth": { type: "api_key", key: "newer-key" },
			});
		});

		test("abort removes only its own pending claim and never commits late credentials", async () => {
			writeAuthJson({ openai: { type: "api_key", key: "other-provider" } });
			authStorage = AuthStorage.create(authJsonPath);
			const finish = pendingLogin("custom-oauth");
			const controller = new AbortController();
			const login = authStorage.login("custom-oauth", { ...callbacks, signal: controller.signal });
			controller.abort();
			expect(JSON.parse(readFileSync(authJsonPath, "utf8"))).toEqual(authStorage.getAll());
			finish();
			await expect(login).rejects.toThrow("Login cancelled");
			const collect = vi.fn();
			await expect(authStorage.setFromLogin("openai", collect, controller.signal)).rejects.toThrow(
				"Login cancelled",
			);
			expect(collect).not.toHaveBeenCalled();
			expect(AuthStorage.create(authJsonPath).getAll()).toEqual({
				openai: { type: "api_key", key: "other-provider" },
			});
		});

		test.each(["claim", "commit"])("rejects a failed %s write without claiming login success", async (failure) => {
			const disk = new FileAuthStorageBackend(authJsonPath);
			let failNextWrite = failure === "claim";
			const backend: AuthStorageBackend = {
				withLock(fn) {
					return disk.withLock((current) => {
						const result = fn(current);
						if (result.next !== undefined && failNextWrite) {
							failNextWrite = false;
							throw new Error("Fixture write failure");
						}
						return result;
					});
				},
				withLockAsync: (fn) => disk.withLockAsync(fn),
			};
			authStorage = AuthStorage.fromStorage(backend);
			const collect = vi.fn(async () => {
				failNextWrite = failure === "commit";
				return { type: "api_key" as const, key: "not-saved" };
			});
			await expect(authStorage.setFromLogin("openai", collect)).rejects.toThrow("Fixture write failure");
			expect(collect).toHaveBeenCalledTimes(failure === "claim" ? 0 : 1);
			expect(authStorage.getAll()).toEqual({});
			expect(JSON.parse(readFileSync(authJsonPath, "utf8"))).toEqual({});
		});
	});

	describe("oauth lock compromise handling", () => {
		test("returns undefined on compromised lock and allows a later retry", async () => {
			const providerId = `test-oauth-provider-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			registerOAuthProvider({
				id: providerId,
				name: "Test OAuth Provider",
				async login() {
					throw new Error("Not used in this test");
				},
				async refreshToken(credentials) {
					return {
						...credentials,
						access: "refreshed-access-token",
						expires: Date.now() + 60_000,
					};
				},
				getApiKey(credentials) {
					return `Bearer ${credentials.access}`;
				},
			});

			writeAuthJson({
				[providerId]: {
					type: "oauth",
					refresh: "refresh-token",
					access: "expired-access-token",
					expires: Date.now() - 10_000,
				},
			});

			authStorage = AuthStorage.create(authJsonPath);

			const realLock = lockfile.lock.bind(lockfile);
			const lockSpy = vi.spyOn(lockfile, "lock");
			lockSpy.mockImplementationOnce(async (file, options) => {
				options?.onCompromised?.(new Error("Unable to update lock within the stale threshold"));
				return realLock(file, options);
			});

			const firstTry = await authStorage.getApiKey(providerId);
			expect(firstTry).toBeUndefined();

			lockSpy.mockRestore();

			const secondTry = await authStorage.getApiKey(providerId);
			expect(secondTry).toBe("Bearer refreshed-access-token");
		});
	});

	describe("persistence semantics", () => {
		test("set preserves unrelated external edits", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "old-anthropic" },
				openai: { type: "api_key", key: "openai-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);

			writeAuthJson({
				anthropic: { type: "api_key", key: "old-anthropic" },
				openai: { type: "api_key", key: "openai-key" },
				google: { type: "api_key", key: "google-key" },
			});

			authStorage.set("anthropic", { type: "api_key", key: "new-anthropic" });

			const updated = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<string, { key: string }>;
			expect(updated.anthropic.key).toBe("new-anthropic");
			expect(updated.openai.key).toBe("openai-key");
			expect(updated.google.key).toBe("google-key");
		});

		test("remove preserves unrelated external edits", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
				openai: { type: "api_key", key: "openai-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);

			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
				openai: { type: "api_key", key: "openai-key" },
				google: { type: "api_key", key: "google-key" },
			});

			authStorage.remove("anthropic");

			const updated = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<string, { key: string }>;
			expect(updated.anthropic).toBeUndefined();
			expect(updated.openai.key).toBe("openai-key");
			expect(updated.google.key).toBe("google-key");
		});

		test("does not overwrite malformed auth file after load error", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			writeFileSync(authJsonPath, "{invalid-json", "utf-8");

			authStorage.reload();
			authStorage.set("openai", { type: "api_key", key: "openai-key" });

			const raw = readFileSync(authJsonPath, "utf-8");
			expect(raw).toBe("{invalid-json");
		});

		test("removeVerified deletes from disk and memory", () => {
			writeAuthJson({
				"mcp:remote": { type: "api_key", key: "token" },
				openai: { type: "api_key", key: "openai-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			authStorage.removeVerified("mcp:remote");

			const updated = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<string, unknown>;
			expect(updated["mcp:remote"]).toBeUndefined();
			expect(authStorage.get("mcp:remote")).toBeUndefined();
			expect((updated.openai as { key: string }).key).toBe("openai-key");
		});

		test("removeVerified clears cached credentials after an authoritative no-op", () => {
			writeAuthJson({ "mcp:remote": { type: "api_key", key: "old-key" } });
			authStorage = AuthStorage.create(authJsonPath);
			authStorage.markAuthStale("mcp:remote");
			AuthStorage.create(authJsonPath).removeVerified("mcp:remote");
			authStorage.removeVerified("mcp:remote");
			expect(authStorage.get("mcp:remote")).toBeUndefined();
			expect(authStorage.getAuthStatus("mcp:remote")).toEqual({ configured: false });
		});

		test("removeVerified throws while the credential may still exist on disk", () => {
			writeAuthJson({
				"mcp:remote": { type: "api_key", key: "token" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			writeFileSync(authJsonPath, "{invalid-json", "utf-8");

			expect(() => authStorage.removeVerified("mcp:remote")).toThrow();
		});

		test("reload records parse errors and drainErrors clears buffer", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			writeFileSync(authJsonPath, "{invalid-json", "utf-8");

			authStorage.reload();

			expect(authStorage.get("anthropic")).toEqual({ type: "api_key", key: "anthropic-key" });

			const firstDrain = authStorage.drainErrors();
			expect(firstDrain.length).toBeGreaterThan(0);
			expect(firstDrain[0]).toBeInstanceOf(Error);

			const secondDrain = authStorage.drainErrors();
			expect(secondDrain).toHaveLength(0);
		});
	});

	describe("auth status", () => {
		test("does not expose stored API keys or OAuth tokens", () => {
			authStorage = AuthStorage.inMemory({
				anthropic: { type: "api_key", key: "secret-api-key" },
				"test-unvalidated-oauth": {
					type: "oauth",
					access: "secret-access-token",
					refresh: "secret-refresh-token",
					expires: Date.now() + 1000,
				},
			});

			expect(authStorage.getAuthStatus("anthropic")).toEqual({ configured: true, source: "stored" });
			expect(authStorage.getAuthStatus("test-unvalidated-oauth")).toEqual({ configured: false });
			expect(JSON.stringify(authStorage.getAuthStatus("anthropic"))).not.toContain("secret-api-key");
			expect(JSON.stringify(authStorage.getAuthStatus("test-unvalidated-oauth"))).not.toContain(
				"secret-access-token",
			);
			expect(JSON.stringify(authStorage.getAuthStatus("test-unvalidated-oauth"))).not.toContain(
				"secret-refresh-token",
			);
		});
	});

	describe("runtime overrides", () => {
		test("runtime override takes priority over auth.json", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo stored-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			authStorage.setRuntimeApiKey("anthropic", "runtime-key");

			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("runtime-key");
		});

		test("removing runtime override falls back to auth.json", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo stored-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			authStorage.setRuntimeApiKey("anthropic", "runtime-key");
			authStorage.removeRuntimeApiKey("anthropic");

			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("stored-key");
		});
	});
});
