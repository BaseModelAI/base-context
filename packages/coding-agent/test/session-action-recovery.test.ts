import type { ImageContent } from "@ponythewhite/base-context-ai";
import { describe, expect, it } from "vitest";
import {
	captureSessionActionRecovery,
	type RecoverableCommandPayload,
	type RecoverableTurnPayload,
	restoreSessionActionRecovery,
	SESSION_ACTION_RECOVERY_FORMAT_VERSION,
	SESSION_ACTION_SKILL_RECOVERY_FORMAT_VERSION,
	type SessionActionRecoverySnapshot,
} from "../src/core/session-action-recovery.js";
import type { SessionAction } from "../src/core/session-action-store.js";

function recoveryActions(): [SessionAction<RecoverableTurnPayload>, SessionAction<RecoverableCommandPayload>] {
	const image: ImageContent = { type: "image", data: "encoded-image", mimeType: "image/png" };
	return [
		{
			id: "turn-1",
			source: "interactive",
			delivery: "next_turn_boundary",
			wake: "external_resume",
			queueKey: "queued-turn",
			agentMessageId: "agent-message-1",
			suppressAutonomousContinuation: true,
			lifecycle: { state: "queued" },
			payload: {
				kind: "turn",
				text: "expanded prompt",
				preview: "visible preview",
				submitted: {
					text: "original prompt",
					content: [{ type: "text", text: "original prompt" }],
					images: [image],
				},
				images: [image],
				content: [{ type: "text", text: "expanded prompt" }, image],
				customMessage: {
					role: "custom",
					customType: "context",
					content: [{ type: "text", text: "context" }],
					display: false,
					timestamp: 1,
				},
				records: [
					{
						id: "primary-1",
						role: "primary",
						message: { role: "user", content: [{ type: "text", text: "expanded prompt" }], timestamp: 1 },
						started: false,
						durable: false,
						ownerActionId: "turn-1",
					},
					{
						id: "prefix-1",
						role: "prefix",
						message: { role: "custom", customType: "prefix", content: "prefix", display: false, timestamp: 1 },
						started: false,
						durable: false,
						ownerActionId: "turn-1",
					},
				],
				executionPolicy: {
					preparation: {
						initialRefineBarrier: "always",
						flushPendingBashBeforeValidation: true,
						validateModelAndAuth: true,
						awaitPendingModelSelection: true,
						preTurnCompaction: "afterModelSelection",
						finalRefineBarrier: "ifInFlight",
					},
					runBeforeAgentStart: true,
					nextTurnContextTiming: "preparation",
					preserveEmptyExtensionPrompt: false,
					completionIncludesRetryChain: true,
				},
				queueVisible: true,
				acceptedAgentMessage: false,
				acceptedBeforeCompletion: true,
			},
		},
		{
			id: "command-1",
			source: "internal",
			delivery: "when_run_idle",
			wake: "on_lower_boundary",
			lifecycle: { state: "queued" },
			payload: {
				kind: "session_command",
				text: "/compact focus",
				submitted: { text: "/compact focus", images: [image] },
				command: { name: "compact", args: "focus", text: "/compact focus" },
				images: [image],
			},
		},
	];
}

