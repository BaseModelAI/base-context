import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	});

	afterEach(() => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it("stores an API key only for the selected provider without sending it", async () => {
		vi.spyOn(LoginDialogComponent.prototype, "showPrompt").mockResolvedValue("test-provider-key");
		const fetch = vi.spyOn(globalThis, "fetch");
		const authStorage = AuthStorage.create(authJsonPath);
		const { host, errorMessages } = createHost(authStorage);

		const result = await new ProviderAuthFlows(host).loginProvider({
			id: "openai",
			name: "OpenAI",
			authType: "api_key",
		});

		expect(result).toMatchObject({ status: "success", providerId: "openai" });
		expect(errorMessages).toEqual([]);
		expect(JSON.parse(readFileSync(authJsonPath, "utf8"))).toEqual({
			openai: { type: "api_key", key: "test-provider-key" },
		});
		expect(fetch).not.toHaveBeenCalled();
	});

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
