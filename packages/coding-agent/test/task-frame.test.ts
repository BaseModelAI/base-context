import { describe, expect, it } from "vitest";
import { compileTaskFrame, type TaskFrameLiteralSource, taskFrameLimits } from "../src/core/task-frame.js";
import type { TaskStateView } from "../src/core/task-state-reader.js";
import type { ReducedTaskItem } from "../src/core/task-state-reducer.js";

const source = {
	sessionId: "session",
	sessionFile: "/fixture/session",
	persistent: true,
	leafId: "current",
	sourceSequence: 3,
};
function requirement(entryId: string, sequence: number, text: string): ReducedTaskItem {
	return {
		state: "active",
		unresolved: false,
		event: {
			source: {
				sessionId: source.sessionId,
				entryId,
				sequence,
				revision: `revision-${entryId}`,
				field: "/nativeOrigin/submitted/text",
			},
			kind: "user_requirement",
			text,
			authority: "user",
			attribution: "source-backed",
			operation: "observe",
			relations: [],
		},
	};
}
function view(items: ReducedTaskItem[]): TaskStateView {
	return { source, coverage: "complete", structuredOnly: true, selective: true, items };
}
function literal(item: ReducedTaskItem, text = item.event.text!): TaskFrameLiteralSource {
	return {
		sessionId: source.sessionId,
		entryId: item.event.source.entryId,
		revision: item.event.source.revision!,
		text: [text],
	};
}

describe("TaskFrame literal-aware selection", () => {
	it("omits visible submitted text and its revisions without losing goal state", () => {
		const input = requirement("current", 3, "Keep warehouse codes ASCII.");
		const tasks = view([input]);
		expect(compileTaskFrame(tasks, taskFrameLimits(), undefined, [literal(input)])).toBeUndefined();
		const old = compileTaskFrame(tasks, taskFrameLimits())!;
		expect(compileTaskFrame(tasks, taskFrameLimits(), old, [literal(input)])).toBeUndefined();
		const goal = requirement("goal", 2, "Ship the warehouse importer");
		goal.event.kind = "user_goal_revision";
		goal.event.goalState = { goalId: "goal", status: "active", operation: "create" };
		const withGoal = compileTaskFrame(view([goal, input]), taskFrameLimits(), old, [literal(input)])!;
		expect(withGoal.rows).toHaveLength(1);
		expect(withGoal.rows[0]).toMatchObject({ text: goal.event.text, goalState: { status: "active" } });
		expect(withGoal.messages).toHaveLength(1);
		expect(JSON.stringify(withGoal.messages)).not.toContain(input.event.text);
	});

	it("spends the text budget on older omitted instructions, not the visible newest prompt", () => {
		const older = requirement("older", 1, `Warehouse codes must stay ASCII. ${"x".repeat(800)}`);
		const omitted = requirement("omitted", 2, "y".repeat(1500));
		const current = requirement("current", 3, "z".repeat(1500));
		const frame = compileTaskFrame(view([current, omitted, older]), taskFrameLimits(), undefined, [
			literal(current),
		])!;
		expect(frame.rows.map((row) => row.source.entryId)).toEqual(["older", "omitted"]);
		expect(frame.rows[0]).toMatchObject({ text: older.event.text });
		expect(frame.rows[1]).toMatchObject({ textOmitted: true });
		expect(frame.rows[1].text).toBeUndefined();
	});

	it("requires the same source revision and actual complete text, not manifest membership", () => {
		const input = requirement("current", 3, "Keep complete submitted instructions.");
		for (const visible of [
			literal(input, "Replaced by an input transform"),
			{ ...literal(input), revision: "other" },
			{ ...literal(input), entryId: "other" },
		]) {
			expect(compileTaskFrame(view([input]), taskFrameLimits(), undefined, [visible])!.rows[0].text).toBe(
				input.event.text,
			);
		}
		expect(
			compileTaskFrame(view([input]), taskFrameLimits(), undefined, [
				literal(input, `Expanded prefix\n${input.event.text}\nExpanded suffix`),
			]),
		).toBeUndefined();
	});
});
