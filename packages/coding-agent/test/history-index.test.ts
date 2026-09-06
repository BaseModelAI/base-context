import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { HistoryIndex, type IndexedSourceEvent } from "../src/core/history-index.js";

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
	expect(await index.get("other", "Item")).toBeUndefined();
	expect((await index.page("session", 0, 2, 1)).events).toEqual([events[0]]);
	expect((await index.search("session", "parser", 2)).events).toEqual([events[0]]);
	await index.clear("session");
	expect((await index.page("session", 0, 2)).coverage).toBe("partial");
	await index.apply("session", events, 2);
	expect((await index.page("session", 0, 2)).coverage).toBe("complete");
});

it("does not advance coverage across a missing source sequence and qualifies incomplete text", async () => {
	await expect(index.apply("session", [source("missing", 2, "lost")], 2)).rejects.toThrow("Missing source sequence");
	expect(await index.get("session", "missing")).toBeUndefined();
	await index.apply("session", [{ ...source("Item", 1, "prefix"), textComplete: false }], 1);
	expect((await index.search("session", "not-present", 1)).coverage).toBe("partial");
	await expect(index.page("session", 0, 1, 129)).rejects.toThrow("page limit");
	await expect(index.apply("session", [], 2)).rejects.toThrow("unindexed source coverage");
	expect((await index.page("session", 0, 2)).indexedThrough).toBe(1);
});
