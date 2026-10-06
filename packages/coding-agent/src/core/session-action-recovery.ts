import type { ImageContent, TextContent, UserMessage } from "@ponythewhite/base-context-ai";
import type { InputSource } from "./extensions/index.js";
import type { CustomMessage } from "./messages.js";
import type { NativeSkillSourceRef } from "./selected-skills.js";
import type {
	DeliveryPolicy,
	DeliveryRecord,
	SessionAction,
	SessionCommandPayload,
	SessionTurnPayload,
	WakePolicy,
} from "./session-action-store.js";
import type { NativeSubmittedInput } from "./session-entry-origin.js";
import type { SessionSlashCommand } from "./slash-commands.js";

type PreTurnCompactionTiming = "beforeModelSelection" | "afterModelSelection" | "skip";
type RefineBarrierPolicy = "always" | "ifInFlight" | "skip";

export interface CommitPreparationPolicy {
	initialRefineBarrier: RefineBarrierPolicy;
	flushPendingBashBeforeValidation: boolean;
	validateModelAndAuth: boolean;
	awaitPendingModelSelection: boolean;
	preTurnCompaction: PreTurnCompactionTiming;
	finalRefineBarrier: RefineBarrierPolicy;
}

export interface TurnExecutionPolicy {
	preparation: CommitPreparationPolicy;
	runBeforeAgentStart: boolean;
	nextTurnContextTiming: "preparation" | "commit" | "skip";
	preserveEmptyExtensionPrompt: boolean;
	completionIncludesRetryChain: boolean;
}

export interface RecoverableTurnPayload extends SessionTurnPayload {
	submitted?: NativeSubmittedInput;
	selectedSkillRef?: NativeSkillSourceRef;
	images?: ImageContent[];
	content?: (TextContent | ImageContent)[];
	customMessage?: CustomMessage;
	executionPolicy: TurnExecutionPolicy;
	queueVisible: boolean;
	acceptedAgentMessage: boolean;
	acceptedBeforeCompletion: boolean;
}

export interface RecoverableCommandPayload extends SessionCommandPayload {
	submitted?: NativeSubmittedInput;
	images?: ImageContent[];
}

export type RecoverableSessionAction = SessionAction<RecoverableTurnPayload | RecoverableCommandPayload>;
type QueuedAgentMessage = UserMessage | CustomMessage;

export const SESSION_ACTION_RECOVERY_FORMAT_VERSION = 1;
/** Only snapshots carrying the new native source binding require this current-format discriminator. */
export const SESSION_ACTION_SKILL_RECOVERY_FORMAT_VERSION = 2;

export interface SessionActionRecoveryRecord {
	id: string;
	role: DeliveryRecord["role"];
	message: QueuedAgentMessage;
	ownerActionId: string;
}

export type SessionActionRecoveryPayload =
	| {
			kind: "turn";
			submitted?: NativeSubmittedInput;
			selectedSkillRef?: NativeSkillSourceRef;
			text: string;
			preview?: string;
			records: SessionActionRecoveryRecord[];
			images?: ImageContent[];
			content?: (TextContent | ImageContent)[];
			customMessage?: CustomMessage;
			executionPolicy: TurnExecutionPolicy;
			queueVisible: boolean;
			acceptedAgentMessage: boolean;
			acceptedBeforeCompletion: boolean;
	  }
	| {
			kind: "session_command";
			submitted?: NativeSubmittedInput;
			text: string;
			command: SessionSlashCommand;
			images?: ImageContent[];
	  };

export interface SessionActionRecoveryAction {
	id: string;
	source: InputSource | "internal";
	delivery: DeliveryPolicy;
	wake: WakePolicy;
	payload: SessionActionRecoveryPayload;
	queueKey?: string;
	agentMessageId?: string;
	suppressAutonomousContinuation?: boolean;
}

export interface SessionActionRecoverySnapshot {
	formatVersion: typeof SESSION_ACTION_RECOVERY_FORMAT_VERSION | typeof SESSION_ACTION_SKILL_RECOVERY_FORMAT_VERSION;
	actions: SessionActionRecoveryAction[];
}

export function cloneCustomMessage(message: CustomMessage): CustomMessage {
	return {
		...message,
		content: Array.isArray(message.content) ? message.content.map((block) => ({ ...block })) : message.content,
	};
}

function cloneQueuedAgentMessage(message: QueuedAgentMessage): QueuedAgentMessage {
	if (message.role === "custom") return cloneCustomMessage(message);
	return {
		...message,
		content: Array.isArray(message.content) ? message.content.map((block) => ({ ...block })) : message.content,
	};
}

