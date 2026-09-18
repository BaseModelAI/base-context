import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanonicalContextCompiler, getCanonicalEpochContext } from "../src/core/canonical-context.js";
import { bindNativeEntryWriter } from "../src/core/session-entry-origin.js";
import type { SessionHistoryReadView } from "../src/core/session-history-index.js";
import { SessionManager } from "../src/core/session-manager.js";
import type { TaskStateProjection } from "../src/core/task-state.js";
import { TASK_STATE_CUSTOM_TYPE, TASK_STATE_SCHEMA } from "../src/core/task-state.js";
import { TaskStateReadCache } from "../src/core/task-state-reader.js";
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
	it("reuses unchanged task reductions and processes only appended evidence during preparation", async () => {
		const add = vi.spyOn(TaskStateReducer.prototype, "add");
		try {
			for (const size of [32, 128]) {
				const manager = await nativeManager();
				const writer = manager[bindNativeEntryWriter]();
				const goal = (index: number, operation: "create" | "complete") =>
					writer.captureGoalOperation({
						version: 1,
						kind: "goal_operation",
						operation,
						actor: "interactive",
						actionId: `${operation}-${index}`,
						submittedText: `/goal ${index}`,
						...(operation === "complete" ? { previousGoalId: `goal-${index}` } : {}),
					})({
						goalId: `goal-${index}`,
						objective: `Keep requirement ${index}`,
						active: operation === "create",
						status: operation === "create" ? "active" : "complete",
						tokensUsed: 0,
						timeUsedSeconds: 0,
						continuationsUsed: 0,
					});
				for (let index = 0; index < size; index++) await goal(index, "create");
				const compiler = new CanonicalContextCompiler();
				const limits = { maxMessages: 512, maxSourceBytes: 4 * 1024 * 1024 };
				const prepare = (purpose: "read" | "request" = "request") =>
					manager.readBranchHistory((history) =>
						compiler.compile(
							history.branchContext,
							limits,
							undefined,
							undefined,
							undefined,
							"on",
							false,
							purpose,
						),
					);
				add.mockClear();
				await prepare();
				expect(add).toHaveBeenCalledTimes(size);
				add.mockClear();
				const warmStart = performance.now();
				await prepare();
				const warmMs = performance.now() - warmStart;
				expect(add).not.toHaveBeenCalled();
				await goal(size - 1, "complete");
				const appendStart = performance.now();
				const appended = await prepare();
				const appendMs = performance.now() - appendStart;
				expect(add).toHaveBeenCalledTimes(1);
				console.info("task preparation", {
					size,
					warmRecords: 0,
					appendRecords: add.mock.calls.length,
					warmMs,
					appendMs,
				});
				expect(
					(await manager.readTaskState()).items.find((item) => item.event.itemId === `goal-${size - 1}`)?.state,
				).toBe("completed");
				// Under the ordinary frame limit, an explicit request rebase is still deferred until ACK.
				expect(getCanonicalEpochContext(appended)?.taskFrame?.messages.length).toBeGreaterThan(1);
				compiler.requestTaskFrameRebase();
				expect(getCanonicalEpochContext(await prepare("read"))?.taskFrameRebased).toBeUndefined();
				for (let retry = 0; retry < 2; retry++) {
					const candidate = getCanonicalEpochContext(await prepare());
					expect(candidate?.taskFrame?.messages).toHaveLength(1);
					expect(candidate?.taskFrameRebased).toBe(true);
				}
				compiler.clear();
				add.mockClear();
				expect(getCanonicalEpochContext(await prepare())?.taskFrameRebased).toBeUndefined();
				expect(add).toHaveBeenCalledTimes(size + 1);
			}
		} finally {
			add.mockRestore();
		}
	});

	it("rebuilds cached evidence on branch navigation, source replacement and failed append reduction", async () => {
		const projections = [requirement(1, "a", "A"), requirement(2, "b", "B")].map((event) => ({
			...event,
			source: { ...event.source, locator: { path: "/capture", offset: event.source.sequence * 10, length: 10 } },
		}));
		const capture = (events: TaskStateProjection[], sequence = 2, ino = 1): SessionHistoryReadView =>
			({
				source: {
					sessionId: "test",
					sessionFile: "/capture",
					leafId: events.at(-1)!.source.entryId,
					sourceSequence: sequence,
					persistent: true,
				},
				get: async (id: string) => events.find((event) => event.source.entryId === id)?.source,
				taskEvidence: async ({ after }: { after?: { sequence: number } | null } = {}) => ({
					sourceIdentity: { journalPath: "/capture", dev: 1, ino },
					indexedThrough: sequence,
					coverage: "complete",
					structuredOnly: true,
					selective: true,
					truncated: false,
					nextAfter: null,
					entries: events
						.filter((event) => event.source.sequence > (after?.sequence ?? 0))
						.map((projection) => ({
							sequence: projection.source.sequence,
							ordinal: 0,
							truncated: false,
							projection,
						})),
				}),
			}) as unknown as SessionHistoryReadView;
		const cache = new TaskStateReadCache();
		const limits = { maxItems: 5, maxSourceBytes: 65536, maxViewBytes: 65536 };
		const add = vi.spyOn(TaskStateReducer.prototype, "add");
		try {
			const initial = await cache.read(capture(projections), limits);
			add.mockClear();
			expect(await cache.read(capture(projections), limits)).toBe(initial);
			expect(add).not.toHaveBeenCalled();
			const completion = {
				...requirement(3, "done", "Done A"),
				relations: [{ kind: "completes" as const, itemId: "a" }],
			};
			const appended = [completion, requirement(4, "c", "C"), requirement(5, "d", "D")].map((event) => ({
				...event,
				source: { ...event.source, locator: { path: "/capture", offset: event.source.sequence * 10, length: 10 } },
			}));
			await expect(cache.read(capture([...projections, ...appended], 5), limits)).rejects.toThrow("item budget");
			const rewind = await cache.read(capture(projections.slice(0, 1), 5), limits);
			expect(rewind.items).toHaveLength(1);
			expect(rewind.items[0].state).toBe("active");
			add.mockClear();
			// Forward navigation to an old descendant must not skip already-existing evidence.
			expect((await cache.read(capture(projections, 5), limits)).items).toHaveLength(2);
			expect(add).toHaveBeenCalledTimes(2);
			add.mockClear();
			const replacement = projections.map((event) => ({ ...event, text: `replacement ${event.text}` }));
			expect((await cache.read(capture(replacement, 5, 2), limits)).items[0].event.text).toBe("replacement A");
			expect(add).toHaveBeenCalledTimes(2);
			cache.clear();
		} finally {
			add.mockRestore();
		}
	});
});
