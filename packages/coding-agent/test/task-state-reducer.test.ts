import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";
import type { TaskStateProjection } from "../src/core/task-state.js";
import { TASK_STATE_CUSTOM_TYPE, TASK_STATE_SCHEMA } from "../src/core/task-state.js";
import { TaskStateReducer } from "../src/core/task-state-reducer.js";

const managers: SessionManager[] = [];
const directories: string[] = [];

async function nativeManager(): Promise<SessionManager> {
	const directory = mkdtempSync(join(tmpdir(), "task-state-view-"));
	directories.push(directory);
	const manager = await SessionManager.create(process.cwd(), directory);
	managers.push(manager);
	return manager;
}

afterEach(async () => {
	await Promise.all(managers.splice(0).map((manager) => manager.close()));
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// Synthetic qualified projections test only reduction, not the native admission boundary.
function requirement(sequence: number, itemId: string, text: string): TaskStateProjection {
	return {
		source: { sessionId: "test", entryId: `entry-${sequence}`, sequence, field: "/data" },
		itemId,
		text,
		kind: "user_requirement",
		operation: "declare",
		relations: [],
		authority: "user",
		attribution: "source-backed",
	};
}

describe("bounded explicit task-state reduction", () => {
	it("preserves literal requirements and retires only an explicit unambiguous target", async () => {
		const limits = { maxItems: 64, maxSourceBytes: 65536, maxViewBytes: 65536 };
		const reducer = new TaskStateReducer(limits);
		Object.assign(limits, { maxItems: 1, maxSourceBytes: 1, maxViewBytes: 1 });
		for (let index = 0; index < 14; index++)
			reducer.add(requirement(index, `Rule-${index}`, `  Keep SRC/File${index}.ts --Flag=Exact  `));
		const revision = requirement(14, "Rule-new", "Use DST/Exact.ts");
		revision.operation = "amend";
		revision.relations = [{ kind: "supersedes", itemId: "Rule-0" }];
		reducer.add(revision);
		revision.text = "caller mutation";
		reducer.add(requirement(15, "rule-0", "  Keep SRC/File0.ts --Flag=Exact  "));
		const result = reducer.finish({});
		expect(result.items).toHaveLength(16);
		expect(result.items.filter((item) => item.state === "active")).toHaveLength(15);
		expect(result.items[0]).toMatchObject({
			state: "superseded",
			changedBy: { entryId: "entry-14" },
			event: { itemId: "Rule-0", text: "  Keep SRC/File0.ts --Flag=Exact  " },
		});
		expect(result.items[14].event.text).toBe("Use DST/Exact.ts");
		expect(result.items[15]).toMatchObject({ state: "active", event: { itemId: "rule-0" } });
		result.items[1].event.text = "returned mutation";
		expect(reducer.finish({}).items[1].event.text).toBe("  Keep SRC/File1.ts --Flag=Exact  ");
		// Actual captured reader: raw structured JSON stays a proposal, including oversized inline evidence.
		const manager = await nativeManager();
		const largeText = "X".repeat(1024 * 1024 + 1);
		for (const [itemId, text] of [
			["Path", "  SRC/Exact.py --Flag  "],
			["path", largeText],
		]) {
			await manager.appendCustomEntry(TASK_STATE_CUSTOM_TYPE, {
				schema: TASK_STATE_SCHEMA,
				itemId,
				text,
				kind: "user_requirement",
				operation: "declare",
				authority: "user",
			});
		}
		const readLimits = { maxItems: 4, maxSourceBytes: 4 * 1024 * 1024, maxViewBytes: 4 * 1024 * 1024 };
		const reading = manager.readTaskState(readLimits);
		Object.assign(readLimits, { maxItems: 1, maxSourceBytes: 1, maxViewBytes: 1 });
		const view = await reading;
		expect(view.coverage).toBe("complete");
		expect(view.items.map((item) => [item.event.itemId, item.state])).toEqual([
			["Path", "proposal"],
			["path", "proposal"],
		]);
		expect(view.items[0].event.text).toBe("  SRC/Exact.py --Flag  ");
		expect(view.items[1].event.text).toBe(largeText);
		expect(view.items[1].event.source.entryId).toBe(manager.getLeafId());
	});

	it("keeps ambiguous requirements active, rejects unqualified retirement and refuses over-budget views", async () => {
		const reducer = new TaskStateReducer();
		reducer.add(requirement(0, "same", "First obligation"));
		reducer.add(requirement(1, "same", "Second obligation"));
		const ambiguous = requirement(2, "same", "Requested amendment");
		ambiguous.operation = "amend";
		reducer.add(ambiguous);
		const proposal = requirement(3, "same", "Claim that both are completed");
		proposal.operation = "complete";
		proposal.authority = "unrecorded";
		proposal.attribution = "proposal";
		proposal.claimedAuthority = "user";
		reducer.add(proposal);
		const result = reducer.finish({});
		expect(result.items.map((item) => item.state)).toEqual(["active", "active", "active", "proposal"]);
		expect(result.items[2].unresolved).toBe(true);
		expect(result.items[3].event.claimedAuthority).toBe("user");
		const small = new TaskStateReducer({ maxItems: 1 });
		small.add(requirement(0, "a", "A"));
		expect(() => small.add(requirement(1, "b", "B"))).toThrow("Task-state item budget exceeded");
		expect(() => new TaskStateReducer({ maxViewBytes: 1 }).add(requirement(0, "a", "A"))).toThrow(
			"JSON byte limit exceeded",
		);
		const manager = await nativeManager();
		await manager.appendCustomEntry("prime-context.task-snapshot", {
			schema: "prime-context.task-snapshot/v2",
			explicitConstraints: [],
		});
		expect((await manager.readTaskState()).coverage).toBe("partial");
		for (const itemId of ["a", "b"])
			await manager.appendCustomEntry(TASK_STATE_CUSTOM_TYPE, {
				schema: TASK_STATE_SCHEMA,
				itemId,
				text: itemId,
				kind: "user_requirement",
				operation: "declare",
			});
		await expect(manager.readTaskState({ maxItems: 1 })).rejects.toThrow("Task-state item budget exceeded");
		await expect(manager.readTaskState({ maxSourceBytes: 1 })).rejects.toThrow(
			"Task-state source byte budget exceeded",
		);
		await expect(manager.readTaskState({ maxViewBytes: 1 })).rejects.toThrow("JSON byte limit exceeded");
	});
});
