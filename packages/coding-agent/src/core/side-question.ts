import { Agent, type AgentMessage } from "@ponythewhite/base-context-agent";
import type { AssistantMessage, UserMessage } from "@ponythewhite/base-context-ai";
import { bindAuxiliaryInferenceStream } from "./inference-coordinator.js";

export type SideQuestionStatus = "running" | "complete" | "cancelled" | "error";

export interface SideQuestionEvent {
	id: string;
	question: string;
	answer: string;
	status: SideQuestionStatus;
	errorMessage?: string;
}

export interface SideQuestionTurn {
	question: string;
	answer: string;
}

export interface SideQuestionRun {
	done: Promise<void>;
	abort(): void;
}

const SIDE_QUESTION_INSTRUCTION =
	"Answer this side question using only the conversation context above. Do not use tools. The user may send follow-up side questions; none of this side conversation is added to the main session.";

function sideQuestionPrompt(question: string, isFirstTurn: boolean): string {
	const body = isFirstTurn ? `${SIDE_QUESTION_INSTRUCTION}\n\n${question}` : question;
	return `<side_question>\n${body}\n</side_question>`;
}

function readAssistantText(message: AgentMessage): string {
	if (message.role !== "assistant") {
		return "";
	}
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

export function startSideQuestion(
	parent: Agent,
	id: string,
	question: string,
	onEvent: (event: SideQuestionEvent) => void | Promise<void>,
	previousTurns: SideQuestionTurn[] = [],
): SideQuestionRun {
	const selectedModel = parent.state.model;
	if (!selectedModel) {
		throw new Error("Select a model before asking a side question");
	}

	const model = { ...selectedModel, cost: { ...selectedModel.cost } };

	// Each turn re-clones the live main conversation, so follow-ups always see
	// the newest main-thread context; earlier side turns are replayed after it.
	const previousTurnMessages: AgentMessage[] = previousTurns.flatMap((turn, index) => [
		{
			role: "user",
			content: [{ type: "text", text: sideQuestionPrompt(turn.question, index === 0) }],
			timestamp: Date.now(),
		} satisfies UserMessage,
		{
			role: "assistant",
			content: [{ type: "text", text: turn.answer }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		} satisfies AssistantMessage,
	]);

	const initialMessages = [...structuredClone(parent.state.messages), ...previousTurnMessages];
	const auxiliaryStream = bindAuxiliaryInferenceStream(parent.streamFn, {
		purpose: "other",
		purposeDetail: "side-question",
	});
	const sideAgent = new Agent({
		initialState: {
			model,
			systemPrompt: parent.state.systemPrompt,
			messages: initialMessages,
			thinkingLevel: "off",
			serviceTier: parent.state.serviceTier,
			tools: [],
		},
		convertToLlm: parent.convertToLlm,
		transformContext: parent.transformContext,
		// The side transcript stays separate; inference still belongs to the subject session.
		streamFn: auxiliaryStream,
		getApiKey: parent.getApiKey,
		onPayload: parent.onPayload,
		onResponse: parent.onResponse,
		shouldStopAfterTurn: () => true,
		sessionId: parent.sessionId,
		thinkingBudgets: parent.thinkingBudgets,
		transport: "sse",
		maxRetryDelayMs: parent.maxRetryDelayMs,
		toolExecution: parent.toolExecution,
	});

	let answer = "";
	let abortRequested = false;
	let started = false;
	const emit = (status: SideQuestionStatus, errorMessage?: string) =>
		onEvent({ id, question, answer, status, ...(errorMessage ? { errorMessage } : {}) });

	let eventQueue: Promise<void> = Promise.resolve();
	const unsubscribe = sideAgent.subscribe((event) => {
		if (event.type !== "message_update" && event.type !== "message_end") {
			return;
		}
		const nextAnswer = readAssistantText(event.message);
		if (nextAnswer === answer) {
			return;
		}
		answer = nextAnswer;
		const update = { id, question, answer, status: "running" as const };
		eventQueue = eventQueue.then(() => onEvent(update));
		void eventQueue.catch(() => undefined);
	});

	const prompt = sideQuestionPrompt(question, previousTurns.length === 0);
	const done = Promise.resolve()
		.then(() => emit("running"))
		.then(async () => {
			if (abortRequested) {
				await emit("cancelled");
				return;
			}
			started = true;
			await sideAgent.prompt(prompt);
			await eventQueue;
			if (abortRequested) {
				await emit("cancelled");
				return;
			}
			if (sideAgent.state.errorMessage) {
				await emit("error", sideAgent.state.errorMessage);
				return;
			}
			await emit("complete");
		})
		.catch(async (error) => {
			const errorMessage = error instanceof Error ? error.message : String(error);
			await Promise.resolve(
				emit(abortRequested ? "cancelled" : "error", abortRequested ? undefined : errorMessage),
			).catch(() => undefined);
		})
		.finally(async () => {
			unsubscribe();
			try {
				await eventQueue;
			} finally {
				await auxiliaryStream.dispose();
			}
		});

	return {
		done,
		abort() {
			abortRequested = true;
			if (started) {
				sideAgent.abort();
			}
		},
	};
}
