import type { AgentMessage } from "@ponythewhite/base-context-agent";
import type { AssistantMessage } from "@ponythewhite/base-context-ai";
import {
	CanonicalContextCompiler,
	getCanonicalViewUnits,
	prepareCanonicalEpoch,
} from "../src/core/canonical-context.js";
import { appendContextEpoch } from "../src/core/context-epoch.js";
import { InferenceCoordinator } from "../src/core/inference-coordinator.js";
import { type CustomMessage, convertToLlm } from "../src/core/messages.js";
import {
	appendSentAgentMessageToToolResult,
	IPYTHON_SENT_AGENT_MESSAGE_CUSTOM_ENTRY,
} from "../src/core/session-context-updates.js";
import { bindNativeEntryWriter } from "../src/core/session-entry-origin.js";
import { buildSessionContext, type SessionManager } from "../src/core/session-manager.js";
import { TASK_STATE_CUSTOM_TYPE, TASK_STATE_SCHEMA } from "../src/core/task-state.js";

export const contextLimits = { maxMessages: 136, maxSourceBytes: 2 * 1024 * 1024 };

export function isTaskFrame(message: AgentMessage): message is CustomMessage {
	return message.role === "custom" && message.customType === "task_frame";
}

export function frameText(message: AgentMessage): string {
	if (!isTaskFrame(message) || typeof message.content !== "string")
		throw new Error("fixture expected a text task frame");
	return message.content;
}

export async function appendPagedContext(manager: SessionManager) {
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
	return { assistant, assistantId, aggregate, expected, sentMessage };
}

// Synthetic privileged compiler-storage inputs, not evidence of physical AS admission.
export async function appendTaskGoal(manager: SessionManager) {
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
	return { writer, goal, goalEntryId, proposalEntryId };
}

export async function compileFixtureContext(
	manager: SessionManager,
	compiler = new CanonicalContextCompiler(),
	omittedIds?: ReadonlySet<string>,
) {
	const requests = new InferenceCoordinator(() => manager.bindRequestSink());
	const captured = requests.capture();
	try {
		return await captured.readHistory((view) => compiler.compile(view, contextLimits, omittedIds));
	} finally {
		await captured.dispose();
		await requests.dispose();
	}
}

export async function appendTaskCompletion(
	manager: SessionManager,
	assistant: AssistantMessage,
	goal: Awaited<ReturnType<typeof appendTaskGoal>>["goal"],
) {
	const writer = manager[bindNativeEntryWriter]();
	const completionEntryId = await writer.captureGoalOperation({
		version: 1,
		kind: "goal_operation",
		operation: "complete",
		actor: "runtime",
		previousGoalId: goal.goalId,
	})({ ...goal, active: false, status: "complete" });
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
	return { completionEntryId, earlierInput, omittedAssistantId, omittedIds };
}

export async function appendLaterInput(manager: SessionManager) {
	const writer = manager[bindNativeEntryWriter]();
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
	return { laterInput, laterInputId };
}

export async function createTaskFrameFixture(manager: SessionManager) {
	const paged = await appendPagedContext(manager);
	const task = await appendTaskGoal(manager);
	const compiler = new CanonicalContextCompiler();
	const withFrame = await compileFixtureContext(manager, compiler);
	const baseText = frameText(withFrame.find(isTaskFrame)!);
	return { ...paged, ...task, compiler, withFrame, baseText };
}

export async function createTaskRevisionFixture(manager: SessionManager) {
	const base = await createTaskFrameFixture(manager);
	const completion = await appendTaskCompletion(manager, base.assistant, base.goal);
	const withDelta = await compileFixtureContext(manager, base.compiler, completion.omittedIds);
	const revisionText = frameText(withDelta.filter(isTaskFrame)[1]);
	const later = await appendLaterInput(manager);
	const withSecondDelta = await compileFixtureContext(manager, base.compiler, completion.omittedIds);
	const secondFrames = withSecondDelta.filter(isTaskFrame);
	return { ...base, ...completion, ...later, withDelta, revisionText, withSecondDelta, secondFrames };
}

export async function createTaskEpochFixture(manager: SessionManager): Promise<
	Awaited<ReturnType<typeof createTaskRevisionFixture>> & {
		prepared: ReturnType<typeof prepareCanonicalEpoch>;
		epochId: string;
	}
> {
	const fixture = await createTaskRevisionFixture(manager);
	const prepared = prepareCanonicalEpoch(
		fixture.withSecondDelta,
		getCanonicalViewUnits(fixture.withSecondDelta)!.map((unit) => unit.id),
		"fixture-native-template/1",
		contextLimits.maxSourceBytes,
	);
	const sink = manager.bindCompactionSink();
	try {
		const epochId = await sink[appendContextEpoch](prepared.checkpoint, 100);
		return { ...fixture, prepared, epochId };
	} finally {
		await sink.release();
	}
}

export function copiedVisibleMessages(messages: readonly AgentMessage[]) {
	// Rebuilt checkpoint timestamps are new. Selected literal bodies and summary options are not.
	return convertToLlm(
		messages.map((message) => (message.role === "compactionSummary" ? { ...message, timestamp: 0 } : message)),
	);
}

export async function compileCopyContext(manager: SessionManager, purpose: "request" | "read" = "request") {
	const requests = new InferenceCoordinator(() => manager.bindRequestSink());
	const captured = requests.capture();
	try {
		return await captured.readHistory((history) =>
			new CanonicalContextCompiler().compile(
				history,
				{ maxMessages: 256, maxSourceBytes: 2 * 1024 * 1024 },
				undefined,
				{},
				undefined,
				"on",
				false,
				purpose,
			),
		);
	} finally {
		await captured.dispose();
		await requests.dispose();
	}
}
