import {
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { OAuthAuthInfo } from "@ponythewhite/base-context-ai";
import { getAgentDir } from "../config.js";
import { assertProductStatePath } from "../runtime-paths.js";

export const PRIME_INFERENCE_PROVIDER_ID = "prime-inference";
export const PRIME_INFERENCE_PROVIDER_NAME = "Prime Inference";
export const BASE_CONTEXT_TRACES_PROVIDER_ID = "base-context-traces";
export const BASE_CONTEXT_TRACES_PROVIDER_NAME = "Base Context Traces";

const DEFAULT_PRIME_API_BASE_URL = "https://api.primeintellect.ai";
const DEFAULT_PRIME_FRONTEND_URL = "https://app.primeintellect.ai";
const DEFAULT_PRIME_INFERENCE_URL = "https://api.pinference.ai/api/v1";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export type PrimeInferenceAuthSource = "api-key";

export type PrimeInferenceLoginResult = {
	apiKey: string;
	source: PrimeInferenceAuthSource;
};

export type PrimeCliConfig = {
	apiKey?: string;
	baseUrl: string;
	frontendUrl: string;
	inferenceUrl: string;
	path: string;
	teamId?: string;
	teamName?: string;
	teamRole?: string;
	teamIdFromEnv: boolean;
};

export type PrimeInferenceLoginCallbacks = {
	onAuth: (info: OAuthAuthInfo) => void;
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
};

export type PrimeInferenceLoginOptions = {
	apiKey?: string;
	configPath?: string;
	fetchFn?: typeof fetch;
	requestTimeoutMs?: number;
};

export type PrimeInferenceAccessResult =
	| { ok: true }
	| {
			ok: false;
			status?: number;
			message: string;
	  };

type PrimeAccessScope = "inference" | "agent_traces";

export type PrimeTeam = {
	teamId: string;
	name: string;
	slug?: string;
	role?: string;
	createdAt?: string;
};

function defaultPrimeCliConfigPath(): string {
	return assertProductStatePath(join(getAgentDir(), "prime-inference.json"));
}

export function getPrimeCliConfigPath(configPath?: string): string {
	return configPath ?? defaultPrimeCliConfigPath();
}

function normalizeBaseUrl(value: string | undefined): string {
	return (value?.trim() || DEFAULT_PRIME_API_BASE_URL).replace(/\/+$/, "").replace(/\/api\/v1$/, "");
}

function normalizeUrl(value: string | undefined, fallback: string): string {
	return (value || fallback).trim().replace(/\/+$/, "");
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
	const value = data[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringEnv(name: string): string | undefined {
	const value = process.env[name];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberField(data: Record<string, unknown>, key: string): number | undefined {
	const value = data[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPrimeCliConfigData(configPath: string): Record<string, unknown> {
	let data: Record<string, unknown> = {};
	if (existsSync(configPath)) {
		try {
			const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
			if (isRecord(parsed)) {
				data = parsed;
			}
		} catch {
			data = {};
		}
	}
	return data;
}

function writePrimeCliConfigData(configPath: string, data: Record<string, unknown>): void {
	configPath = assertProductStatePath(configPath);
	const dir = dirname(configPath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
	const tempPath = join(
		dir,
		`.${basename(configPath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
	);
	let fd: number | undefined = openSync(tempPath, "wx", 0o600);
	try {
		writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
		closeSync(fd);
		fd = undefined;
		chmodSync(tempPath, 0o600);
		renameSync(tempPath, configPath);
		chmodSync(configPath, 0o600);
	} finally {
		if (fd !== undefined) {
			closeSync(fd);
		}
		if (existsSync(tempPath)) {
			rmSync(tempPath, { force: true });
		}
	}
}

function clearPrimeTeamFields(data: Record<string, unknown>): void {
	delete data.team_id;
	delete data.team_name;
	delete data.team_role;
}

export function loadPrimeCliConfig(configPath: string = defaultPrimeCliConfigPath()): PrimeCliConfig {
	const data = readPrimeCliConfigData(configPath);
	const teamIdFromEnv = stringEnv("PRIME_TEAM_ID");
	const teamId = teamIdFromEnv ?? stringField(data, "team_id");

	const config: PrimeCliConfig = {
		baseUrl: normalizeBaseUrl(stringField(data, "base_url")),
		frontendUrl: normalizeUrl(stringField(data, "frontend_url"), DEFAULT_PRIME_FRONTEND_URL),
		inferenceUrl: normalizeUrl(stringField(data, "inference_url"), DEFAULT_PRIME_INFERENCE_URL),
		path: configPath,
		teamIdFromEnv: teamIdFromEnv !== undefined,
	};
	const apiKey = stringField(data, "api_key");
	if (apiKey) {
		config.apiKey = apiKey;
	}
	if (teamId) {
		config.teamId = teamId;
	}
	if (!teamIdFromEnv) {
		const teamName = stringField(data, "team_name");
		const teamRole = stringField(data, "team_role");
		if (teamName) {
			config.teamName = teamName;
		}
		if (teamRole) {
			config.teamRole = teamRole;
		}
	}
	return config;
}

export function savePrimeCliApiKey(apiKey: string, configPath: string = defaultPrimeCliConfigPath()): PrimeCliConfig {
	const data = readPrimeCliConfigData(configPath);
	data.api_key = apiKey;
	clearPrimeTeamFields(data);
	writePrimeCliConfigData(configPath, data);
	return loadPrimeCliConfig(configPath);
}

export function clearPrimeCliCredentials(configPath: string = defaultPrimeCliConfigPath()): PrimeCliConfig {
	const data = readPrimeCliConfigData(configPath);
	delete data.api_key;
	clearPrimeTeamFields(data);
	writePrimeCliConfigData(configPath, data);
	return loadPrimeCliConfig(configPath);
}

export function savePrimeCliTeamSelection(
	team: PrimeTeam | null,
	configPath: string = defaultPrimeCliConfigPath(),
): PrimeCliConfig {
	const data = readPrimeCliConfigData(configPath);
	if (team) {
		data.team_id = team.teamId;
		data.team_name = team.name;
		if (team.role) {
			data.team_role = team.role;
		} else {
			delete data.team_role;
		}
	} else {
		clearPrimeTeamFields(data);
	}
	writePrimeCliConfigData(configPath, data);
	return loadPrimeCliConfig(configPath);
}

export function resolvePrimeAgentTracesBaseUrl(baseUrl?: string): string | undefined {
	const configuredBaseUrl = baseUrl?.trim() || stringEnv("BASE_CONTEXT_TRACES_BASE_URL");
	return configuredBaseUrl ? normalizeBaseUrl(configuredBaseUrl) : undefined;
}

function throwIfCancelled(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new Error("Login cancelled");
	}
}

async function fetchWithTimeout(
	fetchFn: typeof fetch,
	url: string | URL,
	init: RequestInit,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<Response> {
	throwIfCancelled(signal);

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		return await fetchFn(url, { ...init, signal: controller.signal });
	} catch (error) {
		if (signal?.aborted) {
			throw new Error("Login cancelled");
		}
		if (controller.signal.aborted) {
			throw new Error("Prime Inference request timed out");
		}
		throw error;
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", onAbort);
	}
}

async function readResponseMessage(response: Response): Promise<string> {
	const text = await response.text().catch(() => "");
	if (!text.trim()) {
		return response.statusText || "Unknown error";
	}

	try {
		const parsed = JSON.parse(text) as unknown;
		if (isRecord(parsed)) {
			const error = parsed.error;
			if (isRecord(error)) {
				const message = stringField(error, "message");
				if (message) return message;
			}
			const detail = stringField(parsed, "detail");
			if (detail) return detail;
			const message = stringField(parsed, "message");
			if (message) return message;
		}
	} catch {
		// Fall back to raw text.
	}

	return text.trim();
}

async function readJsonObject(response: Response, context: string): Promise<Record<string, unknown>> {
	let parsed: unknown;
	try {
		parsed = (await response.json()) as unknown;
	} catch {
		throw new Error(`${context} returned an invalid response`);
	}
	if (!isRecord(parsed)) {
		throw new Error(`${context} returned an invalid response`);
	}
	return parsed;
}

function parsePrimeTeam(value: unknown): PrimeTeam | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const teamId = stringField(value, "teamId");
	if (!teamId) {
		return undefined;
	}

	const team: PrimeTeam = {
		teamId,
		name: stringField(value, "name") ?? "Unknown",
	};
	const slug = stringField(value, "slug");
	const role = stringField(value, "role");
	const createdAt = stringField(value, "createdAt");
	if (slug) {
		team.slug = slug;
	}
	if (role) {
		team.role = role;
	}
	if (createdAt) {
		team.createdAt = createdAt;
	}
	return team;
}

export async function fetchPrimeTeams(
	apiKey: string,
	baseUrl: string,
	options: {
		fetchFn?: typeof fetch;
		requestTimeoutMs?: number;
		signal?: AbortSignal;
	} = {},
): Promise<PrimeTeam[]> {
	const fetchFn = options.fetchFn ?? fetch;
	const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	const teams: PrimeTeam[] = [];
	let offset = 0;
	const limit = 100;

	while (true) {
		const url = new URL(`${normalizeBaseUrl(baseUrl)}/api/v1/user/teams`);
		url.searchParams.set("offset", String(offset));
		url.searchParams.set("limit", String(limit));
		const response = await fetchWithTimeout(
			fetchFn,
			url,
			{
				method: "GET",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					Accept: "application/json",
				},
			},
			requestTimeoutMs,
			options.signal,
		);

		if (!response.ok) {
			throw new Error(`Failed to fetch Prime teams: ${await readResponseMessage(response)}`);
		}

		const data = await readJsonObject(response, "Prime teams");
		const batch = data.data;
		if (!Array.isArray(batch)) {
			throw new Error("Prime teams response missing team data");
		}

		for (const item of batch) {
			const team = parsePrimeTeam(item);
			if (team) {
				teams.push(team);
			}
		}

		const totalCount = numberField(data, "total_count") ?? teams.length;
		if (batch.length === 0 || teams.length >= totalCount) {
			break;
		}
		offset += limit;
	}

	return teams;
}

async function checkPrimeScopeAccess(
	apiKey: string,
	baseUrl: string,
	scopeName: PrimeAccessScope,
	scopeLabel: string,
	options: {
		fetchFn?: typeof fetch;
		requestTimeoutMs?: number;
		signal?: AbortSignal;
	} = {},
): Promise<PrimeInferenceAccessResult> {
	const fetchFn = options.fetchFn ?? fetch;
	const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	const url = `${normalizeBaseUrl(baseUrl)}/api/v1/user/whoami`;
	const response = await fetchWithTimeout(
		fetchFn,
		url,
		{
			method: "GET",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				Accept: "application/json",
			},
		},
		requestTimeoutMs,
		options.signal,
	);

	if (!response.ok) {
		return {
			ok: false,
			status: response.status,
			message: await readResponseMessage(response),
		};
	}

	const data = await readJsonObject(response, "Prime whoami");
	const user = data.data;
	if (!isRecord(user)) {
		return { ok: false, message: "Prime whoami response missing user data" };
	}

	const scope = user.scope;
	if (!isRecord(scope)) {
		return { ok: false, message: "Prime token is missing permission scope data" };
	}

	const scopedPermission = scope[scopeName];
	if (!isRecord(scopedPermission)) {
		return { ok: false, message: `Prime token is missing ${scopeLabel} permissions` };
	}

	if (scopedPermission.write === true) {
		return { ok: true };
	}

	return { ok: false, message: `Prime token does not have ${scopeLabel} write permission` };
}

export async function checkPrimeInferenceAccess(
	apiKey: string,
	baseUrl: string,
	options: {
		fetchFn?: typeof fetch;
		requestTimeoutMs?: number;
		signal?: AbortSignal;
	} = {},
): Promise<PrimeInferenceAccessResult> {
	return checkPrimeScopeAccess(apiKey, baseUrl, "inference", "inference", options);
}

export async function checkPrimeAgentTracesAccess(
	apiKey: string,
	baseUrl: string,
	options: {
		fetchFn?: typeof fetch;
		requestTimeoutMs?: number;
		signal?: AbortSignal;
	} = {},
): Promise<PrimeInferenceAccessResult> {
	return checkPrimeScopeAccess(apiKey, baseUrl, "agent_traces", "agent trace", options);
}

function formatAccessFailure(result: Exclude<PrimeInferenceAccessResult, { ok: true }>): string {
	const status = result.status === undefined ? "" : `HTTP ${result.status}: `;
	return `${status}${result.message}`;
}

export async function loginPrimeInference(
	callbacks: PrimeInferenceLoginCallbacks,
	options: PrimeInferenceLoginOptions = {},
): Promise<PrimeInferenceLoginResult> {
	throwIfCancelled(callbacks.signal);
	const config = loadPrimeCliConfig(options.configPath);
	const apiKey = options.apiKey?.trim() || stringEnv("PRIME_API_KEY") || config.apiKey;
	if (!apiKey) {
		throw new Error(
			"Base Context does not support Prime browser sign-in. Use /login to enter a Prime Inference API key, or set PRIME_API_KEY.",
		);
	}

	callbacks.onProgress?.("Checking Prime Inference access...");
	const access = await checkPrimeInferenceAccess(apiKey, config.baseUrl, {
		fetchFn: options.fetchFn,
		requestTimeoutMs: options.requestTimeoutMs,
		signal: callbacks.signal,
	});
	if (!access.ok) {
		throw new Error(`Prime API key does not have Prime Inference access (${formatAccessFailure(access)})`);
	}

	throwIfCancelled(callbacks.signal);
	return { apiKey, source: "api-key" };
}

export async function loginPrimeAgentTraces(
	_callbacks: PrimeInferenceLoginCallbacks,
	_options: PrimeInferenceLoginOptions = {},
): Promise<PrimeInferenceLoginResult> {
	throw new Error(
		"Base Context trace browser sign-in is not configured. Set BASE_CONTEXT_TRACES_BASE_URL and a dedicated BASE_CONTEXT_TRACES_API_KEY; Prime Inference credentials are not used for traces.",
	);
}
