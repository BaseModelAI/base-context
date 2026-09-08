import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@ponythewhite/base-context-agent";
import type { AssistantMessage } from "@ponythewhite/base-context-ai";
import { expect, it, vi } from "vitest";
import {
	CanonicalContextCompiler,
	getCanonicalMessageSource,
	getCanonicalViewUnits,
} from "../src/core/canonical-context.js";
import { HistoryIndex } from "../src/core/history-index.js";
import { InferenceCoordinator } from "../src/core/inference-coordinator.js";
import { type CustomMessage, convertToLlm } from "../src/core/messages.js";
import {
	appendSentAgentMessageToToolResult,
	IPYTHON_SENT_AGENT_MESSAGE_CUSTOM_ENTRY,
} from "../src/core/session-context-updates.js";
import { bindNativeEntryWriter } from "../src/core/session-entry-origin.js";
import { buildSessionContext, SessionManager } from "../src/core/session-manager.js";
import { TASK_STATE_CUSTOM_TYPE, TASK_STATE_SCHEMA } from "../src/core/task-state.js";

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
					source: { entryId: goalEntryId, field: "/data", qualification: "native-admission" },
					kind: "user_goal_revision",
					authority: "user",
					state: "active",
					itemId: goal.goalId,
					text: goal.objective,
				},
			],
			recovery: { sessionId: manager.getSessionId(), leafId: proposalEntryId },
		});
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
		// Rendered input can be callback-expanded; only the separately projected submitted clause has user authority.
		expect(
			getCanonicalViewUnits(withSecondDelta)!.find((unit) => unit.exactSources.includes(laterInputId))!.authority,
		).toBe("unrecorded");
		const providerMessages = convertToLlm(withSecondDelta);
		for (const frame of secondFrames) {
			expect(providerMessages[withSecondDelta.indexOf(frame)]).toEqual({
				role: "user",
				content: [{ type: "text", text: frameText(frame) }],
				timestamp: frame.timestamp,
			});
		}
		expect(await manager.readEntries()).toEqual(sourceBeforeSecondDelta);
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
