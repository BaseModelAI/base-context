import type { FinalizedToolExchange, ToolInvocation } from "@ponythewhite/base-context-agent";
import type { ImageContent, Message, TextContent } from "@ponythewhite/base-context-ai";

import type { CustomMessage } from "./messages.js";
import type { ContextEpochEntryRef } from "./request-events.js";
import type { CapturedSkillSelectionWriter, NativeSkillSourceRef } from "./selected-skills.js";

/** The submitted input before native transforms; absence does not imply an empty submission. */
export interface NativeSubmittedInput {
	text: string;
	content?: (TextContent | ImageContent)[];
	images?: ImageContent[];
}

/** Descriptive origin fields. Positive qualification comes from the native writer, never this shape alone. */
export type NativeEntryOrigin =
	| {
			version: 1;
			kind: "input";
			actionId: string;
			recordId: string;
			inputSource: "interactive" | "rpc" | "extension" | "internal";
			recordRole: "primary" | "prefix" | "next_turn";
			submitted?: NativeSubmittedInput;
			/** From the real expansion/action owner, never inferred from the input text. */
			selectedSkillRef?: NativeSkillSourceRef;
	  }
	| {
			version: 1;
			kind: "goal_operation";
			operation: "create" | "revise" | "complete" | "pause" | "resume" | "clear";
			actor: "interactive" | "rpc" | "extension" | "internal" | "runtime";
			actionId?: string;
			submittedText?: string;
			previousGoalId?: string;
	  };

/** Internal host binding; not an option on ordinary raw append APIs. */
export const bindNativeEntryWriter = Symbol("bindNativeEntryWriter");

export type CapturedNativeMessageWrite = (message: Message | CustomMessage) => Promise<string>;
export type CapturedNativeGoalWrite = (goal: unknown) => Promise<string>;

export interface NativeEntryWriter {
	/** Only actual host command/cell selection producers obtain this captured writer. */
	captureSkillSelection(): CapturedSkillSelectionWriter;
	/** Optional provenance qualifies only the original selected owner; all writes retain the captured generation. */
	captureToolInvocation(
		assistant?: ContextEpochEntryRef & { sessionFile: string | undefined },
	): (invocation: ToolInvocation) => Promise<string>;
	captureToolExchange(executionId: string): (exchange: FinalizedToolExchange) => Promise<string>;
	/** Separate from input/goal admission. The bound execution owner alone uses this writer. */
	captureRecoveryExchange(executionId: string): (exchange: FinalizedToolExchange) => Promise<string>;
	captureMessage(origin: Extract<NativeEntryOrigin, { kind: "input" }>): CapturedNativeMessageWrite;
	captureGoalOperation(origin: Extract<NativeEntryOrigin, { kind: "goal_operation" }>): CapturedNativeGoalWrite;
}
