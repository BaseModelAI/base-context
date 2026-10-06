import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CanonicalContextCompiler,
	getCanonicalEpochContext,
	getCanonicalViewUnits,
} from "../src/core/canonical-context.js";
import { prepareViewCompaction } from "../src/core/compaction/index.js";
import { InferenceCoordinator } from "../src/core/inference-coordinator.js";
import { convertToLlm } from "../src/core/messages.js";
import { SessionManager } from "../src/core/session-manager.js";
import { type CompiledTaskFrame, compileTaskFrame, taskFrameLimits } from "../src/core/task-frame.js";
import { readTaskStateFromView } from "../src/core/task-state-reader.js";
import { closeViewSelection } from "../src/core/view-units.js";
import {
	appendPagedContext,
	appendTaskGoal,
	contextLimits,
	createTaskEpochFixture,
	createTaskFrameFixture,
	frameText,
	isTaskFrame,
} from "./canonical-context-fixtures.js";

describe("canonical TaskFrame rendering", () => {
	let dir: string;
	let manager: SessionManager;
	let requests: InferenceCoordinator;
	let capture: InferenceCoordinator | undefined;
	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "base-context-task-frame-"));
		manager = await SessionManager.create(dir, dir);
		requests = new InferenceCoordinator(() => manager.bindRequestSink());
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

	it("renders only source-backed task rows and hides physical source metadata", async () => {
		const { expected } = await appendPagedContext(manager);
		const { goal, goalEntryId, proposalEntryId } = await appendTaskGoal(manager);
		const compiler = new CanonicalContextCompiler();
		const frameLimits = contextLimits;
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
		expect(baseFrames.every((message) => message.display === false)).toBe(true);
	});

	it("anchors sparse revisions to emitted input and does not repeat later visible input", async () => {
		const { writer, goal, assistant, compiler, expected, baseText, goalEntryId } =
			await createTaskFrameFixture(manager);
		const frameLimits = contextLimits;
		capture = requests.capture();
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
		expect(secondFrames).toHaveLength(2);
		expect(secondFrames.every((message) => message.display === false)).toBe(true);
		expect(secondFrames.map(frameText)).toEqual([baseText, revisionText]);
		expect(secondFrames.map(frameText).join("\n")).not.toContain(laterInput.content);
		const earlierIndexNow = withSecondDelta.findIndex(
			(message) => message.role === "user" && message.content === earlierInput.content,
		);
		const laterIndex = withSecondDelta.findIndex(
			(message) => message.role === "user" && message.content === laterInput.content,
		);
		expect(earlierIndexNow).toBe(earlierIndex);
		expect(withSecondDelta[earlierIndexNow - 1]).toBe(secondFrames[1]);
		expect(withSecondDelta[laterIndex - 1]).toEqual(earlierInput);
		expect(withSecondDelta[laterIndex]).toEqual(laterInput);
		expect(compiler.hasActiveEntry(omittedAssistantId)).toBe(true);
		expect(withSecondDelta.filter((message) => !isTaskFrame(message))).toEqual([
			...expected,
			earlierInput,
			laterInput,
		]);
		expect(withSecondDelta).toHaveLength(134);
		const previousFrameUnits = getCanonicalViewUnits(withDelta)!.filter((unit) => unit.kind === "task-frame");
		const nextFrameUnits = getCanonicalViewUnits(withSecondDelta)!.filter((unit) => unit.kind === "task-frame");
		expect(nextFrameUnits.slice(0, 2).map((unit) => [unit.id, unit.sourceRevision])).toEqual(
			previousFrameUnits.map((unit) => [unit.id, unit.sourceRevision]),
		);
		expect(nextFrameUnits[1].requiredVisibleDependencies).toContain(nextFrameUnits[0].id);
		const providerUnits = getCanonicalViewUnits(withSecondDelta)!;
		const closedUnits = closeViewSelection(providerUnits, [nextFrameUnits[1].id], {
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
	});

	it("rebuilds an ACKed task frame after cold replay and preserves compaction inputs", async () => {
		const { prepared, secondFrames, earlierInput, laterInputId, epochId } = await createTaskEpochFixture(manager);
		const frameLimits = contextLimits;
		expect(await manager.readBranchHistory((history) => history.get(epochId))).toMatchObject({
			qualification: "native-context-epoch",
		});
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
		} finally {
			await resumed.dispose();
			await resumedRequests.dispose();
			await reopened.close();
		}
	});
});
