import { fauxAssistantMessage } from "@ponythewhite/base-context-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CustomMessage } from "../../../src/core/messages.js";
import { waitForHeadlessCompletion } from "../../../src/modes/headless-completion.js";
import { createHarness, getAssistantTexts, type Harness } from "../harness.js";

function terminalNotices(messages: readonly unknown[]): CustomMessage[] {
	return messages.filter(
		(message): message is CustomMessage =>
			typeof message === "object" &&
			message !== null &&
			"role" in message &&
			"customType" in message &&
			(message as { role?: unknown }).role === "custom" &&
			(message as { customType?: unknown }).customType === "rlm_child_terminal_notice",
	);
}

function gate(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("#617 subagent terminal agent messages", () => {
	let parent: Harness | undefined;
	let child: Harness | undefined;
	const releaseGates: Array<() => void> = [];

	afterEach(async () => {
		for (const release of releaseGates.splice(0)) release();
		await child?.cleanup();
		await parent?.cleanup();
		child = undefined;
		parent = undefined;
	});

	async function deleteChildDuringCompletion() {
		const runStarted = gate();
		const runFinished = gate();
		const cleanupStarted = gate();
		const cleanupFinished = gate();
		const childWaitStarted = gate();
		releaseGates.push(runFinished.resolve, cleanupFinished.resolve);
		child = await createHarness();
		const childPrompt = vi.spyOn(child.session, "promptAndWait").mockImplementation(async () => {
			runStarted.resolve();
			await runFinished.promise;
		});
		parent = await createHarness({
			serializedRefine: true,
			rlmDepth: 0,
			rlmMaxDepth: 1,
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child!.session }),
				deleteRlmSubagentRuntime: async (_id, session) => {
					cleanupStarted.resolve();
					await cleanupFinished.promise;
					await session?.disposeAsync();
				},
			},
		});
		const spawned = await parent.session.runRlmChild("wait until deleted", { name: "deleted-worker" });
		await runStarted.promise;
		const waitForChild = child.session.waitForRlmQuiescence.bind(child.session);
		vi.spyOn(child.session, "waitForRlmQuiescence").mockImplementation((...args) => {
			const waiting = waitForChild(...args);
			childWaitStarted.resolve();
			return waiting;
		});
		const completion = waitForHeadlessCompletion(parent.session, { waitForRlmQuiescence: true });
		const completed = vi.fn();
		void completion.then(completed, completed);
		await childWaitStarted.promise;
		await parent.session.deleteRlmSubagent(spawned.rlm_child_id);
		await cleanupStarted.promise;
		return { completion, completed, childPrompt, runFinished, cleanupFinished };
	}

	it("waits for owned child deletion cleanup and the resulting parent turn during headless completion", async () => {
		const { completion, completed, childPrompt, runFinished, cleanupFinished } = await deleteChildDuringCompletion();
		const followUpStarted = gate();
		const followUpFinished = gate();
		releaseGates.push(followUpFinished.resolve);
		parent!.setResponses([
			async () => {
				followUpStarted.resolve();
				await followUpFinished.promise;
				return fauxAssistantMessage("parent consumed the deletion");
			},
		]);
		expect(completed).not.toHaveBeenCalled();
		runFinished.resolve();
		await childPrompt.mock.results[0].value;
		expect(completed).not.toHaveBeenCalled();
		cleanupFinished.resolve();
		await followUpStarted.promise;
		expect(completed).not.toHaveBeenCalled();
		followUpFinished.resolve();
		await completion;
		expect(getAssistantTexts(parent!)).toEqual(["parent consumed the deletion"]);
		expect((await parent!.session.listRlmSubagents()).subagents).toEqual([]);
	});

	it("keeps root cancellation authoritative while owned child deletion cleanup is pending", async () => {
		const { completion, completed } = await deleteChildDuringCompletion();
		expect(completed).not.toHaveBeenCalled();
		parent!.session.requestAbort();
		await expect(completion).rejects.toThrow("RLM quiescence wait cancelled");
	});

	it("delivers a child completion without a reply through the private typed notice path", async () => {
		const childSessionName = "terminal-worker";
		const sendAgentMessage = vi.fn(async () => {
			throw new Error("synthesized terminal notices must not use agent_message");
		});
		child = await createHarness({
			agentMessageController: {
				listAgents: () => ({ agents: [] }),
				sendAgentMessage,
			},
		});
		parent = await createHarness({
			rlmDepth: 0,
			rlmMaxDepth: 1,
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child!.session }),
				deleteRlmSubagentRuntime: async () => {},
			},
		});
		child.setResponses([fauxAssistantMessage("child completed")]);

		const spawned = await parent.session.runRlmChild("finish without replying", { name: childSessionName });

		await expect.poll(() => terminalNotices(parent!.session.messages)).toHaveLength(1);
		expect(sendAgentMessage).not.toHaveBeenCalled();
		expect(terminalNotices(parent.session.messages)[0]).toMatchObject({
			customType: "rlm_child_terminal_notice",
			details: {
				kind: "completed_without_reply",
				childId: spawned.rlm_child_id,
				sessionName: childSessionName,
			},
			content: expect.stringContaining(
				`RLM child ${childSessionName} (${spawned.rlm_child_id}) completed without sending a reply`,
			),
		});
	});

	it("waits for the parent to consume a child terminal notice", async () => {
		const childSessionName = "headless-worker";
		const sendAgentMessage = vi.fn(async () => {
			throw new Error("synthesized terminal notices must not use agent_message");
		});
		child = await createHarness({
			agentMessageController: {
				listAgents: () => ({ agents: [] }),
				sendAgentMessage,
			},
		});
		parent = await createHarness({
			serializedRefine: true,
			rlmDepth: 0,
			rlmMaxDepth: 1,
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child!.session }),
				deleteRlmSubagentRuntime: async () => {},
			},
		});
		child.setResponses([fauxAssistantMessage("child completed")]);
		parent.setResponses([fauxAssistantMessage("parent consumed the child result")]);

		const spawned = await parent.session.runRlmChild("finish without replying", { name: childSessionName });
		await waitForHeadlessCompletion(parent.session, { waitForRlmQuiescence: true });

		expect(sendAgentMessage).not.toHaveBeenCalled();
		expect(terminalNotices(parent.session.messages)).toEqual([
			expect.objectContaining({
				details: expect.objectContaining({
					kind: "completed_without_reply",
					childId: spawned.rlm_child_id,
					sessionName: childSessionName,
				}),
			}),
		]);
		expect(getAssistantTexts(parent)).toEqual(["parent consumed the child result"]);
		expect(parent.session.hasRunningRlmChildren()).toBe(false);
	});
});
