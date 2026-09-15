import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HistoryIndex } from "../src/core/history-index.js";
import { SessionManager } from "../src/core/session-manager.js";

describe("canonical session history binding", () => {
	it("indexes ACKed source lazily and restricts exact lookup and pages to the captured branch", async () => {
		const dir = mkdtempSync(join(tmpdir(), "base-context-history-"));
		const session = await SessionManager.create(dir, dir);
		try {
			const ids: string[] = [];
			for (let i = 0; i < 13; i++) {
				ids.push(
					await session.appendMessage({ role: "user", content: `needle Foo.txt requirement ${i}`, timestamp: i }),
				);
			}
			const indexPath = join(session.getSessionArtifactDir()!, "history.sqlite");
			expect(existsSync(indexPath)).toBe(false);
			const all = await session.pageHistory(0, 128);
			expect(all.events.map((event) => event.id)).toEqual(ids);
			expect(all.coverage).toBe("complete");
			expect(existsSync(indexPath)).toBe(true);
			const entry = await session.getHistoryEntry(ids[12]);
			expect(entry?.sequence).toBe(13);
			expect(entry?.locator.path).toBe(session.getSessionFile());
			const bytes = readFileSync(session.getSessionFile()!);
			expect(
				bytes.subarray(entry!.locator.offset, entry!.locator.offset + entry!.locator.length).toString(),
			).toContain("needle Foo.txt requirement 12");
			session.branch(ids[0]);
			const alternative = await session.appendMessage({
				role: "user",
				content: "needle foo.txt alternative",
				timestamp: 20,
			});
			expect(await session.getHistoryEntry(ids[12])).toBeUndefined();
			expect((await session.pageHistory()).events.map((event) => event.id)).toEqual([ids[0], alternative]);
			expect((await session.searchHistory("needle")).events.map((event) => event.id)).toEqual([alternative, ids[0]]);
			const taskKey = "owner-task";
			const explicitConstraints = Array.from({ length: 13 }, (_, index) => {
				const id = index === 0 ? "Foo.txt" : index === 1 ? "foo.txt" : `item-${index}`;
				return { id, text: `preserve ${id} exactly`, sourceEntryId: ids[0] };
			});
			await session.appendCustomEntry("prime-context.task-snapshot", {
				schema: "prime-context.task-snapshot/v2",
				taskKey,
				explicitConstraints,
			});
			const evidence = await session.taskEvidence({ taskKey });
			expect(evidence.entries).toHaveLength(13);
			expect(evidence.coverage).toBe("partial");
			expect(evidence.structuredOnly).toBe(true);
			for (const itemId of ["Foo.txt", "foo.txt"]) {
				const exact = await session.taskEvidence({ taskKey, itemId });
				expect(exact.entries).toHaveLength(1);
				expect(exact.entries[0]).toMatchObject({
					truncated: false,
					projection: { itemId, text: `preserve ${itemId} exactly`, authority: "unrecorded" },
				});
			}
			const missing = await session.taskEvidence({ taskKey, itemId: "missing" });
			expect(missing.entries).toEqual([]);
			expect(missing.coverage).toBe("partial");
			session.branch(ids[12]);
			expect((await session.taskEvidence({ taskKey })).entries).toEqual([]);
			const native = await session.appendMessage(
				{ role: "user", content: "Expanded request view", timestamp: 30 },
				{
					version: 1,
					kind: "input",
					actionId: "native-action",
					recordId: "native-record",
					inputSource: "interactive",
					recordRole: "primary",
					submitted: { text: "Preserve Foo.txt exactly" },
				},
			);
			expect((await session.getHistoryEntry(native))?.authority).toBe("unrecorded");
			const originals = await session.taskEvidence();
			expect(originals.entries).toHaveLength(1);
			expect(originals.entries[0]).toMatchObject({
				projection: {
					text: "Preserve Foo.txt exactly",
					authority: "user",
					source: { entryId: native, field: "/nativeOrigin/submitted/text" },
				},
			});

			const fragments: string[] = [];
			let fragment = await session.readHistoryPayload(native, { maxBytes: 64 });
			while (fragment) {
				expect(fragment.byteLength).toBeGreaterThan(0);
				expect(fragment.byteLength).toBeLessThanOrEqual(64);
				fragments.push(fragment.text);
				if (!fragment.nextCursor) break;
				fragment = await session.readHistoryPayload(native, { maxBytes: 64, cursor: fragment.nextCursor });
			}
			expect(JSON.parse(fragments.join(""))).toMatchObject({
				id: native,
				nativeOrigin: { submitted: { text: "Preserve Foo.txt exactly" } },
				message: { content: "Expanded request view" },
			});
			expect(await session.readHistoryPayload(alternative)).toBeUndefined();
		} finally {
			await session.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps canonical writes usable during index failure and rebuilds a deleted derived index", async () => {
		const dir = mkdtempSync(join(tmpdir(), "base-context-history-failure-"));
		let session = await SessionManager.create(dir, dir);
		const file = session.getSessionFile()!;
		const indexPath = join(session.getSessionArtifactDir()!, "history.sqlite");
		const failedSync = vi
			.spyOn(HistoryIndex.prototype, "syncSource")
			.mockRejectedValue(new Error("index unavailable"));
		try {
			const first = await session.appendMessage({ role: "user", content: "literal must remain", timestamp: 0 });
			await expect(session.getHistoryEntry(first)).rejects.toThrow("index unavailable");
			const second = await session.appendMessage({ role: "user", content: "later canonical fact", timestamp: 1 });
			expect(session.getLeafId()).toBe(second);
			expect(readFileSync(file, "utf8")).toContain("literal must remain");
			await session.close();
			failedSync.mockRestore();
			rmSync(indexPath);
			session = await SessionManager.open(file);
			expect((await session.pageHistory()).events.map((event) => event.id)).toEqual([first, second]);
			expect((await session.getHistoryEntry(first))?.text).toContain("literal must remain");
			expect((await session.readHistoryPayload(first))?.text).toContain("literal must remain");
		} finally {
			failedSync.mockRestore();
			await session.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
