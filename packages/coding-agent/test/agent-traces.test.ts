import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@ponythewhite/base-context-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR, getAgentTracesLogPath } from "../src/config.js";
import {
	catchUpAgentTraceUploads,
	findAgentTraceFiles,
	installAgentTraceUpload,
	previewAgentTraceFile,
	uploadAgentTraceFile,
	uploadAllAgentTraces,
} from "../src/core/agent-traces.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { BASE_CONTEXT_TRACES_PROVIDER_ID, PRIME_INFERENCE_PROVIDER_ID } from "../src/core/prime-inference-auth.js";
import { readSessionJournal } from "../src/core/session-journal-reader.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

interface FetchCall {
	url: string;
	init: RequestInit;
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createUserMessage(text: string) {
	return {
		role: "user" as const,
		content: text,
		timestamp: Date.now(),
	};
}

function createFetchRecorder(calls: FetchCall[]): typeof fetch {
	return async (input, init) => {
		calls.push({ url: String(input), init: init ?? {} });
		return new Response(
			JSON.stringify({
				session_id: "uploaded-session",
				trace_id: "uploaded-trace",
				bytes_stored: 123,
				key: "trace/key.jsonl",
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	};
}

const ownedSessionManagers: SessionManager[] = [];

async function createSession(
	cwd: string,
	sessionDir: string,
	id?: string,
	parentSession?: string,
): Promise<SessionManager> {
	const sessionManager = await SessionManager.create(cwd, sessionDir, { id, parentSession });
	ownedSessionManagers.push(sessionManager);
	return sessionManager;
}

async function writeSession(
	cwd: string,
	sessionDir: string,
	id: string,
	parentSession?: string,
): Promise<SessionManager> {
	const sessionManager = await createSession(cwd, sessionDir, id, parentSession);
	await sessionManager.appendMessage(createUserMessage(`user ${id}`));
	await sessionManager.appendMessage(createAssistantMessage(`assistant ${id}`));
	return sessionManager;
}

async function readTraceBody(sessionFile: string): Promise<string> {
	const lines: string[] = [];
	for await (const { json } of readSessionJournal(sessionFile)) {
		lines.push(`${json}\n`);
	}
	return lines.join("");
}

/** Mirrors the outbox on-disk format: one JSON entry per session file, named by path hash. */
function outboxEntryPath(agentDir: string, sessionFile: string): string {
	const key = createHash("sha256").update(sessionFile).digest("hex").slice(0, 32);
	return join(agentDir, "trace-export-outbox", `${key}.json`);
}

function writeOutboxEntry(agentDir: string, sessionFile: string, signature?: { size: number; mtimeMs: number }): void {
	mkdirSync(join(agentDir, "trace-export-outbox"), { recursive: true });
	writeFileSync(outboxEntryPath(agentDir, sessionFile), JSON.stringify({ sessionFile, ...signature }));
}

function readOutboxEntry(
	agentDir: string,
	sessionFile: string,
): { sessionFile: string; kind?: string; size?: number; mtimeMs?: number; uploadedBytes?: number } | undefined {
	if (!existsSync(outboxEntryPath(agentDir, sessionFile))) {
		return undefined;
	}
	return JSON.parse(readFileSync(outboxEntryPath(agentDir, sessionFile), "utf8")) as {
		sessionFile: string;
		kind?: string;
		size?: number;
		mtimeMs?: number;
		uploadedBytes?: number;
	};
}

function writeLedgerOutboxEntry(agentDir: string, ledgerFile: string, uploadedBytes?: number): void {
	mkdirSync(join(agentDir, "trace-export-outbox"), { recursive: true });
	writeFileSync(
		outboxEntryPath(agentDir, ledgerFile),
		JSON.stringify({
			sessionFile: ledgerFile,
			kind: "semantic-edges",
			...(uploadedBytes === undefined ? {} : { uploadedBytes }),
		}),
	);
}

async function advanceTimersUntil(condition: () => boolean): Promise<void> {
	for (let step = 0; step < 200 && !condition(); step += 1) {
		await stat(new URL(import.meta.url));
		if (!condition() && vi.getTimerCount() > 0) {
			await vi.advanceTimersToNextTimerAsync();
		}
	}
	if (!condition()) {
		throw new Error("Timed out advancing fake timers to the expected condition");
	}
}

describe("agent trace upload", () => {
	let tempDir: string;
	let originalTraceApiKey: string | undefined;
	let originalPrimeApiKey: string | undefined;
	let originalTraceBaseUrl: string | undefined;
	let originalPrimeBaseUrl: string | undefined;
	let originalAgentDir: string | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "agent-traces-test-"));
		originalAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = tempDir;
		originalTraceApiKey = process.env.BASE_CONTEXT_TRACES_API_KEY;
		originalPrimeApiKey = process.env.PRIME_API_KEY;
		originalTraceBaseUrl = process.env.BASE_CONTEXT_TRACES_BASE_URL;
		originalPrimeBaseUrl = process.env.PRIME_API_BASE_URL;
		delete process.env.BASE_CONTEXT_TRACES_API_KEY;
		delete process.env.PRIME_API_KEY;
		delete process.env.BASE_CONTEXT_TRACES_BASE_URL;
		delete process.env.PRIME_API_BASE_URL;
	});

	afterEach(async () => {
		if (vi.isFakeTimers()) vi.clearAllTimers();
		vi.restoreAllMocks();
		vi.useRealTimers();
		await Promise.all(ownedSessionManagers.splice(0).map((sessionManager) => sessionManager.close()));
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
		if (originalTraceApiKey === undefined) {
			delete process.env.BASE_CONTEXT_TRACES_API_KEY;
		} else {
			process.env.BASE_CONTEXT_TRACES_API_KEY = originalTraceApiKey;
		}
		if (originalPrimeApiKey === undefined) {
			delete process.env.PRIME_API_KEY;
		} else {
			process.env.PRIME_API_KEY = originalPrimeApiKey;
		}
		if (originalTraceBaseUrl === undefined) {
			delete process.env.BASE_CONTEXT_TRACES_BASE_URL;
		} else {
			process.env.BASE_CONTEXT_TRACES_BASE_URL = originalTraceBaseUrl;
		}
		if (originalPrimeBaseUrl === undefined) {
			delete process.env.PRIME_API_BASE_URL;
		} else {
			process.env.PRIME_API_BASE_URL = originalPrimeBaseUrl;
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not upload when trace sharing is disabled", async () => {
		const sessionManager = await writeSession(tempDir, join(tempDir, "sessions"), "disabled-session");
		const calls: FetchCall[] = [];
		const result = await uploadAgentTraceFile({
			sessionFile: sessionManager.getSessionFile(),
			authStorage: AuthStorage.inMemory({
				[BASE_CONTEXT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: false } }),
			baseUrl: "https://api.example.test",
			fetchFn: createFetchRecorder(calls),
			reloadConfig: false,
		});

		expect(result).toEqual({ status: "disabled" });
		expect(calls).toHaveLength(0);
	});

	it("allows an explicit one-shot upload without enabling automatic sharing", async () => {
		const sessionManager = await writeSession(tempDir, join(tempDir, "sessions"), "one-shot-session");
		const calls: FetchCall[] = [];
		const result = await uploadAgentTraceFile({
			sessionFile: sessionManager.getSessionFile(),
			authStorage: AuthStorage.inMemory({
				[BASE_CONTEXT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: false } }),
			requireEnabled: false,
			baseUrl: "https://api.example.test",
			fetchFn: createFetchRecorder(calls),
			reloadConfig: false,
		});

		expect(result.status).toBe("uploaded");
		expect(calls).toHaveLength(1);
	});

	it("stops before reading the session body when trace sharing is disabled after upload starts", async () => {
		const sessionManager = await writeSession(tempDir, join(tempDir, "sessions"), "disabled-before-read-session");
		const settingsManager = SettingsManager.inMemory({ agentTraces: { enabled: true } });
		const enabledSpy = vi.spyOn(settingsManager, "getAgentTracesEnabled");
		enabledSpy.mockReturnValueOnce(true).mockReturnValue(false);

		const calls: FetchCall[] = [];
		const result = await uploadAgentTraceFile({
			sessionFile: sessionManager.getSessionFile(),
			authStorage: AuthStorage.inMemory({
				[BASE_CONTEXT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager,
			baseUrl: "https://api.example.test",
			fetchFn: createFetchRecorder(calls),
			reloadConfig: false,
		});

		expect(result).toEqual({ status: "disabled" });
		expect(calls).toHaveLength(0);
		expect(enabledSpy).toHaveBeenCalledTimes(2);
	});

	it("rechecks trace sharing before sending the upload request", async () => {
		const sessionManager = await writeSession(tempDir, join(tempDir, "sessions"), "disabled-before-fetch-session");
		const settingsManager = SettingsManager.inMemory({ agentTraces: { enabled: true } });
		const enabledSpy = vi.spyOn(settingsManager, "getAgentTracesEnabled");
		enabledSpy.mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValue(false);

		const calls: FetchCall[] = [];
		const result = await uploadAgentTraceFile({
			sessionFile: sessionManager.getSessionFile(),
			authStorage: AuthStorage.inMemory({
				[BASE_CONTEXT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager,
			baseUrl: "https://api.example.test",
			fetchFn: createFetchRecorder(calls),
			reloadConfig: false,
		});

		expect(result).toEqual({ status: "disabled" });
		expect(calls).toHaveLength(0);
		expect(enabledSpy).toHaveBeenCalledTimes(3);
	});

	it("uploads decoded session payload JSONL with trace headers", async () => {
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		const parent = await writeSession(cwd, sessionDir, "parent-session");
		const child = await writeSession(cwd, sessionDir, "child-session", parent.getSessionFile());
		const childSessionFile = child.getSessionFile();
		expect(childSessionFile).toBeDefined();

		const calls: FetchCall[] = [];
		const result = await uploadAgentTraceFile({
			sessionFile: childSessionFile,
			authStorage: AuthStorage.inMemory({
				[BASE_CONTEXT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn: createFetchRecorder(calls),
			reloadConfig: false,
		});

		expect(result).toEqual({
			status: "uploaded",
			sessionId: "uploaded-session",
			traceId: "uploaded-trace",
			bytesStored: 123,
			key: "trace/key.jsonl",
		});
		expect(calls).toHaveLength(1);
		const call = calls[0];
		expect(call.url).toBe("https://api.example.test/api/v1/agent-traces/sessions/child-session");
		expect(call.init.method).toBe("PUT");
		const body = await readTraceBody(childSessionFile!);
		expect(call.init.body).toBe(body);
		expect(Buffer.byteLength(body)).toBeLessThan((await stat(childSessionFile!)).size);

		const headers = new Headers(call.init.headers);
		expect(headers.get("authorization")).toBe("Bearer trace-key");
		expect(headers.get("content-type")).toBe("application/x-ndjson");
		expect(headers.get("x-trace-id")).toBe("parent-session");
		expect(headers.get("x-parent-session")).toBe("parent-session");
		expect(headers.get("x-cwd")).toBe(cwd);
		expect(headers.get("x-agent-version")).toBeTruthy();
		expect(headers.get("content-length")).toBeNull();
	});

	it("requires an explicit export endpoint and still permits local preview", async () => {
		const sessionManager = await writeSession(tempDir, join(tempDir, "sessions"), "prod-session");
		const configPath = join(tempDir, "prime-config.json");
		writeFileSync(configPath, JSON.stringify({ base_url: "https://dev-api.example/api/v1" }));
		process.env.PRIME_API_BASE_URL = "https://wrong-api.example";

		const calls: FetchCall[] = [];
		const result = await uploadAgentTraceFile({
			sessionFile: sessionManager.getSessionFile(),
			authStorage: AuthStorage.inMemory({
				[BASE_CONTEXT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			configPath,
			fetchFn: createFetchRecorder(calls),
			reloadConfig: false,
		});

		expect(result).toMatchObject({
			status: "failed",
			message: expect.stringContaining("BASE_CONTEXT_TRACES_BASE_URL"),
		});
		expect(calls).toHaveLength(0);
		const preview = await previewAgentTraceFile({ sessionFile: sessionManager.getSessionFile() });
		expect(preview).toMatchObject({
			status: "ready",
			uploadable: false,
			endpoint: undefined,
			contentPreview: (await readTraceBody(sessionManager.getSessionFile() as string)).trimEnd(),
		});
	});

	it("uses BASE_CONTEXT_TRACES_BASE_URL for trace API overrides", async () => {
		const sessionManager = await writeSession(tempDir, join(tempDir, "sessions"), "override-session");
		process.env.BASE_CONTEXT_TRACES_BASE_URL = "https://trace-api.example/api/v1";

		const calls: FetchCall[] = [];
		const result = await uploadAgentTraceFile({
			sessionFile: sessionManager.getSessionFile(),
			authStorage: AuthStorage.inMemory({
				[BASE_CONTEXT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			fetchFn: createFetchRecorder(calls),
			reloadConfig: false,
		});

		expect(result.status).toBe("uploaded");
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("https://trace-api.example/api/v1/agent-traces/sessions/override-session");
	});

	it("does not catch up an inherited outbox when trace upload is installed", async () => {
		vi.useFakeTimers();
		const sessionDir = join(tempDir, "sessions");
		const missed = await writeSession(tempDir, sessionDir, "missed-session");
		const inheritedOutbox = join(tempDir, "agent-traces-outbox");
		mkdirSync(inheritedOutbox);
		const entryPath = join(inheritedOutbox, "pending.json");
		const entry = JSON.stringify({ sessionFile: missed.getSessionFile() });
		writeFileSync(entryPath, entry);
		const live = await createSession(tempDir, sessionDir);
		const calls: FetchCall[] = [];
		const options = {
			authStorage: AuthStorage.inMemory({
				[BASE_CONTEXT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn: createFetchRecorder(calls),
		};
		installAgentTraceUpload(live, options);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(calls).toHaveLength(0);
		expect((await catchUpAgentTraceUploads(options)).results).toEqual([]);
		expect(calls).toHaveLength(0);
		expect(readFileSync(entryPath, "utf8")).toBe(entry);
	});

	it("schedules upload only after each entry is persisted", async () => {
		vi.useFakeTimers();
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		const sessionManager = await createSession(cwd, sessionDir, "listener-session");

		const calls: FetchCall[] = [];
		installAgentTraceUpload(sessionManager, {
			authStorage: AuthStorage.inMemory({
				[BASE_CONTEXT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn: createFetchRecorder(calls),
		});

		const userPersist = sessionManager.appendMessage(createUserMessage("hello"));
		expect(vi.getTimerCount()).toBe(0);
		await userPersist;
		expect(vi.getTimerCount()).toBe(1);

		await sessionManager.appendMessage(createAssistantMessage("hi"));
		expect(vi.getTimerCount()).toBe(1);
		await advanceTimersUntil(() => calls.length === 1);
		expect(calls[0].url).toBe("https://api.example.test/api/v1/agent-traces/sessions/listener-session");
	});

	it("coalesces new content that persists during an in-flight upload into one follow-up upload", async () => {
		vi.useFakeTimers();
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		const sessionManager = await createSession(cwd, sessionDir, "concurrent-upload-session");

		let releaseFetch: () => void = () => {};
		const fetchReleased = new Promise<void>((resolve) => {
			releaseFetch = resolve;
		});
		const calls: FetchCall[] = [];
		const fetchFn: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init: init ?? {} });
			if (calls.length === 1) {
				await fetchReleased;
			}
			return new Response(JSON.stringify({ bytes_stored: 123 }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};

		installAgentTraceUpload(sessionManager, {
			authStorage: AuthStorage.inMemory({
				[BASE_CONTEXT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn,
		});

		await sessionManager.appendMessage(createUserMessage("hello"));
		await sessionManager.appendMessage(createAssistantMessage("hi"));
		await advanceTimersUntil(() => calls.length === 1);

		// New content lands while the first upload is still in flight.
		await sessionManager.appendMessage(createUserMessage("more"));
		await sessionManager.appendMessage(createAssistantMessage("content"));
		await advanceTimersUntil(() => vi.getTimerCount() > 0);
		await vi.advanceTimersToNextTimerAsync();
		expect(calls).toHaveLength(1);

		releaseFetch();
		await advanceTimersUntil(() => calls.length === 2);
		const sessionFile = sessionManager.getSessionFile() as string;
		const finalBody = await readTraceBody(sessionFile);
		const finalStats = await stat(sessionFile);
		expect(calls[1].init.body).toBe(finalBody);
		// Drain the follow-up upload's completion so its chain cannot leak into later fake-timer tests.
		await advanceTimersUntil(() => readOutboxEntry(tempDir, sessionFile)?.size === finalStats.size);
		expect(readOutboxEntry(tempDir, sessionFile)).toEqual({
			sessionFile,
			size: finalStats.size,
			mtimeMs: finalStats.mtimeMs,
		});
	});

	it("schedules automatic uploads at most once per minute and only after new entries persist", async () => {
		vi.useFakeTimers();
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		const sessionManager = await createSession(cwd, sessionDir, "throttled-session");

		const calls: FetchCall[] = [];
		installAgentTraceUpload(sessionManager, {
			authStorage: AuthStorage.inMemory({
				[BASE_CONTEXT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn: createFetchRecorder(calls),
		});

		await sessionManager.appendMessage(createUserMessage("hello"));
		await sessionManager.appendMessage(createAssistantMessage("hi"));
		expect(Number(setTimeoutSpy.mock.calls.at(-1)?.[1])).toBe(1_000);
		await advanceTimersUntil(() => calls.length === 1);

		setTimeoutSpy.mockClear();
		await sessionManager.appendMessage(createUserMessage("next"));
		expect(Number(setTimeoutSpy.mock.calls.at(-1)?.[1])).toBe(60_000);
	});

	it("surfaces the underlying fetch cause and logs the failure", async () => {
		const session = await writeSession(tempDir, join(tempDir, "sessions"), "failing-session");
		const sessionFile = session.getSessionFile();

		const failingFetch: typeof fetch = async () => {
			const error = new TypeError("fetch failed");
			(error as { cause?: unknown }).cause = { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND host" };
			throw error;
		};

		const result = await uploadAgentTraceFile({
			sessionFile,
			authStorage: AuthStorage.inMemory({
				[BASE_CONTEXT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn: failingFetch,
			reloadConfig: false,
		});

		expect(result.status).toBe("failed");
		if (result.status === "failed") {
			expect(result.message).toBe("fetch failed (ENOTFOUND)");
		}

		const logContents = readFileSync(getAgentTracesLogPath(), "utf8");
		expect(logContents).toContain("upload failed");
		expect(logContents).toContain("fetch failed (ENOTFOUND)");
		expect(logContents).toContain(sessionFile ?? "");
	});

	it("retries once on a transient connection failure, then succeeds", async () => {
		const session = await writeSession(tempDir, join(tempDir, "sessions"), "retry-session");
		const calls: FetchCall[] = [];
		let attempts = 0;
		const flakyFetch: typeof fetch = async (input, init) => {
			attempts += 1;
			if (attempts === 1) {
				const error = new TypeError("fetch failed");
				(error as { cause?: unknown }).cause = { code: "ECONNRESET" };
				throw error;
			}
			return createFetchRecorder(calls)(input, init);
		};

		const result = await uploadAgentTraceFile({
			sessionFile: session.getSessionFile(),
			authStorage: AuthStorage.inMemory({
				[BASE_CONTEXT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn: flakyFetch,
			reloadConfig: false,
		});

		expect(attempts).toBe(2);
		expect(result.status).toBe("uploaded");
		expect(calls).toHaveLength(1);
	});

	it("uses bounded exponential backoff with jitter for transient failures", async () => {
		const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
		const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
		const session = await writeSession(tempDir, join(tempDir, "sessions"), "bounded-retry-session");
		let attempts = 0;
		const failingFetch: typeof fetch = async () => {
			attempts += 1;
			const error = new TypeError("fetch failed");
			(error as { cause?: unknown }).cause = { code: "ECONNRESET" };
			throw error;
		};

		const result = await uploadAgentTraceFile({
			sessionFile: session.getSessionFile(),
			authStorage: AuthStorage.inMemory({
				[BASE_CONTEXT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn: failingFetch,
			reloadConfig: false,
		});
		expect(attempts).toBe(4);
		expect(result.status).toBe("failed");
		const retryDelays = timeoutSpy.mock.calls.map((call) => Number(call[1])).filter((delay) => delay < 15_000);
		expect(retryDelays).toEqual([400, 800, 1_600]);
		randomSpy.mockRestore();
	});

	it("retries request timeouts within the retry bound", async () => {
		vi.useFakeTimers();
		const session = await writeSession(tempDir, join(tempDir, "sessions"), "timeout-retry-session");
		let markFirstAttemptStarted: () => void = () => {};
		const firstAttemptStarted = new Promise<void>((resolve) => {
			markFirstAttemptStarted = resolve;
		});
		let attempts = 0;
		const timeoutFetch: typeof fetch = async (_input, init) => {
			attempts += 1;
			if (attempts === 1) {
				markFirstAttemptStarted();
			}
			return await new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal;
				signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		};

		const upload = uploadAgentTraceFile({
			sessionFile: session.getSessionFile(),
			authStorage: AuthStorage.inMemory({
				[BASE_CONTEXT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn: timeoutFetch,
			requestTimeoutMs: 100,
			reloadConfig: false,
		});

		await firstAttemptStarted;
		await vi.runAllTimersAsync();
		const result = await upload;
		expect(attempts).toBe(4);
		expect(result).toEqual({ status: "failed", message: "Trace upload timed out after 100ms" });
	});

	it("retries transient HTTP responses but not permanent HTTP responses", async () => {
		const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);
		const session = await writeSession(tempDir, join(tempDir, "sessions"), "http-retry-session");
		let attempts = 0;
		const fetchFn: typeof fetch = async () => {
			attempts += 1;
			if (attempts < 3) {
				return new Response(JSON.stringify({ detail: "temporarily unavailable" }), { status: 503 });
			}
			return new Response(JSON.stringify({ bytes_stored: 42 }), { status: 200 });
		};

		const result = await uploadAgentTraceFile({
			sessionFile: session.getSessionFile(),
			authStorage: AuthStorage.inMemory({
				[BASE_CONTEXT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn,
			reloadConfig: false,
		});
		expect(attempts).toBe(3);
		expect(result.status).toBe("uploaded");
		randomSpy.mockRestore();
	});

	it("returns a rate-limited upload immediately instead of sleeping in-request", async () => {
		const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
		const session = await writeSession(tempDir, join(tempDir, "sessions"), "rate-limit-session");
		let attempts = 0;
		const fetchFn: typeof fetch = async () => {
			attempts += 1;
			return new Response(JSON.stringify({ detail: "Too Many Requests" }), { status: 429 });
		};

		const result = await uploadAgentTraceFile({
			sessionFile: session.getSessionFile(),
			authStorage: AuthStorage.inMemory({
				[BASE_CONTEXT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn,
			reloadConfig: false,
		});

		expect(attempts).toBe(1);
		expect(result).toMatchObject({ status: "failed", statusCode: 429 });
		expect(timeoutSpy.mock.calls.map((call) => Number(call[1]))).not.toContain(60_000);
	});

	it("reschedules a rate-limited automatic upload without blocking and retries on the next cycle", async () => {
		vi.useFakeTimers();
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		const sessionManager = await createSession(cwd, sessionDir, "rate-limit-reschedule-session");

		let attempts = 0;
		const calls: FetchCall[] = [];
		const fetchFn: typeof fetch = async (input, init) => {
			attempts += 1;
			if (attempts === 1) {
				return new Response(JSON.stringify({ detail: "Too Many Requests" }), { status: 429 });
			}
			return createFetchRecorder(calls)(input, init);
		};

		installAgentTraceUpload(sessionManager, {
			authStorage: AuthStorage.inMemory({
				[BASE_CONTEXT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn,
		});

		await sessionManager.appendMessage(createUserMessage("hello"));
		await sessionManager.appendMessage(createAssistantMessage("hi"));
		await advanceTimersUntil(() => attempts === 1);
		// The rate-limited cycle re-arms itself; the retry succeeds without any caller waiting.
		await advanceTimersUntil(() => calls.length === 1);
		expect(attempts).toBe(2);
	});

	it.each([503])("honors Retry-After when retrying HTTP %i", async (status) => {
		vi.useFakeTimers();
		const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
		const session = await writeSession(tempDir, join(tempDir, "sessions"), `retry-after-session-${status}`);
		let markFirstAttemptStarted: () => void = () => {};
		const firstAttemptStarted = new Promise<void>((resolve) => {
			markFirstAttemptStarted = resolve;
		});
		let attempts = 0;
		const fetchFn: typeof fetch = async () => {
			attempts += 1;
			if (attempts === 1) {
				markFirstAttemptStarted();
				return new Response(null, { status, headers: { "retry-after": "17" } });
			}
			return new Response(JSON.stringify({ bytes_stored: 42 }), { status: 200 });
		};

		const upload = uploadAgentTraceFile({
			sessionFile: session.getSessionFile(),
			authStorage: AuthStorage.inMemory({
				[BASE_CONTEXT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn,
			reloadConfig: false,
		});

		await firstAttemptStarted;
		await vi.runAllTimersAsync();
		const result = await upload;
		expect(attempts).toBe(2);
		expect(result.status).toBe("uploaded");
		expect(timeoutSpy.mock.calls.map((call) => Number(call[1]))).toContain(17_000);
	});

	it("caps Retry-After at the platform rate-limit window", async () => {
		vi.useFakeTimers();
		const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
		const session = await writeSession(tempDir, join(tempDir, "sessions"), "bounded-retry-after-session");
		let markFirstAttemptStarted: () => void = () => {};
		const firstAttemptStarted = new Promise<void>((resolve) => {
			markFirstAttemptStarted = resolve;
		});
		let attempts = 0;
		const fetchFn: typeof fetch = async () => {
			attempts += 1;
			if (attempts === 1) {
				markFirstAttemptStarted();
				return new Response(null, { status: 503, headers: { "retry-after": "3600" } });
			}
			return new Response(JSON.stringify({ bytes_stored: 42 }), { status: 200 });
		};

		const upload = uploadAgentTraceFile({
			sessionFile: session.getSessionFile(),
			authStorage: AuthStorage.inMemory({
				[BASE_CONTEXT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn,
			reloadConfig: false,
		});

		await firstAttemptStarted;
		await vi.runAllTimersAsync();
		const result = await upload;
		expect(attempts).toBe(2);
		expect(result.status).toBe("uploaded");
		expect(timeoutSpy.mock.calls.map((call) => Number(call[1]))).toContain(60_000);
		expect(timeoutSpy.mock.calls.map((call) => Number(call[1]))).not.toContain(3_600_000);
	});

	it("surfaces the cancellation reason when aborted during the retry backoff", async () => {
		const session = await writeSession(tempDir, join(tempDir, "sessions"), "aborted-retry-session");
		const controller = new AbortController();
		const abortReason = new Error("upload cancelled");
		let attempts = 0;
		const flakyFetch: typeof fetch = async () => {
			attempts += 1;
			controller.abort(abortReason);
			const error = new TypeError("fetch failed");
			(error as { cause?: unknown }).cause = { code: "ECONNRESET" };
			throw error;
		};

		const result = await uploadAgentTraceFile({
			sessionFile: session.getSessionFile(),
			authStorage: AuthStorage.inMemory({
				[BASE_CONTEXT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn: flakyFetch,
			signal: controller.signal,
			reloadConfig: false,
		});

		expect(attempts).toBe(1);
		expect(result.status).toBe("failed");
		if (result.status === "failed") {
			expect(result.message).toBe("upload cancelled");
		}
	});

	it("does not back off when an HTTP response cleanup aborts the upload", async () => {
		vi.useFakeTimers();
		const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
		const session = await writeSession(tempDir, join(tempDir, "sessions"), "aborted-http-retry-session");
		const controller = new AbortController();
		const abortReason = new Error("upload cancelled during cleanup");
		let attempts = 0;
		const fetchFn: typeof fetch = async () => {
			attempts += 1;
			return {
				status: 503,
				headers: new Headers(),
				body: {
					cancel: async () => {
						controller.abort(abortReason);
					},
				},
			} as unknown as Response;
		};

		const upload = uploadAgentTraceFile({
			sessionFile: session.getSessionFile(),
			authStorage: AuthStorage.inMemory({
				[BASE_CONTEXT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn,
			signal: controller.signal,
			reloadConfig: false,
		});

		await vi.runAllTimersAsync();
		const result = await upload;
		expect(attempts).toBe(1);
		expect(result).toEqual({ status: "failed", message: "upload cancelled during cleanup" });
		const retryDelays = timeoutSpy.mock.calls.map((call) => Number(call[1])).filter((delay) => delay < 15_000);
		expect(retryDelays).toEqual([]);
	});

	it("does not retry a permanent DNS failure", async () => {
		const session = await writeSession(tempDir, join(tempDir, "sessions"), "dns-failure-session");
		let attempts = 0;
		const dnsFailFetch: typeof fetch = async () => {
			attempts += 1;
			const error = new TypeError("fetch failed");
			(error as { cause?: unknown }).cause = { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND host" };
			throw error;
		};

		const result = await uploadAgentTraceFile({
			sessionFile: session.getSessionFile(),
			authStorage: AuthStorage.inMemory({
				[BASE_CONTEXT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn: dnsFailFetch,
			reloadConfig: false,
		});

		expect(attempts).toBe(1);
		expect(result.status).toBe("failed");
		if (result.status === "failed") {
			expect(result.message).toBe("fetch failed (ENOTFOUND)");
		}
	});

	it("does not retry on an HTTP error response", async () => {
		const session = await writeSession(tempDir, join(tempDir, "sessions"), "http-error-session");
		let attempts = 0;
		const erroringFetch: typeof fetch = async () => {
			attempts += 1;
			return new Response(JSON.stringify({ detail: "bad request" }), {
				status: 400,
				headers: { "content-type": "application/json" },
			});
		};

		const result = await uploadAgentTraceFile({
			sessionFile: session.getSessionFile(),
			authStorage: AuthStorage.inMemory({
				[BASE_CONTEXT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn: erroringFetch,
			reloadConfig: false,
		});

		expect(attempts).toBe(1);
		expect(result.status).toBe("failed");
		if (result.status === "failed") {
			expect(result.statusCode).toBe(400);
		}
	});

	it("previews the current trace without requiring sharing or credentials", async () => {
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		const parent = await writeSession(cwd, sessionDir, "preview-parent");
		const child = await writeSession(cwd, sessionDir, "preview-child", parent.getSessionFile());

		const result = await previewAgentTraceFile({
			sessionFile: child.getSessionFile(),
			baseUrl: "https://api.example.test",
			maxContentChars: 256,
		});

		expect(result.status).toBe("ready");
		if (result.status === "ready") {
			expect(result).toMatchObject({
				sessionId: "preview-child",
				traceId: "preview-parent",
				parentSessionId: "preview-parent",
				cwd,
				uploadable: true,
				endpoint: "https://api.example.test/api/v1/agent-traces/sessions/preview-child",
				truncated: true,
			});
			expect(result.contentPreview).toContain("middle of trace omitted");
			expect(result.contentPreview).toContain("preview-child");
		}
	});

	it("discovers and uploads saved parent and subagent traces", async () => {
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		const parent = await writeSession(cwd, sessionDir, "all-parent");
		const childDir = join(tempDir, "session-artifacts", "all-parent", "sub-12345678");
		const child = await writeSession(cwd, childDir, "all-child", parent.getSessionFile());
		const grandchildDir = join(childDir, "sub-87654321");
		const grandchild = await writeSession(cwd, grandchildDir, "all-grandchild", child.getSessionFile());
		writeFileSync(join(childDir, "not-a-session.jsonl"), '{"type":"diagnostic"}\n');

		const discovered = await findAgentTraceFiles(sessionDir);
		expect(discovered).toEqual([child.getSessionFile(), grandchild.getSessionFile(), parent.getSessionFile()].sort());

		vi.useFakeTimers();
		const calls: FetchCall[] = [];
		let resolveFirstCompletion: () => void = () => {};
		const firstCompletion = new Promise<void>((resolve) => {
			resolveFirstCompletion = resolve;
		});
		const progress: Array<{ completed: number; total: number }> = [];
		const upload = uploadAllAgentTraces({
			sessionDir,
			authStorage: AuthStorage.inMemory({
				[BASE_CONTEXT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: false } }),
			requireEnabled: false,
			baseUrl: "https://api.example.test",
			fetchFn: createFetchRecorder(calls),
			reloadConfig: false,
			concurrency: 0.5,
			onProgress: ({ completed, total }) => {
				progress.push({ completed, total });
				if (completed === 1) {
					resolveFirstCompletion();
				}
			},
		});
		await firstCompletion;
		await advanceTimersUntil(() => calls.length === 3);
		const result = await upload;

		expect(result).toMatchObject({ total: 3, uploaded: 3, failed: 0, skipped: 0, bytesStored: 369 });
		expect(calls.map((call) => call.url).sort()).toEqual(
			[
				"https://api.example.test/api/v1/agent-traces/sessions/all-child",
				"https://api.example.test/api/v1/agent-traces/sessions/all-grandchild",
				"https://api.example.test/api/v1/agent-traces/sessions/all-parent",
			].sort(),
		);
		const grandchildCall = calls.find((call) => call.url.endsWith("/all-grandchild"));
		const grandchildHeaders = new Headers(grandchildCall?.init.headers);
		expect(grandchildHeaders.get("x-trace-id")).toBe("all-parent");
		expect(grandchildHeaders.get("x-parent-session")).toBe("all-child");
		expect(progress[0]).toEqual({ completed: 0, total: 3 });
		expect(progress.at(-1)).toEqual({ completed: 3, total: 3 });
	});

	it("paces batch request starts within the platform rate limit", async () => {
		const sessionDir = join(tempDir, "sessions");
		for (let index = 0; index < 6; index += 1) {
			await writeSession(tempDir, sessionDir, `rate-limited-all-${index}`);
		}

		vi.useFakeTimers();
		let markFirstRequestStarted: () => void = () => {};
		const firstRequestStarted = new Promise<void>((resolve) => {
			markFirstRequestStarted = resolve;
		});
		const requestStarts: number[] = [];
		const fetchFn: typeof fetch = async () => {
			requestStarts.push(Date.now());
			if (requestStarts.length === 1) {
				markFirstRequestStarted();
			}
			return new Response(JSON.stringify({ bytes_stored: 1 }), { status: 200 });
		};

		const upload = uploadAllAgentTraces({
			sessionDir,
			authStorage: AuthStorage.inMemory({
				[BASE_CONTEXT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: false } }),
			requireEnabled: false,
			baseUrl: "https://api.example.test",
			fetchFn,
			reloadConfig: false,
		});

		await firstRequestStarted;
		await advanceTimersUntil(() => requestStarts.length === 6);
		const result = await upload;
		expect(result).toMatchObject({ total: 6, uploaded: 6, failed: 0, skipped: 0 });
		expect(requestStarts).toHaveLength(6);
		for (let index = 1; index < requestStarts.length; index += 1) {
			expect(requestStarts[index]! - requestStarts[index - 1]!).toBeGreaterThanOrEqual(12_000);
		}
		expect(requestStarts[5]! - requestStarts[0]!).toBeGreaterThanOrEqual(60_000);
	});

	it("stops scheduling batch uploads after cancellation", async () => {
		const sessionDir = join(tempDir, "sessions");
		await writeSession(tempDir, sessionDir, "abort-all-a");
		await writeSession(tempDir, sessionDir, "abort-all-b");
		await writeSession(tempDir, sessionDir, "abort-all-c");
		const controller = new AbortController();
		const calls: FetchCall[] = [];

		const result = await uploadAllAgentTraces({
			sessionDir,
			authStorage: AuthStorage.inMemory({
				[BASE_CONTEXT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: false } }),
			requireEnabled: false,
			baseUrl: "https://api.example.test",
			fetchFn: createFetchRecorder(calls),
			reloadConfig: false,
			concurrency: 1,
			signal: controller.signal,
			onProgress: ({ completed }) => {
				if (completed === 1) {
					controller.abort(new Error("cancel batch"));
				}
			},
		});

		expect(calls).toHaveLength(1);
		expect(result).toMatchObject({ total: 3, uploaded: 1, failed: 0, skipped: 2 });
		expect(result.results).toHaveLength(1);
	});

	it("counts in-flight batch cancellations as skipped", async () => {
		const sessionDir = join(tempDir, "sessions");
		await writeSession(tempDir, sessionDir, "abort-in-flight-a");
		await writeSession(tempDir, sessionDir, "abort-in-flight-b");
		await writeSession(tempDir, sessionDir, "abort-in-flight-c");
		const controller = new AbortController();
		const abortReason = new Error("cancel in-flight batch");
		vi.useFakeTimers();
		let markFirstRequestStarted: () => void = () => {};
		const firstRequestStarted = new Promise<void>((resolve) => {
			markFirstRequestStarted = resolve;
		});
		let attempts = 0;
		const fetchFn: typeof fetch = async (_input, init) => {
			attempts += 1;
			if (attempts === 1) {
				markFirstRequestStarted();
			}
			return await new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
				if (attempts === 2) {
					queueMicrotask(() => controller.abort(abortReason));
				}
			});
		};

		const upload = uploadAllAgentTraces({
			sessionDir,
			authStorage: AuthStorage.inMemory({
				[BASE_CONTEXT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: false } }),
			requireEnabled: false,
			baseUrl: "https://api.example.test",
			fetchFn,
			reloadConfig: false,
			concurrency: 2,
			signal: controller.signal,
		});
		await firstRequestStarted;
		await advanceTimersUntil(() => attempts === 2);
		const result = await upload;

		expect(attempts).toBe(2);
		expect(result).toMatchObject({ total: 3, uploaded: 0, failed: 0, skipped: 3 });
		expect(result.results).toHaveLength(0);
	});

	it("durably records upload intent on disk before any upload happens", async () => {
		vi.useFakeTimers();
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		const sessionManager = await createSession(cwd, sessionDir, "unflushed-session");

		const calls: FetchCall[] = [];
		installAgentTraceUpload(sessionManager, {
			authStorage: AuthStorage.inMemory({
				[BASE_CONTEXT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn: createFetchRecorder(calls),
		});

		await sessionManager.appendMessage(createUserMessage("hello"));
		await sessionManager.appendMessage(createAssistantMessage("hi"));
		const sessionFile = sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();

		// The intent marker is on disk when the persist ACK resolves.
		expect(readOutboxEntry(tempDir, sessionFile as string)).toEqual({ sessionFile });
		expect(calls).toHaveLength(0);
	});

	it("catch-up uploads exactly the content a previous process never uploaded, then goes quiet", async () => {
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		const missed = await writeSession(cwd, sessionDir, "crash-lost-session");
		const missedFile = missed.getSessionFile() as string;
		writeOutboxEntry(tempDir, missedFile);

		const calls: FetchCall[] = [];
		const options = {
			authStorage: AuthStorage.inMemory({
				[BASE_CONTEXT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn: createFetchRecorder(calls),
			reloadConfig: false,
		};

		const first = await catchUpAgentTraceUploads(options);
		expect(first.results.map(({ result }) => result.status)).toEqual(["uploaded"]);
		expect(calls).toHaveLength(1);
		expect(calls[0].init.body).toBe(await readTraceBody(missedFile));
		const stats = await stat(missedFile);
		expect(readOutboxEntry(tempDir, missedFile)).toEqual({
			sessionFile: missedFile,
			size: stats.size,
			mtimeMs: stats.mtimeMs,
		});

		// Unchanged content: subsequent cycles and restarts never re-POST.
		const second = await catchUpAgentTraceUploads(options);
		expect(second.results).toEqual([]);
		const automatic = await uploadAgentTraceFile({ ...options, sessionFile: missedFile });
		expect(automatic).toEqual({ status: "unchanged" });
		expect(calls).toHaveLength(1);
	});

	it("prunes cursor entries whose session file was deleted", async () => {
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		const kept = await writeSession(cwd, sessionDir, "kept-session");
		const keptFile = kept.getSessionFile() as string;
		const keptStats = await stat(keptFile);
		const keptSignature = { size: keptStats.size, mtimeMs: keptStats.mtimeMs };
		const deletedFile = join(sessionDir, "deleted-session.jsonl");
		writeOutboxEntry(tempDir, deletedFile);
		writeOutboxEntry(tempDir, keptFile, keptSignature);

		const calls: FetchCall[] = [];
		const result = await catchUpAgentTraceUploads({
			authStorage: AuthStorage.inMemory({
				[BASE_CONTEXT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn: createFetchRecorder(calls),
			reloadConfig: false,
		});

		expect(result).toEqual({ pruned: 1, semanticEdgeLedgersPending: 0, results: [] });
		expect(calls).toHaveLength(0);
		expect(existsSync(outboxEntryPath(tempDir, deletedFile))).toBe(false);
		expect(readOutboxEntry(tempDir, keptFile)).toEqual({ sessionFile: keptFile, ...keptSignature });
	});

	it("registers the semantic-edge ledger with a kind-tagged durable intent at persist", async () => {
		vi.useFakeTimers();
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		const sessionManager = await createSession(cwd, sessionDir, "ledger-intent-session");
		const ledgerPath = join(tempDir, "artifacts", "semantic-edges.jsonl");

		const calls: FetchCall[] = [];
		installAgentTraceUpload(sessionManager, {
			authStorage: AuthStorage.inMemory({
				[BASE_CONTEXT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn: createFetchRecorder(calls),
			semanticEdgesLedgerPath: ledgerPath,
		});
		await sessionManager.appendMessage(createUserMessage("hello"));
		await sessionManager.appendMessage(createAssistantMessage("hi"));

		// Durable at the persist ACK, tagged with its own delivery kind, before any wire call.
		expect(readOutboxEntry(tempDir, ledgerPath)).toEqual({ sessionFile: ledgerPath, kind: "semantic-edges" });
		expect(calls).toHaveLength(0);

		// A re-install with a DIFFERENT ledger path registers the new ledger at the next persist.
		const movedLedgerPath = join(tempDir, "artifacts-moved", "semantic-edges.jsonl");
		installAgentTraceUpload(sessionManager, {
			authStorage: AuthStorage.inMemory({
				[BASE_CONTEXT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn: createFetchRecorder(calls),
			semanticEdgesLedgerPath: movedLedgerPath,
		});
		await sessionManager.appendMessage(createAssistantMessage("after re-install"));
		expect(readOutboxEntry(tempDir, movedLedgerPath)).toEqual({
			sessionFile: movedLedgerPath,
			kind: "semantic-edges",
		});
		expect(calls).toHaveLength(0);
	});

	it("creates no outbox intent while trace sharing is disabled", async () => {
		vi.useFakeTimers();
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		const sessionManager = await createSession(cwd, sessionDir, "opted-out-session");
		const ledgerPath = join(tempDir, "artifacts", "semantic-edges.jsonl");

		installAgentTraceUpload(sessionManager, {
			authStorage: AuthStorage.inMemory({
				[BASE_CONTEXT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: false } }),
			baseUrl: "https://api.example.test",
			fetchFn: createFetchRecorder([]),
			semanticEdgesLedgerPath: ledgerPath,
		});
		await sessionManager.appendMessage(createUserMessage("private"));
		await sessionManager.appendMessage(createAssistantMessage("also private"));

		// Neither kind leaves a durable entry: enabling sharing later must not
		// retroactively collect sessions recorded while sharing was off.
		expect(readOutboxEntry(tempDir, sessionManager.getSessionFile() as string)).toBeUndefined();
		expect(readOutboxEntry(tempDir, ledgerPath)).toBeUndefined();
	});

	it("re-registers the ledger at the next persist after its entry is pruned", async () => {
		vi.useFakeTimers();
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		const sessionManager = await createSession(cwd, sessionDir, "pruned-ledger-session");
		const ledgerPath = join(tempDir, "artifacts", "semantic-edges.jsonl");

		installAgentTraceUpload(sessionManager, {
			authStorage: AuthStorage.inMemory({
				[BASE_CONTEXT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn: createFetchRecorder([]),
			semanticEdgesLedgerPath: ledgerPath,
		});
		await sessionManager.appendMessage(createUserMessage("hello"));
		await sessionManager.appendMessage(createAssistantMessage("hi"));
		expect(readOutboxEntry(tempDir, ledgerPath)).toEqual({ sessionFile: ledgerPath, kind: "semantic-edges" });

		// A concurrent catch-up pruned the entry (missing ledger file at scan time).
		rmSync(outboxEntryPath(tempDir, ledgerPath));
		await sessionManager.appendMessage(createUserMessage("still here"));
		expect(readOutboxEntry(tempDir, ledgerPath)).toEqual({ sessionFile: ledgerPath, kind: "semantic-edges" });
	});

	it("counts appended ledger bytes as pending, stays quiet at the cursor, and prunes deleted ledgers", async () => {
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		const ledgerFile = join(sessionDir, "semantic-edges.jsonl");
		writeFileSync(ledgerFile, `${JSON.stringify({ type: "session_registered", session_id: "s" })}\n`);
		writeLedgerOutboxEntry(tempDir, ledgerFile);
		const deletedLedger = join(sessionDir, "gone", "semantic-edges.jsonl");
		writeLedgerOutboxEntry(tempDir, deletedLedger);

		const calls: FetchCall[] = [];
		const options = {
			authStorage: AuthStorage.inMemory({
				[BASE_CONTEXT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn: createFetchRecorder(calls),
			reloadConfig: false,
		};

		// Catch-up after a kill: the never-delivered ledger is pending; the deleted one is pruned.
		const first = await catchUpAgentTraceUploads(options);
		expect(first).toEqual({ pruned: 1, semanticEdgeLedgersPending: 1, results: [] });
		expect(existsSync(outboxEntryPath(tempDir, deletedLedger))).toBe(false);
		// The cursor stays untouched: the first real sender must deliver the whole backlog.
		expect(readOutboxEntry(tempDir, ledgerFile)).toEqual({ sessionFile: ledgerFile, kind: "semantic-edges" });

		// A cursor at the file size means unchanged: never re-counted, never resent.
		const { size } = await stat(ledgerFile);
		writeLedgerOutboxEntry(tempDir, ledgerFile, size);
		const second = await catchUpAgentTraceUploads(options);
		expect(second).toEqual({ pruned: 0, semanticEdgeLedgersPending: 0, results: [] });

		// Appended bytes beyond the cursor become pending again.
		writeFileSync(ledgerFile, `${JSON.stringify({ type: "request_started", request_id: "r", session_id: "s" })}\n`, {
			flag: "a",
		});
		const third = await catchUpAgentTraceUploads(options);
		expect(third).toEqual({ pruned: 0, semanticEdgeLedgersPending: 1, results: [] });
		expect(calls).toHaveLength(0);
	});

	it("arms upload timers that never hold the process open", async () => {
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		const sessionManager = await createSession(cwd, sessionDir, "unref-session");

		const calls: FetchCall[] = [];
		installAgentTraceUpload(sessionManager, {
			authStorage: AuthStorage.inMemory({
				[BASE_CONTEXT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn: createFetchRecorder(calls),
		});

		await sessionManager.appendMessage(createUserMessage("hello"));
		await sessionManager.appendMessage(createAssistantMessage("hi"));
		const timer = setTimeoutSpy.mock.results.at(-1)?.value as NodeJS.Timeout;
		try {
			expect(timer.hasRef()).toBe(false);
		} finally {
			clearTimeout(timer);
		}
	});

	it("honors an advertised Retry-After on the next scheduled cycle without blocking", async () => {
		vi.useFakeTimers();
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		const sessionManager = await createSession(cwd, sessionDir, "retry-after-reschedule-session");

		let attempts = 0;
		const calls: FetchCall[] = [];
		const fetchFn: typeof fetch = async (input, init) => {
			attempts += 1;
			if (attempts === 1) {
				return new Response(null, { status: 429, headers: { "retry-after": "300" } });
			}
			return createFetchRecorder(calls)(input, init);
		};

		installAgentTraceUpload(sessionManager, {
			authStorage: AuthStorage.inMemory({
				[BASE_CONTEXT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn,
		});

		await sessionManager.appendMessage(createUserMessage("hello"));
		await sessionManager.appendMessage(createAssistantMessage("hi"));
		await advanceTimersUntil(() => attempts === 1);
		await advanceTimersUntil(() => vi.getTimerCount() > 0);
		expect(Number(setTimeoutSpy.mock.calls.at(-1)?.[1])).toBe(300_000);

		// A fresh persist must not re-arm inside the advertised window.
		await sessionManager.appendMessage(createUserMessage("more"));
		expect(Number(setTimeoutSpy.mock.calls.at(-1)?.[1])).toBeGreaterThanOrEqual(299_000);

		await advanceTimersUntil(() => calls.length === 1);
		expect(attempts).toBe(2);
	});

	it("retries the intent marker on the next persist after a failed write", async () => {
		vi.useFakeTimers();
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		const sessionManager = await createSession(cwd, sessionDir, "marker-retry-session");
		const blocker = join(tempDir, "trace-export-outbox");
		writeFileSync(blocker, "not a directory");

		const calls: FetchCall[] = [];
		installAgentTraceUpload(sessionManager, {
			authStorage: AuthStorage.inMemory({
				[BASE_CONTEXT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn: createFetchRecorder(calls),
		});

		await sessionManager.appendMessage(createUserMessage("hello"));
		await sessionManager.appendMessage(createAssistantMessage("hi"));
		const sessionFile = sessionManager.getSessionFile() as string;
		expect(readOutboxEntry(tempDir, sessionFile)).toBeUndefined();

		rmSync(blocker);
		await sessionManager.appendMessage(createUserMessage("again"));
		expect(readOutboxEntry(tempDir, sessionFile)).toEqual({ sessionFile });
	});

	it("caps an absurd Retry-After at the max timer delay instead of retrying immediately", async () => {
		vi.useFakeTimers();
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		const sessionManager = await createSession(cwd, sessionDir, "absurd-retry-after-session");

		let attempts = 0;
		const fetchFn: typeof fetch = async () => {
			attempts += 1;
			// 30 days, far beyond Node's ~24.8-day timer maximum.
			return new Response(null, { status: 429, headers: { "retry-after": "2592000" } });
		};

		installAgentTraceUpload(sessionManager, {
			authStorage: AuthStorage.inMemory({
				[BASE_CONTEXT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn,
		});

		await sessionManager.appendMessage(createUserMessage("hello"));
		await sessionManager.appendMessage(createAssistantMessage("hi"));
		await advanceTimersUntil(() => attempts === 1);
		await advanceTimersUntil(() => vi.getTimerCount() > 0);
		expect(Number(setTimeoutSpy.mock.calls.at(-1)?.[1])).toBe(2_147_483_647);
	});

	it("returns a retryable failure when the upload cursor cannot be persisted", async () => {
		const session = await writeSession(tempDir, join(tempDir, "sessions"), "cursor-persist-failure");
		writeFileSync(join(tempDir, "trace-export-outbox"), "not a directory");

		const calls: FetchCall[] = [];
		const result = await uploadAgentTraceFile({
			sessionFile: session.getSessionFile(),
			authStorage: AuthStorage.inMemory({
				[BASE_CONTEXT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn: createFetchRecorder(calls),
			reloadConfig: false,
		});

		expect(calls).toHaveLength(1);
		expect(result.status).toBe("failed");
		if (result.status === "failed") {
			expect(result.message).toContain("cursor");
		}
	});

	it("a corrupt outbox entry costs only itself; other cursors survive", async () => {
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		const kept = await writeSession(cwd, sessionDir, "kept-cursor-session");
		const keptFile = kept.getSessionFile() as string;
		const keptStats = await stat(keptFile);
		writeOutboxEntry(tempDir, keptFile, { size: keptStats.size, mtimeMs: keptStats.mtimeMs });
		writeFileSync(join(tempDir, "trace-export-outbox", "deadbeef.json"), "not json");

		const calls: FetchCall[] = [];
		const options = {
			authStorage: AuthStorage.inMemory({
				[BASE_CONTEXT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn: createFetchRecorder(calls),
			reloadConfig: false,
		};

		const result = await catchUpAgentTraceUploads(options);
		expect(result).toEqual({ pruned: 1, semanticEdgeLedgersPending: 0, results: [] });
		expect(calls).toHaveLength(0);
		expect(existsSync(join(tempDir, "trace-export-outbox", "deadbeef.json"))).toBe(false);
		expect(await uploadAgentTraceFile({ ...options, sessionFile: keptFile })).toEqual({ status: "unchanged" });
		expect(calls).toHaveLength(0);
	});

	it("never reuses inference or CLI credentials for trace export", async () => {
		const session = await writeSession(tempDir, join(tempDir, "sessions"), "credential-order-session");
		const calls: FetchCall[] = [];
		const configPath = join(tempDir, "prime-config.json");
		writeFileSync(configPath, JSON.stringify({ api_key: "cli-fallback-key" }));
		process.env.PRIME_API_KEY = "provider-only-key";

		const result = await uploadAgentTraceFile({
			sessionFile: session.getSessionFile(),
			authStorage: AuthStorage.inMemory({
				[PRIME_INFERENCE_PROVIDER_ID]: { type: "api_key", key: "inference-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			configPath,
			fetchFn: createFetchRecorder(calls),
			reloadConfig: false,
		});

		expect(result.status).toBe("missing_credentials");
		expect(calls).toHaveLength(0);
	});
});
