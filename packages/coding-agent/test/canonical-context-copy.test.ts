import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, type Model, registerFauxProvider } from "@ponythewhite/base-context-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import {
	getCanonicalEpochContext,
	getCanonicalViewUnits,
	prepareCanonicalEpoch,
} from "../src/core/canonical-context.js";
import { appendContextEpoch, readContextEpoch } from "../src/core/context-epoch.js";
import { convertToLlm } from "../src/core/messages.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { type CompiledTaskFrame, compileTaskFrame, taskFrameLimits } from "../src/core/task-frame.js";
import {
	compileCopyContext,
	contextLimits,
	copiedVisibleMessages,
	createTaskEpochFixture,
	frameText,
	isTaskFrame,
} from "./canonical-context-fixtures.js";

async function createCopySession(manager: SessionManager, model: Model<string>) {
	return createAgentSession({
		cwd: manager.getCwd(),
		agentDir: join(manager.getSessionDir(), "agent"),
		sessionManager: manager,
		model,
		authStorage: AuthStorage.inMemory({ [model.provider]: { type: "api_key", key: "local-faux-copy" } }),
		settingsManager: SettingsManager.inMemory({
			canonicalContext: { maxMessages: 256, maxSourceBytes: 2 * 1024 * 1024 },
			compaction: { enabled: false },
		}),
		tools: [],
		includeGoals: false,
		prewarmIpythonKernel: false,
	});
}

async function appendCopySummary(manager: SessionManager, aggregate: AssistantMessage["usage"]) {
	const summarySink = manager.bindCompactionSink();
	const summary = {
		summary: "Keep the selected file context.",
		details: { fixtureSummary: "copied verbatim" },
		fromHook: true,
		customInstructions: "Preserve case-sensitive file names.",
		usage: aggregate,
	};
	try {
		const input = await compileCopyContext(manager);
		const recipe = prepareCanonicalEpoch(
			input,
			getCanonicalViewUnits(input)!.map((unit) => unit.id),
			"fixture-native-template/1",
			contextLimits.maxSourceBytes,
		).checkpoint;
		await summarySink[appendContextEpoch]({ ...recipe, representation: null, includeSummary: true }, 100, summary);
		return summary;
	} finally {
		await summarySink.release();
	}
}

