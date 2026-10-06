import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@ponythewhite/base-context-agent";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	type Model,
	type ProviderRequestProjection,
	type ProviderRequestRepresentation,
	RequestTokenBudget,
} from "@ponythewhite/base-context-ai";
import { expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import {
	CanonicalContextCompiler,
	getCanonicalEpochContext,
	getCanonicalMessageSource,
	getCanonicalViewUnits,
	prepareCanonicalEpoch,
	prepareContextModeEpoch,
	preparePublicContextWindow,
	prepareRecoveryCompaction,
} from "../src/core/canonical-context.js";
import { prepareViewCompaction } from "../src/core/compaction/index.js";
import { appendContextEpoch } from "../src/core/context-epoch.js";
import { HistoryIndex } from "../src/core/history-index.js";
import { InferenceCoordinator } from "../src/core/inference-coordinator.js";
import { convertToLlm } from "../src/core/messages.js";
import {
	captureRequestViewBoundary,
	matchesRequestView,
	type RequestViewCandidate,
	selectRequestView,
} from "../src/core/request-view-selection.js";
import { createAgentSession } from "../src/core/sdk.js";
import { recoverCapturedHistory } from "../src/core/selective-recovery.js";
import { bindNativeEntryWriter } from "../src/core/session-entry-origin.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { appendPagedContext, compileCopyContext } from "./canonical-context-fixtures.js";

async function _createCopySession(manager: SessionManager, model: Model<string>) {
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

it("maps provider projection indices around refinement UI barriers without reordering tool results", async () => {
	const dir = mkdtempSync(join(tmpdir(), "base-context-ui-projection-"));
	const manager = await SessionManager.create(dir, dir);
	try {
		await manager.appendMessage({ role: "user", content: "Keep tool order", timestamp: 0 });
		const assistant = {
			...fauxAssistantMessage("Earlier answer"),
			api: "openai-completions" as const,
			provider: "deepseek",
			model: "deepseek-flash",
		};
		await manager.appendCustomMessageEntry("refinement_outcome", "UI before tools", true, {});
		await manager.appendMessage(assistant);
		await manager.appendMessage({
			...assistant,
			stopReason: "toolUse",
			content: [
				{ type: "toolCall", id: "a", name: "fixture", arguments: {} },
				{ type: "toolCall", id: "b", name: "fixture", arguments: {} },
			],
		});
		const result = (id: string): Extract<AgentMessage, { role: "toolResult" }> => ({
			role: "toolResult",
			toolCallId: id,
			toolName: "fixture",
			content: [{ type: "text", text: id }],
			isError: false,
			timestamp: 1,
		});
		await manager.appendMessage(result("b"));
		await manager.appendCustomMessageEntry("refinement_outcome", "UI ordering barrier", true, {});
		await manager.appendMessage(result("a"));
		const messages = await compileCopyContext(manager);
		const llm = convertToLlm(messages);
		const commits: RequestViewCandidate[] = [];
		const boundary = captureRequestViewBoundary(messages, async (candidate) => {
			commits.push(candidate);
		});
		expect(matchesRequestView(boundary, boundary.source, { messages: llm })).toBe(true);
		expect(messages).toHaveLength(llm.length + 2);
		const toolIndices = messages.flatMap((message, index) => (message.role === "toolResult" ? [index] : []));
		expect(toolIndices.map((index) => (messages[index] as { toolCallId: string }).toolCallId)).toEqual(["b", "a"]);
		expect(messages[toolIndices[0] + 1]).toMatchObject({ role: "custom", customType: "refinement_outcome" });
		const canonicalGroup = messages.flatMap((message, index) =>
			message.role === "toolResult" || (message.role === "assistant" && message.stopReason === "toolUse")
				? [index]
				: [],
		);
		const providerGroup = canonicalGroup.map((index) => boundary.providerMessageIndices.indexOf(index));
		const plainIndex = llm.findIndex((message) => message.role === "assistant" && message.stopReason === "stop");
		const request: ProviderRequestRepresentation = {
			api: "openai-completions",
			provider: "deepseek",
			url: "https://api.deepseek.com/chat/completions",
			body: JSON.stringify({
				model: "deepseek-flash",
				max_tokens: 16,
				messages: [
					{ role: "system", content: "fixture" },
					...llm.map((message) => ({
						role: message.role === "toolResult" ? "tool" : message.role,
						content: "fixture",
					})),
				],
			}),
		};
		const encoder = vi.fn((_replacements: readonly { messageIndex: number; text: string }[]) => ({
			request,
			projection: { ...projection, encodePublicWindow: undefined },
		}));
		const projection: ProviderRequestProjection = {
			kind: "deepseek-completions-text-tools-v1",
			replayContract: "message-groups",
			publicWindow: true,
			messageIndices: [null, ...llm.map((_, index) => index)],
			optionalMessageIndices: [plainIndex],
			generatedMessageIndices: [plainIndex],
			publicMessageGroups: [providerGroup],
			encodePublicWindow: encoder,
		};
		const budget = new RequestTokenBudget({
			mode: "enforce",
			profiles: [
				{
					id: "ui-projection",
					revision: "1",
					api: "openai-completions",
					provider: "deepseek",
					url: request.url,
					model: "deepseek-flash",
					authMode: "fixture",
					templateRevision: "1",
					replayFamily: "fixture",
					contextTokens: 100000,
					outputCeilingTokens: 16,
					estimate: { tokensPerUtf8Byte: 1, templateTokens: 0, marginTokens: 0 },
				},
			],
		});
		expect(await selectRequestView(boundary, request, projection, budget, true)).toBe(request.body);
		expect(commits).toHaveLength(1);
		expect(commits[0].selectedUnitIds).toEqual(boundary.units.map((unit) => unit.id));
		expect(commits[0].projection.messageIndices).toEqual([null, ...boundary.providerMessageIndices]);
		expect(commits[0].projection.publicMessageGroups).toEqual([canonicalGroup]);
		expect(commits[0].projection.generatedMessageIndices).toEqual([boundary.providerMessageIndices[plainIndex]]);
		expect(commits[0].projection.optionalMessageIndices).toEqual([boundary.providerMessageIndices[plainIndex]]);
		const encoded = commits[0].projection.encodePublicWindow!(
			canonicalGroup.map((messageIndex) => ({ messageIndex, text: "public" })),
		)!;
		expect(encoder).toHaveBeenCalledWith(providerGroup.map((messageIndex) => ({ messageIndex, text: "public" })));
		expect(encoded.projection.publicMessageGroups).toEqual([canonicalGroup]);
		expect(encoded.projection.messageIndices).toEqual([null, ...boundary.providerMessageIndices]);
	} finally {
		await manager.flushNow();
		rmSync(dir, { recursive: true, force: true });
	}
});

it("reconstructs the whole retained context across pages and caches immutable source entries", async () => {
	const dir = mkdtempSync(join(tmpdir(), "base-context-compile-"));
	const manager = await SessionManager.create(dir, dir);
	const requests = new InferenceCoordinator(() => manager.bindRequestSink());
	let capture: InferenceCoordinator | undefined;
	try {
		const { assistantId, aggregate, expected, sentMessage } = await appendPagedContext(manager);
		capture = requests.capture();
		const compiler = new CanonicalContextCompiler();
		const reads = vi.spyOn(HistoryIndex.prototype, "readPayload");
		const relatedReads = vi.spyOn(HistoryIndex.prototype, "readContextUpdatePayload");
		const limits = { maxMessages: 130, maxSourceBytes: 2 * 1024 * 1024 };
		const first = await capture.readHistory((view) => compiler.compile(view, limits));
		const compiledAssistant = first.find((message) => message.role === "assistant");
		if (!compiledAssistant) throw new Error("fixture expected an assistant");
		const source = getCanonicalMessageSource(compiledAssistant);
		const expectedSource = {
			sessionId: manager.getSessionId(),
			sessionFile: manager.getSessionFile(),
			entryId: assistantId,
		};
		expect(source).toEqual(expectedSource);
		expect(getCanonicalMessageSource(structuredClone(compiledAssistant))).toBeUndefined();
		Object.assign(source!, { entryId: "caller-modified" });
		expect(getCanonicalMessageSource(compiledAssistant)).toEqual(expectedSource);
		expect(first).toEqual(expected);
		expect(first[0]).toMatchObject({ role: "compactionSummary", retainedMessageCount: 128 });
		expect(
			first.slice(-2).map((message) => (message.role === "toolResult" ? message.toolCallId : "wrong role")),
		).toEqual(["a", "b"]);
		expect(first).toHaveLength(130);
		const units = getCanonicalViewUnits(first)!;
		expect(units).toHaveLength(130);
		expect(units.find((unit) => unit.exactSources.includes(assistantId))).toMatchObject({
			kind: "replay-group",
			authority: "assistant-public",
			tokenEstimate: null,
		});
		expect(units[1].authority).toBe("unrecorded");
		const firstRevision = units[0].sourceRevision;
		Object.assign(units[0], { sourceRevision: "caller-modified" });
		expect(getCanonicalViewUnits(first)![0].sourceRevision).toBe(firstRevision);
		expect(getCanonicalViewUnits(structuredClone(first))).toBeUndefined();
		expect(first.find((message) => message.role === "assistant")).toMatchObject({ usage: aggregate });
		expect(first.find((message) => message.role === "toolResult" && message.toolCallId === "a")).toMatchObject({
			details: { sentAgentMessages: [sentMessage] },
		});
		const readCount = reads.mock.calls.length;
		const relatedCount = relatedReads.mock.calls.length;
		expect(relatedCount).toBe(3);
		const user = first.find((message) => message.role === "user");
		if (user?.role !== "user") throw new Error("fixture expected retained user input");
		user.content = "changed by a replaceable transform";
		const second = await capture.readHistory((view) => compiler.compile(view, limits));
		expect(getCanonicalMessageSource(second.find((message) => message.role === "assistant")!)).toEqual(
			expectedSource,
		);
		expect(second).toEqual(expected);
		expect(reads).toHaveBeenCalledTimes(readCount);
		expect(relatedReads).toHaveBeenCalledTimes(relatedCount);
	} finally {
		try {
			await capture?.dispose();
			await manager.close();
		} finally {
			vi.restoreAllMocks();
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

it("retains the legal chronological suffix after view compaction", async () => {
	const dir = mkdtempSync(join(tmpdir(), "base-context-compaction-suffix-"));
	const manager = await SessionManager.create(dir, dir);
	try {
		const ids: string[] = [];
		for (const text of ["older", "current", "latest"]) {
			ids.push(await manager.appendMessage({ role: "user", content: text.repeat(1500), timestamp: ids.length }));
		}
		const input = await compileCopyContext(manager);
		const context = getCanonicalEpochContext(input)!;
		const preparation = prepareViewCompaction(
			input,
			context.references.map((ref) => ref?.ref.entryId),
			await manager.readBranch(),
			{ enabled: true, reserveTokens: 64, keepRecentTokens: 3000 },
		)!;
		expect(preparation.firstKeptEntryId).toBe(ids[1]);
		await manager.appendCompaction("Older work summarized", preparation.firstKeptEntryId, preparation.tokensBefore);

		const rebuilt = await compileCopyContext(manager);
		expect(rebuilt.filter((message) => message.role !== "compactionSummary")).toEqual(input.slice(1));
		expect(rebuilt[0]).toMatchObject({ role: "compactionSummary", summary: "Older work summarized" });
	} finally {
		await manager.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

it("summarizes older recovery without resurrecting omitted messages and keeps its source recoverable", async () => {
	const dir = mkdtempSync(join(tmpdir(), "base-context-compaction-sparse-"));
	let manager = await SessionManager.create(dir, dir);
	const maxBytes = 2 * 1024 * 1024;
	try {
		await manager.appendMessage({ role: "user", content: "Earlier task", timestamp: 0 });
		const assistant: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "openai",
			model: "fixture",
			content: [{ type: "toolCall", id: "recovery-call", name: "prime_context", arguments: { action: "read" } }],
			stopReason: "toolUse",
			timestamp: 1,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		const recoveryCallId = await manager.appendMessage(assistant);
		const recoveryResultId = await manager[bindNativeEntryWriter]().captureRecoveryExchange("pinned-recovery")({
			executionId: "pinned-recovery",
			sourceOrder: 0,
			toolCallId: "recovery-call",
			toolName: "prime_context",
			originalInput: { action: "read" },
			executedInput: { action: "read" },
			toolExecution: "sequential",
			executionOutcome: "completed",
			cancellationRequested: false,
			result: {
				role: "toolResult",
				toolCallId: "recovery-call",
				toolName: "prime_context",
				content: [{ type: "text", text: "Older recovered evidence ".repeat(2500) }],
				isError: false,
				timestamp: 2,
			},
		});
		const omittedUserId = await manager.appendMessage({ role: "user", content: "Omitted request", timestamp: 3 });
		const omittedAssistantId = await manager.appendMessage({
			...assistant,
			content: [{ type: "text", text: "Omitted answer" }],
			stopReason: "stop",
			timestamp: 4,
		});
		const currentUserId = await manager.appendMessage({ role: "user", content: "Current task", timestamp: 5 });
		const currentAssistantId = await manager.appendMessage({
			...assistant,
			content: [
				{ type: "toolCall", id: "current-recovery-call", name: "prime_context", arguments: { action: "read" } },
			],
			timestamp: 6,
		});
		const currentResultId = await manager[bindNativeEntryWriter]().captureRecoveryExchange("current-recovery")({
			executionId: "current-recovery",
			sourceOrder: 0,
			toolCallId: "current-recovery-call",
			toolName: "prime_context",
			originalInput: { action: "read" },
			executedInput: { action: "read" },
			toolExecution: "sequential",
			executionOutcome: "completed",
			cancellationRequested: false,
			result: {
				role: "toolResult",
				toolCallId: "current-recovery-call",
				toolName: "prime_context",
				content: [{ type: "text", text: "Current recovery evidence" }],
				isError: false,
				timestamp: 7,
			},
		});
		await manager.appendCompaction("Earlier work summarized", recoveryCallId, 100);
		const publicInput = preparePublicContextWindow(await compileCopyContext(manager))!.messages;
		const omitted = new Set([omittedUserId, omittedAssistantId]);
		const selected = prepareCanonicalEpoch(
			publicInput,
			getCanonicalViewUnits(publicInput)!
				.filter((unit) => !unit.exactSources.some((id) => omitted.has(id)))
				.map((unit) => unit.id),
			"fixture-native-template/1",
			maxBytes,
			"message-groups",
			true,
		);
		const selectionSink = manager.bindCompactionSink();
		try {
			await selectionSink[appendContextEpoch](selected.checkpoint, 100);
		} finally {
			await selectionSink.release();
		}

		const captured = await compileCopyContext(manager);
		const sourceIds = (messages: AgentMessage[]) =>
			getCanonicalEpochContext(messages)!.references.flatMap((ref, index) =>
				ref && messages[index].role !== "compactionSummary" ? [ref.ref.entryId] : [],
			);
		expect(sourceIds(captured)).toEqual([
			recoveryCallId,
			recoveryResultId,
			currentUserId,
			currentAssistantId,
			currentResultId,
		]);
		expect(getCanonicalViewUnits(captured)!.find((unit) => unit.kind === "recovery")!.exactSources).toContain(
			recoveryResultId,
		);
		const references = getCanonicalEpochContext(captured)!.references;
		const callIndex = references.findIndex((ref) => ref?.ref.entryId === recoveryCallId);
		const pathEntries = await manager.readBranch();
		expect(pathEntries.find((entry) => entry.id === recoveryResultId)).toMatchObject({
			execution: { originalInput: { action: "read" }, executedInput: { action: "read" } },
		});
		const preparation = prepareViewCompaction(
			captured,
			references.map((ref) => ref?.ref.entryId),
			pathEntries,
			{ enabled: true, reserveTokens: 64, keepRecentTokens: 20_000 },
		)!;
		// Retention reaches the old pin, but that pin cannot name a chronological suffix across the omitted gap.
		expect(preparation.firstKeptEntryId).toBe(currentUserId);
		// Both the old call and recovered body can summarize after accepted coverage.
		expect(preparation.messagesToSummarize).toContainEqual(captured[callIndex]);
		expect(preparation.messagesToSummarize).toContainEqual(
			captured[references.findIndex((ref) => ref?.ref.entryId === recoveryResultId)],
		);
		const checkpoint = prepareRecoveryCompaction(captured, preparation.firstKeptEntryId, maxBytes)!;
		const summarySink = manager.bindCompactionSink();
		try {
			await summarySink[appendContextEpoch](checkpoint, preparation.tokensBefore, {
				summary: "Selected work summarized",
			});
		} finally {
			await summarySink.release();
		}

		const rebuilt = await compileCopyContext(manager);
		expect(sourceIds(rebuilt)).toEqual([currentUserId, currentAssistantId, currentResultId]);
		expect(rebuilt.filter((message) => message.role !== "compactionSummary")).toEqual(
			captured.filter((_, index) =>
				[currentUserId, currentAssistantId, currentResultId].includes(references[index]?.ref.entryId ?? ""),
			),
		);
		expect(rebuilt[0]).toMatchObject({ role: "compactionSummary", summary: "Selected work summarized" });
		expect(Buffer.byteLength(JSON.stringify(rebuilt))).toBeLessThan(5000);

		const nextRequest = prepareCanonicalEpoch(
			rebuilt,
			getCanonicalViewUnits(rebuilt)!.map((unit) => unit.id),
			"fixture-native-template/1",
			maxBytes,
			"message-groups",
			true,
		);
		const nextSink = manager.bindCompactionSink();
		try {
			await nextSink[appendContextEpoch](nextRequest.checkpoint, 100);
		} finally {
			await nextSink.release();
		}
		const second = prepareRecoveryCompaction(await compileCopyContext(manager), currentUserId, maxBytes)!;
		const secondSink = manager.bindCompactionSink();
		try {
			await secondSink[appendContextEpoch](second, 100, { summary: "Selected work summarized again" });
		} finally {
			await secondSink.release();
		}
		const sessionFile = manager.getSessionFile()!;
		await manager.close();
		manager = await SessionManager.open(sessionFile, dir);
		const cold = await compileCopyContext(manager);
		expect(sourceIds(cold)).toEqual([currentUserId, currentAssistantId, currentResultId]);
		expect(Buffer.byteLength(JSON.stringify(cold))).toBeLessThan(5000);
		const recovered = await manager.readBranchHistory((history) =>
			recoverCapturedHistory(history.branchContext, {
				action: "read",
				ref: recoveryResultId,
				startByte: 0,
				endByte: 24,
			}),
		);
		expect(recovered.results[0].records[0]).toMatchObject({
			ref: recoveryResultId,
			text: "Older recovered evidence",
		});
	} finally {
		await manager.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

it("keeps an unresolved tool continuation intact across summary and cold replay", async () => {
	const dir = mkdtempSync(join(tmpdir(), "base-context-compaction-unresolved-"));
	let manager = await SessionManager.create(dir, dir);
	const maxBytes = 2 * 1024 * 1024;
	try {
		const assistantId = await manager.appendMessage({
			...fauxAssistantMessage("Outcome still unknown"),
			content: [{ type: "toolCall", id: "pending-call", name: "fixture", arguments: {} }],
			stopReason: "toolUse",
		});
		await manager[bindNativeEntryWriter]().captureToolInvocation({
			sessionId: manager.getSessionId(),
			sessionFile: manager.getSessionFile(),
			entryId: assistantId,
		})({
			executionId: "pending-execution",
			sourceOrder: 0,
			toolCallId: "pending-call",
			toolName: "fixture",
			originalInput: {},
			executedInput: {},
			toolExecution: "sequential",
		});
		const tailId = await manager.appendMessage({ role: "user", content: "Keep the current task", timestamp: 3 });
		const messages = await compileCopyContext(manager, "read");
		const checkpoint = prepareRecoveryCompaction(messages, tailId, maxBytes)!;
		expect(checkpoint.toolContinuations?.[0]).toMatchObject({
			assistantEntryId: assistantId,
			calls: [{ executionId: "pending-execution", outcome: "outcome_unknown" }],
		});
		expect(checkpoint.views.map((view) => view.ref.entryId)).toContain(assistantId);
		const sink = manager.bindCompactionSink();
		try {
			await sink[appendContextEpoch](checkpoint, 100, { summary: "Earlier work summarized" });
		} finally {
			await sink.release();
		}
		const sessionFile = manager.getSessionFile()!;
		await manager.close();
		manager = await SessionManager.open(sessionFile, dir);
		const cold = await compileCopyContext(manager, "read");
		expect(getCanonicalEpochContext(cold)?.toolContinuations).toEqual(checkpoint.toolContinuations);
		expect(getCanonicalEpochContext(cold)?.references.some((ref) => ref?.ref.entryId === tailId)).toBe(true);
	} finally {
		await manager.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

it.each(["literal", "public"] as const)(
	"continues source-ordered epochs after reverse tool completion (%s)",
	async (representation) => {
		const dir = mkdtempSync(join(tmpdir(), "base-context-epoch-tool-order-"));
		const manager = await SessionManager.create(dir, dir);
		const maxBytes = 2 * 1024 * 1024;
		try {
			await manager.appendMessage({ role: "user", content: "summarized prefix", timestamp: 0 });
			const assistant: AssistantMessage = {
				role: "assistant",
				api: "openai-responses",
				provider: "openai",
				model: "fixture",
				content: [
					{ type: "toolCall", id: "a", name: "bash", arguments: {} },
					{ type: "toolCall", id: "b", name: "bash", arguments: {} },
				],
				stopReason: "toolUse",
				timestamp: 1,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			const assistantId = await manager.appendMessage(assistant);
			const resultB = await manager.appendMessage({
				role: "toolResult",
				toolCallId: "b",
				toolName: "bash",
				content: [{ type: "text", text: "B finished first" }],
				isError: false,
				timestamp: 2,
			});
			const resultA = await manager.appendMessage({
				role: "toolResult",
				toolCallId: "a",
				toolName: "bash",
				content: [{ type: "text", text: "A finished last" }],
				isError: false,
				timestamp: 3,
			});
			// A summary's newer source sequence is not a literal-tail candidate.
			await manager.appendCompaction("Earlier work", assistantId, 100);
			const input = await compileCopyContext(manager);
			expect(input.filter((message) => message.role === "toolResult").map((message) => message.toolCallId)).toEqual([
				"a",
				"b",
			]);
			const mode = prepareContextModeEpoch(input, "on", maxBytes);
			expect(mode.checkpoint.literalTailId).toBe(resultA);
			const modeSink = manager.bindCompactionSink();
			try {
				await modeSink[appendContextEpoch](mode.checkpoint, null);
			} finally {
				await modeSink.release();
			}
			const retained = await compileCopyContext(manager);
			expect(retained).toEqual(input);
			const candidate = representation === "public" ? preparePublicContextWindow(retained)!.messages : retained;
			const prepared = prepareCanonicalEpoch(
				candidate,
				getCanonicalViewUnits(candidate)!.map((unit) => unit.id),
				"fixture-native-template/1",
				maxBytes,
				representation === "public" ? "message-groups" : "complete-context",
				representation === "public",
			);
			expect(prepared.checkpoint.literalTailId).toBe(resultA);
			expect(prepared.checkpoint.views.map((reference) => reference.ref.entryId)).toContain(resultB);
			expect(prepared.checkpoint.views.map((reference) => reference.ref.entryId)).not.toContain(resultA);
			const sink = manager.bindCompactionSink();
			try {
				await sink[appendContextEpoch](prepared.checkpoint, 100);
			} finally {
				await sink.release();
			}
			expect(await compileCopyContext(manager)).toEqual(prepared.messages);
			const nextAssistant: AssistantMessage = {
				...assistant,
				content: [{ type: "toolCall", id: "c", name: "bash", arguments: {} }],
				timestamp: 4,
			};
			const timeout: AgentMessage = {
				role: "toolResult",
				toolCallId: "c",
				toolName: "bash",
				content: [{ type: "text", text: "Command timed out after 60000 ms" }],
				isError: true,
				timestamp: 5,
			};
			await manager.appendMessage(nextAssistant);
			await manager.appendMessage(timeout);
			expect(await compileCopyContext(manager)).toEqual([...prepared.messages, nextAssistant, timeout]);
		} finally {
			await manager.close();
			rmSync(dir, { recursive: true, force: true });
		}
	},
);

it("rebases a full TaskFrame only through an acknowledged full-view epoch", async () => {
	const dir = mkdtempSync(join(tmpdir(), "base-context-task-rebase-"));
	const manager = await SessionManager.create(dir, dir);
	const requests = new InferenceCoordinator(() => manager.bindRequestSink());
	const compiler = new CanonicalContextCompiler();
	const limits = { maxMessages: 256, maxSourceBytes: 2 * 1024 * 1024 };
	const frameLimits = { maxBytes: 4_096, maxReferences: 1, maxTextBytes: 128 };
	try {
		await manager.appendMessage({ role: "user", content: "Retain the current goal", timestamp: 0 });
		const writer = manager[bindNativeEntryWriter]();
		let rebased = false;
		for (let index = 0; index < 8 && !rebased; index++) {
			await writer.captureGoalOperation({
				version: 1,
				kind: "goal_operation",
				operation: "create",
				actor: "interactive",
				actionId: `rebase-${index}`,
				submittedText: `/goal Current goal ${index}`,
			})({
				goalId: `goal-${index}`,
				objective: `Current goal ${index}`,
				active: true,
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				continuationsUsed: 0,
			});
			const sink = manager.bindCompactionSink();
			const captured = requests.capture(sink);
			try {
				const messages = await captured.readHistory((view) =>
					compiler.compile(view, limits, undefined, frameLimits),
				);
				const context = getCanonicalEpochContext(messages)!;
				if (!context.taskFrameRebased) continue;
				rebased = true;
				const sourceLeaf = manager.getLeafId();
				expect(context.taskFrame!.messages).toHaveLength(1);
				expect(context.taskFrame!.anchors).toEqual([]);
				expect(context.taskFrame!.messages[0].content).toContain(`Current goal ${index}`);
				expect(Buffer.byteLength(JSON.stringify(context.taskFrame!.messages))).toBeLessThanOrEqual(
					frameLimits.maxBytes,
				);
				// Preparing or abandoning the candidate never publishes it into the old prefix.
				const retry = await captured.readHistory((view) => compiler.compile(view, limits, undefined, frameLimits));
				expect(getCanonicalEpochContext(retry)?.taskFrameRebased).toBe(true);
				expect(manager.getLeafId()).toBe(sourceLeaf);
				const boundary = captureRequestViewBoundary(messages, async (candidate) => {
					expect(candidate.assessment).toBeUndefined();
					expect(candidate.selectedUnitIds).toHaveLength(messages.length);
					const prepared = prepareCanonicalEpoch(
						messages,
						candidate.selectedUnitIds,
						"fixture-native-rebase/1",
						limits.maxSourceBytes,
					);
					const entryId = await sink[appendContextEpoch](prepared.checkpoint, null);
					return { sessionId: manager.getSessionId(), entryId };
				});
				expect(boundary.requiresEpoch).toBe(true);
				const request: ProviderRequestRepresentation = {
					api: "openai-completions",
					provider: "deepseek",
					url: "https://api.deepseek.com/chat/completions",
					body: JSON.stringify({ model: "deepseek-flash", messages: convertToLlm(messages) }),
				};
				await selectRequestView(
					boundary,
					request,
					{
						kind: "deepseek-completions-text-tools-v1",
						messageIndices: messages.map((_, position) => position),
					},
					undefined,
					false,
				);
				expect(manager.getLeafId()).not.toBe(sourceLeaf);
			} finally {
				await captured.dispose();
			}
		}
		expect(rebased).toBe(true);
		const rebuilt = requests.capture();
		try {
			const messages = await rebuilt.readHistory((view) => compiler.compile(view, limits, undefined, frameLimits));
			expect(getCanonicalEpochContext(messages)?.taskFrameRebased).toBeUndefined();
			expect(getCanonicalEpochContext(messages)?.taskFrame?.messages).toHaveLength(1);
		} finally {
			await rebuilt.dispose();
		}
	} finally {
		await requests.dispose();
		await manager.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
