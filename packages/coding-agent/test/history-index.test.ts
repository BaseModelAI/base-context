import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
	type ContextManifestCursor,
	HistoryIndex,
	type IndexedSourceEvent,
	type ParentPathCursor,
} from "../src/core/history-index.js";
import { decodeJournalFrame } from "../src/core/journal-frame.js";
import { SESSION_JOURNAL_MAX_FRAME_BYTES, SessionJournalOwner } from "../src/core/session-journal-owner.js";
import { TASK_STATE_SCHEMA } from "../src/core/task-state.js";

let dir: string;
let index: HistoryIndex;
beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "base-context-history-index-"));
	index = await HistoryIndex.open(join(dir, "index.sqlite"), { nodeExecutable: process.env.BASE_CONTEXT_TEST_NODE });
});
afterEach(async () => {
	await index.close();
	rmSync(dir, { recursive: true, force: true });
});
function source(id: string, sequence: number, text: string): IndexedSourceEvent {
	return {
		id,
		sequence,
		parentId: sequence === 1 ? null : "Item",
		kind: "message",
		authority: "runtime",
		locator: { path: join(dir, "canonical.jsonl"), offset: sequence * 100, length: 100 },
		revision: `revision-${id}`,
		text,
		textComplete: true,
	};
}

it("indexes exact case-sensitive IDs and bounded pages/search without copying source bodies", async () => {
	const events = [source("Item", 1, "parser symbol"), source("item", 2, "different symbol")];
	await index.apply("session", events, 2);
	await index.apply("session", events, 2);
	expect(await index.get("session", "Item")).toEqual(events[0]);
	expect(await index.get("session", "Item", { leafId: "item", through: 2 })).toEqual(events[0]);
	expect(await index.get("session", "item", { leafId: "Item", through: 2 })).toBeUndefined();
	expect(await index.get("other", "Item")).toBeUndefined();
	await expect(index.getSource("session", "Item", 2)).rejects.toThrow("index is unavailable");
	await expect(index.parentPath("session", { leafId: "item", through: 2 })).rejects.toThrow("index is unavailable");
	await expect(index.branchBootstrap("session", { leafId: "item", through: 2 })).rejects.toThrow(
		"index is unavailable",
	);
	await expect(index.contextManifest("session", { leafId: "item", through: 2 })).rejects.toThrow(
		"index is unavailable",
	);
	expect((await index.page("session", 0, 2, 1)).events).toEqual([events[0]]);
	expect((await index.search("session", "parser", 2)).events).toEqual([events[0]]);
	await index.clear("session");
	expect((await index.page("session", 0, 2)).coverage).toBe("partial");
	await index.apply("session", events, 2);
	expect((await index.page("session", 0, 2)).coverage).toBe("complete");
	const journalPath = join(dir, "canonical.jsonl");
	const owner = await SessionJournalOwner.open({ journalPath, create: true });
	try {
		await owner.appendJson(
			JSON.stringify({ type: "session", version: 3, id: "canonical", timestamp: "2026-01-01T00:00:00Z", cwd: dir }),
		);
		const header = owner.getSnapshot();
		const entry = (id: string, parentId: string | null, text: string, type = "message") =>
			JSON.stringify({
				id,
				parentId,
				type,
				...(type === "message" ? { message: { role: "user", content: text } } : { request: { text } }),
			});
		await owner.appendJson(entry("root", null, "source root"), "retained-import");
		const first = owner.getSnapshot();
		const siblingJson =
			'{ "id":"sibling", "parentId":"root", "type":"message", "message":{"role":"user","content":"sibling only"}, "retention":"retained-import", "lexeme":1e+03 }';
		await owner.appendJson(siblingJson);
		const firstSync = index.syncSource("canonical", first);
		const child = Reflect.get(index, "child");
		const closing = index.close();
		expect(await firstSync).toEqual({ ...first, indexedThrough: 1 });
		await closing;
		expect(child.exitCode).toBe(0);
		index = await HistoryIndex.open(join(dir, "index.sqlite"));
		expect(await index.get("canonical", "sibling")).toBeUndefined();
		const indexed = await index.get("canonical", "root");
		expect(indexed?.retention).toBe("retained-import");
		expect(await index.getSource("canonical", "root", 1)).toEqual(indexed);
		expect(indexed?.locator).toEqual({
			path: journalPath,
			offset: header.byteLength,
			length: first.byteLength - header.byteLength,
		});
		expect(indexed?.revision).toBe(first.checksum);
		const frame = readFileSync(journalPath).subarray(
			indexed!.locator.offset,
			indexed!.locator.offset + indexed!.locator.length,
		);
		expect(
			decodeJournalFrame(frame, { sequence: 1, checksum: header.checksum }, SESSION_JOURNAL_MAX_FRAME_BYTES).payload,
		).toMatchObject({ id: "root" });
		await owner.appendJson(entry("chosen", "root", `chosen ${"é".repeat(8192)}`));
		await owner.appendJson(entry("root-request", "root", "root request", "request"));
		await owner.appendJson(entry("sibling-request", "sibling", "sibling request", "request"));
		const latest = owner.getSnapshot();
		expect((await index.syncSource("canonical", latest)).indexedThrough).toBe(5);
		const scope = { leafId: "chosen" };
		expect((await index.page("canonical", 0, 5, 64, scope)).events.map((item) => item.id)).toEqual([
			"root",
			"chosen",
			"root-request",
		]);
		expect(await index.get("canonical", "sibling", { ...scope, through: 5 })).toBeUndefined();
		const sibling = await index.getSource("canonical", "sibling", 5);
		expect(sibling).toMatchObject({ id: "sibling", sequence: 2 });
		expect(sibling?.retention).toBeUndefined();
		expect((await index.page("canonical", 0, 5, 1)).events).toEqual([indexed]);
		expect(await index.readSourcePayload("canonical", "sibling", 5)).toMatchObject({
			text: siblingJson,
			nextCursor: null,
		});
		expect(await index.getSource("canonical", "sibling", 1)).toBeUndefined();
		expect(await index.readSourcePayload("canonical", "sibling", 1)).toBeUndefined();
		expect((await index.search("canonical", "sibling", 5, 16, scope)).events).toEqual([]);
		expect((await index.search("canonical", "absent", 5, 16, { leafId: "sibling" })).coverage).toBe("complete");
		expect((await index.search("canonical", "absent", 5, 16, scope)).coverage).toBe("partial");
		const chosen = await index.get("canonical", "chosen");
		expect(Buffer.byteLength(chosen!.text)).toBeLessThanOrEqual(8192);
		expect(chosen?.textComplete).toBe(false);
		const contextScope = { leafId: "chosen", through: 5 };
		const contextFirst = await index.contextManifest("canonical", contextScope, { limit: 1 });
		expect(contextFirst).toMatchObject({
			selection: "known",
			summaryRef: null,
			activeBase: 0,
			retainedMessageCount: 0,
			activeMessageCount: 2,
			order: "source",
		});
		expect(contextFirst.refs.map((ref) => ref.entryId)).toEqual(["root"]);
		expect(contextFirst.refs[0].ordinal).toBe(1);
		expect(contextFirst.nextCursor).toMatchObject({
			version: 1,
			sessionId: "canonical",
			journalPath,
			leafId: "chosen",
			through: 5,
			throughRevision: latest.checksum,
			nextOrdinal: 2,
		});
		expect(await index.contextManifest("canonical", { leafId: null, through: 0 })).toMatchObject({
			selection: "known",
			activeMessageCount: 0,
			refs: [],
			nextCursor: null,
		});

		await owner.appendJson(
			JSON.stringify({
				id: "media",
				parentId: "chosen",
				type: "message",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "visible media prompt" },
						{ type: "image", data: "QklOQVJZX09OTFlfSU1BR0U=", mimeType: "image/png" },
					],
				},
			}),
		);
		const mediaSnapshot = owner.getSnapshot();
		await index.syncSource("canonical", mediaSnapshot);
		expect(await index.get("canonical", "media")).toMatchObject({
			text: "visible media prompt",
			textComplete: false,
			authority: "unrecorded",
		});
		expect(
			(
				await index.search("canonical", "QklOQVJZX09OTFlfSU1BR0U", mediaSnapshot.nextSequence - 1, 16, {
					leafId: "media",
				})
			).events,
		).toEqual([]);
		expect((await index.get("canonical", "root"))?.authority).toBe("unrecorded");

		expect(await index.branchBootstrap("canonical", { leafId: null, through: 0 })).toEqual({
			model: null,
			thinkingLevel: null,
			serviceTier: null,
			goalState: null,
			rlmMaxDepth: null,
			hasBranchMessage: false,
			hasContextMessages: false,
			goalSeedable: true,
		});
		expect(await index.parentPath("canonical", { leafId: null, through: 0 })).toEqual({
			events: [],
			nextCursor: null,
			totalEntries: 0,
		});
		const contextSecond = await index.contextManifest("canonical", contextScope, {
			cursor: contextFirst.nextCursor!,
		});
		expect(contextSecond.refs.map((ref) => ref.entryId)).toEqual(["chosen"]);
		expect(contextSecond.nextCursor).toBeNull();
		expect(
			await index.contextManifest("canonical", contextScope, {
				cursor: { ...contextFirst.nextCursor!, nextOrdinal: 3 },
			}),
		).toMatchObject({ refs: [], nextCursor: null });
		await expect(
			index.contextManifest("canonical", contextScope, {
				cursor: { ...contextFirst.nextCursor!, throughRevision: "0".repeat(64) },
			}),
		).rejects.toThrow("cursor mismatch");
		await expect(
			index.contextManifest("canonical", contextScope, {
				cursor: { ...contextFirst.nextCursor!, journalPath: `${journalPath}.other` },
			}),
		).rejects.toThrow("cursor mismatch");
		const taskKey = "Task/Case";
		const constraints = Array.from({ length: 13 }, (_, number) => ({
			id: number === 0 ? "Item" : number === 1 ? "item" : `item-${number}`,
			text: number === 12 ? `  thirteenth ${"z".repeat(9000)}  ` : `exact requirement ${number}`,
		}));
		await owner.appendJson(
			JSON.stringify({
				id: "legacy-tasks",
				parentId: "media",
				type: "custom",
				customType: "prime-context.task-snapshot",
				data: { schema: "prime-context.task-snapshot/v2", taskKey, explicitConstraints: constraints },
			}),
		);
		const task = (id: string, parentId: string, itemId: string, text: string, key = taskKey) =>
			JSON.stringify({
				id,
				parentId,
				type: "custom",
				customType: "task_state",
				data: {
					schema: TASK_STATE_SCHEMA,
					taskKey: key,
					itemId,
					kind: "user_requirement",
					text,
					operation: "amend",
					authority: "user",
				},
			});
		const updated = await owner.appendJson(
			task("updated-task", "legacy-tasks", "Item", "later proposal, not retirement"),
		);
		const hugeJson = task("huge-task", "updated-task", "Huge", "x".repeat(1024 * 1024 + 1024));
		const huge = await owner.appendJson(hugeJson);
		await owner.appendJson(task("after-huge", "huge-task", "Tail", "after oversized evidence"));
		await owner.appendJson(task("other-task", "after-huge", "Item", "other task identity", "Other/Case"));
		await owner.appendJson(
			JSON.stringify({
				id: "empty-import",
				parentId: "other-task",
				type: "compaction",
				summary: "empty imported snapshot",
				details: {
					schema: "prime-context.reference-compaction/v1",
					taskSnapshot: {
						schema: "prime-context.task-snapshot/v2",
						taskKey: "Empty/Case",
						explicitConstraints: [],
					},
				},
			}),
		);
		const taskSnapshot = owner.getSnapshot();
		const taskScope = { leafId: "empty-import", through: taskSnapshot.nextSequence - 1 };
		await index.syncSource("canonical", taskSnapshot);
		expect((await index.contextManifest("canonical", taskScope)).selection).toBe("invalid-first-kept");
		const tasks = await index.taskEvidence("canonical", taskScope, { taskKey });
		expect(tasks.entries).toHaveLength(16);
		expect(tasks).toMatchObject({ structuredOnly: true, selective: true, coverage: "partial", truncated: true });
		const firstThirteen = tasks.entries.slice(0, 13).map((item) => (item.truncated ? undefined : item.projection));
		expect(firstThirteen.map((item) => item?.itemId)).toEqual(constraints.map((item) => item.id));
		expect(firstThirteen.map((item) => item?.text)).toEqual(constraints.map((item) => item.text));
		expect(firstThirteen.every((item) => item?.authority === "unrecorded")).toBe(true);
		expect(firstThirteen[0]?.source).toMatchObject({
			field: "/data/explicitConstraints/0",
			locator: { path: journalPath },
		});
		expect((await index.taskEvidence("canonical", taskScope, { taskKey, itemId: "Item" })).entries).toHaveLength(2);
		expect((await index.taskEvidence("canonical", taskScope, { taskKey, itemId: "item" })).entries).toHaveLength(1);
		expect(
			(await index.taskEvidence("canonical", taskScope, { taskKey: "Other/Case", itemId: "Item" })).entries,
		).toHaveLength(1);
		expect(
			(await index.taskEvidence("canonical", { leafId: "sibling", through: taskScope.through }, { taskKey }))
				.entries,
		).toEqual([]);
		const absent = await index.taskEvidence("canonical", taskScope, { taskKey: "Empty/Case", itemId: "not present" });
		expect(absent.entries).toEqual([]);
		expect(absent.coverage).toBe("partial");
		const limited = await index.taskEvidence("canonical", taskScope, {
			taskKey,
			limit: 1,
			after: { sequence: updated.sequence, ordinal: 0 },
		});
		expect(limited.entries).toHaveLength(1);
		expect(limited.entries[0]).toMatchObject({
			truncated: true,
			itemId: "Huge",
			source: { entryId: "huge-task", field: "/data", locator: { path: journalPath } },
		});
		const hugeEvent = await index.get("canonical", "huge-task");
		if (limited.entries[0].truncated) {
			expect(limited.entries[0].source.locator).toEqual(hugeEvent?.locator);
			expect(limited.entries[0].source.revision).toBe(hugeEvent?.revision);
		}
		expect(limited.nextAfter).toEqual({ sequence: huge.sequence, ordinal: 0 });
		expect(Buffer.byteLength(JSON.stringify(limited))).toBeLessThanOrEqual(1024 * 1024);
		const resumed = await index.taskEvidence("canonical", taskScope, { taskKey, limit: 1, after: limited.nextAfter });
		expect(resumed.entries[0]).toMatchObject({ truncated: false, projection: { itemId: "Tail" } });
		const payload = await index.readPayload("canonical", "huge-task", taskScope);
		expect(await index.readSourcePayload("canonical", "huge-task", taskScope.through)).toEqual(payload);
		expect(payload?.format).toBe("canonical-json-fragment");
		expect(payload?.byteOffset).toBe(0);
		expect(payload!.byteLength).toBeLessThanOrEqual(64 * 1024);
		expect(payload?.text).toBe(Buffer.from(hugeJson).subarray(0, payload!.byteLength).toString("utf8"));
		expect(payload?.nextCursor).not.toBeNull();
		const continuation = await index.readPayload("canonical", "huge-task", taskScope, {
			cursor: payload!.nextCursor!,
			maxBytes: 31,
		});
		expect(
			await index.readSourcePayload("canonical", "huge-task", taskScope.through, {
				cursor: payload!.nextCursor!,
				maxBytes: 31,
			}),
		).toEqual(continuation);
		expect(continuation?.byteOffset).toBe(payload!.byteLength);
		expect(continuation?.text).toBe(
			Buffer.from(hugeJson)
				.subarray(payload!.byteLength, payload!.byteLength + 31)
				.toString("utf8"),
		);
		expect(await index.readPayload("canonical", "sibling", taskScope)).toBeUndefined();
		expect(await index.readPayload("canonical", "absent", taskScope)).toBeUndefined();
		await expect(index.readPayload("canonical", "root", taskScope, { cursor: payload!.nextCursor! })).rejects.toThrow(
			"cursor mismatch",
		);

		let chainLeaf = taskScope.leafId;
		for (let number = 0; number < 130; number++) {
			const id = `chain-${number}`;
			await owner.appendJson(entry(id, chainLeaf, "chain node"));
			chainLeaf = id;
		}
		const chainSnapshot = owner.getSnapshot();
		const chainScope = { leafId: chainLeaf, through: chainSnapshot.nextSequence - 1 };
		await index.syncSource("canonical", chainSnapshot);
		expect((await index.get("canonical", "root", chainScope))?.id).toBe("root");
		const chainIds: string[] = [];
		let chainAfter = 0;
		while (true) {
			const page = await index.page("canonical", chainAfter, chainScope.through, 64, chainScope);
			chainIds.push(...page.events.map((event) => event.id));
			expect(page.coverage).toBe("complete");
			expect(page.truncated).toBe(page.nextAfter !== null);
			if (page.nextAfter === null) break;
			expect(page.nextAfter).toBe(page.events.at(-1)?.sequence);
			expect(page.nextAfter).toBeGreaterThan(chainAfter);
			chainAfter = page.nextAfter;
		}
		expect(chainIds).toEqual([
			"root",
			"chosen",
			"root-request",
			"media",
			"legacy-tasks",
			"updated-task",
			"huge-task",
			"after-huge",
			"other-task",
			"empty-import",
			...Array.from({ length: 130 }, (_, n) => `chain-${n}`),
		]);
		const firstPath = await index.parentPath("canonical", chainScope, { limit: 1 });
		expect(firstPath).toEqual({
			events: [indexed],
			totalEntries: chainIds.length - 1,
			nextCursor: {
				version: 1,
				sessionId: "canonical",
				journalPath,
				dev: chainSnapshot.dev,
				ino: chainSnapshot.ino,
				leafId: chainLeaf,
				through: chainScope.through,
				throughRevision: chainSnapshot.checksum,
				nextDepth: 1,
			},
		});
		const parentIds = firstPath.events.map((event) => event.id);
		let parentCursor: ParentPathCursor | null = firstPath.nextCursor;
		while (parentCursor) {
			const page = await index.parentPath("canonical", chainScope, { cursor: parentCursor });
			expect(page.events.length).toBeLessThanOrEqual(64);
			expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(1024 * 1024);
			parentIds.push(...page.events.map((event) => event.id));
			parentCursor = page.nextCursor;
		}
		expect(parentIds).toEqual(chainIds.filter((id) => id !== "root-request"));
		expect(
			(await index.parentPath("canonical", { leafId: "root-request", through: 5 })).events.map((event) => event.id),
		).toEqual(["root", "root-request"]);
		await expect(index.parentPath("canonical", chainScope, { limit: 129 })).rejects.toThrow("path limit");
		await expect(
			index.parentPath("canonical", { ...chainScope, leafId: "root" }, { cursor: firstPath.nextCursor! }),
		).rejects.toThrow("cursor mismatch");
		await expect(
			index.parentPath("canonical", chainScope, {
				cursor: { ...firstPath.nextCursor!, throughRevision: "0".repeat(64) },
			}),
		).rejects.toThrow("cursor mismatch");
		await expect(
			index.parentPath("canonical", chainScope, { cursor: { ...firstPath.nextCursor!, nextDepth: -1 } }),
		).rejects.toThrow("cursor position");
		const chainSearch = await index.search("canonical", "chain node", chainScope.through, 2, chainScope);
		expect(chainSearch.events.map((event) => event.id)).toEqual(["chain-129", "chain-128"]);
		expect(chainSearch).toMatchObject({ truncated: true, nextAfter: null, coverage: "partial" });
		expect((await index.search("canonical", "sibling", chainScope.through, 2, chainScope)).events).toEqual([]);
		expect(
			(
				await index.search("canonical", "root request", chainScope.through, 2, { leafId: "root-request" })
			).events.map((event) => event.id),
		).toEqual(["root-request"]);
		expect((await index.taskEvidence("canonical", chainScope, { taskKey })).entries).toEqual(tasks.entries);
		const chainTasks = await index.taskEvidence("canonical", chainScope, { taskKey, limit: 2 });
		expect(chainTasks.entries).toEqual(tasks.entries.slice(0, 2));
		expect(chainTasks.nextAfter).toEqual({ sequence: tasks.entries[1].sequence, ordinal: 1 });
		const nextChainTasks = await index.taskEvidence("canonical", chainScope, {
			taskKey,
			limit: 2,
			after: chainTasks.nextAfter,
		});
		expect(nextChainTasks.entries).toEqual(tasks.entries.slice(2, 4));
		expect(nextChainTasks.nextAfter).toEqual({ sequence: tasks.entries[3].sequence, ordinal: 3 });
		expect(await index.get("canonical", "sibling", chainScope)).toBeUndefined();
		expect((await index.get("canonical", "root-request", chainScope))?.id).toBe("root-request");
		expect(await index.get("canonical", "sibling-request", chainScope)).toBeUndefined();
		expect((await index.readPayload("canonical", "huge-task", chainScope))?.text).toBe(payload?.text);
		expect(await index.readPayload("canonical", "sibling", chainScope)).toBeUndefined();
		expect((await index.readPayload("canonical", "root-request", chainScope))?.text).toContain('"root-request"');
		expect(await index.readPayload("canonical", "ROOT", chainScope)).toBeUndefined();
		expect(await index.get("canonical", "root-request", { leafId: "root", through: 1 })).toBeUndefined();
		expect(await index.readPayload("canonical", "root-request", { leafId: "root", through: 1 })).toBeUndefined();
		expect((await index.get("canonical", "root-request", { ...chainScope, leafId: "root-request" }))?.id).toBe(
			"root-request",
		);
		await expect(index.get("canonical", "absent", { ...chainScope, leafId: "ROOT" })).rejects.toThrow("branch leaf");
		await expect(index.readPayload("canonical", "absent", { ...chainScope, leafId: "ROOT" })).rejects.toThrow(
			"branch leaf",
		);
		await expect(index.get("canonical", "root", { leafId: chainLeaf, through: taskScope.through })).rejects.toThrow(
			"branch leaf",
		);
		await index.apply("canonical", [], chainScope.through);
		expect((await index.get("canonical", "root"))?.id).toBe("root");
		await expect(index.get("canonical", "root", chainScope)).rejects.toThrow("parent lookup budget");
		await expect(index.page("canonical", chainScope.through, chainScope.through, 2, chainScope)).rejects.toThrow(
			"parent lookup budget",
		);
		await expect(index.search("canonical", "absent", chainScope.through, 2, chainScope)).rejects.toThrow(
			"parent lookup budget",
		);
		expect((await index.get("canonical", "chain-128", chainScope))?.id).toBe("chain-128");
		await expect(index.readPayload("canonical", "root", chainScope)).rejects.toThrow("index is unavailable");
		await index.syncSource("canonical", chainSnapshot);
		expect((await index.get("canonical", "root", chainScope))?.id).toBe("root");

		const bootstrapControls = [
			{ id: "bootstrap-model", type: "model_change", provider: "fixture", modelId: "configured" },
			{ id: "bootstrap-thinking", type: "thinking_level_change", thinkingLevel: "high" },
			{ id: "bootstrap-tier", type: "service_tier_change", serviceTier: "priority" },
		];
		let controlParent: string | null = null;
		for (const value of bootstrapControls) {
			await owner.appendJson(JSON.stringify({ ...value, parentId: controlParent }), "retained-import");
			controlParent = value.id;
		}
		await owner.appendJson(entry("bootstrap-request", controlParent, "attached request", "request"));
		const controlSnapshot = owner.getSnapshot();
		const controlScope = { leafId: controlParent, through: controlSnapshot.nextSequence - 1 };
		await index.syncSource("canonical", controlSnapshot);
		expect(
			(await index.parentPath("canonical", chainScope, { cursor: firstPath.nextCursor!, limit: 1 })).events.map(
				(event) => event.id,
			),
		).toEqual(["chosen"]);
		const controlBootstrap = await index.branchBootstrap("canonical", controlScope);
		expect(controlBootstrap).toEqual({
			model: await index.getSource("canonical", "bootstrap-model", controlScope.through),
			thinkingLevel: await index.getSource("canonical", "bootstrap-thinking", controlScope.through),
			serviceTier: await index.getSource("canonical", "bootstrap-tier", controlScope.through),
			goalState: null,
			rlmMaxDepth: null,
			hasBranchMessage: false,
			hasContextMessages: false,
			goalSeedable: true,
		});
		expect(controlBootstrap.model?.retention).toBe("retained-import");
		expect(await index.branchBootstrap("canonical", { ...controlScope, leafId: "bootstrap-request" })).toMatchObject({
			hasContextMessages: false,
			goalSeedable: false,
		});
		const bootstrapGoal = {
			active: true,
			status: "active",
			tokensUsed: 0,
			timeUsedSeconds: 0,
			continuationsUsed: 0,
		};
		let contextParentId = chainLeaf;
		const contextEntries = [
			{ id: "context-boundary", type: "model_change", provider: "fixture", modelId: "before-assistant" },
			{ id: "bootstrap-goal", type: "custom", customType: "thread_goal_state", data: bootstrapGoal },
			{
				id: "bootstrap-malformed-goal",
				type: "custom",
				customType: "thread_goal_state",
				data: { ...bootstrapGoal, active: "claimed" },
			},
			{ id: "bootstrap-retained-goal", type: "custom", customType: "thread_goal_state", data: bootstrapGoal },
			{ id: "bootstrap-rlm-depth", type: "custom", customType: "rlm_max_depth_state", data: { maxDepth: 0 } },
			{
				id: "bootstrap-invalid-rlm-depth",
				type: "custom",
				customType: "rlm_max_depth_state",
				data: { maxDepth: 1.5 },
			},
			{
				id: "context-assistant",
				type: "message",
				message: {
					role: "assistant",
					provider: "fixture",
					model: "error-assistant",
					stopReason: "error",
					content: [
						{ type: "toolCall", id: "a" },
						{ type: "toolCall", id: "b" },
					],
				},
			},
			{ id: "context-result-b", type: "message", message: { role: "toolResult", toolCallId: "b", content: [] } },
			{ id: "context-request", type: "request" },
			{ id: "context-result-a", type: "message", message: { role: "toolResult", toolCallId: "a", content: [] } },
			{
				id: "context-ui",
				type: "custom_message",
				customType: "session_slash_command",
				content: "UI only",
				display: false,
			},
			{
				id: "context-bash",
				type: "message",
				message: { role: "bashExecution", command: "true", output: "", excludeFromContext: true },
			},
			{ id: "context-branch", type: "branch_summary", summary: "branch summary", fromId: "root" },
			{ id: "context-empty", type: "branch_summary", summary: "", fromId: "root" },
			{
				id: "context-compact",
				type: "compaction",
				summary: "latest summary",
				firstKeptEntryId: "chain-0",
				tokensBefore: 99,
				customInstructions: "exact instructions",
			},
			{ id: "context-after", type: "message", message: { role: "user", content: "after compaction" } },
		];
		for (const value of contextEntries) {
			await owner.appendJson(
				JSON.stringify({ ...value, parentId: contextParentId, timestamp: "2026-01-01T00:00:00Z" }),
				value.id === "bootstrap-retained-goal" || value.id === "bootstrap-rlm-depth"
					? "retained-import"
					: undefined,
			);
			contextParentId = value.id;
		}
		const contextSnapshot = owner.getSnapshot();
		const visibleScope = { leafId: contextParentId, through: contextSnapshot.nextSequence - 1 };
		await index.syncSource("canonical", contextSnapshot);
		const contextBootstrap = await index.branchBootstrap("canonical", visibleScope);
		expect(contextBootstrap).toEqual({
			model: await index.getSource("canonical", "context-assistant", visibleScope.through),
			thinkingLevel: null,
			serviceTier: null,
			goalState: await index.getSource("canonical", "bootstrap-goal", visibleScope.through),
			rlmMaxDepth: await index.getSource("canonical", "bootstrap-rlm-depth", visibleScope.through),
			hasBranchMessage: true,
			hasContextMessages: true,
			goalSeedable: false,
		});
		expect(contextBootstrap.rlmMaxDepth?.retention).toBe("retained-import");
		expect(await index.branchBootstrap("canonical", controlScope)).toEqual(controlBootstrap);
		const visibleIds: string[] = [];
		const visibleOrdinals: number[] = [];
		let contextCursor: ContextManifestCursor | undefined;
		do {
			const page = await index.contextManifest("canonical", visibleScope, { cursor: contextCursor });
			expect(page.selection).toBe("known");
			if (page.selection !== "known") throw new Error("Expected a known context selection");
			expect(page.activeMessageCount).toBe(137);
			expect(page.retainedMessageCount).toBe(136);
			expect(page.summaryRef).toMatchObject({ entryId: "context-compact", kind: "compaction" });
			expect(page.refs.length).toBeLessThanOrEqual(64);
			expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(1024 * 1024);
			visibleIds.push(...page.refs.map((ref) => ref.entryId));
			visibleOrdinals.push(...page.refs.map((ref) => ref.ordinal));
			contextCursor = page.nextCursor ?? undefined;
		} while (contextCursor);
		expect(visibleIds).toEqual([
			...Array.from({ length: 130 }, (_, n) => `chain-${n}`),
			"context-assistant",
			"context-result-b",
			"context-result-a",
			"context-ui",
			"context-bash",
			"context-branch",
			"context-after",
		]);
		expect(visibleOrdinals).toEqual(Array.from({ length: 137 }, (_, n) => visibleOrdinals[0] + n));
		await owner.appendJson(
			JSON.stringify({
				id: "context-compact2",
				parentId: contextParentId,
				type: "compaction",
				summary: "new summary",
				firstKeptEntryId: "context-boundary",
				tokensBefore: 50,
			}),
		);
		const invisibleBoundarySnapshot = owner.getSnapshot();
		const invisibleBoundaryScope = {
			leafId: "context-compact2",
			through: invisibleBoundarySnapshot.nextSequence - 1,
		};
		await index.syncSource("canonical", invisibleBoundarySnapshot);
		expect(await index.contextManifest("canonical", invisibleBoundaryScope)).toMatchObject({
			selection: "known",
			activeMessageCount: 7,
			retainedMessageCount: 7,
			summaryRef: { entryId: "context-compact2" },
		});
		expect((await index.contextManifest("canonical", invisibleBoundaryScope)).refs.map((ref) => ref.entryId)).toEqual(
			visibleIds.slice(130),
		);
		await owner.appendJson(
			JSON.stringify({
				id: "context-bad-request",
				parentId: "context-compact2",
				type: "compaction",
				summary: "bad boundary",
				firstKeptEntryId: "root-request",
			}),
		);
		const badBoundarySnapshot = owner.getSnapshot();
		const badBoundaryScope = { leafId: "context-bad-request", through: badBoundarySnapshot.nextSequence - 1 };
		await index.syncSource("canonical", badBoundarySnapshot);
		expect(await index.get("canonical", "root-request", badBoundaryScope)).toBeDefined();
		expect(await index.contextManifest("canonical", badBoundaryScope)).toMatchObject({
			selection: "invalid-first-kept",
			refs: [],
			nextCursor: null,
		});
		const usageTarget = { kind: "assistant-usage", targetId: "update-assistant" } as const;
		const sentTarget = { kind: "ipython-sent-message", toolCallId: "IPython/Case" } as const;
		const sentData = (id: string, message: string, toolCallId: string = sentTarget.toolCallId) => ({
			toolCallId,
			message: {
				id,
				message,
				deliveryStatus: "delivered",
				target: { activeSessionId: "active-child", sessionId: "child", sessionName: 17 },
			},
		});
		const relatedRefs = async (ids: string[]) =>
			Promise.all(
				ids.map(async (entryId) => {
					const event = (await index.get("canonical", entryId))!;
					return {
						entryId,
						sequence: event.sequence,
						kind: event.kind,
						locator: event.locator,
						revision: event.revision,
					};
				}),
			);
		const earlyUsageJson = JSON.stringify({
			id: "usage-before-assistant",
			parentId: "sibling",
			type: "child_usage_attributed",
			targetId: usageTarget.targetId,
			aggregateUsage: {
				input: 1,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		await owner.appendJson(earlyUsageJson);
		await owner.appendJson(
			JSON.stringify({
				id: usageTarget.targetId,
				parentId: "context-compact2",
				type: "message",
				message: { role: "assistant", content: [] },
			}),
		);
		const earlyUpdateSnapshot = owner.getSnapshot();
		const earlyUpdateScope = { leafId: usageTarget.targetId, through: earlyUpdateSnapshot.nextSequence - 1 };
		await index.syncSource("canonical", earlyUpdateSnapshot);
		expect(await index.contextUpdates("canonical", earlyUpdateScope, usageTarget)).toEqual({
			refs: await relatedRefs(["usage-before-assistant"]),
			order: "source",
		});
		expect(
			(await index.readContextUpdatePayload("canonical", "usage-before-assistant", earlyUpdateScope, usageTarget))
				?.text,
		).toBe(earlyUsageJson);
		expect(await index.readPayload("canonical", "usage-before-assistant", earlyUpdateScope)).toBeUndefined();

		const sentBeforeJson = JSON.stringify({
			id: "sent-before-compaction",
			parentId: usageTarget.targetId,
			type: "custom",
			customType: "ipython_sent_agent_message",
			data: sentData("duplicate", "before compaction"),
		});
		await owner.appendJson(sentBeforeJson);
		const updateEntries = [
			{ id: "update-boundary", type: "tool_intent" },
			{
				id: "update-compaction",
				type: "compaction",
				summary: "update summary",
				firstKeptEntryId: "update-boundary",
			},
			{
				id: "sent-late",
				type: "custom",
				customType: "ipython_sent_agent_message",
				data: sentData("duplicate", "late update"),
			},
			{
				id: "sent-invalid",
				type: "custom",
				customType: "ipython_sent_agent_message",
				data: {
					...sentData("invalid", "not delivered"),
					message: { ...sentData("invalid", "not delivered").message, deliveryStatus: "failed" },
				},
			},
			{
				id: "sent-wrong-kind",
				type: "custom_message",
				customType: "ipython_sent_agent_message",
				data: sentData("wrong-kind", "wrong kind"),
			},
			{
				id: "sent-wrong-type",
				type: "custom",
				customType: "IPYTHON_SENT_AGENT_MESSAGE",
				data: sentData("wrong-type", "wrong custom type"),
			},
			{
				id: "sent-wrong-key",
				type: "custom",
				customType: "ipython_sent_agent_message",
				data: sentData("wrong-key", "wrong key", "ipython/case"),
			},
			{
				id: "sent-empty",
				type: "custom",
				customType: "ipython_sent_agent_message",
				data: {
					toolCallId: "",
					message: {
						id: "",
						message: "",
						deliveryStatus: "queued",
						target: { activeSessionId: "", sessionId: "" },
					},
				},
			},
			{ id: "usage-forged", type: "custom", targetId: usageTarget.targetId, aggregateUsage: {} },
		];
		let updateLeaf = "sent-before-compaction";
		for (const value of updateEntries) {
			await owner.appendJson(JSON.stringify({ ...value, parentId: updateLeaf }));
			updateLeaf = value.id;
		}
		await owner.appendJson(
			JSON.stringify({
				id: "sent-sibling",
				parentId: "sibling",
				type: "custom",
				customType: "ipython_sent_agent_message",
				data: sentData("sibling", "sibling only"),
			}),
		);
		await owner.appendJson(
			JSON.stringify({
				id: "usage-unrelated",
				parentId: "sibling",
				type: "child_usage_attributed",
				targetId: "other-assistant",
				aggregateUsage: {},
			}),
		);
		await owner.appendJson(
			JSON.stringify({
				id: "usage-nonassistant",
				parentId: "sibling",
				type: "child_usage_attributed",
				targetId: "root",
				aggregateUsage: {},
			}),
		);
		const latestUsageJson = JSON.stringify({
			id: "usage-latest",
			parentId: "sibling",
			type: "child_usage_attributed",
			targetId: usageTarget.targetId,
			aggregateUsage: "é".repeat(70 * 1024),
		});
		await owner.appendJson(latestUsageJson);
		const updateSnapshot = owner.getSnapshot();
		const updateScope = { leafId: updateLeaf, through: updateSnapshot.nextSequence - 1 };
		await index.syncSource("canonical", updateSnapshot);
		const latestUsageRefs = await relatedRefs(["usage-latest"]);
		const sentRefs = await relatedRefs(["sent-before-compaction", "sent-late"]);
		expect(await index.contextUpdates("canonical", updateScope, usageTarget)).toEqual({
			refs: latestUsageRefs,
			order: "source",
		});
		expect(await index.contextUpdates("canonical", earlyUpdateScope, usageTarget)).toEqual({
			refs: await relatedRefs(["usage-before-assistant"]),
			order: "source",
		});
		await expect(
			index.contextUpdates("canonical", updateScope, { kind: "assistant-usage", targetId: "root" }),
		).rejects.toThrow("assistant");
		await expect(
			index.contextUpdates("canonical", { ...updateScope, leafId: "sibling" }, usageTarget),
		).rejects.toThrow();
		expect(await index.contextUpdates("canonical", updateScope, sentTarget)).toEqual({
			refs: sentRefs,
			order: "source",
		});
		expect(
			await index.contextUpdates("canonical", updateScope, { kind: "ipython-sent-message", toolCallId: "" }),
		).toEqual({
			refs: await relatedRefs(["sent-empty"]),
			order: "source",
		});
		expect(await index.contextUpdates("canonical", earlyUpdateScope, sentTarget)).toEqual({
			refs: [],
			order: "source",
		});
		expect(
			(await index.readContextUpdatePayload("canonical", "sent-before-compaction", updateScope, sentTarget))?.text,
		).toBe(sentBeforeJson);
		for (const eventId of [
			"sent-sibling",
			"sent-invalid",
			"sent-wrong-kind",
			"sent-wrong-type",
			"sent-wrong-key",
			"sent-empty",
			"usage-latest",
		]) {
			expect(await index.readContextUpdatePayload("canonical", eventId, updateScope, sentTarget)).toBeUndefined();
		}
		for (const eventId of ["usage-before-assistant", "usage-forged", "usage-unrelated", "sent-late", "absent"]) {
			expect(await index.readContextUpdatePayload("canonical", eventId, updateScope, usageTarget)).toBeUndefined();
		}
		await expect(
			index.readContextUpdatePayload(
				"canonical",
				"usage-latest",
				{ ...updateScope, leafId: "sibling" },
				usageTarget,
			),
		).rejects.toThrow("assistant");
		await expect(
			index.readContextUpdatePayload("canonical", "usage-nonassistant", updateScope, {
				kind: "assistant-usage",
				targetId: "root",
			}),
		).rejects.toThrow("assistant");
		expect(
			(await index.readContextUpdatePayload("canonical", "usage-before-assistant", earlyUpdateScope, usageTarget))
				?.text,
		).toBe(earlyUsageJson);
		expect(
			await index.readContextUpdatePayload("canonical", "usage-latest", earlyUpdateScope, usageTarget),
		).toBeUndefined();
		expect(await index.readPayload("canonical", "usage-latest", updateScope)).toBeUndefined();
		const updatePayload = await index.readContextUpdatePayload("canonical", "usage-latest", updateScope, usageTarget);
		expect(updatePayload?.format).toBe("canonical-json-fragment");
		expect(updatePayload?.byteOffset).toBe(0);
		expect(updatePayload!.byteLength).toBeLessThanOrEqual(64 * 1024);
		expect(Buffer.byteLength(updatePayload!.text)).toBe(updatePayload!.byteLength);
		expect(updatePayload?.text).toBe(
			Buffer.from(latestUsageJson).subarray(0, updatePayload!.byteLength).toString("utf8"),
		);
		expect(updatePayload?.nextCursor).not.toBeNull();
		const updateContinuation = await index.readContextUpdatePayload(
			"canonical",
			"usage-latest",
			updateScope,
			usageTarget,
			{
				cursor: updatePayload!.nextCursor!,
				maxBytes: 31,
			},
		);
		expect(updateContinuation?.byteOffset).toBe(updatePayload!.byteLength);
		expect(updateContinuation!.byteLength).toBeLessThanOrEqual(31);
		expect(Buffer.byteLength(updateContinuation!.text)).toBe(updateContinuation!.byteLength);
		expect(updateContinuation?.text).toBe(
			Buffer.from(latestUsageJson)
				.subarray(updatePayload!.byteLength, updatePayload!.byteLength + updateContinuation!.byteLength)
				.toString("utf8"),
		);
		await expect(
			index.readContextUpdatePayload("canonical", "sent-before-compaction", updateScope, sentTarget, {
				cursor: updatePayload!.nextCursor!,
			}),
		).rejects.toThrow("cursor mismatch");
		await index.apply("canonical", [], updateScope.through);
		await expect(index.contextUpdates("canonical", updateScope, sentTarget)).rejects.toThrow("index is unavailable");
		await expect(
			index.readContextUpdatePayload("canonical", "usage-latest", updateScope, usageTarget),
		).rejects.toThrow("index is unavailable");
		await index.syncSource("canonical", updateSnapshot);
		expect(await index.contextUpdates("canonical", updateScope, sentTarget)).toEqual({
			refs: sentRefs,
			order: "source",
		});
		expect(await index.contextUpdates("canonical", updateScope, usageTarget)).toEqual({
			refs: latestUsageRefs,
			order: "source",
		});
		await index.close();
		execFileSync(process.execPath, [
			"--experimental-sqlite",
			"--disable-warning=ExperimentalWarning",
			"--input-type=module",
			"-e",
			'import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync(process.argv[1]); try { db.exec("DROP TABLE task_evidence; DROP TABLE task_import_loss; DROP TABLE source_payload; DROP TABLE source_ancestry; DROP TABLE source_jump; ALTER TABLE context_node DROP COLUMN latest_model; ALTER TABLE context_node DROP COLUMN latest_thinking; ALTER TABLE context_node DROP COLUMN latest_service_tier; ALTER TABLE context_node DROP COLUMN latest_goal; ALTER TABLE context_node DROP COLUMN has_session_message; ALTER TABLE context_node DROP COLUMN goal_seedable; ALTER TABLE context_node DROP COLUMN latest_rlm_max_depth; ALTER TABLE context_node DROP COLUMN has_branch_message; ALTER TABLE source_event DROP COLUMN retention; UPDATE source_event SET authority=\'user\'; PRAGMA user_version=7;"); } finally { db.close(); }',
			join(dir, "index.sqlite"),
		]);
		index = await HistoryIndex.open(join(dir, "index.sqlite"));
		expect(await index.get("canonical", "root")).toBeUndefined();
		await expect(index.contextUpdates("canonical", updateScope, sentTarget)).rejects.toThrow("index is unavailable");
		await expect(
			index.readContextUpdatePayload("canonical", "usage-latest", updateScope, usageTarget),
		).rejects.toThrow("index is unavailable");
		await expect(index.readPayload("canonical", "root", taskScope)).rejects.toThrow("index is unavailable");
		expect(await index.taskEvidence("canonical", taskScope, { taskKey })).toMatchObject({
			entries: [],
			coverage: "partial",
		});
		await index.syncSource("canonical", taskSnapshot);
		expect((await index.get("canonical", "root"))?.authority).toBe("unrecorded");
		expect((await index.getSource("canonical", "root", taskScope.through))?.retention).toBe("retained-import");
		expect((await index.taskEvidence("canonical", taskScope, { taskKey })).entries).toHaveLength(16);
		expect((await index.readPayload("canonical", "huge-task", taskScope))?.text).toBe(payload?.text);
		const before = readFileSync(journalPath);
		await index.close();
		rmSync(join(dir, "index.sqlite"));
		index = await HistoryIndex.open(join(dir, "index.sqlite"));
		expect(await index.syncSource("canonical", taskSnapshot)).toEqual({
			...taskSnapshot,
			indexedThrough: taskScope.through,
		});
		expect((await index.taskEvidence("canonical", taskScope, { taskKey })).entries).toHaveLength(16);
		expect((await index.page("canonical", 0, 5, 64, scope)).events.map((item) => item.id)).toEqual([
			"root",
			"chosen",
			"root-request",
		]);
		await index.syncSource("canonical", invisibleBoundarySnapshot);
		expect(await index.parentPath("canonical", chainScope, { limit: 1 })).toEqual(firstPath);
		expect(await index.branchBootstrap("canonical", visibleScope)).toEqual(contextBootstrap);
		expect((await index.contextManifest("canonical", invisibleBoundaryScope)).refs.map((ref) => ref.entryId)).toEqual(
			visibleIds.slice(130),
		);
		await index.syncSource("canonical", updateSnapshot);
		expect(await index.contextUpdates("canonical", updateScope, usageTarget)).toEqual({
			refs: latestUsageRefs,
			order: "source",
		});
		expect(await index.contextUpdates("canonical", updateScope, sentTarget)).toEqual({
			refs: sentRefs,
			order: "source",
		});
		expect((await index.readContextUpdatePayload("canonical", "usage-latest", updateScope, usageTarget))?.text).toBe(
			updatePayload?.text,
		);
		expect(readFileSync(journalPath)).toEqual(before);
		const budgetOwner = await SessionJournalOwner.open({
			journalPath: join(dir, "query-budget.jsonl"),
			create: true,
		});
		try {
			await budgetOwner.appendJson(
				JSON.stringify({
					type: "session",
					version: 3,
					id: "query-budget",
					timestamp: "2026-01-01T00:00:00Z",
					cwd: dir,
				}),
			);
			await budgetOwner.appendJson(entry("root", null, "budget root"));
			const budgetKey = "Budget/Case";
			const budgetTask = await budgetOwner.appendJson(
				JSON.stringify({
					id: "budget-task",
					parentId: "root",
					type: "custom",
					customType: "prime-context.task-snapshot",
					data: {
						schema: "prime-context.task-snapshot/v2",
						taskKey: budgetKey,
						explicitConstraints: Array.from({ length: 256 }, () => ({ id: "Budget", text: "candidate" })),
					},
				}),
			);
			const taskBudgetSnapshot = budgetOwner.getSnapshot();
			const taskBudgetScope = { leafId: "root", through: taskBudgetSnapshot.nextSequence - 1 };
			await index.syncSource("query-budget", taskBudgetSnapshot);
			const taskSelections = [
				{ taskKey: budgetKey },
				{ itemId: "Budget" },
				{ taskKey: budgetKey, itemId: "Budget" },
			];
			for (const options of taskSelections) {
				expect(await index.taskEvidence("query-budget", taskBudgetScope, options)).toMatchObject({
					entries: [],
					coverage: "complete",
					truncated: false,
					nextAfter: null,
				});
			}
			await budgetOwner.appendJson(task("budget-task-extra", "root", "Budget", "extra candidate", budgetKey));
			const taskOverflowSnapshot = budgetOwner.getSnapshot();
			const taskOverflowScope = { ...taskBudgetScope, through: taskOverflowSnapshot.nextSequence - 1 };
			await index.syncSource("query-budget", taskOverflowSnapshot);
			for (const options of taskSelections) {
				await expect(index.taskEvidence("query-budget", taskOverflowScope, options)).rejects.toThrow(
					"candidate budget",
				);
			}
			expect(
				await index.taskEvidence("query-budget", taskOverflowScope, { taskKey: budgetKey, itemId: "absent" }),
			).toMatchObject({ entries: [], coverage: "complete" });
			const taskTail = await index.taskEvidence(
				"query-budget",
				{ ...taskOverflowScope, leafId: "budget-task" },
				{ taskKey: budgetKey, itemId: "Budget", limit: 1, after: { sequence: budgetTask.sequence, ordinal: 254 } },
			);
			expect(taskTail.entries).toHaveLength(1);
			expect(taskTail.entries[0]).toMatchObject({ sequence: budgetTask.sequence, ordinal: 255 });
			expect(taskTail).toMatchObject({ coverage: "partial", truncated: false, nextAfter: null });
			const lossKey = "Budget/Loss";
			const lossStart = budgetOwner.getSnapshot().nextSequence;
			for (let n = 0; n < 257; n++) {
				await budgetOwner.appendJson(
					JSON.stringify({
						id: `loss-${n}`,
						parentId: "root",
						type: "custom",
						customType: "prime-context.task-snapshot",
						data: {
							schema: "prime-context.task-snapshot/v2",
							taskKey: n % 2 === 0 ? lossKey : undefined,
							explicitConstraints: [],
						},
					}),
				);
			}
			const lossSnapshot = budgetOwner.getSnapshot();
			await index.syncSource("query-budget", lossSnapshot);
			// Empty NULL/key carriers count together, before item and cursor filtering.
			const lossOptions = {
				taskKey: lossKey,
				itemId: "absent",
				after: { sequence: lossSnapshot.nextSequence - 1, ordinal: 0 },
			};
			expect(
				await index.taskEvidence("query-budget", { leafId: "root", through: lossStart + 255 }, lossOptions),
			).toMatchObject({ entries: [], coverage: "complete" });
			for (const [leafId, taskKey] of [
				["loss-254", lossKey],
				["loss-255", "unrelated-key"],
			]) {
				expect(
					await index.taskEvidence(
						"query-budget",
						{ leafId, through: lossSnapshot.nextSequence - 1 },
						{
							...lossOptions,
							taskKey,
						},
					),
				).toMatchObject({ entries: [], coverage: "partial" });
			}
			for (const leafId of ["root", "loss-256"]) {
				await expect(
					index.taskEvidence("query-budget", { leafId, through: lossSnapshot.nextSequence - 1 }, lossOptions),
				).rejects.toThrow("candidate budget");
			}
		} finally {
			await budgetOwner.close();
		}
	} finally {
		await owner.close();
	}
});

