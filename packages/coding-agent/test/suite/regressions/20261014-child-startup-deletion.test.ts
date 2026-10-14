import { fauxAssistantMessage } from "@ponythewhite/base-context-ai";
import { describe, expect, it, vi } from "vitest";
import { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.js";
import type { AgentSessionServices } from "../../../src/core/agent-session-services.js";
import { waitForHeadlessCompletion } from "../../../src/modes/headless-completion.js";
import { createHarness, type Harness } from "../harness.js";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("child deletion during failed startup", () => {
	it("cleans the admitted child when startup and its first cleanup fail before publication", async () => {
		const parent = await createHarness({ rlmDepth: 0, rlmMaxDepth: 2 });
		const services = { cwd: parent.tempDir, agentDir: parent.tempDir } as AgentSessionServices;
		const entered = deferred();
		const release = deferred();
		let child: Harness | undefined;
		const runtime = new AgentSessionRuntime(parent.session, services, async ({ sessionManager, sessionOptions }) => {
			child = await createHarness({
				sessionManager,
				rlmDepth: 1,
				rlmMaxDepth: 2,
				rlmChildAdmission: sessionOptions!.rlmChildAdmission,
			});
			vi.spyOn(child.session, "disposeAsync").mockRejectedValueOnce(new Error("first cleanup failed"));
			entered.resolve();
			await release.promise;
			throw new Error("startup failed");
		});
		try {
			await parent.session.setRlmMaxSubagents(1);
			parent.setResponses([fauxAssistantMessage("Read deletion outcome.")]);
			const handle = await parent.session.runRlmChild("task", { name: "startup-child" });
			await entered.promise;
			await parent.session.deleteRlmSubagent(handle.rlm_child_id);
			release.resolve();
			await waitForHeadlessCompletion(parent.session, { waitForRlmQuiescence: true, timeoutMs: 3000 });
			expect(Reflect.get(child!.session, "_disposed")).toBe(true);
			const admission = await parent.session.reserveRlmChildAdmission();
			await admission.settle();
		} finally {
			release.resolve();
			vi.restoreAllMocks();
			await child?.cleanup();
			await runtime.dispose();
			await parent.cleanup();
		}
	});
});
