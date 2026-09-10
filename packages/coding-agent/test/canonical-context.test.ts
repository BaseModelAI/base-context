import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@ponythewhite/base-context-agent";
import { type AssistantMessage, type Model, registerFauxProvider } from "@ponythewhite/base-context-ai";
import { expect, it, vi } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import {
	CanonicalContextCompiler,
	getCanonicalEpochContext,
	getCanonicalMessageSource,
	getCanonicalViewUnits,
	prepareCanonicalEpoch,
} from "../src/core/canonical-context.js";
import { prepareViewCompaction } from "../src/core/compaction/index.js";
import { appendContextEpoch, readContextEpoch } from "../src/core/context-epoch.js";
import { HistoryIndex } from "../src/core/history-index.js";
import { InferenceCoordinator } from "../src/core/inference-coordinator.js";
import { type CustomMessage, convertToLlm } from "../src/core/messages.js";
import { createAgentSession } from "../src/core/sdk.js";
import {
	appendSentAgentMessageToToolResult,
	IPYTHON_SENT_AGENT_MESSAGE_CUSTOM_ENTRY,
} from "../src/core/session-context-updates.js";
import { bindNativeEntryWriter } from "../src/core/session-entry-origin.js";
import { buildSessionContext, SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { type CompiledTaskFrame, compileTaskFrame, taskFrameLimits } from "../src/core/task-frame.js";
import { TASK_STATE_CUSTOM_TYPE, TASK_STATE_SCHEMA } from "../src/core/task-state.js";
import { readTaskStateFromView } from "../src/core/task-state-reader.js";
import { closeViewSelection } from "../src/core/view-units.js";

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

function copiedVisibleMessages(messages: readonly AgentMessage[]) {
	// Rebuilt checkpoint timestamps are new. Selected literal bodies and summary options are not.
	return convertToLlm(
		messages.map((message) => (message.role === "compactionSummary" ? { ...message, timestamp: 0 } : message)),
	);
}

async function compileCopyContext(manager: SessionManager) {
	const requests = new InferenceCoordinator(() => manager.bindRequestSink());
	const captured = requests.capture();
	try {
		return await captured.readHistory((history) =>
			new CanonicalContextCompiler().compile(history, { maxMessages: 256, maxSourceBytes: 2 * 1024 * 1024 }),
		);
	} finally {
		await captured.dispose();
		await requests.dispose();
	}
}

it("reconstructs the whole retained context across pages and caches immutable source entries", async () => {
	const dir = mkdtempSync(join(tmpdir(), "base-context-compile-"));
	const manager = await SessionManager.create(dir, dir);
	const requests = new InferenceCoordinator(() => manager.bindRequestSink());
	let capture: InferenceCoordinator | undefined;
	try {
		await manager.appendMessage({ role: "user", content: "discarded prefix", timestamp: 0 });
		const sentMessage = {
			id: "sent",
			message: "delivered before compact",
			deliveryStatus: "delivered" as const,
			target: { activeSessionId: "recipient", sessionId: "recipient-session" },
		};
		await manager.appendCustomEntry(IPYTHON_SENT_AGENT_MESSAGE_CUSTOM_ENTRY, {
			toolCallId: "a",
			message: sentMessage,
		});
		let firstKept = "";
		for (let i = 0; i < 126; i++) {
			const id = await manager.appendMessage({ role: "user", content: `kept ${i}`, timestamp: i + 1 });
			if (i === 0) firstKept = id;
		}
		const assistant: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "openai",
			model: "fixture",
			timestamp: 128,
			content: [
				{ type: "toolCall", id: "a", name: "ipython", arguments: {} },
				{ type: "toolCall", id: "b", name: "ipython", arguments: {} },
			],
			stopReason: "toolUse",
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
		await manager.appendMessage({
			role: "toolResult",
			toolCallId: "b",
			toolName: "ipython",
			content: [{ type: "text", text: "second result" }],
			isError: false,
			timestamp: 129,
		});
		await manager.appendCompaction("summary", firstKept, 500);
		await manager.appendMessage({
			role: "toolResult",
			toolCallId: "a",
			toolName: "ipython",
			content: [{ type: "text", text: "first result" }],
			isError: false,
			timestamp: 130,
		});
		const leaf = await manager.appendCustomEntry(IPYTHON_SENT_AGENT_MESSAGE_CUSTOM_ENTRY, {
			toolCallId: "a",
			message: { ...sentMessage, message: "must not replace first" },
		});
		await manager.appendMessage({ role: "user", content: "abandoned sibling", timestamp: 131 });
		await manager.appendCustomEntry(IPYTHON_SENT_AGENT_MESSAGE_CUSTOM_ENTRY, {
			toolCallId: "a",
			message: { ...sentMessage, id: "sibling", message: "not on selected branch" },
		});
		const aggregate = {
			...assistant.usage,
			input: 37,
			output: 4,
			totalTokens: 41,
			cost: { ...assistant.usage.cost, input: 0.5, total: 0.5 },
		};
		await manager.appendChildUsageAttribution(assistantId, aggregate, aggregate);
		await manager.branchTo(leaf);
		const expected = buildSessionContext(await manager.readBranch()).messages;
		for (const message of expected) appendSentAgentMessageToToolResult(message, "a", sentMessage);
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

		// Synthetic privileged compiler-storage inputs, not evidence of physical AS admission.
		await capture.dispose();
		capture = undefined;
		const writer = manager[bindNativeEntryWriter]();
		const goal = {
			goalId: "TaskFrame/Case",
			objective: "Preserve Foo.ts separately from foo.ts",
			active: true,
			status: "active",
			tokensUsed: 0,
			timeUsedSeconds: 0,
			continuationsUsed: 0,
		};
		const goalEntryId = await writer.captureGoalOperation({
			version: 1,
			kind: "goal_operation",
			operation: "create",
			actor: "interactive",
			actionId: "compiler-fixture-goal",
			submittedText: `/goal ${goal.objective}`,
		})(goal);
		const proposalEntryId = await manager.appendCustomEntry(TASK_STATE_CUSTOM_TYPE, {
			schema: TASK_STATE_SCHEMA,
			itemId: "Foo.ts",
			kind: "user_requirement",
			text: "Raw proposal to remove Foo.ts",
			operation: "declare",
			authority: "user",
		});
		const isTaskFrame = (message: AgentMessage): message is CustomMessage =>
			message.role === "custom" && message.customType === "task_frame";
		const frameText = (message: AgentMessage) => {
			if (message.role !== "custom" || message.customType !== "task_frame" || typeof message.content !== "string")
				throw new Error("fixture expected a text task frame");
			expect(message.display).toBe(false);
			return message.content;
		};
		const frameLimits = { ...limits, maxMessages: 136 };
		capture = requests.capture();
		const sourceBeforeFrame = await manager.readEntries();
		const frameOptions = { maxBytes: 16_384 };
		const withFrame = await capture.readHistory((view) => {
			const compiled = compiler.compile(view, frameLimits, undefined, frameOptions);
			frameOptions.maxBytes = 1; // The compiler must copy partial options before its first wait.
			return compiled;
		});
		const baseFrames = withFrame.filter(isTaskFrame);
		expect(baseFrames).toHaveLength(1);
		expect(withFrame[0]).toBe(baseFrames[0]);
		expect(withFrame.filter((message) => !isTaskFrame(message))).toEqual(expected);
		expect(withFrame).toHaveLength(131);
		const baseText = frameText(baseFrames[0]);
		const base = JSON.parse(baseText.slice(baseText.indexOf("\n") + 1));
		expect(base).toMatchObject({
			type: "base",
			structuredOnly: true,
			selective: true,
			eligible: 1,
			indexed: 1,
			rows: [
				{
					source: { entryId: goalEntryId, field: "/data" },
					kind: "user_goal_revision",
					authority: "user",
					state: "active",
					itemId: goal.goalId,
					text: goal.objective,
				},
			],
			recovery: { sessionId: manager.getSessionId(), leafId: proposalEntryId },
		});
		const frameTasks = await capture.readHistory((view) => readTaskStateFromView(view));
		const fullFrame = compileTaskFrame(frameTasks, taskFrameLimits())!;
		const fullSource = fullFrame.rows[0].source;
		expect(fullSource).toMatchObject({
			entryId: goalEntryId,
			qualification: "native-admission",
			revision: expect.any(String),
			sequence: expect.any(Number),
			locator: { path: manager.getSessionFile() },
		});
		expect(base.rows[0].source).toEqual({
			sessionId: fullSource.sessionId,
			entryId: fullSource.entryId,
			field: fullSource.field,
			revision: fullSource.revision,
		});
		expect(base.recovery).toEqual({
			sessionId: frameTasks.source.sessionId,
			leafId: frameTasks.source.leafId,
			sourceSequence: frameTasks.source.sourceSequence,
		});
		expect(fullFrame.origins[0]).toEqual(frameTasks.source);
		expect(fullFrame.material).toContain(manager.getSessionFile()!);
		expect(baseText).not.toContain(manager.getSessionFile()!);
		// A prior full-metadata render remains frozen when the owned material is unchanged.
		const frozenFrame: CompiledTaskFrame = {
			...fullFrame,
			messages: [
				{
					...fullFrame.messages[0],
					content:
						baseText.slice(0, baseText.indexOf("\n") + 1) +
						JSON.stringify({ type: "base", ...JSON.parse(fullFrame.material), recovery: frameTasks.source }),
				},
			],
		};
		expect(compileTaskFrame(frameTasks, taskFrameLimits(), frozenFrame)).toBe(frozenFrame);
		expect(frozenFrame.messages[0].content).toContain(manager.getSessionFile()!);
		expect(baseText).not.toContain("Raw proposal to remove Foo.ts");
		expect(convertToLlm([baseFrames[0]])).toEqual([
			{ role: "user", content: [{ type: "text", text: baseText }], timestamp: baseFrames[0].timestamp },
		]);
		expect(await manager.readEntries()).toEqual(sourceBeforeFrame);

		const completionEntryId = await writer.captureGoalOperation({
			version: 1,
			kind: "goal_operation",
			operation: "complete",
			actor: "runtime",
			previousGoalId: goal.goalId,
		})({ ...goal, active: false, status: "complete" });
		const held = await capture.readHistory((view) => compiler.compile(view, frameLimits));
		expect(held.filter(isTaskFrame).map(frameText)).toEqual([baseText]);
		expect(held.filter((message) => !isTaskFrame(message))).toEqual(expected);
		await capture.dispose();
		capture = undefined;
		const earlierInput = { role: "user" as const, content: "Input before the first revision", timestamp: 132 };
		await manager.appendMessage(earlierInput);
		const omittedAssistantId = await manager.appendMessage({
			...assistant,
			content: [{ type: "text", text: "Omitted intermediate answer" }],
			stopReason: "stop",
			timestamp: 133,
		});
		// Explicitly omit a real stored assistant; the new anchor must use the emitted user instead.
		const omittedIds = new Set([omittedAssistantId]);
		capture = requests.capture();
		const sourceBeforeDelta = await manager.readEntries();
		const withDelta = await capture.readHistory((view) => compiler.compile(view, frameLimits, omittedIds));
		const frames = withDelta.filter(isTaskFrame);
		expect(frames).toHaveLength(2);
		expect(frameText(frames[0])).toBe(baseText);
		const revisionText = frameText(frames[1]);
		const revision = JSON.parse(revisionText.slice(revisionText.indexOf("\n") + 1));
		expect(revisionText).not.toContain(manager.getSessionFile()!);
		expect(revision).toMatchObject({
			type: "revision",
			structuredOnly: true,
			selective: true,
			changed: [
				{
					source: { entryId: completionEntryId },
					authority: "tool-data",
					state: "descriptive",
					goalState: { operation: "complete", previousGoalId: goal.goalId },
				},
			],
			noLongerSelected: [
				{
					source: { entryId: goalEntryId },
					state: "completed",
					changedBy: { entryId: completionEntryId },
					selectionOnly: true,
				},
			],
		});
		const earlierIndex = withDelta.findIndex(
			(message) => message.role === "user" && message.content === earlierInput.content,
		);
		expect(withDelta[earlierIndex]).toEqual(earlierInput);
		expect(withDelta[earlierIndex - 1]).toBe(frames[1]);
		expect(compiler.hasActiveEntry(omittedAssistantId)).toBe(true);
		expect(withDelta.filter((message) => !isTaskFrame(message))).toEqual([...expected, earlierInput]);
		expect(withDelta).toHaveLength(133);
		expect(await manager.readEntries()).toEqual(sourceBeforeDelta);

		const laterInput = { role: "user" as const, content: "Preserve Bar.ts in the next request", timestamp: 134 };
		const laterInputId = await writer.captureMessage({
			version: 1,
			kind: "input",
			actionId: "compiler-fixture-next-input",
			recordId: "compiler-fixture-next-record",
			inputSource: "interactive",
			recordRole: "primary",
			submitted: { text: laterInput.content },
		})(laterInput);
		await capture.dispose();
		capture = requests.capture();
		const sourceBeforeSecondDelta = await manager.readEntries();
		const withSecondDelta = await capture.readHistory((view) => compiler.compile(view, frameLimits, omittedIds));
		const secondFrames = withSecondDelta.filter(isTaskFrame);
		expect(secondFrames).toHaveLength(3);
		expect(secondFrames.slice(0, 2).map(frameText)).toEqual([baseText, revisionText]);
		const secondRevisionText = frameText(secondFrames[2]);
		const secondRevision = JSON.parse(secondRevisionText.slice(secondRevisionText.indexOf("\n") + 1));
		expect(secondRevision).toMatchObject({
			type: "revision",
			changed: [
				{
					source: { entryId: laterInputId, field: "/nativeOrigin/submitted/text" },
					kind: "user_requirement",
					authority: "user",
					state: "active",
					text: laterInput.content,
				},
			],
			noLongerSelected: [],
		});
		const earlierIndexNow = withSecondDelta.findIndex(
			(message) => message.role === "user" && message.content === earlierInput.content,
		);
		const laterIndex = withSecondDelta.findIndex(
			(message) => message.role === "user" && message.content === laterInput.content,
		);
		expect(earlierIndexNow).toBe(earlierIndex);
		expect(withSecondDelta[earlierIndexNow - 1]).toBe(secondFrames[1]);
		expect(withSecondDelta[laterIndex - 1]).toBe(secondFrames[2]);
		expect(withSecondDelta[laterIndex]).toEqual(laterInput);
		expect(compiler.hasActiveEntry(omittedAssistantId)).toBe(true);
		expect(withSecondDelta.filter((message) => !isTaskFrame(message))).toEqual([
			...expected,
			earlierInput,
			laterInput,
		]);
		expect(withSecondDelta).toHaveLength(135);
		const previousFrameUnits = getCanonicalViewUnits(withDelta)!.filter((unit) => unit.kind === "task-frame");
		const nextFrameUnits = getCanonicalViewUnits(withSecondDelta)!.filter((unit) => unit.kind === "task-frame");
		expect(nextFrameUnits.slice(0, 2).map((unit) => [unit.id, unit.sourceRevision])).toEqual(
			previousFrameUnits.map((unit) => [unit.id, unit.sourceRevision]),
		);
		expect(nextFrameUnits[2].requiredVisibleDependencies).toContain(nextFrameUnits[1].id);
		const providerUnits = getCanonicalViewUnits(withSecondDelta)!;
		const closedUnits = closeViewSelection(providerUnits, [nextFrameUnits[2].id], {
			maxUnits: frameLimits.maxMessages,
			maxDependencies: frameLimits.maxMessages * 4,
			maxMetadataBytes: frameLimits.maxSourceBytes,
		});
		expect(closedUnits.map((unit) => unit.id)).toEqual(providerUnits.map((unit) => unit.id));
		// Rendered input can be callback-expanded; only the separately projected submitted clause has user authority.
		expect(
			getCanonicalViewUnits(withSecondDelta)!.find((unit) => unit.exactSources.includes(laterInputId))!.authority,
		).toBe("unrecorded");
		const providerMessages = convertToLlm(withSecondDelta);
		expect(providerMessages).toHaveLength(closedUnits.length);
		for (const frame of secondFrames) {
			expect(providerMessages[withSecondDelta.indexOf(frame)]).toEqual({
				role: "user",
				content: [{ type: "text", text: frameText(frame) }],
				timestamp: frame.timestamp,
			});
		}
		expect(await manager.readEntries()).toEqual(sourceBeforeSecondDelta);

		// Persist actual source recipes, then discard both the compiler and source owner.
		// This is an epoch/compiler path, not a provider token-estimate or cache-hit test.
		await capture.dispose();
		const checkpointSink = manager.bindCompactionSink();
		capture = requests.capture(checkpointSink);
		const checkpointInput = await capture.readHistory((view) => compiler.compile(view, frameLimits, omittedIds));
		const prepared = prepareCanonicalEpoch(
			checkpointInput,
			getCanonicalViewUnits(checkpointInput)!.map((unit) => unit.id),
			"fixture-native-template/1",
			frameLimits.maxSourceBytes,
		);
		const epochId = await checkpointSink[appendContextEpoch](prepared.checkpoint, 100);
		expect(await manager.readBranchHistory((history) => history.get(epochId))).toMatchObject({
			qualification: "native-context-epoch",
		});
		await capture.dispose();
		capture = undefined;
		const sessionFile = manager.getSessionFile()!;
		await manager.close();
		const reopened = await SessionManager.open(sessionFile, dir);
		const resumedRequests = new InferenceCoordinator(() => reopened.bindRequestSink());
		const resumed = resumedRequests.capture();
		try {
			const rebuilt = await resumed.readHistory((view) => new CanonicalContextCompiler().compile(view, frameLimits));
			expect(convertToLlm(rebuilt)).toEqual(convertToLlm(prepared.messages));
			expect(rebuilt.filter(isTaskFrame).map(frameText)).toEqual(secondFrames.map(frameText));
			expect(getCanonicalViewUnits(rebuilt)!.some((unit) => unit.kind === "fixed-view")).toBe(true);
			const view = getCanonicalEpochContext(rebuilt)!;
			const preparation = prepareViewCompaction(
				rebuilt,
				view.references.map((ref) => ref?.ref.entryId),
				await reopened.readBranch(),
				{ enabled: true, reserveTokens: 64, keepRecentTokens: 1 },
			);
			expect(preparation?.firstKeptEntryId).toBe(laterInputId);
			expect(preparation?.messagesToSummarize).toContainEqual(earlierInput);
			expect(preparation?.messagesToSummarize.filter(isTaskFrame).map(frameText)).toEqual(
				secondFrames.map(frameText),
			);

			// Explicit copies rebuild recipes; a copied fixture profile is not a provider certificate.
			const opaqueCopy = await SessionManager.forkFrom(sessionFile, dir, join(dir, "opaque-copy"));
			const faux = registerFauxProvider({ api: "faux-copy-epoch", provider: "faux-copy-epoch", tokensPerSecond: 0 });
			try {
				const opaqueContext = await compileCopyContext(opaqueCopy);
				expect(convertToLlm(opaqueContext.filter((message) => !isTaskFrame(message)))).toEqual(
					convertToLlm(prepared.messages.filter((message) => !isTaskFrame(message))),
				);
				expect(getCanonicalEpochContext(opaqueContext)!.checkpoint!.representation).toBe(
					"fixture-native-template/1",
				);
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

				// An ordinary summary carries source recipes, not a measured request representation.
				const summarySink = reopened.bindCompactionSink();
				const summaryCapture = resumedRequests.capture(summarySink);
				const summary = {
					summary: "Keep the selected file context.",
					details: { fixtureSummary: "copied verbatim" },
					fromHook: true,
					customInstructions: "Preserve case-sensitive file names.",
					usage: aggregate,
				};
				try {
					const input = await summaryCapture.readHistory((history) =>
						new CanonicalContextCompiler().compile(history, frameLimits),
					);
					const recipe = prepareCanonicalEpoch(
						input,
						getCanonicalViewUnits(input)!.map((unit) => unit.id),
						"fixture-native-template/1",
						frameLimits.maxSourceBytes,
					).checkpoint;
					await summarySink[appendContextEpoch](
						{ ...recipe, representation: null, includeSummary: true },
						100,
						summary,
					);
				} finally {
					await summaryCapture.dispose();
				}
				const selected = await compileCopyContext(reopened);
				const summaryEntryId = reopened.getLeafId()!;
				const { usage: summaryUsage, ...summaryOptions } = summary;
				const copiedEntries = await reopened.readEntries();
				for (const retained of [false, true]) {
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
								copiedEpoch.taskFrame.origins.every(
									(origin) => origin.sessionId === destination.getSessionId(),
								),
							).toBe(true);
							expect(
								copiedEpoch.taskFrame.rows.every((row) => row.source.sessionId === destination.getSessionId()),
							).toBe(true);
							expect(copiedEpoch.taskFrame.messages.map(frameText).join("\n")).not.toContain(
								destination.getSessionFile()!,
							);
						}
						if (retained) {
							expect(tasks.items.some((item) => item.event.authority === "user")).toBe(false);
							expect(copied.filter(isTaskFrame).map(frameText)).not.toEqual(secondFrames.map(frameText));
						} else {
							expect(
								tasks.items.find((item) => item.event.source.entryId === laterInputId)?.event.authority,
							).toBe("user");
						}
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
							telemetryDisabled: true,
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
							for (const message of convertToLlm(copied)) {
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
								telemetryDisabled: true,
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
				}
			} finally {
				faux.unregister();
				await opaqueCopy.close();
			}
		} finally {
			try {
				await resumed.dispose();
				await resumedRequests.dispose();
			} finally {
				await reopened.close();
			}
		}
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

it("refuses budgets and invalid retained boundaries instead of silently dropping active context", async () => {
	const dir = mkdtempSync(join(tmpdir(), "base-context-compile-limit-"));
	const manager = await SessionManager.create(dir, dir);
	const requests = new InferenceCoordinator(() => manager.bindRequestSink());
	let capture: InferenceCoordinator | undefined;
	try {
		await manager.appendMessage({ role: "user", content: "one", timestamp: 1 });
		const secondEntryId = await manager.appendMessage({ role: "user", content: "two", timestamp: 2 });
		capture = requests.capture();
		const compiler = new CanonicalContextCompiler();
		const reads = vi.spyOn(HistoryIndex.prototype, "readPayload");
		await expect(
			capture.readHistory((view) => compiler.compile(view, { maxMessages: 1, maxSourceBytes: 4096 })),
		).rejects.toThrow("message budget exceeded");
		await expect(
			capture.readHistory((view) => compiler.compile(view, { maxMessages: 10, maxSourceBytes: 1 })),
		).rejects.toThrow("source byte budget exceeded");
		expect(reads).not.toHaveBeenCalled();
		await capture.dispose();
		await manager.appendCompaction("not a complete replacement", "missing boundary", 50);
		capture = requests.capture();
		await expect(
			capture.readHistory((view) => compiler.compile(view, { maxMessages: 10, maxSourceBytes: 4096 })),
		).rejects.toThrow("invalid-first-kept");
		expect(reads).not.toHaveBeenCalled();

		await capture.dispose();
		capture = undefined;
		await manager.branchTo(secondEntryId);
		await manager[bindNativeEntryWriter]().captureGoalOperation({
			version: 1,
			kind: "goal_operation",
			operation: "create",
			actor: "interactive",
			actionId: "compiler-fixture-edge",
			submittedText: "/goal Preserve the edge",
		})({
			goalId: "TaskFrame/Edge",
			objective: "Preserve the edge",
			active: true,
			status: "active",
			tokensUsed: 0,
			timeUsedSeconds: 0,
			continuationsUsed: 0,
		});
		capture = requests.capture();
		await expect(
			capture.readHistory((view) =>
				compiler.compile(view, { maxMessages: 10, maxSourceBytes: 4096 }, undefined, { maxBytes: 1 }),
			),
		).rejects.toThrow("Task frame byte budget exceeded");
		await expect(
			capture.readHistory((view) => compiler.compile(view, { maxMessages: 2, maxSourceBytes: 4096 })),
		).rejects.toThrow("Canonical context message budget exceeded");
		expect(reads).not.toHaveBeenCalled();

		// Real captured compiler output refusal; no native transport or provider claim.
		await capture.dispose();
		capture = undefined;
		const orphanId = await manager.appendMessage({
			role: "toolResult",
			toolCallId: "missing-call",
			toolName: "fixture",
			content: [{ type: "text", text: "result without a retained call" }],
			isError: false,
			timestamp: 3,
		});
		const beforeRefusal = await manager.readEntries();
		capture = requests.capture();
		await expect(
			capture.readHistory((view) => compiler.compile(view, { maxMessages: 16, maxSourceBytes: 64 * 1024 })),
		).rejects.toThrow("View-unit replay group is incomplete");
		expect(compiler.hasActiveEntry(orphanId)).toBe(false);
		expect(await manager.readEntries()).toEqual(beforeRefusal);

		await capture.dispose();
		capture = undefined;
		await manager.branchTo(secondEntryId);
		// Ordinary intent payload labels/IDs cannot mint the original selected-owner qualifier.
		const legacyAssistant = await manager.appendMessage({
			role: "assistant",
			api: "openai-responses",
			provider: "openai",
			model: "offline-tool-owner",
			content: [{ type: "toolCall", id: "copied_call|fc_copied", name: "copied_owner", arguments: {} }],
			stopReason: "toolUse",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: 4,
		});
		const legacyIntent = await manager.appendToolInvocation({
			executionId: "copied-execution",
			sourceOrder: 0,
			toolCallId: "copied_call|fc_copied",
			toolName: "copied_owner",
			originalInput: {
				qualification: "native-tool-execution",
				assistant: {
					sessionId: manager.getSessionId(),
					sessionFile: manager.getSessionFile(),
					entryId: legacyAssistant,
				},
			},
			executedInput: {},
			toolExecution: "sequential",
		});
		const beforeLegacy = await manager.readEntries();
		capture = requests.capture();
		expect(await capture.readHistory((view) => view.get(legacyIntent))).toMatchObject({ authority: "runtime" });
		expect((await capture.readHistory((view) => view.get(legacyIntent)))?.qualification).toBeUndefined();
		await expect(
			capture.readHistory((view) =>
				compiler.compile(
					view,
					{ maxMessages: 16, maxSourceBytes: 64 * 1024 },
					undefined,
					{},
					undefined,
					"on",
					true,
				),
			),
		).rejects.toThrow("original tool owner is unqualified");
		expect(compiler.hasActiveEntry(legacyAssistant)).toBe(false);
		expect(await manager.readEntries()).toEqual(beforeLegacy);
		await capture.dispose();
		capture = undefined;
		await manager.branchTo(secondEntryId);
		const checkpointSink = manager.bindCompactionSink();
		capture = requests.capture(checkpointSink);
		const epochLimits = { maxMessages: 16, maxSourceBytes: 64 * 1024 };
		const candidate = await capture.readHistory(async (view) => {
			await expect(
				view.atSnapshot!({ ...view.source, sourceSequence: view.source.sourceSequence + 1 }),
			).rejects.toThrow("outside its captured source");
			await expect(view.atSnapshot!({ ...view.source, leafId: orphanId })).rejects.toThrow(
				"outside its captured branch",
			);
			return new CanonicalContextCompiler().compile(view, epochLimits);
		});
		const prepared = prepareCanonicalEpoch(
			candidate,
			getCanonicalViewUnits(candidate)!.map((unit) => unit.id),
			"fixture-native-template/1",
			epochLimits.maxSourceBytes,
		);
		const newer = await manager.appendMessage({ role: "user", content: "newer admitted input", timestamp: 4 });
		await expect(checkpointSink[appendContextEpoch](prepared.checkpoint, 10)).rejects.toThrow(
			"source or branch changed",
		);
		expect(manager.getLeafId()).toBe(newer);

		// A real destination ACK must precede adoption, including when its completion fails afterward.
		await capture.dispose();
		capture = undefined;
		await manager.branchTo(secondEntryId);
		const sourceSink = manager.bindCompactionSink();
		capture = requests.capture(sourceSink);
		const sourceInput = await capture.readHistory((history) =>
			new CanonicalContextCompiler().compile(history, epochLimits),
		);
		const sourceRecipe = prepareCanonicalEpoch(
			sourceInput,
			getCanonicalViewUnits(sourceInput)!.map((unit) => unit.id),
			"fixture-native-template/1",
			epochLimits.maxSourceBytes,
		).checkpoint;
		const sourceLeaf = await sourceSink[appendContextEpoch](
			{ ...sourceRecipe, representation: null, includeSummary: true },
			10,
			{ summary: "Retain the two exact inputs." },
		);
		await capture.dispose();
		capture = undefined;
		expect(requests.hasPending).toBe(false);
		const sourceFile = manager.getSessionFile()!;
		const sourceEntries = await manager.readEntries();
		const primary = new Error("fixture failed after destination epoch ACK");
		const cleanup = new Error("fixture destination capture release failed");
		let destination: SessionManager | undefined;
		let destinationEpoch: string | undefined;
		let acknowledge!: () => void;
		const acknowledged = new Promise<void>((resolve) => {
			acknowledge = resolve;
		});
		let releaseAck!: () => void;
		const ackGate = new Promise<void>((resolve) => {
			releaseAck = resolve;
		});
		let released = false;
		const bindCompactionSink = SessionManager.prototype.bindCompactionSink;
		const binding = vi.spyOn(SessionManager.prototype, "bindCompactionSink").mockImplementation(function (
			this: SessionManager,
			limits,
		) {
			const sink = bindCompactionSink.call(this, limits);
			if (this === manager) return sink;
			destination = this;
			const append = sink[appendContextEpoch];
			sink[appendContextEpoch] = async (...args) => {
				destinationEpoch = await append(...args);
				acknowledge();
				await ackGate;
				throw primary;
			};
			const release = sink.release;
			sink.release = async () => {
				await release();
				released = true;
				throw cleanup;
			};
			return sink;
		});
		const adopting = manager.createBranchedSession(sourceLeaf);
		const failed = adopting.then(
			() => undefined,
			(error: unknown) => error,
		);
		try {
			await Promise.race([
				acknowledged,
				adopting.then(() => {
					throw new Error("Expected a destination epoch ACK");
				}),
			]);
			expect(manager.getSessionFile()).toBe(sourceFile);
			expect(manager.getLeafId()).toBe(sourceLeaf);
			expect(destination!.getSessionFile()).not.toBe(sourceFile);
			expect(destination!.getLeafId()).toBe(destinationEpoch);
			releaseAck();
			const error = await failed;
			expect(error).toBeInstanceOf(AggregateError);
			expect((error as AggregateError).errors).toEqual([primary, cleanup]);
			expect(released).toBe(true);
			expect(manager.getSessionFile()).toBe(sourceFile);
			expect(manager.getLeafId()).toBe(sourceLeaf);
			expect(await manager.readEntries()).toEqual(sourceEntries);
			expect(requests.hasPending).toBe(false);
			const inspected = await SessionManager.open(destination!.getSessionFile()!, dir);
			try {
				expect(await inspected.readEntry(secondEntryId)).toEqual(await manager.readEntry(secondEntryId));
				expect(await inspected.readEntry(sourceLeaf)).toEqual(await manager.readEntry(sourceLeaf));
				expect(await inspected.readEntry(destinationEpoch!)).toMatchObject({
					type: "compaction",
					summary: "Retain the two exact inputs.",
				});
				expect(copiedVisibleMessages(await compileCopyContext(inspected))).toEqual(
					copiedVisibleMessages(await compileCopyContext(manager)),
				);
			} finally {
				await inspected.close();
			}
		} finally {
			releaseAck();
			await failed;
			binding.mockRestore();
			await destination?.close();
		}
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
