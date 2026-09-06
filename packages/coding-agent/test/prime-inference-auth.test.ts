import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	checkPrimeAgentTracesAccess,
	checkPrimeInferenceAccess,
	clearPrimeCliCredentials,
	fetchPrimeTeams,
	getPrimeCliConfigPath,
	loadPrimeCliConfig,
	loginPrimeAgentTraces,
	loginPrimeInference,
	resolvePrimeAgentTracesBaseUrl,
	savePrimeCliApiKey,
	savePrimeCliTeamSelection,
} from "../src/core/prime-inference-auth.js";

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json",
		},
	});
}

function getUrl(input: string | URL | Request): string {
	if (typeof input === "string") {
		return input;
	}
	if (input instanceof URL) {
		return input.toString();
	}
	return input.url;
}

function getAuthorization(init?: RequestInit): string | undefined {
	const headers = init?.headers;
	if (!headers || Array.isArray(headers)) {
		return undefined;
	}
	if (headers instanceof Headers) {
		return headers.get("Authorization") ?? undefined;
	}
	const headerRecord = headers as Record<string, string | undefined>;
	return headerRecord.Authorization ?? headerRecord.authorization;
}

describe("Prime Inference auth", () => {
	let tempDir: string;
	let configPath: string;
	let originalTraceBaseUrl: string | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-prime-auth-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		configPath = join(tempDir, "config.json");
		vi.stubEnv("HOME", tempDir);
		vi.stubEnv("BASE_CONTEXT_HOME", join(tempDir, "base-context"));
		vi.stubEnv("PRIME_API_KEY", undefined);
		vi.stubEnv("PRIME_TEAM_ID", undefined);
		originalTraceBaseUrl = process.env.BASE_CONTEXT_TRACES_BASE_URL;
		delete process.env.BASE_CONTEXT_TRACES_BASE_URL;
	});

	afterEach(() => {
		if (originalTraceBaseUrl === undefined) {
			delete process.env.BASE_CONTEXT_TRACES_BASE_URL;
		} else {
			process.env.BASE_CONTEXT_TRACES_BASE_URL = originalTraceBaseUrl;
		}
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it("loads Prime CLI config with defaults", () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				api_key: "prime-key",
				base_url: "https://prime-api.example/api/v1",
				frontend_url: "https://prime-app.example/",
			}),
		);

		expect(loadPrimeCliConfig(configPath)).toEqual({
			apiKey: "prime-key",
			baseUrl: "https://prime-api.example",
			frontendUrl: "https://prime-app.example",
			inferenceUrl: "https://api.pinference.ai/api/v1",
			path: configPath,
			teamIdFromEnv: false,
		});
	});

	it("loads Prime CLI team selection", () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				api_key: "prime-key",
				team_id: "team-1",
				team_name: "Research",
				team_role: "admin",
			}),
		);

		expect(loadPrimeCliConfig(configPath)).toMatchObject({
			apiKey: "prime-key",
			teamId: "team-1",
			teamName: "Research",
			teamRole: "admin",
			teamIdFromEnv: false,
		});
	});

	it("lets PRIME_TEAM_ID override Prime CLI team selection", () => {
		const originalTeamId = process.env.PRIME_TEAM_ID;
		process.env.PRIME_TEAM_ID = "env-team";
		writeFileSync(
			configPath,
			JSON.stringify({
				team_id: "file-team",
				team_name: "Research",
				team_role: "admin",
			}),
		);

		try {
			expect(loadPrimeCliConfig(configPath)).toMatchObject({
				teamId: "env-team",
				teamIdFromEnv: true,
			});
			expect(loadPrimeCliConfig(configPath).teamName).toBeUndefined();
		} finally {
			if (originalTeamId === undefined) {
				delete process.env.PRIME_TEAM_ID;
			} else {
				process.env.PRIME_TEAM_ID = originalTeamId;
			}
		}
	});

	it("fetches Prime teams across paginated responses", async () => {
		const requestedUrls: string[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			requestedUrls.push(getUrl(input));
			expect(getAuthorization(init)).toBe("Bearer prime-key");
			if (requestedUrls.length === 1) {
				return jsonResponse({
					data: [{ teamId: "team-1", name: "Research", slug: "research", role: "admin" }],
					total_count: 2,
				});
			}
			return jsonResponse({
				data: [{ teamId: "team-2", name: "Infra", slug: "infra", role: "member" }],
				total_count: 2,
			});
		});

		await expect(
			fetchPrimeTeams("prime-key", "https://prime-api.example/api/v1", { fetchFn: fetchMock }),
		).resolves.toEqual([
			{ teamId: "team-1", name: "Research", slug: "research", role: "admin" },
			{ teamId: "team-2", name: "Infra", slug: "infra", role: "member" },
		]);
		expect(requestedUrls).toEqual([
			"https://prime-api.example/api/v1/user/teams?offset=0&limit=100",
			"https://prime-api.example/api/v1/user/teams?offset=100&limit=100",
		]);
	});

	it("checks Prime Inference access with Prime whoami permissions", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			expect(getUrl(input)).toBe("https://prime-api.example/api/v1/user/whoami");
			expect(init?.method).toBe("GET");
			expect(getAuthorization(init)).toBe("Bearer prime-key");
			return jsonResponse({ data: { scope: { inference: { read: true, write: true } } } });
		});

		await expect(
			checkPrimeInferenceAccess("prime-key", "https://prime-api.example", { fetchFn: fetchMock }),
		).resolves.toEqual({ ok: true });
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("checks Prime Agent trace access with Prime whoami permissions", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			expect(getUrl(input)).toBe("https://prime-api.example/api/v1/user/whoami");
			expect(init?.method).toBe("GET");
			expect(getAuthorization(init)).toBe("Bearer prime-key");
			return jsonResponse({ data: { scope: { agent_traces: { read: true, write: true } } } });
		});

		await expect(
			checkPrimeAgentTracesAccess("prime-key", "https://prime-api.example", { fetchFn: fetchMock }),
		).resolves.toEqual({ ok: true });
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("throws contextual errors for invalid Prime whoami JSON", async () => {
		const fetchMock = vi.fn(async (): Promise<Response> => {
			return new Response("not json", {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		await expect(
			checkPrimeInferenceAccess("prime-key", "https://prime-api.example", { fetchFn: fetchMock }),
		).rejects.toThrow("Prime whoami returned an invalid response");
	});

	it.each(["config", "environment", "explicit"] as const)("validates a direct %s Prime API key", async (source) => {
		if (source === "config") writeFileSync(configPath, JSON.stringify({ api_key: "prime-key" }));
		if (source === "environment") process.env.PRIME_API_KEY = "prime-key";
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			expect(getUrl(input)).toBe("https://api.primeintellect.ai/api/v1/user/whoami");
			expect(getAuthorization(init)).toBe("Bearer prime-key");
			return jsonResponse({ data: { scope: { inference: { write: true } } } });
		});
		const onAuth = vi.fn();

		const result = await loginPrimeInference(
			{ onAuth },
			{ configPath, apiKey: source === "explicit" ? "prime-key" : undefined, fetchFn: fetchMock },
		);

		expect(result).toEqual({ apiKey: "prime-key", source: "api-key" });
		expect(onAuth).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("honors cancellation before returning a configured Prime API key", async () => {
		writeFileSync(configPath, JSON.stringify({ api_key: "prime-cli-key" }));
		const controller = new AbortController();
		const fetchMock = vi.fn(async (): Promise<Response> => {
			const response = jsonResponse({ data: { scope: { inference: { write: true } } } });
			vi.spyOn(response, "json").mockImplementation(async () => {
				controller.abort();
				return { data: { scope: { inference: { write: true } } } };
			});
			return response;
		});

		await expect(
			loginPrimeInference(
				{
					onAuth: () => {},
					signal: controller.signal,
				},
				{ configPath, fetchFn: fetchMock, requestTimeoutMs: 1000 },
			),
		).rejects.toThrow("Login cancelled");
	});

	it("rejects an invalid key without starting browser login", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ data: { scope: { inference: { write: false } } } }));
		const onAuth = vi.fn();

		await expect(
			loginPrimeInference({ onAuth }, { configPath, apiKey: "invalid-key", fetchFn: fetchMock }),
		).rejects.toThrow("Prime token does not have inference write permission");
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(onAuth).not.toHaveBeenCalled();
	});

	it("uses isolated Base Context provider state without borrowing the Prime CLI config", async () => {
		const legacyDir = join(tempDir, ".prime");
		const legacyPath = join(legacyDir, "config.json");
		const legacyData = JSON.stringify({ api_key: "borrowed-key", team_id: "borrowed-team" });
		mkdirSync(legacyDir);
		writeFileSync(legacyPath, legacyData);
		const onAuth = vi.fn();
		const fetchMock = vi.fn();

		expect(getPrimeCliConfigPath()).toBe(join(tempDir, "base-context", "prime-inference.json"));
		expect(loadPrimeCliConfig().apiKey).toBeUndefined();
		await expect(loginPrimeInference({ onAuth }, { fetchFn: fetchMock })).rejects.toThrow("PRIME_API_KEY");
		expect(onAuth).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();

		savePrimeCliApiKey("base-key");
		savePrimeCliTeamSelection({ teamId: "base-team", name: "Research" });
		expect(loadPrimeCliConfig()).toMatchObject({ apiKey: "base-key", teamId: "base-team" });
		clearPrimeCliCredentials();
		expect(loadPrimeCliConfig().apiKey).toBeUndefined();
		expect(loadPrimeCliConfig().teamId).toBeUndefined();
		expect(readFileSync(legacyPath, "utf-8")).toBe(legacyData);
	});

	it("allows explicit legacy reads but rejects legacy write targets and aliases", () => {
		const legacyDir = join(tempDir, ".prime");
		const legacyPath = join(legacyDir, "config.json");
		const aliasPath = join(tempDir, "alias.json");
		const legacyData = JSON.stringify({ api_key: "borrowed-key" });
		mkdirSync(legacyDir);
		writeFileSync(legacyPath, legacyData);
		symlinkSync(legacyPath, aliasPath);

		expect(loadPrimeCliConfig(legacyPath).apiKey).toBe("borrowed-key");
		for (const target of [legacyPath, aliasPath]) {
			expect(() => savePrimeCliApiKey("base-key", target)).toThrow("cannot write legacy state");
			expect(() => savePrimeCliTeamSelection(null, target)).toThrow("cannot write legacy state");
			expect(() => clearPrimeCliCredentials(target)).toThrow("cannot write legacy state");
		}
		expect(readFileSync(legacyPath, "utf-8")).toBe(legacyData);
	});

	it("requires separate trace configuration without borrowing inference auth or browser login", async () => {
		writeFileSync(configPath, JSON.stringify({ api_key: "inference-key" }));
		process.env.PRIME_API_KEY = "inference-env-key";
		const onAuth = vi.fn();
		const fetchMock = vi.fn();

		expect(resolvePrimeAgentTracesBaseUrl()).toBeUndefined();
		expect(resolvePrimeAgentTracesBaseUrl("https://traces.example/api/v1/")).toBe("https://traces.example");
		process.env.BASE_CONTEXT_TRACES_BASE_URL = "https://configured-traces.example/api/v1";
		expect(resolvePrimeAgentTracesBaseUrl()).toBe("https://configured-traces.example");
		await expect(loginPrimeAgentTraces({ onAuth }, { configPath, fetchFn: fetchMock })).rejects.toThrow(
			"Set BASE_CONTEXT_TRACES_BASE_URL and a dedicated BASE_CONTEXT_TRACES_API_KEY",
		);
		expect(onAuth).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
