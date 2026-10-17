import { fauxAssistantMessage } from "@ponythewhite/base-context-ai";
import { describe, expect, it, vi } from "vitest";
import { CanonicalContextCompiler } from "../../../src/core/canonical-context.js";
import { InferenceCoordinator } from "../../../src/core/inference-coordinator.js";
import { normalizeTaskContract, renderTaskContract } from "../../../src/core/task-contract.js";
import { TASK_FRAME_CUSTOM_TYPE } from "../../../src/core/task-frame.js";
import { readTaskStateFromView } from "../../../src/core/task-state-reader.js";
import { contextLimits } from "../../canonical-context-fixtures.js";
import { createHarness } from "../harness.js";

describe("delegated task contract context", () => {
	it("carries the contract into the child and retains descriptive context after compaction", async () => {
		const harness = await createHarness({ persistSession: true });
		const contract = normalizeTaskContract({
			rules: ["Keep the supplied serial field"],
			assumptions: ["Do not infer the asset age"],
			integration_owner: "parent",
			stages: [
				{
					name: "read records",
					input_meanings: { serial: "Source identifier as text" },
					output_meanings: { serial: "Unchanged identifier, including leading zeros" },
					assumptions: ["Source ordering is intentional"],
				},
			],
			boundary_case: {
				description: "Leading-zero identifier through the consumer CLI",
				expected_behavior: "Emit exactly 00123, not 123",
				consumer: "Transferred CLI",
				runtime: "Consumer .venv Python",
				cwd: "/srv/consumer",
			},
		});
		try {
			harness.setResponses([fauxAssistantMessage("Prepared"), fauxAssistantMessage("Notice handled")]);
			const result = await harness.session.runRlmChild("Inspect the claim", {
				name: "claim-worker",
				task_contract: contract,
			});
			await harness.session.waitForRlmQuiescence();
			const child = harness.session.getRlmChildSession(result.rlm_child_id)!;
			const entries = await child.sessionManager.readBranch();
			const spawn = entries.find((entry) => entry.type === "custom_message" && entry.customType === "agent_message");
			expect(spawn).toMatchObject({
				content: expect.stringContaining(renderTaskContract(contract)),
				details: { taskContract: contract },
			});
			const kept = await child.sessionManager.appendMessage({
				role: "user",
				content: "Continue from the prepared result",
				timestamp: 100,
			});
			await child.sessionManager.appendCompaction("Prior work summarized without the brief", kept, 1000);
			const requests = new InferenceCoordinator(() => child.sessionManager.bindRequestSink());
			const capture = requests.capture();
			try {
				const state = await capture.readHistory(readTaskStateFromView);
				const brief = state.items.find((item) => item.event.source.entryId === spawn!.id)!;
				expect(brief).toMatchObject({
					state: "descriptive",
					event: { authority: "assistant-public", attribution: "descriptive", source: { field: "/content" } },
				});
				const compiled = await capture.readHistory((view) =>
					new CanonicalContextCompiler().compile(view, contextLimits),
				);
				const frames = compiled.filter(
					(message) => message.role === "custom" && message.customType === TASK_FRAME_CUSTOM_TYPE,
				);
				expect(JSON.stringify(frames)).toContain("Keep the supplied serial field");
				expect(JSON.stringify(frames)).toContain("Do not infer the asset age");
				expect(JSON.stringify(frames)).toContain("Unchanged identifier, including leading zeros");
				expect(JSON.stringify(frames)).toContain("Source ordering is intentional");
				expect(JSON.stringify(frames)).toContain("Emit exactly 00123, not 123");
				expect(JSON.stringify(frames)).toContain("Consumer .venv Python");
				expect(JSON.stringify(frames)).toContain("/srv/consumer");
				expect(child.goalState.status).toBe("idle");
			} finally {
				await capture.dispose();
				await requests.dispose();
			}
		} finally {
			await harness.cleanup();
		}
	});

	it("rejects an invalid contract before reserving a child", async () => {
		const harness = await createHarness();
		try {
			const reserve = vi.spyOn(harness.session, "reserveRlmChildAdmission");
			for (const [contract, error] of [
				[{ rules: [], hidden: true }, "task_contract.hidden"],
				[{ stages: [{ name: "read", input_meanings: {} }] }, "task_contract.stages[0].output_meanings"],
				[{ boundary_case: { description: "case", runtime: 1 } }, "task_contract.boundary_case.runtime"],
			] as const) {
				await expect(harness.session.runRlmChild("Inspect", { task_contract: contract })).rejects.toThrow(error);
			}
			expect(reserve).not.toHaveBeenCalled();
		} finally {
			await harness.cleanup();
		}
	});
});