describe("session action recovery codec", () => {
	it("round-trips turns, commands and skill bindings while copying input and policy fields", () => {
		const [turn, command] = recoveryActions();
		const runtimeTurn = { ...turn, payload: { ...turn.payload, captureRunMessages: new Set() } };
		const snapshot = captureSessionActionRecovery([runtimeTurn, command]);
		expect(snapshot.formatVersion).toBe(SESSION_ACTION_RECOVERY_FORMAT_VERSION);
		expect(snapshot.actions[0]?.payload).not.toHaveProperty("captureRunMessages");
		expect(snapshot.actions[0]).not.toHaveProperty("lifecycle");
		const restored = restoreSessionActionRecovery(snapshot, []);
		expect(restored).toEqual([turn, command]);
		expect(captureSessionActionRecovery(restored)).toEqual(snapshot);

		const capturedPayload = snapshot.actions[0]!.payload;
		const payload = restored[0]!.payload;
		if (capturedPayload.kind !== "turn" || payload.kind !== "turn") throw new Error("Expected recovered turn");
		expect(capturedPayload.records[0]).not.toHaveProperty("durable");
		expect(capturedPayload.content).not.toBe(turn.payload.content);
		expect(capturedPayload.submitted?.images?.[0]).not.toBe(turn.payload.submitted?.images?.[0]);
		expect(capturedPayload.executionPolicy.preparation).not.toBe(turn.payload.executionPolicy.preparation);
		expect(payload.content).not.toBe(capturedPayload.content);
		expect(payload.records[0]!.message).not.toBe(turn.payload.records[0]!.message);
		expect(payload.content).not.toBe(turn.payload.content);
		expect(payload.images?.[0]).not.toBe(turn.payload.images?.[0]);
		expect(payload.customMessage?.content).not.toBe(turn.payload.customMessage?.content);
		payload.submitted!.images![0]!.data = "changed";
		payload.executionPolicy.preparation.validateModelAndAuth = false;
		expect(captureSessionActionRecovery([turn, command])).toEqual(snapshot);
		expect(captureSessionActionRecovery(restored)).not.toEqual(snapshot);

		turn.payload.selectedSkillRef = { sessionId: "session-1", sessionFile: "/session.jsonl", entryId: "skill-1" };
		const skillSnapshot = captureSessionActionRecovery([turn]);
		expect(skillSnapshot.formatVersion).toBe(SESSION_ACTION_SKILL_RECOVERY_FORMAT_VERSION);
		expect(restoreSessionActionRecovery(skillSnapshot, [])).toEqual([turn]);
		const skillPayload = skillSnapshot.actions[0]!.payload;
		if (skillPayload.kind !== "turn") throw new Error("Expected recovered skill turn");
		expect(skillPayload.selectedSkillRef).not.toBe(turn.payload.selectedSkillRef);
		turn.payload.selectedSkillRef = { ...turn.payload.selectedSkillRef, entryId: "skill-2" };
		expect(skillSnapshot.actions[0]?.payload).toMatchObject({ selectedSkillRef: { entryId: "skill-1" } });
	});

	it("rejects unsupported versions, duplicate ids and delivery records owned by another action", () => {
		const [turn] = recoveryActions();
		const snapshot = captureSessionActionRecovery([turn]);
		const owned = new Set([turn.id]);
		expect(() => restoreSessionActionRecovery(snapshot, owned)).toThrow("Duplicate session action id: turn-1");
		expect(owned).toEqual(new Set([turn.id]));
		expect(() =>
			restoreSessionActionRecovery({ ...snapshot, actions: [...snapshot.actions, ...snapshot.actions] }, []),
		).toThrow("Duplicate session action id: turn-1");
		expect(() =>
			restoreSessionActionRecovery(
				{ ...snapshot, formatVersion: -1 } as unknown as SessionActionRecoverySnapshot,
				[],
			),
		).toThrow("Unsupported session action recovery format version: -1");

		turn.payload.selectedSkillRef = { sessionId: "session-1", sessionFile: undefined, entryId: "skill-1" };
		const skillSnapshot = captureSessionActionRecovery([turn]);
		expect(() =>
			restoreSessionActionRecovery({ ...skillSnapshot, formatVersion: SESSION_ACTION_RECOVERY_FORMAT_VERSION }, []),
		).toThrow("Unsupported session action recovery format version: 1");
		turn.payload.records[0]!.ownerActionId = "another-turn";
		expect(() => restoreSessionActionRecovery(captureSessionActionRecovery([turn]), [])).toThrow(
			"Session action turn-1 has invalid delivery correlation",
		);
	});
});