/** Serialize the queued actions selected by the owning store, without runtime preparation or delivery state. */
export function captureSessionActionRecovery(
	actions: readonly RecoverableSessionAction[],
): SessionActionRecoverySnapshot {
	return {
		formatVersion: actions.some((action) => action.payload.kind === "turn" && action.payload.selectedSkillRef)
			? SESSION_ACTION_SKILL_RECOVERY_FORMAT_VERSION
			: SESSION_ACTION_RECOVERY_FORMAT_VERSION,
		actions: actions.map((action) => ({
			id: action.id,
			source: action.source,
			delivery: action.delivery,
			wake: action.wake,
			...(action.queueKey ? { queueKey: action.queueKey } : {}),
			...(action.agentMessageId ? { agentMessageId: action.agentMessageId } : {}),
			...(action.suppressAutonomousContinuation ? { suppressAutonomousContinuation: true } : {}),
			payload:
				action.payload.kind === "turn"
					? {
							kind: "turn",
							text: action.payload.text,
							...(action.payload.selectedSkillRef
								? { selectedSkillRef: { ...action.payload.selectedSkillRef } }
								: {}),
							...(action.payload.submitted ? { submitted: structuredClone(action.payload.submitted) } : {}),
							...(action.payload.preview ? { preview: action.payload.preview } : {}),
							records: action.payload.records.map((record) => ({
								id: record.id,
								role: record.role,
								message: cloneQueuedAgentMessage(record.message),
								ownerActionId: record.ownerActionId,
							})),
							...(action.payload.images
								? {
										images: action.payload.images.map((image) => ({
											...image,
										})),
									}
								: {}),
							...(action.payload.content
								? {
										content: action.payload.content.map((block) => ({
											...block,
										})),
									}
								: {}),
							...(action.payload.customMessage
								? {
										customMessage: cloneCustomMessage(action.payload.customMessage),
									}
								: {}),
							executionPolicy: {
								...action.payload.executionPolicy,
								preparation: {
									...action.payload.executionPolicy.preparation,
								},
							},
							queueVisible: action.payload.queueVisible,
							acceptedAgentMessage: action.payload.acceptedAgentMessage,
							acceptedBeforeCompletion: action.payload.acceptedBeforeCompletion,
						}
					: {
							kind: "session_command",
							text: action.payload.text,
							...(action.payload.submitted ? { submitted: structuredClone(action.payload.submitted) } : {}),
							command: { ...action.payload.command },
							...(action.payload.images
								? {
										images: action.payload.images.map((image) => ({
											...image,
										})),
									}
								: {}),
						},
		})),
	};
}

/** Decode the whole snapshot before admission. The owner retains admission and scheduling responsibilities. */
export function restoreSessionActionRecovery(
	snapshot: SessionActionRecoverySnapshot,
	ownedActionIds: Iterable<string>,
): RecoverableSessionAction[] {
	if (
		(snapshot.formatVersion !== SESSION_ACTION_RECOVERY_FORMAT_VERSION &&
			snapshot.formatVersion !== SESSION_ACTION_SKILL_RECOVERY_FORMAT_VERSION) ||
		(snapshot.formatVersion === SESSION_ACTION_RECOVERY_FORMAT_VERSION &&
			snapshot.actions.some((action) => action.payload.kind === "turn" && action.payload.selectedSkillRef))
	) {
		throw new Error(`Unsupported session action recovery format version: ${snapshot.formatVersion}`);
	}
	const actionIds = new Set(ownedActionIds);
	const actions = snapshot.actions.map((recovered): RecoverableSessionAction => {
		if (actionIds.has(recovered.id)) throw new Error(`Duplicate session action id: ${recovered.id}`);
		actionIds.add(recovered.id);
		if (
			recovered.payload.kind === "turn" &&
			recovered.payload.records.some((record) => record.ownerActionId !== recovered.id)
		) {
			throw new Error(`Session action ${recovered.id} has invalid delivery correlation`);
		}
		const payload: RecoverableTurnPayload | RecoverableCommandPayload =
			recovered.payload.kind === "turn"
				? {
						kind: "turn",
						text: recovered.payload.text,
						...(recovered.payload.selectedSkillRef
							? { selectedSkillRef: { ...recovered.payload.selectedSkillRef } }
							: {}),
						...(recovered.payload.submitted ? { submitted: structuredClone(recovered.payload.submitted) } : {}),
						...(recovered.payload.preview ? { preview: recovered.payload.preview } : {}),
						records: recovered.payload.records.map((record) => ({
							id: record.id,
							role: record.role,
							message: cloneQueuedAgentMessage(record.message),
							started: false,
							durable: false,
							ownerActionId: record.ownerActionId,
						})),
						...(recovered.payload.images
							? {
									images: recovered.payload.images.map((image) => ({
										...image,
									})),
								}
							: {}),
						...(recovered.payload.content
							? {
									content: recovered.payload.content.map((block) => ({
										...block,
									})),
								}
							: {}),
						...(recovered.payload.customMessage
							? {
									customMessage: cloneCustomMessage(recovered.payload.customMessage),
								}
							: {}),
						executionPolicy: {
							...recovered.payload.executionPolicy,
							preparation: {
								...recovered.payload.executionPolicy.preparation,
							},
						},
						queueVisible: recovered.payload.queueVisible,
						acceptedAgentMessage: recovered.payload.acceptedAgentMessage,
						acceptedBeforeCompletion: recovered.payload.acceptedBeforeCompletion,
					}
				: {
						kind: "session_command",
						text: recovered.payload.text,
						...(recovered.payload.submitted ? { submitted: structuredClone(recovered.payload.submitted) } : {}),
						command: { ...recovered.payload.command },
						...(recovered.payload.images
							? {
									images: recovered.payload.images.map((image) => ({
										...image,
									})),
								}
							: {}),
					};
		return {
			id: recovered.id,
			source: recovered.source,
			delivery: recovered.delivery,
			wake: recovered.wake,
			payload,
			lifecycle: { state: "queued" },
			...(recovered.queueKey ? { queueKey: recovered.queueKey } : {}),
			...(recovered.agentMessageId ? { agentMessageId: recovered.agentMessageId } : {}),
			...(recovered.suppressAutonomousContinuation ? { suppressAutonomousContinuation: true } : {}),
		};
	});
	return actions;
}
