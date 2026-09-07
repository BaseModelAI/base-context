import type { ImageContent, TextContent } from "@ponythewhite/base-context-ai";

/** The submitted input before native transforms; absence does not imply an empty submission. */
export interface NativeSubmittedInput {
	text: string;
	content?: (TextContent | ImageContent)[];
	images?: ImageContent[];
}

/** Captured by native admission/control code, outside arbitrary message/custom data. */
export type NativeEntryOrigin =
	| {
			version: 1;
			kind: "input";
			actionId: string;
			recordId: string;
			inputSource: "interactive" | "rpc" | "extension" | "internal";
			recordRole: "primary" | "prefix" | "next_turn";
			submitted?: NativeSubmittedInput;
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
