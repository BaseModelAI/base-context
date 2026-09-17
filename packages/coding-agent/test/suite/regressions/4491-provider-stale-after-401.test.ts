import { type AssistantMessage, fauxAssistantMessage } from "@ponythewhite/base-context-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthSourceToken } from "../../../src/core/auth-storage.js";
import { createNativeInferenceStream } from "../../../src/core/inference-coordinator.js";
import { createHarness, type Harness } from "../harness.js";
import { createDeferred } from "../scheduling.js";

function provider401Message(structured = true): AssistantMessage {
	return {
		...fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: structured ? "401 Unauthorized: invalid API key" : "401 status code (no body)",
		}),
		diagnostics: structured
			? [{ type: "provider_stream_failure", timestamp: Date.now(), details: { kind: "auth", status: 401 } }]
			: undefined,
	};
}

describe("issue #4491 provider stale after 401", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	async function createAuthHarness(retryEnabled = true) {
		const harness = await createHarness({
			provider: "openai",
			settings: { retry: { enabled: retryEnabled, maxRetries: 2, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		// Use the SDK native auth/options dispatcher, not a manual preflight lookup.
		// The final transport remains the registered local simulation.
		const sources: AuthSourceToken[] = [];
		harness.session.agent.streamFn = createNativeInferenceStream(async (_model, _context, options) => {
			const registry = harness.session.modelRegistry;
			const auth = await registry.getApiKeyAndHeaders(harness.getModel());
			if (!auth.ok) throw new Error(auth.error);
			if (auth.sourceToken) sources.push(auth.sourceToken);
			return { ...options, apiKey: auth.apiKey, authSourceToken: auth.sourceToken };
		});
		return { harness, sources };
	}

	it.each([
		{ structured: true, retryEnabled: true },
		{ structured: false, retryEnabled: true },
		{ structured: true, retryEnabled: false },
	])("settles auth failure without retrying ($structured/$retryEnabled)", async ({ structured, retryEnabled }) => {
		const { harness, sources } = await createAuthHarness(retryEnabled);
		harness.setResponses([
			provider401Message(structured),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "500 Internal Server Error" }),
			provider401Message(),
		]);

		await harness.session.prompt("hello");
		await harness.session.waitForIdle();

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.getPendingResponseCount()).toBe(2);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		expect(harness.eventsOfType("auto_retry_end")).toEqual([]);
		expect(sources).toMatchObject([{ provider: "openai", source: "runtime" }]);
		expect(harness.eventsOfType("auth_stale")).toEqual([
			{ type: "auth_stale", provider: "openai", sourceTokens: sources },
		]);
		expect(harness.authStorage.hasAuth("openai")).toBe(false);
		await expect(harness.authStorage.getApiKey("openai")).resolves.toBeUndefined();
		expect(harness.authStorage.getAuthStatus("openai")).toEqual({
			configured: false,
			source: "stale",
			label: "expired",
		});
		expect(harness.session.isRetrying).toBe(false);
		expect(harness.session.agent.state.isStreaming).toBe(false);
		expect(harness.session.agent.state.pendingToolCalls.size).toBe(0);
		expect(harness.eventsOfType("agent_end")).toHaveLength(1);
		const assistants = harness.session.messages.filter(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(assistants).toHaveLength(1);
		expect(assistants[0].stopReason).toBe("error");
		expect(assistants[0].errorMessage).toContain("401");
		expect(assistants[0].errorMessage).toContain("Run /login to update credentials.");
	});

	it("joins cancelled terminal work and marks only its captured auth source stale", async () => {
		const { harness, sources } = await createAuthHarness();
		const requestStarted = createDeferred();
		const responseReady = createDeferred();
		harness.setResponses([
			async () => {
				requestStarted.resolve();
				await responseReady.promise;
				return provider401Message();
			},
			provider401Message(),
		]);
		const markSource = vi.spyOn(harness.authStorage, "markAuthSourceStale");
		const reached = createDeferred();
		const release = createDeferred();
		const unsubscribe = harness.session.agent.subscribe(async (event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				reached.resolve();
				await release.promise;
			}
		});
		let prompt: Promise<void> | undefined;
		let abort: Promise<void> | undefined;
		try {
			prompt = harness.session.prompt("hello");
			await requestStarted.promise;
			harness.authStorage.setRuntimeApiKey("openai", "fresh-key");
			responseReady.resolve();
			await reached.promise;
			expect(sources).toMatchObject([{ provider: "openai", source: "runtime" }]);
			expect(harness.session.isRetrying).toBe(false);
			let idleSettled = false;
			const idle = harness.session.waitForIdle().then(() => {
				idleSettled = true;
			});
			abort = harness.session.abort();
			await Promise.resolve();
			expect(idleSettled).toBe(false);
			release.resolve();
			await Promise.all([prompt, abort, idle]);

			expect(harness.faux.state.callCount).toBe(1);
			expect(harness.getPendingResponseCount()).toBe(1);
			expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
			expect(harness.eventsOfType("auto_retry_end")).toEqual([]);
			expect(harness.eventsOfType("auth_stale")).toEqual([
				{ type: "auth_stale", provider: "openai", sourceTokens: sources },
			]);
			await expect(harness.authStorage.getApiKey("openai")).resolves.toBe("fresh-key");
			expect(markSource).toHaveBeenCalledExactlyOnceWith(sources[0]);
			expect(harness.session.isRetrying).toBe(false);
			expect(harness.session.agent.state.isStreaming).toBe(false);
			expect(harness.session.agent.state.pendingToolCalls.size).toBe(0);
		} finally {
			responseReady.resolve();
			release.resolve();
			await Promise.allSettled([prompt, abort].filter((value) => value !== undefined));
			unsubscribe();
		}
	});
});
