import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HistoryIndex } from "../src/core/history-index.js";
import { IPYTHON_SENT_AGENT_MESSAGE_CUSTOM_ENTRY } from "../src/core/session-context-updates.js";
import { SessionManager } from "../src/core/session-manager.js";
import { emptyUsage } from "../src/core/usage.js";

describe("canonical session history binding", () => {
	it("indexes ACKed source and restricts exact lookup and pages to the captured branch", async () => {
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
			// Existing indexed-owner startup initializes the derived index before explicit history reads.
			expect(existsSync(indexPath)).toBe(true);
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
			await session.branchTo(ids[0]);
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
			await session.branchTo(ids[12]);
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
			// Raw nativeOrigin fields cannot mint native-admission authority.
			expect(originals.entries[0]).toMatchObject({
				projection: {
					text: "Preserve Foo.txt exactly",
					authority: "unrecorded",
					attribution: "proposal",
					claimedAuthority: "user",
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

	it("pages all source update revisions, including off-branch records, through one captured prefix", async () => {
		const dir = mkdtempSync(join(tmpdir(), "base-context-source-updates-"));
		const session = await SessionManager.create(dir, dir);
		try {
			const assistant = await session.appendMessage({
				role: "assistant",
				content: [{ type: "toolCall", id: "tool-1", name: "ipython", arguments: { code: "pass" } }],
				api: "openai-completions",
				provider: "openai",
				model: "test",
				usage: emptyUsage(),
				stopReason: "toolUse",
				timestamp: 0,
			});
			const updates: string[] = [];
			for (let index = 0; index < 65; index++)
				updates.push(await session.appendChildUsageAttribution(assistant, emptyUsage()));
			const sentData = {
				toolCallId: "tool-1",
				message: {
					id: "sent-1",
					message: "sent off branch",
					deliveryStatus: "delivered",
					target: { activeSessionId: "peer", sessionId: "peer-session" },
				},
			};
			const sent = await session.appendCustomEntry(IPYTHON_SENT_AGENT_MESSAGE_CUSTOM_ENTRY, sentData);
			await session.branchTo(assistant);
			const usageTarget = { kind: "assistant-usage" as const, targetId: assistant };
			const sentTarget = { kind: "ipython-sent-message" as const, toolCallId: "tool-1" };
			let lateSent: string;
			await session.readSourceHistory(async (history) => {
				await session.appendChildUsageAttribution(assistant, emptyUsage());
				lateSent = await session.appendCustomEntry(IPYTHON_SENT_AGENT_MESSAGE_CUSTOM_ENTRY, {
					...sentData,
					message: { ...sentData.message, id: "sent-late" },
				});
				const payloadRead = vi.spyOn(HistoryIndex.prototype, "readSourcePayload");
				try {
					const first = await history.sourceContextUpdates(usageTarget);
					expect(first.events.map((event) => event.id)).toEqual(updates.slice(0, 64));
					expect(first.coverage).toBe("complete");
					expect(first.indexedThrough).toBeGreaterThanOrEqual(history.source.sourceSequence);
					expect(first.truncated).toBe(true);
					expect(first.nextAfter).toBe(first.events.at(-1)?.sequence);
					const second = await history.sourceContextUpdates(usageTarget, first.nextAfter!);
					expect(second.events.map((event) => event.id)).toEqual(updates.slice(64));
					expect(second).toMatchObject({ coverage: "complete", truncated: false, nextAfter: null });
					expect((await history.sourceContextUpdates(sentTarget)).events.map((event) => event.id)).toEqual([sent]);
					expect((await history.branchContext.contextUpdates(sentTarget)).refs).toEqual([]);
					await expect(history.sourceContextUpdates(usageTarget, -1)).rejects.toThrow(
						"Invalid history query source range",
					);
					expect(payloadRead).not.toHaveBeenCalled();
				} finally {
					payloadRead.mockRestore();
				}
			});
			expect(
				await session.readSourceHistory(async (history) =>
					(await history.sourceContextUpdates(sentTarget)).events.map((event) => event.id),
				),
			).toEqual([sent, lateSent!]);
		} finally {
			await session.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("refuses unavailable indexed planning without poisoning the writer and rebuilds a deleted index", async () => {
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
			const before = readFileSync(file, "utf8");
			await expect(
				session.appendMessage({ role: "user", content: "unverified append", timestamp: 1 }),
			).rejects.toThrow("index unavailable");
			expect(readFileSync(file, "utf8")).toBe(before);
			expect(session.getLeafId()).toBe(first);
			failedSync.mockRestore();
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
