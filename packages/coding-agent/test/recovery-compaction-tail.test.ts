import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@ponythewhite/base-context-ai";
import { expect, it } from "vitest";
import {
	canonicalRecoveryBoundary,
	getCanonicalEpochContext,
	getCanonicalViewUnits,
	MissingRecoveryReplayContractError,
	prepareCanonicalEpoch,
	preparePublicContextWindow,
	prepareRecoveryCompaction,
} from "../src/core/canonical-context.js";
import { prepareViewCompaction } from "../src/core/compaction/index.js";
import { appendContextEpoch } from "../src/core/context-epoch.js";
import { bindNativeEntryWriter } from "../src/core/session-entry-origin.js";
import { SessionManager } from "../src/core/session-manager.js";
import { compileCopyContext } from "./canonical-context-fixtures.js";

const maxBytes = 2 * 1024 * 1024;

async function appendRecovery(manager: SessionManager, id: string) {
	const caller = {
		...fauxAssistantMessage(""),
		content: [{ type: "toolCall" as const, id, name: "prime_context", arguments: { action: "read" } }],
		stopReason: "toolUse" as const,
	};
	const callerId = await manager.appendMessage(caller);
	const result = {
		role: "toolResult" as const,
		toolCallId: id,
		toolName: "prime_context",
		content: [{ type: "text" as const, text: `Recovered report: ${id}` }],
		isError: false,
		timestamp: 2,
	};
	const resultId = await manager[bindNativeEntryWriter]().captureRecoveryExchange(id)({
		executionId: id,
		sourceOrder: 0,
		toolCallId: id,
		toolName: "prime_context",
		originalInput: { action: "read" },
		executedInput: { action: "read" },
		toolExecution: "sequential",
		executionOutcome: "completed",
		cancellationRequested: false,
		result,
	});
	return { callerId, caller, resultId, result };
}

it.each([false, true])(
	"compacts an accepted prefix without accepting its fresh recovery tail (public=%s)",
	async (publicWindow) => {
		const dir = mkdtempSync(join(tmpdir(), "base-context-recovery-tail-"));
		let manager = await SessionManager.create(dir, dir);
		try {
			await manager.appendMessage({ role: "user", content: "Earlier task", timestamp: 0 });
			await appendRecovery(manager, "accepted-report");
			const keptId = await manager.appendMessage({ role: "user", content: "Current task", timestamp: 3 });
			const input = await compileCopyContext(manager);
			const acceptedInput = publicWindow ? preparePublicContextWindow(input)!.messages : input;
			const accepted = prepareCanonicalEpoch(
				acceptedInput,
				getCanonicalViewUnits(acceptedInput)!.map((unit) => unit.id),
				"fixture-native-template/1",
				maxBytes,
				"message-groups",
				publicWindow,
			);
			const acceptance = manager.bindCompactionSink();
			try {
				await acceptance[appendContextEpoch](accepted.checkpoint, 100);
			} finally {
				await acceptance.release();
			}
			const fresh = await appendRecovery(manager, "unaccepted-report");
			const captured = await compileCopyContext(manager);
			const context = getCanonicalEpochContext(captured)!;
			expect(canonicalRecoveryBoundary(captured)).toBe(keptId);
			const preparation = prepareViewCompaction(
				captured,
				context.references.map((ref) => ref?.ref.entryId),
				await manager.readBranch(),
				{ enabled: true, reserveTokens: 64, keepRecentTokens: 1 },
				canonicalRecoveryBoundary(captured),
			)!;
			expect(preparation.firstKeptEntryId).toBe(keptId);
			const summarized = JSON.stringify([preparation.messagesToSummarize, preparation.turnPrefixMessages]);
			expect(summarized).toContain("accepted-report");
			expect(summarized).not.toContain("unaccepted-report");
			expect(() => prepareRecoveryCompaction(captured, fresh.callerId, maxBytes)).toThrow(
				"Recovery compaction must retain its unmeasured literal tail",
			);
			const checkpoint = prepareRecoveryCompaction(captured, keptId, maxBytes)!;
			expect(checkpoint.source).toEqual(context.source);
			expect(checkpoint.recoveryReplayThrough).toEqual(accepted.checkpoint.source);
			expect(checkpoint.continuation?.publicTailThrough).toEqual(
				publicWindow ? accepted.checkpoint.source : undefined,
			);
			const summary = manager.bindCompactionSink();
			try {
				await summary[appendContextEpoch](checkpoint, preparation.tokensBefore, {
					summary: "Earlier report summarized",
				});
			} finally {
				await summary.release();
			}
			const sessionFile = manager.getSessionFile()!;
			await manager.close();
			manager = await SessionManager.open(sessionFile, dir);
			const cold = await compileCopyContext(manager);
			expect(cold).toContainEqual(fresh.caller);
			expect(cold).toContainEqual(fresh.result);
			expect(getCanonicalEpochContext(cold)!.inheritedRecoveryCoverage ?? []).toEqual([]);
			expect(canonicalRecoveryBoundary(cold)).toBe(keptId);
			const copied = await SessionManager.forkFrom(sessionFile, dir, join(dir, "copy"));
			try {
				const copiedContext = getCanonicalEpochContext(await compileCopyContext(copied))!;
				expect(copiedContext.checkpoint?.recoveryReplayThrough?.sessionId).toBe(copied.getSessionId());
				expect(copiedContext.inheritedRecoveryCoverage ?? []).toEqual([]);
			} finally {
				await copied.close();
			}
			const repeated = prepareRecoveryCompaction(cold, keptId, maxBytes)!;
			expect(repeated.source).toEqual(getCanonicalEpochContext(cold)!.source);
			expect(repeated.recoveryReplayThrough).toEqual(accepted.checkpoint.source);
			expect(() => prepareRecoveryCompaction(cold, fresh.callerId, maxBytes)).toThrow(
				"Recovery compaction must retain its unmeasured literal tail",
			);
		} finally {
			await manager.close();
			rmSync(dir, { recursive: true, force: true });
		}
	},
);

it.each([undefined, "complete-context"] as const)(
	"refuses recovery without a usable replay contract (%s)",
	async (replayContract) => {
		const dir = mkdtempSync(join(tmpdir(), "base-context-recovery-contract-"));
		const manager = await SessionManager.create(dir, dir);
		try {
			await manager.appendMessage({ role: "user", content: "Earlier task", timestamp: 0 });
			if (replayContract) {
				const input = await compileCopyContext(manager);
				const accepted = prepareCanonicalEpoch(
					input,
					getCanonicalViewUnits(input)!.map((unit) => unit.id),
					"fixture-native-template/1",
					maxBytes,
					replayContract,
				);
				const sink = manager.bindCompactionSink();
				try {
					await sink[appendContextEpoch](accepted.checkpoint, 100);
				} finally {
					await sink.release();
				}
			}
			await appendRecovery(manager, "unaccepted-report");
			const inputForRefusal = await compileCopyContext(manager);
			expect(() => canonicalRecoveryBoundary(inputForRefusal)).toThrow(MissingRecoveryReplayContractError);
		} finally {
			await manager.close();
			rmSync(dir, { recursive: true, force: true });
		}
	},
);
