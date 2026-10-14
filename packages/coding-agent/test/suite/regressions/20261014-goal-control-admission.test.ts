import { describe, expect, it } from "vitest";
import { GOAL_STATE_CUSTOM_TYPE } from "../../../src/core/goals.js";
import { createHarness } from "../harness.js";

describe("goal host creation admission", () => {
	it("starts a new goal after the previous goal completes", async () => {
		const h = await createHarness({ persistSession: true, rlmDepth: 0 });
		try {
			await h.session.handleGoalHostRequest("goal.create", { objective: "First goal" });
			await h.session.handleGoalHostRequest("goal.complete");
			await h.session.handleGoalHostRequest("goal.create", { objective: "Second goal" });
			expect(h.session.goalState).toMatchObject({ status: "active", objective: "Second goal" });
			const history = await h.sessionManager.readBranch();
			expect(history.at(-1)).toMatchObject({
				customType: GOAL_STATE_CUSTOM_TYPE,
				data: { status: "active", objective: "Second goal" },
			});
		} finally {
			await h.cleanup();
		}
	});

	it("rejects a second creation while the first native write is pending", async () => {
		const h = await createHarness({ persistSession: true, rlmDepth: 0 });
		try {
			const results = await Promise.allSettled([
				h.session.handleGoalHostRequest("goal.create", { objective: "First goal" }),
				h.session.handleGoalHostRequest("goal.create", { objective: "Second goal" }),
			]);
			const history = await h.sessionManager.readBranch();
			const goals = history.filter(
				(entry) => entry.type === "custom" && entry.customType === GOAL_STATE_CUSTOM_TYPE,
			);
			expect({ results: results.map(({ status }) => status), goal: h.session.goalState, goals }).toMatchObject({
				results: ["fulfilled", "rejected"],
				goal: { status: "active", objective: "First goal" },
				goals: [{ data: { status: "active", objective: "First goal" } }],
			});
		} finally {
			await h.cleanup();
		}
	});
});
