import { getModel } from "@ponythewhite/base-context-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as canonicalContext from "../src/core/canonical-context.js";
import { appendContextEpoch } from "../src/core/context-epoch.js";
import { SessionManager } from "../src/core/session-manager.js";
import { createHarness, type Harness } from "./suite/harness.js";
import { createDeferred } from "./suite/scheduling.js";

describe("MAIN epoch cancellation boundary", () => {
	let harness: Harness | undefined;

	afterEach(async () => {
		vi.restoreAllMocks();
		await harness?.cleanup();
		harness = undefined;
	});

	it.each(["before submission", "after ACK"] as const)(
		"honors cancellation %s",
		async (boundary) => {
			// Faux dispatch omits physical-attempt preparation. Exercise the built-in serializer
			// locally; cancellation must prevent HTTP dispatch in both cases.
			const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected HTTP dispatch"));
			const model = { ...getModel("deepseek", "deepseek-flash"), maxTokens: 16_384 };
			harness = await createHarness({
				persistSession: true,
				settings: { compaction: { enabled: false }, autoRefine: { enabled: false }, retry: { enabled: false } },
				requestTokenBudget: {
					mode: "enforce",
					profiles: [
						{
							id: "offline-epoch-cancellation",
							revision: "1",
							api: model.api,
							provider: model.provider,
							url: "https://api.deepseek.com/chat/completions",
							model: model.id,
							authMode: "fixture-api-key",
							templateRevision: "deepseek-text-tools-fixture-v1",
							replayFamily: "deepseek-completions",
							contextTokens: 120000,
							outputCeilingTokens: model.maxTokens,
							estimate: { tokensPerUtf8Byte: 1, templateTokens: 0, marginTokens: 32 },
						},
					],
				},
			});
			const { session, sessionManager } = harness;
			session.modelRegistry.registerProvider(model.provider, {
				api: model.api,
				baseUrl: model.baseUrl,
				apiKey: "offline-epoch-fixture-key",
				models: [model],
			});
			harness.authStorage.setRuntimeApiKey(model.provider, "offline-epoch-fixture-key");
			await session.setModel(model);
			await session.setThinkingLevel("low");
			session.setActiveToolsByName(["prime_context"]);

			const reached = createDeferred();
			const release = createDeferred();
			const prepare = vi.spyOn(canonicalContext, "prepareCanonicalEpoch");
			const adopted = vi.spyOn(session.agent.state, "messages", "set");
			const bind = SessionManager.prototype.bindCompactionSink;
			let acknowledged: string | undefined;
			vi.spyOn(sessionManager, "bindCompactionSink").mockImplementation(function (this: SessionManager, ...args) {
				const sink = bind.apply(this, args);
				const append = sink[appendContextEpoch];
				sink[appendContextEpoch] = async (...params) => {
					if (boundary === "before submission") {
						reached.resolve();
						await release.promise;
					}
					const entryId = await append(...params);
					acknowledged = entryId;
					if (boundary === "after ACK") {
						reached.resolve();
						await release.promise;
					}
					return entryId;
				};
				return sink;
			});

			const prompt = session.prompt("Retain this task when the request is cancelled.");
			const outcome = prompt.catch((error: unknown) => error);
			try {
				await reached.promise;
				const prepared = prepare.mock.results.at(-1)?.value as ReturnType<
					typeof canonicalContext.prepareCanonicalEpoch
				>;
				expect(prepared).toBeDefined();
				const callsBeforeAbort = adopted.mock.calls.length;
				session.requestAbort();
				release.resolve();
				await outcome;
				await session.waitForIdle();
				const entries = await sessionManager.readEntries();
				const epochs = entries.filter((entry) => entry.type === "compaction");
				expect(fetch).not.toHaveBeenCalled();
				if (boundary === "before submission") {
					expect(acknowledged).toBeUndefined();
					expect(epochs).toHaveLength(0);
					expect(adopted.mock.calls.slice(callsBeforeAbort)).toHaveLength(0);
				} else {
					expect(epochs.map((entry) => entry.id)).toEqual([acknowledged]);
					expect(adopted.mock.calls.slice(callsBeforeAbort)).toContainEqual([prepared.messages]);
				}
			} finally {
				release.resolve();
				session.requestAbort();
				await outcome;
			}
		},
		15_000,
	);
});
