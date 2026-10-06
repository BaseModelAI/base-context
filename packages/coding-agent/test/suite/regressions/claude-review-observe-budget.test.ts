import { getModel, RequestTokenBudgetError, type RequestTokenBudgetOptions } from "@ponythewhite/base-context-ai";
import { expect, it, vi } from "vitest";
import { readContextEpoch } from "../../../src/core/context-epoch.js";
import { SessionManager } from "../../../src/core/session-manager.js";
import { createHarness } from "../harness.js";

it.each([
	{ mode: "observe", restored: "active" },
	{ mode: "enforce", restored: "active" },
	{ mode: "observe", restored: "removed" },
	{ mode: "observe", restored: "disabled" },
] as const)("preserves $mode policy after a fitting epoch (restored=$restored)", async ({ mode, restored }) => {
	const model = { ...getModel("deepseek", "deepseek-flash"), maxTokens: 16 };
	const requestTokenBudget: RequestTokenBudgetOptions = {
		mode,
		profiles: [
			{
				id: "offline-observe",
				revision: "1",
				api: model.api,
				provider: model.provider,
				url: "https://api.deepseek.com/chat/completions",
				model: model.id,
				authMode: "fixture-api-key",
				templateRevision: "deepseek-text-tools-v1",
				replayFamily: "deepseek-completions",
				contextTokens: 120000,
				outputCeilingTokens: 16,
				estimate: { tokensPerUtf8Byte: 1, templateTokens: 0, marginTokens: 32 },
			},
		],
	};
	let harness = await createHarness({
		persistSession: true,
		settings: { compaction: { enabled: false }, autoRefine: { enabled: false }, retry: { enabled: false } },
		requestTokenBudget,
	});
	const original = harness;
	const bodies: string[] = [];
	const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
		expect(String(url)).toBe(requestTokenBudget.profiles[0].url);
		bodies.push(String(init?.body));
		return new Response(
			`data: ${JSON.stringify({
				id: `reply-${bodies.length}`,
				object: "chat.completion.chunk",
				created: 1,
				model: model.id,
				choices: [{ index: 0, delta: { role: "assistant", content: "Done." }, finish_reason: "stop" }],
				usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
			})}\n\ndata: [DONE]\n\n`,
			{ headers: { "content-type": "text/event-stream" } },
		);
	});
	const configure = async () => {
		harness.session.modelRegistry.registerProvider(model.provider, {
			api: model.api,
			baseUrl: model.baseUrl,
			apiKey: "offline-key",
			models: [model],
		});
		harness.authStorage.setRuntimeApiKey(model.provider, "offline-key");
		await harness.session.setModel(model);
		await harness.session.setThinkingLevel("low");
		harness.session.setActiveToolsByName([]);
	};
	try {
		await configure();
		await harness.session.prompt("Reply briefly.");
		expect(bodies).toHaveLength(1);
		const entries = await harness.sessionManager.readEntries();
		expect(
			entries.some((entry) => entry.type === "compaction" && readContextEpoch(entry.details, 2 * 1024 * 1024)),
		).toBe(true);
		if (restored !== "active") {
			const file = harness.session.sessionFile!;
			await harness.session.disposeAsync();
			await harness.sessionManager.close();
			harness = await createHarness({
				sessionManager: await SessionManager.open(file),
				cwd: original.tempDir,
				settings: {
					compaction: { enabled: false },
					autoRefine: { enabled: false },
					retry: { enabled: false },
					...(restored === "removed" ? { requestTokenBudget: { mode: "observe", profiles: [] } } : {}),
				},
			});
			await configure();
		}
		const text = restored === "active" ? "Keep this entire instruction. ".repeat(6000) : "Continue after reopening.";
		const next = harness.session.prompt(text);
		if (mode === "enforce") {
			await expect(next).rejects.toBeInstanceOf(RequestTokenBudgetError);
			expect(bodies).toHaveLength(1);
		} else {
			await next;
			expect(bodies).toHaveLength(2);
			expect(bodies[1]).toContain(text);
			const admitted = (await harness.sessionManager.readEntries())
				.filter((entry) => entry.type === "request" && entry.request.type === "attempt_admitted")
				.at(-1);
			expect(admitted).toMatchObject({
				request: {
					contextEpoch: { sessionId: harness.session.sessionId },
					...(restored === "disabled"
						? {}
						: { descriptor: { requestBudget: { status: restored === "removed" ? "unknown" : "over-budget" } } }),
				},
			});
		}
	} finally {
		fetch.mockRestore();
		if (harness !== original) await harness.cleanup();
		await original.cleanup();
	}
});
