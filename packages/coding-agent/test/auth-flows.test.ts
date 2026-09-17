import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOAuthProvider, resetOAuthProviders } from "@ponythewhite/base-context-ai/oauth";
import type { Component, OverlayHandle, TUI } from "@ponythewhite/base-context-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import type { ModelRegistry } from "../src/core/model-registry.js";
import { ProviderAuthFlows, type ProviderAuthFlowsHost } from "../src/modes/interactive/auth-flows.js";
import { LoginDialogComponent } from "../src/modes/interactive/components/login-dialog.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function createOverlayHandle(): OverlayHandle {
	return {
		hide: vi.fn(),
		setHidden: vi.fn(),
		isHidden: () => false,
		focus: vi.fn(),
		unfocus: vi.fn(),
		isFocused: () => true,
	};
}

function createFakeTui(overlays: Component[] = []): TUI {
	return {
		terminal: { columns: 80, rows: 24 },
		requestRender: vi.fn(),
		showOverlay: vi.fn((component: Component) => {
			overlays.push(component);
			return createOverlayHandle();
		}),
	} as unknown as TUI;
}

function createHost(authStorage: AuthStorage): {
	host: ProviderAuthFlowsHost;
	statusMessages: string[];
	errorMessages: string[];
	overlays: Component[];
} {
	const statusMessages: string[] = [];
	const errorMessages: string[] = [];
	const overlays: Component[] = [];
	const modelRegistry = {
		authStorage,
		refresh: vi.fn(),
		getAll: () => [],
		getProviderDisplayName: (providerId: string) => providerId,
		getProviderAuthStatus: (providerId: string) => authStorage.getAuthStatus(providerId),
	} as unknown as ModelRegistry;

	return {
		host: {
			ui: createFakeTui(overlays),
			modelRegistry,
			showStatus: (message) => statusMessages.push(message),
			showError: (message) => errorMessages.push(message),
			getAvailableModels: async () => [],
		},
		statusMessages,
		errorMessages,
		overlays,
	};
}