it("does not advance coverage across a missing source sequence and qualifies incomplete text", async () => {
	await expect(index.apply("session", [source("missing", 2, "lost")], 2)).rejects.toThrow("Missing source sequence");
	expect(await index.get("session", "missing")).toBeUndefined();
	await index.apply("session", [{ ...source("Item", 1, "prefix"), textComplete: false }], 1);
	expect((await index.search("session", "not-present", 1)).coverage).toBe("partial");
	await expect(index.page("session", 0, 1, 129)).rejects.toThrow("page limit");
	await expect(index.apply("session", [], 2)).rejects.toThrow("unindexed source coverage");
	expect((await index.page("session", 0, 2)).indexedThrough).toBe(1);
	const applyBatches = async (sessionId: string, values: IndexedSourceEvent[]) => {
		for (let offset = 0; offset < values.length; offset += 128) {
			const batch = values.slice(offset, offset + 128);
			await index.apply(sessionId, batch, batch[batch.length - 1].sequence);
		}
	};
	const siblings = Array.from({ length: 257 }, (_, n) => source(`candidate-${n}`, n + 2, "candidate common"));
	await applyBatches("bounded", [source("Item", 1, "root"), ...siblings]);
	for (const select of [
		(through: number, leafId = "Item") => index.page("bounded", 1, through, 1, { leafId }),
		(through: number, leafId = "Item") => index.search("bounded", "candidate common", through, 1, { leafId }),
	]) {
		expect(await select(257)).toMatchObject({ events: [], coverage: "complete", truncated: false, nextAfter: null });
		const last = await select(257, "candidate-255");
		expect(last.events.map((event) => event.id)).toEqual(["candidate-255"]);
		expect(last).toMatchObject({ coverage: "complete", truncated: false, nextAfter: null });
		await expect(select(258)).rejects.toThrow("candidate budget");
	}
	expect(await index.page("bounded", 1, 258, 1)).toMatchObject({
		events: [siblings[0]],
		truncated: true,
		nextAfter: 2,
	});
	expect(await index.search("bounded", "candidate common", 258, 1)).toMatchObject({
		events: [siblings[256]],
		truncated: true,
		nextAfter: null,
	});
	// Bound the rarest postings before probing the other term.
	const conjunction = [
		source("Item", 1, "common"),
		...siblings.map((event) => ({ ...event, text: "rare" })),
		...Array.from({ length: 257 }, (_, n) => source(`common-${n}`, n + 259, "common")),
	];
	await applyBatches("conjunction", conjunction);
	expect(await index.search("conjunction", "rare common", 257, 1)).toMatchObject({
		events: [],
		coverage: "complete",
		truncated: false,
	});
	await expect(index.search("conjunction", "rare common", 258, 1)).rejects.toThrow("candidate budget");
	// Selection and incomplete-text coverage each get their own candidate budget.
	await applyBatches("sparse", [
		source("Item", 1, "root"),
		...siblings.map((event) => ({ ...event, textComplete: false })),
	]);
	expect(await index.search("sparse", "absent", 257, 1, { leafId: "Item" })).toMatchObject({
		events: [],
		coverage: "complete",
	});
	expect((await index.search("sparse", "candidate common", 257, 1, { leafId: "candidate-255" })).coverage).toBe(
		"partial",
	);
	for (const leafId of ["Item", "candidate-256"]) {
		await expect(index.search("sparse", "absent", 258, 1, { leafId })).rejects.toThrow("candidate budget");
	}
	const journalPath = join(dir, "edge.jsonl");
	const owner = await SessionJournalOwner.open({ journalPath, create: true });
	try {
		await owner.appendJson(JSON.stringify({ type: "session", version: 3, id: "edge", cwd: dir }));
		await owner.appendJson(
			JSON.stringify({ type: "message", id: "kept", parentId: null, message: { role: "user", content: "kept" } }),
		);
		await index.syncSource("edge", owner.getSnapshot());
		await owner.appendJson(
			JSON.stringify({
				type: "custom",
				id: "staged",
				parentId: "kept",
				customType: "task_state",
				data: {
					schema: TASK_STATE_SCHEMA,
					taskKey: "Edge",
					itemId: "new-item",
					kind: "model_plan",
					text: "staged task evidence",
					operation: "declare",
				},
			}),
		);
		const snapshot = owner.getSnapshot();
		const bytes = readFileSync(journalPath);
		const failing = index.syncSource("edge", { ...snapshot, checksum: "0".repeat(64) });
		const queuedRead = index.get("edge", "staged");
		await expect(failing).rejects.toThrow("sequence/checksum");
		expect(await queuedRead).toBeUndefined();
		expect((await index.page("edge", 0, 2)).indexedThrough).toBe(1);
		await expect(index.readPayload("edge", "staged", { leafId: "staged", through: 2 })).rejects.toThrow(
			"requested source prefix",
		);
		await expect(index.branchBootstrap("edge", { leafId: "kept", through: 2 })).rejects.toThrow(
			"requested source prefix",
		);
		await expect(index.parentPath("edge", { leafId: "kept", through: 2 })).rejects.toThrow("requested source prefix");
		await expect(index.getSource("edge", "kept", 2)).rejects.toThrow("requested source prefix");
		await expect(index.readSourcePayload("edge", "kept", 2)).rejects.toThrow("requested source prefix");
		await expect(index.getSource("edge", "kept", -1)).rejects.toThrow("Invalid history source prefix");
		await expect(index.syncSource("wrong-session", snapshot)).rejects.toThrow("session identity");
		await index.syncSource("edge", snapshot);
		expect(
			(
				await index.taskEvidence(
					"edge",
					{ leafId: "staged", through: snapshot.nextSequence - 1 },
					{ taskKey: "Edge", itemId: "new-item" },
				)
			).entries,
		).toHaveLength(1);
		expect(readFileSync(journalPath)).toEqual(bytes);
		await owner.appendJson(JSON.stringify({ type: "message", id: "bootstrap-empty-message", parentId: null }));
		const emptyMessageSnapshot = owner.getSnapshot();
		const emptyMessageScope = { leafId: "bootstrap-empty-message", through: emptyMessageSnapshot.nextSequence - 1 };
		await index.syncSource("edge", emptyMessageSnapshot);
		expect(await index.branchBootstrap("edge", emptyMessageScope)).toMatchObject({
			hasBranchMessage: true,
			hasContextMessages: false,
			goalSeedable: false,
		});
		expect(await index.contextManifest("edge", emptyMessageScope)).toMatchObject({ activeMessageCount: 1 });
		await owner.appendJson(JSON.stringify({ type: "message", id: "orphan", parentId: "late" }));
		const unresolved = owner.getSnapshot();
		const orphanScope = { leafId: "orphan", through: unresolved.nextSequence - 1 };
		await index.syncSource("edge", unresolved);
		await expect(index.branchBootstrap("edge", orphanScope)).rejects.toThrow("lineage is unresolved");
		await expect(index.parentPath("edge", orphanScope)).rejects.toThrow("lineage is unresolved");
		expect((await index.get("edge", "orphan", orphanScope))?.parentId).toBe("late");
		expect(await index.contextManifest("edge", orphanScope)).toMatchObject({
			selection: "unresolved-lineage",
			refs: [],
			nextCursor: null,
		});
		expect(await index.get("edge", "absent", orphanScope)).toBeUndefined();
		await expect(index.get("edge", "kept", orphanScope)).rejects.toThrow("missing parent");
		await expect(index.readPayload("edge", "kept", orphanScope)).rejects.toThrow("missing parent");
		await expect(index.page("edge", orphanScope.through, orphanScope.through, 1, orphanScope)).rejects.toThrow(
			"missing parent",
		);
		await expect(index.search("edge", "absent", orphanScope.through, 1, orphanScope)).rejects.toThrow(
			"missing parent",
		);
		await expect(index.taskEvidence("edge", orphanScope, { taskKey: "absent" })).rejects.toThrow("missing parent");
		await owner.appendJson(JSON.stringify({ type: "message", id: "late", parentId: "kept" }));
		await owner.appendJson(JSON.stringify({ type: "message", id: "cycle-a", parentId: "cycle-b" }));
		await owner.appendJson(JSON.stringify({ type: "message", id: "cycle-b", parentId: "cycle-a" }));
		const linked = owner.getSnapshot();
		const linkedScope = { ...orphanScope, through: linked.nextSequence - 1 };
		await index.syncSource("edge", linked);
		expect((await index.get("edge", "kept", linkedScope))?.id).toBe("kept");
		expect((await index.readPayload("edge", "kept", linkedScope))?.text).toContain('"kept"');
		await expect(index.get("edge", "kept", orphanScope)).rejects.toThrow("missing parent");
		await expect(index.get("edge", "kept", { ...linkedScope, leafId: "cycle-a" })).rejects.toThrow("cycle");
		expect((await index.get("edge", "cycle-a", { ...linkedScope, leafId: "cycle-a" }))?.id).toBe("cycle-a");
		const cycleScope = { ...linkedScope, leafId: "cycle-a" };
		await expect(index.branchBootstrap("edge", cycleScope)).rejects.toThrow("lineage is unresolved");
		await expect(index.parentPath("edge", cycleScope)).rejects.toThrow("lineage is unresolved");
		await expect(index.page("edge", linkedScope.through, linkedScope.through, 1, cycleScope)).rejects.toThrow(
			"cycle",
		);
		await expect(index.search("edge", "absent", linkedScope.through, 1, cycleScope)).rejects.toThrow("cycle");
		await expect(index.taskEvidence("edge", cycleScope, { taskKey: "absent" })).rejects.toThrow("cycle");
		expect((await index.search("edge", "absent", linkedScope.through, 1, linkedScope)).events).toEqual([]);
		expect(await index.get("edge", "orphan", { ...linkedScope, leafId: "kept" })).toBeUndefined();
		expect((await index.contextManifest("edge", linkedScope)).selection).toBe("unresolved-lineage");
		await owner.appendJson(
			JSON.stringify({
				id: "empty-boundary",
				parentId: "bootstrap-empty-message",
				type: "compaction",
				summary: "",
				firstKeptEntryId: "",
			}),
		);
		const emptyBoundarySnapshot = owner.getSnapshot();
		await index.syncSource("edge", emptyBoundarySnapshot);
		expect(
			await index.branchBootstrap("edge", {
				leafId: "empty-boundary",
				through: emptyBoundarySnapshot.nextSequence - 1,
			}),
		).toMatchObject({ hasContextMessages: true, goalSeedable: false });
		expect(
			(
				await index.contextManifest("edge", {
					leafId: "empty-boundary",
					through: emptyBoundarySnapshot.nextSequence - 1,
				})
			).selection,
		).toBe("invalid-first-kept");
		const budgetTarget = { kind: "ipython-sent-message", toolCallId: "budget-call" } as const;
		const budgetEntry = (number: number) =>
			JSON.stringify({
				id: `budget-${number}`,
				parentId: "kept",
				type: "custom",
				customType: "ipython_sent_agent_message",
				data: {
					toolCallId: budgetTarget.toolCallId,
					message: {
						id: `sent-${number}`,
						message: "candidate",
						deliveryStatus: "queued",
						target: { activeSessionId: "active", sessionId: "child" },
					},
				},
			});
		for (let number = 0; number < 128; number++) {
			await owner.appendJson(budgetEntry(number));
		}
		const budgetSnapshot = owner.getSnapshot();
		const budgetScope = { leafId: "budget-0", through: budgetSnapshot.nextSequence - 1 };
		await index.syncSource("edge", budgetSnapshot);
		const firstCandidate = (await index.get("edge", "budget-0"))!;
		expect(await index.contextUpdates("edge", budgetScope, budgetTarget)).toEqual({
			refs: [
				{
					entryId: firstCandidate.id,
					sequence: firstCandidate.sequence,
					kind: "custom",
					locator: firstCandidate.locator,
					revision: firstCandidate.revision,
				},
			],
			order: "source",
		});
		expect(await index.contextUpdates("edge", { ...budgetScope, leafId: "kept" }, budgetTarget)).toEqual({
			refs: [],
			order: "source",
		});
		expect((await index.readContextUpdatePayload("edge", "budget-0", budgetScope, budgetTarget))?.text).toBe(
			budgetEntry(0),
		);
		await owner.appendJson(budgetEntry(128));
		const exhaustedSnapshot = owner.getSnapshot();
		const exhaustedScope = { ...budgetScope, through: exhaustedSnapshot.nextSequence - 1 };
		await index.syncSource("edge", exhaustedSnapshot);
		await expect(index.contextUpdates("edge", exhaustedScope, budgetTarget)).rejects.toThrow("candidate budget");
		await expect(index.contextUpdates("edge", { ...exhaustedScope, leafId: "kept" }, budgetTarget)).rejects.toThrow(
			"candidate budget",
		);
		expect((await index.contextUpdates("edge", budgetScope, budgetTarget)).refs).toHaveLength(1);
		await owner.close();
		writeFileSync(`${journalPath}.replacement`, bytes);
		renameSync(`${journalPath}.replacement`, journalPath);
		await expect(index.syncSource("edge", snapshot)).rejects.toThrow("physical identity");
		await expect(
			index.readPayload("edge", "staged", { leafId: "staged", through: snapshot.nextSequence - 1 }),
		).rejects.toThrow("source identity");
		await expect(index.readSourcePayload("edge", "staged", snapshot.nextSequence - 1)).rejects.toThrow(
			"source identity",
		);
		expect(readFileSync(journalPath)).toEqual(bytes);
	} finally {
		await owner.close();
	}
});