describe("canonical epoch copies", () => {
	let dir: string;
	let manager: SessionManager;
	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "base-context-epoch-copy-"));
		manager = await SessionManager.create(dir, dir);
	});
	afterEach(async () => {
		try {
			await manager.close();
		} finally {
			vi.restoreAllMocks();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not treat a copied opaque profile as permission to send", async () => {
		const { prepared } = await createTaskEpochFixture(manager);
		const sessionFile = manager.getSessionFile()!;
		// Explicit copies rebuild recipes; a copied fixture profile is not a provider certificate.
		const opaqueCopy = await SessionManager.forkFrom(sessionFile, dir, join(dir, "opaque-copy"));
		const faux = registerFauxProvider({ api: "faux-copy-epoch", provider: "faux-copy-epoch", tokensPerSecond: 0 });
		try {
			const opaqueContext = await compileCopyContext(opaqueCopy);
			expect(convertToLlm(opaqueContext.filter((message) => !isTaskFrame(message)))).toEqual(
				convertToLlm(prepared.messages.filter((message) => !isTaskFrame(message))),
			);
			expect(getCanonicalEpochContext(opaqueContext)!.checkpoint!.representation).toBe("fixture-native-template/1");
			const { session: refused } = await createCopySession(opaqueCopy, {
				...faux.getModel(),
				api: "openai-responses",
				provider: "openai",
				id: "offline-copy-profile",
				baseUrl: "https://example.invalid/v1",
			});
			const fetch = vi
				.spyOn(globalThis, "fetch")
				.mockRejectedValue(new Error("Copied profile must refuse before send"));
			try {
				const refusal = await refused.agent.continue().then(
					() => undefined,
					(error: unknown) => error,
				);
				expect(refusal ?? refused.agent.state.errorMessage).toBeTruthy();
				expect(faux.state.callCount).toBe(0);
				expect(fetch).not.toHaveBeenCalled();
			} finally {
				try {
					await refused.disposeAsync({ kernelSnapshot: false });
				} finally {
					fetch.mockRestore();
				}
			}
		} finally {
			faux.unregister();
			await opaqueCopy.close();
		}
	});

	it.each([false, true])("rebuilds copy recipes and source attribution (retained=%s)", async (retained) => {
		const { aggregate, goalEntryId, laterInputId, proposalEntryId, secondFrames } =
			await createTaskEpochFixture(manager);
		const reopened = manager;
		const sessionFile = manager.getSessionFile()!;
		const summary = await appendCopySummary(manager, aggregate);
		const selected = await compileCopyContext(reopened);
		const summaryEntryId = reopened.getLeafId()!;
		const { usage: summaryUsage, ...summaryOptions } = summary;
		const copiedEntries = await reopened.readEntries();
		const destination = retained
			? await SessionManager.importRetainedFrom(sessionFile, dir, join(dir, "retained-copy"))
			: await SessionManager.forkFrom(sessionFile, dir, join(dir, "native-copy"));
		try {
			// The copied records retain IDs, parent relations, and literal bodies, including side metadata.
			expect((await destination.readEntries()).slice(0, copiedEntries.length)).toEqual(copiedEntries);
			const copied = await compileCopyContext(destination);
			expect(copiedVisibleMessages(copied.filter((message) => !isTaskFrame(message)))).toEqual(
				copiedVisibleMessages(selected.filter((message) => !isTaskFrame(message))),
			);
			const copiedEpoch = getCanonicalEpochContext(copied)!.checkpoint!;
			expect(copiedEpoch.source).toMatchObject({
				sessionId: destination.getSessionId(),
				sessionFile: destination.getSessionFile(),
				persistent: true,
			});
			expect(copiedEpoch.source.sessionId).not.toBe(reopened.getSessionId());
			expect(copiedEpoch).toMatchObject({ representation: null, includeSummary: true });
			expect(copiedEpoch.replayContract).toBe(retained ? undefined : "complete-context");
			for (const reference of copiedEpoch.views) {
				expect(reference.source.sessionId).toBe(destination.getSessionId());
				expect(reference.source.sessionFile).toBe(destination.getSessionFile());
				expect(reference.ref.locator.path).toBe(destination.getSessionFile());
			}
			const copiedControl = await destination.readEntry(destination.getLeafId()!);
			if (copiedControl?.type !== "compaction") throw new Error("Expected a destination epoch control");
			expect(copiedControl).toMatchObject({ ...summaryOptions, tokensBefore: 100 });
			expect(copiedControl.usage).toBeUndefined();
			expect(await destination.readEntry(summaryEntryId)).toMatchObject({
				...summary,
				usage: summaryUsage,
			});
			const origins = await destination.readBranchHistory(async (history) => ({
				goal: await history.get(goalEntryId),
				input: await history.get(laterInputId),
				proposal: await history.get(proposalEntryId),
				epoch: await history.get(destination.getLeafId()!),
			}));
			expect(origins.epoch).toMatchObject({ qualification: "native-context-epoch" });
			expect(origins.epoch!.retention).not.toBe("retained-import");
			expect(origins.proposal!.qualification).toBeUndefined();
			expect(origins.proposal!.retention).toBe(retained ? "retained-import" : undefined);
			for (const origin of [origins.goal, origins.input]) {
				expect(origin).toMatchObject({ qualification: "native-admission" });
				expect(origin!.retention).toBe(retained ? "retained-import" : undefined);
			}
			const tasks = await destination.readTaskState();
			expect(copiedEpoch.taskFrame?.material).toBe(compileTaskFrame(tasks, taskFrameLimits())?.material);
			// Lowering can leave no eligible task rows, so the destination reducer may omit the frame.
			if (copiedEpoch.taskFrame) {
				expect(
					copiedEpoch.taskFrame.origins.every((origin) => origin.sessionId === destination.getSessionId()),
				).toBe(true);
				expect(copiedEpoch.taskFrame.rows.every((row) => row.source.sessionId === destination.getSessionId())).toBe(
					true,
				);
				expect(copiedEpoch.taskFrame.messages.map(frameText).join("\n")).not.toContain(
					destination.getSessionFile()!,
				);
			}
			if (retained) {
				expect(tasks.items.some((item) => item.event.authority === "user")).toBe(false);
				expect(copied.filter(isTaskFrame).map(frameText)).not.toEqual(secondFrames.map(frameText));
			} else {
				expect(tasks.items.find((item) => item.event.source.entryId === laterInputId)?.event.authority).toBe(
					"user",
				);
			}
		} finally {
			await destination.close();
		}
	});

	it.each([false, true])("ACKs copied context before the native transport runs (retained=%s)", async (retained) => {
		const { aggregate, assistant } = await createTaskEpochFixture(manager);
		const sessionFile = manager.getSessionFile()!;
		await appendCopySummary(manager, aggregate);
		const destination = retained
			? await SessionManager.importRetainedFrom(sessionFile, dir, join(dir, "retained-copy"))
			: await SessionManager.forkFrom(sessionFile, dir, join(dir, "native-copy"));
		try {
			const copied = await compileCopyContext(destination);
			const copiedEpoch = getCanonicalEpochContext(copied)!.checkpoint!;
			const copiedControl = await destination.readEntry(destination.getLeafId()!);
			if (copiedControl?.type !== "compaction") throw new Error("Expected a destination epoch control");
			// A null summary is still managed: the real native projection must ACK before send.
			const nativeModel: Model<"openai-responses"> = {
				id: assistant.model,
				name: "Copied source model",
				api: "openai-responses",
				provider: assistant.provider,
				baseUrl: "https://example.invalid/v1",
				reasoning: false,
				input: ["text"],
				contextWindow: 300_000,
				maxTokens: 16,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			};
			const services = await createAgentSessionServices({
				cwd: destination.getCwd(),
				agentDir: join(destination.getSessionDir(), "native-agent"),
				authStorage: AuthStorage.inMemory(),
				settingsManager: SettingsManager.inMemory({
					canonicalContext: { maxMessages: 256, maxSourceBytes: 2 * 1024 * 1024 },
					compaction: { enabled: false },
					autoRefine: { enabled: false },
					retry: { enabled: false },
				}),
				resourceLoaderOptions: { noExtensions: true, noPromptTemplates: true, noThemes: true },
			});
			services.modelRegistry.registerProvider(nativeModel.provider, {
				baseUrl: nativeModel.baseUrl,
				apiKey: "offline-copy-key",
				api: nativeModel.api,
				models: [
					{
						id: nativeModel.id,
						name: nativeModel.name,
						api: nativeModel.api,
						reasoning: nativeModel.reasoning,
						input: nativeModel.input,
						contextWindow: nativeModel.contextWindow,
						maxTokens: nativeModel.maxTokens,
						cost: nativeModel.cost,
					},
				],
			});
			let nativeSession: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
			let sentBody: string | undefined;
			const nativeFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
				let acceptedFrame: CompiledTaskFrame | undefined;
				// This runs at the genuine native transport boundary, after the destination's canonical ACK.
				await destination.readBranchHistory(async (history) => {
					const manifest = await history.branchContext.contextManifest({ limit: 1 });
					if (manifest.selection !== "known" || !manifest.summaryRef)
						throw new Error("Expected measured destination epoch");
					const finalized = await history.hydrateEntry(manifest.summaryRef.entryId, 2 * 1024 * 1024);
					if (finalized?.entry.type !== "compaction")
						throw new Error("Expected canonical epoch before native send");
					expect(finalized.source).toMatchObject({ qualification: "native-context-epoch" });
					expect(finalized.source.retention).toBeUndefined();
					const measured = readContextEpoch(finalized.entry.details, 2 * 1024 * 1024);
					acceptedFrame = measured?.taskFrame;
					if (finalized.source.id === copiedControl.id) {
						// An unchanged full view may reuse its prior ACK; copying still supplies no profile claim.
						expect(measured).toEqual(copiedEpoch);
					} else {
						expect(typeof measured?.representation).toBe("string");
						expect(measured?.representation).not.toBe("");
					}
					expect(measured?.source).toMatchObject({
						sessionId: destination.getSessionId(),
						sessionFile: destination.getSessionFile(),
						persistent: true,
					});
					expect(measured!.source.sourceSequence).toBeLessThan(finalized.source.sequence);
					for (const reference of measured!.views) {
						expect(reference.source.sessionFile).toBe(destination.getSessionFile());
						expect(reference.ref.locator.path).toBe(destination.getSessionFile());
					}
				});
				if (typeof init?.body !== "string") throw new Error("Expected exact native Responses body");
				sentBody = init.body;
				expect(JSON.parse(sentBody).model).toBe(assistant.model);
				// A copied frame may shed now-literal input at this ACK. Assert the actual accepted frame, not its uncommitted candidate metadata.
				for (const message of convertToLlm([
					...copied.filter((message) => !isTaskFrame(message)),
					...(acceptedFrame?.messages ?? []),
				])) {
					const text =
						typeof message.content === "string"
							? [message.content]
							: message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
					for (const part of text) expect(sentBody).toContain(JSON.stringify(part).slice(1, -1));
				}
				const item = {
					type: "message",
					id: "msg_copy_reply",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Copied context OK.", annotations: [] }],
				};
				const sse = [
					{
						type: "response.output_item.added",
						output_index: 0,
						item: { ...item, status: "in_progress", content: [] },
					},
					{ type: "response.output_item.done", output_index: 0, item },
					{
						type: "response.completed",
						response: {
							id: "resp_copy_reply",
							model: nativeModel.id,
							status: "completed",
							usage: {
								input_tokens: 10,
								output_tokens: 1,
								total_tokens: 11,
								input_tokens_details: { cached_tokens: 0 },
							},
						},
					},
				]
					.map((event) => `data: ${JSON.stringify(event)}\n\n`)
					.join("");
				return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
			});
			try {
				({ session: nativeSession } = await createAgentSessionFromServices({
					services,
					sessionManager: destination,
					model: nativeModel,
					tools: [],
					noTools: "all",
					includeGoals: false,
					includeCompactSkill: false,
					prewarmIpythonKernel: false,
					requestTokenBudget: {
						mode: "enforce",
						profiles: [
							{
								id: "offline-copy-epoch",
								revision: "1",
								api: nativeModel.api,
								provider: nativeModel.provider,
								url: "https://example.invalid/v1/responses",
								model: nativeModel.id,
								authMode: "fixture-api-key",
								templateRevision: "responses-text-v1",
								replayFamily: "responses-text-v1",
								contextTokens: 300_000,
								outputCeilingTokens: 16,
								estimate: { tokensPerUtf8Byte: 1, templateTokens: 8, marginTokens: 16 },
							},
						],
					},
				}));
				await nativeSession.agent.continue();
				expect(nativeFetch).toHaveBeenCalledOnce();
				expect(sentBody).toBeDefined();
				expect(nativeSession.agent.state.errorMessage).toBeUndefined();
				expect(nativeSession.messages.at(-1)).toMatchObject({
					role: "assistant",
					content: [expect.objectContaining({ type: "text", text: "Copied context OK." })],
				});
			} finally {
				try {
					await nativeSession?.disposeAsync({ kernelSnapshot: false });
				} finally {
					nativeFetch.mockRestore();
				}
			}
		} finally {
			await destination.close();
		}
	});
});