describe("ProviderAuthFlows", () => {
	let tempDir: string;
	let authJsonPath: string;

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-auth-flows-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		authJsonPath = join(tempDir, "auth.json");
		writeFileSync(authJsonPath, "{}");
		vi.stubEnv("HOME", tempDir);
		vi.stubEnv("BASE_CONTEXT_HOME", join(tempDir, "base-context"));
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network in auth flow tests"));
	});

	afterEach(() => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		resetOAuthProviders();
	});

	it("stores an API key only for the selected provider without sending it", async () => {
		const showPrompt = vi.spyOn(LoginDialogComponent.prototype, "showPrompt").mockResolvedValue("test-provider-key");
		const fetch = vi.spyOn(globalThis, "fetch");
		const authStorage = AuthStorage.create(authJsonPath);
		const { host, errorMessages } = createHost(authStorage);

		const result = await new ProviderAuthFlows(host).loginProvider({
			id: "openai",
			name: "OpenAI",
			authType: "api_key",
		});

		expect(result).toMatchObject({ status: "success", providerId: "openai" });
		expect(showPrompt).toHaveBeenCalledWith("Enter API key:", undefined, { masked: true });
		expect(errorMessages).toEqual([]);
		expect(JSON.parse(readFileSync(authJsonPath, "utf8"))).toEqual({
			openai: { type: "api_key", key: "test-provider-key" },
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	it("does not save a late API-key prompt after peer logout", async () => {
		let submit!: (value: string) => void;
		vi.spyOn(LoginDialogComponent.prototype, "showPrompt").mockImplementation(
			() =>
				new Promise((resolve) => {
					submit = resolve;
				}),
		);
		const authStorage = AuthStorage.create(authJsonPath);
		const { host, statusMessages, errorMessages } = createHost(authStorage);
		const login = new ProviderAuthFlows(host).loginProvider({ id: "openai", name: "OpenAI", authType: "api_key" });
		AuthStorage.create(authJsonPath).logout("openai");
		submit("late-key");
		await expect(login).resolves.toEqual({ status: "failed" });
		expect(statusMessages).toEqual([]);
		expect(errorMessages.join(" ")).toContain("Login cancelled");
		expect(JSON.parse(readFileSync(authJsonPath, "utf8"))).toEqual({});
	});

	it.each([
		{ providerId: "mcp:custom", failWrite: false },
		{ providerId: "mcp:custom", failWrite: true },
		{ providerId: "openai", failWrite: false },
		{ providerId: "openai", failWrite: true },
	])(
		"$providerId logout reports success only after verified removal (write failure: $failWrite)",
		async ({ providerId, failWrite }) => {
			const authStorage = AuthStorage.create(authJsonPath);
			authStorage.set(providerId, { type: "api_key", key: "stored-token" });
			const { host, overlays, statusMessages, errorMessages } = createHost(authStorage);
			const onAuthChanged = vi.fn();
			host.onAuthChanged = onAuthChanged;
			const logout = new ProviderAuthFlows(host).runLogout();
			if (failWrite) writeFileSync(authJsonPath, "{invalid-json");
			overlays[0]?.handleInput?.("\r");
			await expect(logout).resolves.toBe(failWrite ? null : providerId);
			expect(host.modelRegistry.refresh).toHaveBeenCalledTimes(failWrite ? 0 : 1);
			expect(onAuthChanged).toHaveBeenCalledTimes(failWrite ? 0 : 1);
			if (failWrite) {
				expect(statusMessages).toEqual([]);
				expect(errorMessages.join(" ")).toContain("Logout failed");
				expect(authStorage.has(providerId)).toBe(true);
			} else {
				expect(errorMessages).toEqual([]);
				expect(statusMessages).toHaveLength(1);
				expect(authStorage.has(providerId)).toBe(false);
			}
		},
	);

	it("leaves credentials unchanged when provider login is cancelled", async () => {
		vi.spyOn(LoginDialogComponent.prototype, "showPrompt").mockRejectedValue(new Error("Login cancelled"));
		const authStorage = AuthStorage.create(authJsonPath);
		const { host, errorMessages } = createHost(authStorage);

		await expect(
			new ProviderAuthFlows(host).loginProvider({ id: "openai", name: "OpenAI", authType: "api_key" }),
		).resolves.toEqual({ status: "cancelled" });

		expect(authStorage.list()).toEqual([]);
		expect(errorMessages).toEqual([]);
	});

	it.each(["anthropic", "github-copilot", "openai-codex"])(
		"runs the selected %s subscription login",
		async (providerId) => {
			const provider = getOAuthProvider(providerId)!;
			const showAuth = vi.spyOn(LoginDialogComponent.prototype, "showAuth").mockImplementation(() => {});
			vi.spyOn(LoginDialogComponent.prototype, "showManualInput").mockResolvedValue(
				"http://localhost/callback?code=test",
			);
			const login = vi.spyOn(provider, "login").mockImplementation(async (callbacks) => {
				callbacks.onAuth({ url: "https://login.example.test/authorize" });
				if (provider.usesCallbackServer) {
					await expect(callbacks.onManualCodeInput?.()).resolves.toContain("code=test");
				}
				return { access: "test-access", refresh: "test-refresh", expires: Date.now() + 60_000 };
			});
			const { host, overlays, statusMessages, errorMessages } = createHost(AuthStorage.create(authJsonPath));
			const flow = new ProviderAuthFlows(host);
			expect(flow.getLoginProviderOptions("oauth").map((entry) => entry.id)).not.toContain("prime-intellect");
			const result = flow.runLogin({ authType: "oauth" });
			for (const character of providerId) overlays[0]?.handleInput?.(character);
			overlays[0]?.handleInput?.("\r");
			await expect(result).resolves.toMatchObject({ status: "success", providerId, authType: "oauth" });
			expect(login).toHaveBeenCalledOnce();
			expect(showAuth).toHaveBeenCalledWith("https://login.example.test/authorize", undefined);
			expect(errorMessages).toEqual([]);
			expect(statusMessages.join(" ")).toContain("Use /model to select a model");
			expect(Object.keys(JSON.parse(readFileSync(authJsonPath, "utf8")))).toEqual([providerId]);
			expect(globalThis.fetch).not.toHaveBeenCalled();
		},
	);

	it("leaves OAuth storage unchanged after a cancelled browser login", async () => {
		vi.spyOn(getOAuthProvider("openai-codex")!, "login").mockRejectedValue(new Error("Login cancelled"));
		const authStorage = AuthStorage.create(authJsonPath);
		const { host, errorMessages } = createHost(authStorage);
		await expect(
			new ProviderAuthFlows(host).loginProvider({ id: "openai-codex", name: "Codex", authType: "oauth" }),
		).resolves.toEqual({ status: "cancelled" });
		expect(authStorage.list()).toEqual([]);
		expect(errorMessages).toEqual([]);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("opens login on the requested MCP Connections category", async () => {
		const authStorage = AuthStorage.create(authJsonPath);
		const { host, overlays } = createHost(authStorage);

		const loginResult = new ProviderAuthFlows(host).runLogin({ initialCategory: "service" });

		expect(overlays).toHaveLength(1);
		const output = stripAnsi(overlays[0]?.render(80).join("\n") ?? "");
		expect(output).toContain("Serper (web search)");
		expect(output).not.toContain("Anthropic");
		overlays[0]?.handleInput?.("\x1b");
		await expect(loginResult).resolves.toEqual({ status: "cancelled" });
	});
});
