import { describe, expect, it } from "vitest";
import {
	getTaskStateImportCoverage,
	projectTaskStateSource,
	TASK_STATE_CUSTOM_TYPE,
	TASK_STATE_KINDS,
	TASK_STATE_SCHEMA,
	type TaskStateSource,
} from "../src/core/task-state.js";

function source(entry: TaskStateSource["entry"], sequence = 1): TaskStateSource {
	return {
		sessionId: "session-A",
		sequence,
		locator: { path: "/sessions/session-A.jsonl", offset: 100, length: 200 },
		revision: "frame-revision",
		entry,
	};
}

describe("canonical task-state source projection", () => {
	it("preserves more than twelve exact native proposals without granting claimed authority", () => {
		const ids = ["Foo.txt", "foo.txt", ...Array.from({ length: 11 }, (_, index) => `item-${index}`)];
		const exactTexts = ids.map((id, index) => (index === 12 ? `  ${id}: ${"x".repeat(9000)}  ` : `Preserve ${id}.`));
		const projected = ids.flatMap((itemId, index) => [
			...projectTaskStateSource(
				source(
					{
						id: `entry-${index}`,
						parentId: index === 0 ? null : `entry-${index - 1}`,
						type: "custom",
						customType: TASK_STATE_CUSTOM_TYPE,
						data: {
							schema: TASK_STATE_SCHEMA,
							taskKey: "Task/Case",
							itemId,
							kind: TASK_STATE_KINDS[index % TASK_STATE_KINDS.length],
							text: exactTexts[index],
							operation: index === 12 ? "supersede" : "declare",
							relations: index === 12 ? [{ kind: "supersedes", itemId: "item-0" }] : [],
							originalSource: { sessionId: "original-session", entryId: "User-Source" },
							authority: "user",
							trusted: true,
						},
					},
					index + 1,
				),
			),
		]);

		expect(projected).toHaveLength(13);
		expect(projected.map((item) => item.itemId)).toEqual(ids);
		expect(projected.map((item) => item.text)).toEqual(exactTexts);
		expect(new Set(projected.map((item) => item.kind))).toEqual(new Set(TASK_STATE_KINDS));
		expect(projected.every((item) => item.authority === "unrecorded" && item.attribution === "proposal")).toBe(true);
		expect(projected.every((item) => item.claimedAuthority === "user")).toBe(true);
		expect(projected[0].relations).toEqual([]);
		expect(projected[1].relations).toEqual([]);
		expect(projected[12].relations).toEqual([{ kind: "supersedes", itemId: "item-0" }]);
		expect(projected[12].source).toEqual({
			sessionId: "session-A",
			entryId: "entry-12",
			sequence: 13,
			field: "/data",
			locator: { path: "/sessions/session-A.jsonl", offset: 100, length: 200 },
			revision: "frame-revision",
		});
		expect(projected[0].originalSource).toMatchObject({ sessionId: "original-session", entryId: "User-Source" });

		const inputOrigin = {
			version: 1,
			kind: "input",
			actionId: "action",
			recordId: "record",
			inputSource: "interactive",
			recordRole: "primary",
			submitted: {
				text: "  /raw Foo.txt  ",
				content: [
					{ type: "text", text: "Keep --Case" },
					{ type: "image", data: "not-indexed-as-text", mimeType: "image/png" },
				],
			},
		};
		const userEntry = {
			id: "native-user",
			parentId: null,
			type: "message",
			message: { role: "user", content: "Expanded text is not the submitted original." },
			nativeOrigin: inputOrigin,
		};
		const original = [...projectTaskStateSource(source(userEntry))];
		expect(original.map((item) => item.text)).toEqual(["  /raw Foo.txt  ", "Keep --Case"]);
		expect(original.every((item) => item.authority === "user" && item.attribution === "source-backed")).toBe(true);
		expect(original.map((item) => item.source.field)).toEqual([
			"/nativeOrigin/submitted/text",
			"/nativeOrigin/submitted/content/0/text",
		]);
		expect([
			...projectTaskStateSource(
				source({
					...userEntry,
					nativeOrigin: undefined,
					message: { role: "user", nativeOrigin: inputOrigin },
				}),
			),
		]).toEqual([]);
		expect([
			...projectTaskStateSource(
				source({
					...userEntry,
					nativeOrigin: { ...inputOrigin, recordRole: "prefix" },
				}),
			),
		]).toEqual([]);
	});

	it("decodes both legacy carriers without lost items, inferred completion, or goal activation", () => {
		const snapshot = {
			schema: "prime-context.task-snapshot/v2",
			taskKey: "Legacy/Case",
			objective: "Preserve the original task.",
			objectiveSourceEntryId: "User-A",
			explicitConstraints: Array.from({ length: 13 }, (_, index) => ({
				id: index === 0 ? "Foo.txt" : index === 1 ? "foo.txt" : `constraint-${index}`,
				text: `  Literal ${index}: Foo.txt != foo.txt  `,
				sourceEntryId: `User-${index}`,
				...(index === 12 ? { supersededBy: "Explicit-New-Item" } : {}),
			})),
			focus: "Current focus",
			openItems: [{ id: "Open-A", text: "Not implicitly complete" }, { text: "No supplied identity" }],
			pinnedObservationIds: ["obs:Exact"],
			actionableObservations: [{ text: "Observed data", observationRef: "obs:Exact", sourceToolCallId: "Call-A" }],
			artifacts: [{ pathOrId: "Foo.txt", description: "Retain case", sourceToolCallId: "Call-A" }],
		};
		const custom = [
			...projectTaskStateSource(
				source({
					id: "legacy",
					parentId: null,
					type: "custom",
					customType: "prime-context.task-snapshot",
					data: snapshot,
				}),
			),
		];
		const compacted = [
			...projectTaskStateSource(
				source(
					{
						id: "compact",
						parentId: "legacy",
						type: "compaction",
						details: {
							schema: "prime-context.reference-compaction/v1",
							taskSnapshot: { ...snapshot, openItems: [] },
						},
					},
					2,
				),
			),
		];

		for (const rows of [custom, compacted]) {
			const constraints = rows.filter((item) => item.kind === "user_requirement");
			expect(constraints).toHaveLength(13);
			expect(constraints.map((item) => item.itemId)).toEqual(snapshot.explicitConstraints.map((item) => item.id));
			expect(constraints.map((item) => item.text)).toEqual(snapshot.explicitConstraints.map((item) => item.text));
			expect(constraints[0].relations).toEqual([]);
			expect(constraints[1].relations).toEqual([]);
			expect(constraints[12].relations).toEqual([{ kind: "superseded_by", itemId: "Explicit-New-Item" }]);
			expect(
				rows.every((item) => item.authority === "unrecorded" && item.importCoverage?.earlierItemsMayHaveBeenLost),
			).toBe(true);
			expect(rows.every((item) => item.operation === "observe")).toBe(true);
		}
		expect(custom.find((item) => item.itemId === "Open-A")?.importCoverage?.source).toBe("unrecorded");
		expect(custom.find((item) => item.text === "No supplied identity")?.itemId).toBeUndefined();
		expect(compacted.some((item) => item.itemId === "Open-A")).toBe(false);
		expect(compacted[1].source.field).toBe("/details/taskSnapshot/explicitConstraints/0");
		expect(compacted[1].originalSource?.entryId).toBe("User-0");
		expect(compacted[1].importCoverage?.source).toBe("unverified");

		const emptySnapshot = {
			schema: "prime-context.task-snapshot/v2",
			taskKey: "Empty/Case",
			explicitConstraints: [],
			openItems: [],
		};
		const emptySources = [
			source({
				id: "empty-custom",
				parentId: null,
				type: "custom",
				customType: "prime-context.task-snapshot",
				data: emptySnapshot,
			}),
			source({
				id: "empty-compaction",
				parentId: null,
				type: "compaction",
				details: { schema: "prime-context.reference-compaction/v1", taskSnapshot: emptySnapshot },
			}),
		];
		for (const emptySource of emptySources) {
			expect([...projectTaskStateSource(emptySource)]).toEqual([]);
			expect(getTaskStateImportCoverage(emptySource)).toEqual({
				taskKey: "Empty/Case",
				earlierItemsMayHaveBeenLost: true,
			});
		}

		const goal = [
			...projectTaskStateSource(
				source(
					{
						id: "goal",
						parentId: "compact",
						type: "custom",
						customType: "thread_goal_state",
						data: {
							goalId: "Goal-A",
							objective: "Recorded objective",
							active: false,
							status: "complete",
							tokensUsed: 0,
							timeUsedSeconds: 0,
							continuationsUsed: 0,
						},
					},
					3,
				),
			),
		];
		expect(goal).toHaveLength(1);
		expect(goal[0]).toMatchObject({
			kind: "observed_fact",
			authority: "unrecorded",
			attribution: "descriptive",
			operation: "observe",
			goalState: { goalId: "Goal-A", status: "complete" },
			relations: [],
		});
		const runtimeComplete = [
			...projectTaskStateSource(
				source({
					id: "runtime-complete",
					parentId: null,
					type: "custom",
					customType: "thread_goal_state",
					data: {
						goalId: "Goal-A",
						objective: "Recorded objective",
						active: false,
						status: "complete",
						tokensUsed: 0,
						timeUsedSeconds: 0,
						continuationsUsed: 0,
					},
					nativeOrigin: {
						version: 1,
						kind: "goal_operation",
						operation: "complete",
						actor: "runtime",
						previousGoalId: "Goal-A",
					},
				}),
			),
		];
		expect(runtimeComplete[0]).toMatchObject({
			kind: "observed_fact",
			authority: "tool-data",
			operation: "observe",
			relations: [],
			goalState: { operation: "complete" },
		});
		const userRevision = [
			...projectTaskStateSource(
				source({
					id: "user-revision",
					parentId: null,
					type: "custom",
					customType: "thread_goal_state",
					data: {
						goalId: "Goal-B",
						objective: "New objective",
						active: true,
						status: "active",
						tokensUsed: 0,
						timeUsedSeconds: 0,
						continuationsUsed: 0,
					},
					nativeOrigin: {
						version: 1,
						kind: "goal_operation",
						operation: "revise",
						actor: "interactive",
						actionId: "goal-action",
						submittedText: "/goal New objective",
						previousGoalId: "Goal-A",
					},
				}),
			),
		];
		expect(userRevision[0]).toMatchObject({
			kind: "user_goal_revision",
			authority: "user",
			operation: "amend",
			relations: [{ kind: "supersedes", itemId: "Goal-A" }],
			originalSource: { entryId: "user-revision", field: "/nativeOrigin/submittedText" },
		});
	});
});
