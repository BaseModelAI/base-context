import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	type Model,
	type ProviderRequestProjection,
	type ProviderRequestRepresentation,
} from "@ponythewhite/base-context-ai";
import { expect, it } from "vitest";
import { bindResponsesPublicWindow, convertResponsesMessages } from "../../ai/src/providers/openai-responses-shared.js";
import {
	CanonicalContextCompiler,
	getCanonicalEpochContext,
	prepareCanonicalEpoch,
	preparePublicContextWindow,
} from "../src/core/canonical-context.js";
import {
	appendContextEpoch,
	CONTEXT_INTERRUPTED_TOOL_RENDERER,
	contextEpochRepresentation,
} from "../src/core/context-epoch.js";
import { convertToLlm } from "../src/core/messages.js";
import {
	captureRequestViewBoundary,
	matchesRequestView,
	type RequestViewCandidate,
	selectRequestView,
} from "../src/core/request-view-selection.js";
import { captureNativeRequestOutputSource, SessionManager } from "../src/core/session-manager.js";

const model: Model<"openai-responses"> = {
	id: "offline-filtered-projection",
	name: "Offline filtered projection",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	contextWindow: 100000,
	maxTokens: 16,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const limits = { maxMessages: 256, maxSourceBytes: 2 * 1024 * 1024 };

it.each(["error", "aborted", "toolUse"] as const)(
	"resumes a stored absent-tool summary without replaying a filtered %s assistant",
	async (stopReason) => {
		const dir = mkdtempSync(join(tmpdir(), "base-context-filtered-projection-"));
		let manager = await SessionManager.create(dir, dir);
		try {
			await manager.appendMessage({ role: "user", content: "earlier history", timestamp: 0 });
			const firstKept = await manager.appendMessage({ role: "user", content: "retained request", timestamp: 1 });
			const partial = {
				...fauxAssistantMessage(
					[
						{ type: "text" as const, text: "partial tool reply" },
						{ type: "toolCall" as const, id: "call_partial|fc_partial", name: "fixture", arguments: {} },
					],
					{ stopReason },
				),
				api: model.api,
				provider: model.provider,
				model: model.id,
			};
			const output = manager.bindRequestSink();
			let partialId: string;
			try {
				const source = await output.source;
				partialId = (await captureNativeRequestOutputSource(output)!({
					operationId: "offline-failed-output",
					attemptIds: [],
					source,
				})!(manager, partial))!;
			} finally {
				await output.release();
			}
			await manager.appendCustomMessageEntry("refinement_outcome", "UI ordering barrier", true, {});
			await manager.appendMessage({
				...fauxAssistantMessage("successful retry"),
				api: model.api,
				provider: model.provider,
				model: model.id,
			});
			const summary = manager.bindCompactionSink();
			try {
				const source = await summary.source;
				// Reproduce the already-persisted plan made by the pre-fix requested-summary path.
				await summary[appendContextEpoch](
					{
						version: 8,
						mode: "on",
						renderer: CONTEXT_INTERRUPTED_TOOL_RENDERER,
						source,
						representation: null,
						includeSummary: true,
						publicWindow: true,
						replayContract: "message-groups",
						continuation: { kind: "harness-summary", publicTailThrough: source },
						views: [],
						literalTailId: firstKept,
						toolContinuations: [{ assistantEntryId: partialId, calls: [{ admission: "absent", source }] }],
					},
					100,
					{ summary: "requested summary", customInstructions: "retain the current request" },
				);
			} finally {
				await summary.release();
			}
			const file = manager.getSessionFile()!;
			await manager.close();
			manager = await SessionManager.open(file);
			const sink = manager.bindCompactionSink();
			try {
				const messages = await sink.readHistory((history) =>
					new CanonicalContextCompiler().compile(history, limits, undefined, undefined, undefined, "on", true),
				);
				const partialIndex = messages.findIndex(
					(message) => message.role === "assistant" && message.stopReason === stopReason,
				);
				expect(messages[partialIndex]).toEqual(partial);
				const commits: RequestViewCandidate[] = [];
				const boundary = captureRequestViewBoundary(messages, async (candidate) => {
					commits.push(candidate);
					const prepared = prepareCanonicalEpoch(
						candidate.publicMessages ?? messages,
						candidate.selectedUnitIds,
						contextEpochRepresentation(candidate.request, candidate.assessment, limits.maxSourceBytes, true),
						limits.maxSourceBytes,
						candidate.projection.replayContract,
						candidate.projection.publicWindow,
					);
					const entryId = await sink[appendContextEpoch](prepared.checkpoint, null);
					return { sessionId: manager.getSessionId(), entryId };
				});
				const llm = convertToLlm(messages);
				expect(matchesRequestView(boundary, boundary.source, { messages: llm })).toBe(true);
				const filtered = stopReason !== "toolUse";
				expect(boundary.providerMessageIndices.includes(partialIndex)).toBe(!filtered);
				expect(boundary.pendingPublicMessageGroups).toEqual(filtered ? undefined : [[partialIndex]]);
				let projection: ProviderRequestProjection | undefined;
				const input = convertResponsesMessages(model, { messages: llm }, new Set([model.provider]), {
					responsesMessageIds: llm.map((_, index) => index),
					pendingPublicMessageGroups: boundary.providerPendingPublicMessageGroups,
					onProjection: (value) => {
						projection = value;
					},
				});
				expect(projection).toBeDefined();
				const request: ProviderRequestRepresentation = {
					api: model.api,
					provider: model.provider,
					url: `${model.baseUrl}/responses`,
					body: JSON.stringify({ model: model.id, input, max_output_tokens: 16 }),
				};
				const body = await selectRequestView(
					boundary,
					request,
					bindResponsesPublicWindow(request, projection!),
					undefined,
					true,
				);
				expect(commits).toHaveLength(1);
				expect(commits[0].selectedUnitIds).toEqual(boundary.units.map((unit) => unit.id));
				expect(body).not.toContain('"type":"function_call"');
				expect(body?.includes("partial tool reply")).toBe(!filtered);
				expect(commits[0].projection.pendingPublicMessageGroups).toBeUndefined();
				if (filtered) {
					expect(getCanonicalEpochContext(messages)?.toolContinuations).toBeUndefined();
					expect(preparePublicContextWindow(messages)).toBeUndefined();
				}
			} finally {
				await sink.release();
			}
			await manager.close();
			manager = await SessionManager.open(file);
			const reloaded = manager.bindRequestSink();
			try {
				const messages = await reloaded.readHistory((history) =>
					new CanonicalContextCompiler().compile(history, limits, undefined, undefined, undefined, "on", true),
				);
				const boundary = captureRequestViewBoundary(messages, async () => {});
				if (stopReason !== "toolUse") {
					expect(messages).toContainEqual(partial);
					expect(boundary.pendingPublicMessageGroups).toBeUndefined();
					expect(JSON.stringify(convertToLlm(messages))).not.toContain("partial tool reply");
				}
			} finally {
				await reloaded.release();
			}
		} finally {
			await manager.close();
			rmSync(dir, { recursive: true, force: true });
		}
	},
);
