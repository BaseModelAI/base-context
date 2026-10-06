import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CanonicalContextCompiler,
	getCanonicalViewUnits,
	prepareCanonicalEpoch,
} from "../src/core/canonical-context.js";
import { appendContextEpoch } from "../src/core/context-epoch.js";
import { HistoryIndex } from "../src/core/history-index.js";
import { InferenceCoordinator } from "../src/core/inference-coordinator.js";
import { bindNativeEntryWriter } from "../src/core/session-entry-origin.js";
import { SessionManager } from "../src/core/session-manager.js";
import { compileCopyContext, copiedVisibleMessages } from "./canonical-context-fixtures.js";

describe("canonical source refusals", () => {
	let dir: string;
	let manager: SessionManager;
	let requests: InferenceCoordinator;
	let capture: InferenceCoordinator | undefined;
	let compiler: CanonicalContextCompiler;
	let secondEntryId: string;
	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "base-context-compile-limit-"));
		manager = await SessionManager.create(dir, dir);
		requests = new InferenceCoordinator(() => manager.bindRequestSink());
		compiler = new CanonicalContextCompiler();
		await manager.appendMessage({ role: "user", content: "one", timestamp: 1 });
		secondEntryId = await manager.appendMessage({ role: "user", content: "two", timestamp: 2 });
	});
	afterEach(async () => {
		try {
			await capture?.dispose();
			capture = undefined;
			await requests.dispose();
			await manager.close();
		} finally {
			vi.restoreAllMocks();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("refuses message, byte, and invalid retained boundaries before hydrating payloads", async () => {
		capture = requests.capture();
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
	});

	it("does not adopt the source cache when TaskFrame limits refuse the build", async () => {
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
		// Literal-aware frames inspect actual text, but rejected builds cannot adopt their source cache.
		expect(compiler.hasActiveEntry(secondEntryId)).toBe(false);
	});

	it("refuses an orphan tool result without changing canonical history", async () => {
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
	});

	it("does not grant native ownership from labels in ordinary tool intent data", async () => {
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
	});

	it("rejects stale source epochs and snapshots outside the captured branch", async () => {
		const orphanId = await manager.appendMessage({ role: "user", content: "sibling", timestamp: 3 });
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
	});

	it("keeps a failed copy's ACK on its destination without adopting it into the source", async () => {
		const epochLimits = { maxMessages: 16, maxSourceBytes: 64 * 1024 };
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
	});
});
