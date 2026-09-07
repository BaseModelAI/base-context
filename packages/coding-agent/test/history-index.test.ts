import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { HistoryIndex, type IndexedSourceEvent } from "../src/core/history-index.js";
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
		await owner.appendJson(entry("root", null, "source root"));
		const first = owner.getSnapshot();
		await owner.appendJson(entry("sibling", "root", "sibling only"));
		const firstSync = index.syncSource("canonical", first);
		const child = Reflect.get(index, "child");
		const closing = index.close();
		expect(await firstSync).toEqual({ ...first, indexedThrough: 1 });
		await closing;
		expect(child.exitCode).toBe(0);
		index = await HistoryIndex.open(join(dir, "index.sqlite"));
		expect(await index.get("canonical", "sibling")).toBeUndefined();
		const indexed = await index.get("canonical", "root");
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
		expect((await index.search("canonical", "sibling", 5, 16, scope)).events).toEqual([]);
		expect((await index.search("canonical", "absent", 5, 16, { leafId: "sibling" })).coverage).toBe("complete");
		expect((await index.search("canonical", "absent", 5, 16, scope)).coverage).toBe("partial");
		const chosen = await index.get("canonical", "chosen");
		expect(Buffer.byteLength(chosen!.text)).toBeLessThanOrEqual(8192);
		expect(chosen?.textComplete).toBe(false);

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
		expect(payload?.format).toBe("canonical-json-fragment");
		expect(payload?.byteOffset).toBe(0);
		expect(payload!.byteLength).toBeLessThanOrEqual(64 * 1024);
		expect(payload?.text).toBe(Buffer.from(hugeJson).subarray(0, payload!.byteLength).toString("utf8"));
		expect(payload?.nextCursor).not.toBeNull();
		const continuation = await index.readPayload("canonical", "huge-task", taskScope, {
			cursor: payload!.nextCursor!,
			maxBytes: 31,
		});
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
		expect((await index.get("canonical", "chain-128", chainScope))?.id).toBe("chain-128");
		await expect(index.readPayload("canonical", "root", chainScope)).rejects.toThrow("index is unavailable");
		await index.syncSource("canonical", chainSnapshot);
		expect((await index.get("canonical", "root", chainScope))?.id).toBe("root");

		await index.close();
		execFileSync(process.execPath, [
			"--experimental-sqlite",
			"--disable-warning=ExperimentalWarning",
			"--input-type=module",
			"-e",
			'import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync(process.argv[1]); try { db.exec("DROP TABLE task_evidence; DROP TABLE task_import_loss; DROP TABLE source_payload; DROP TABLE source_ancestry; DROP TABLE source_jump; UPDATE source_event SET authority=\'user\'; PRAGMA user_version=5;"); } finally { db.close(); }',
			join(dir, "index.sqlite"),
		]);
		index = await HistoryIndex.open(join(dir, "index.sqlite"));
		expect(await index.get("canonical", "root")).toBeUndefined();
		await expect(index.readPayload("canonical", "root", taskScope)).rejects.toThrow("index is unavailable");
		expect(await index.taskEvidence("canonical", taskScope, { taskKey })).toMatchObject({
			entries: [],
			coverage: "partial",
		});
		await index.syncSource("canonical", taskSnapshot);
		expect((await index.get("canonical", "root"))?.authority).toBe("unrecorded");
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
		expect(readFileSync(journalPath)).toEqual(before);
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
		await owner.appendJson(JSON.stringify({ type: "message", id: "orphan", parentId: "late" }));
		const unresolved = owner.getSnapshot();
		const orphanScope = { leafId: "orphan", through: unresolved.nextSequence - 1 };
		await index.syncSource("edge", unresolved);
		expect((await index.get("edge", "orphan", orphanScope))?.parentId).toBe("late");
		expect(await index.get("edge", "absent", orphanScope)).toBeUndefined();
		await expect(index.get("edge", "kept", orphanScope)).rejects.toThrow("missing parent");
		await expect(index.readPayload("edge", "kept", orphanScope)).rejects.toThrow("missing parent");
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
		expect(await index.get("edge", "orphan", { ...linkedScope, leafId: "kept" })).toBeUndefined();
		await owner.close();
		writeFileSync(`${journalPath}.replacement`, bytes);
		renameSync(`${journalPath}.replacement`, journalPath);
		await expect(index.syncSource("edge", snapshot)).rejects.toThrow("physical identity");
		await expect(
			index.readPayload("edge", "staged", { leafId: "staged", through: snapshot.nextSequence - 1 }),
		).rejects.toThrow("source identity");
		expect(readFileSync(journalPath)).toEqual(bytes);
	} finally {
		await owner.close();
	}
});
