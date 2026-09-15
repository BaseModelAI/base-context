import { existsSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { type CustomEntry, loadEntriesFromFile, SessionManager } from "../../src/core/session-manager.js";
import { assistantMsg, userMsg } from "../utilities.js";

describe("SessionManager append and tree traversal", () => {
	describe("append operations", () => {
		it("appendMessage creates entry with correct parentId chain", async () => {
			const session = SessionManager.inMemory();

			const id1 = await session.appendMessage(userMsg("first"));
			const id2 = await session.appendMessage(assistantMsg("second"));
			const id3 = await session.appendMessage(userMsg("third"));

			const entries = session.getEntries();
			expect(entries).toHaveLength(3);

			expect(entries[0].id).toBe(id1);
			expect(entries[0].parentId).toBeNull();
			expect(entries[0].type).toBe("message");

			expect(entries[1].id).toBe(id2);
			expect(entries[1].parentId).toBe(id1);

			expect(entries[2].id).toBe(id3);
			expect(entries[2].parentId).toBe(id2);
		});

		it("appendThinkingLevelChange integrates into tree", async () => {
			const session = SessionManager.inMemory();

			const msgId = await session.appendMessage(userMsg("hello"));
			const thinkingId = await session.appendThinkingLevelChange("high");
			const _msg2Id = await session.appendMessage(assistantMsg("response"));

			const entries = session.getEntries();
			expect(entries).toHaveLength(3);

			const thinkingEntry = entries.find((e) => e.type === "thinking_level_change");
			expect(thinkingEntry).toBeDefined();
			expect(thinkingEntry!.id).toBe(thinkingId);
			expect(thinkingEntry!.parentId).toBe(msgId);

			expect(entries[2].parentId).toBe(thinkingId);
		});

		it("appendModelChange integrates into tree", async () => {
			const session = SessionManager.inMemory();

			const msgId = await session.appendMessage(userMsg("hello"));
			const modelId = await session.appendModelChange("openai", "gpt-4");
			const _msg2Id = await session.appendMessage(assistantMsg("response"));

			const entries = session.getEntries();
			const modelEntry = entries.find((e) => e.type === "model_change");
			expect(modelEntry).toBeDefined();
			expect(modelEntry?.id).toBe(modelId);
			expect(modelEntry?.parentId).toBe(msgId);
			if (modelEntry?.type === "model_change") {
				expect(modelEntry.provider).toBe("openai");
				expect(modelEntry.modelId).toBe("gpt-4");
			}

			expect(entries[2].parentId).toBe(modelId);
		});

		it("appendCompaction integrates into tree", async () => {
			const session = SessionManager.inMemory();

			const id1 = await session.appendMessage(userMsg("1"));
			const id2 = await session.appendMessage(assistantMsg("2"));
			const compactionId = await session.appendCompaction("summary", id1, 1000);
			const _id3 = await session.appendMessage(userMsg("3"));

			const entries = session.getEntries();
			const compactionEntry = entries.find((e) => e.type === "compaction");
			expect(compactionEntry).toBeDefined();
			expect(compactionEntry?.id).toBe(compactionId);
			expect(compactionEntry?.parentId).toBe(id2);
			if (compactionEntry?.type === "compaction") {
				expect(compactionEntry.summary).toBe("summary");
				expect(compactionEntry.firstKeptEntryId).toBe(id1);
				expect(compactionEntry.tokensBefore).toBe(1000);
			}

			expect(entries[3].parentId).toBe(compactionId);
		});

		it("appendCompaction persists customInstructions", async () => {
			const session = SessionManager.inMemory();

			const id1 = await session.appendMessage(userMsg("1"));
			await session.appendMessage(assistantMsg("2"));
			await session.appendCompaction("summary", id1, 1000, undefined, undefined, "focus on xyz");

			const compactionEntry = session.getEntries().find((e) => e.type === "compaction");
			if (compactionEntry?.type === "compaction") {
				expect(compactionEntry.customInstructions).toBe("focus on xyz");
			} else {
				expect.fail("compaction entry not found");
			}
		});

		it("appendCustomEntry integrates into tree", async () => {
			const session = SessionManager.inMemory();

			const msgId = await session.appendMessage(userMsg("hello"));
			const customId = await session.appendCustomEntry("my_data", { key: "value" });
			const _msg2Id = await session.appendMessage(assistantMsg("response"));

			const entries = session.getEntries();
			const customEntry = entries.find((e) => e.type === "custom") as CustomEntry;
			expect(customEntry).toBeDefined();
			expect(customEntry.id).toBe(customId);
			expect(customEntry.parentId).toBe(msgId);
			expect(customEntry.customType).toBe("my_data");
			expect(customEntry.data).toEqual({ key: "value" });

			expect(entries[2].parentId).toBe(customId);
		});

		it("leaf pointer advances after each append", async () => {
			const session = SessionManager.inMemory();

			expect(session.getLeafId()).toBeNull();

			const id1 = await session.appendMessage(userMsg("1"));
			expect(session.getLeafId()).toBe(id1);

			const id2 = await session.appendMessage(assistantMsg("2"));
			expect(session.getLeafId()).toBe(id2);

			const id3 = await session.appendThinkingLevelChange("high");
			expect(session.getLeafId()).toBe(id3);
		});
	});

	describe("getPath", () => {
		it("returns empty array for empty session", async () => {
			const session = SessionManager.inMemory();
			expect(session.getBranch()).toEqual([]);
		});

		it("returns single entry path", async () => {
			const session = SessionManager.inMemory();
			const id = await session.appendMessage(userMsg("hello"));

			const path = session.getBranch();
			expect(path).toHaveLength(1);
			expect(path[0].id).toBe(id);
		});

		it("returns full path from root to leaf", async () => {
			const session = SessionManager.inMemory();

			const id1 = await session.appendMessage(userMsg("1"));
			const id2 = await session.appendMessage(assistantMsg("2"));
			const id3 = await session.appendThinkingLevelChange("high");
			const id4 = await session.appendMessage(userMsg("3"));

			const path = session.getBranch();
			expect(path).toHaveLength(4);
			expect(path.map((e) => e.id)).toEqual([id1, id2, id3, id4]);
		});

		it("returns path from specified entry to root", async () => {
			const session = SessionManager.inMemory();

			const id1 = await session.appendMessage(userMsg("1"));
			const id2 = await session.appendMessage(assistantMsg("2"));
			const _id3 = await session.appendMessage(userMsg("3"));
			const _id4 = await session.appendMessage(assistantMsg("4"));

			const path = session.getBranch(id2);
			expect(path).toHaveLength(2);
			expect(path.map((e) => e.id)).toEqual([id1, id2]);
		});
	});

	describe("getTree", () => {
		it("returns empty array for empty session", async () => {
			const session = SessionManager.inMemory();
			expect(session.getTree()).toEqual([]);
		});

		it("returns single root for linear session", async () => {
			const session = SessionManager.inMemory();

			const id1 = await session.appendMessage(userMsg("1"));
			const id2 = await session.appendMessage(assistantMsg("2"));
			const id3 = await session.appendMessage(userMsg("3"));

			const tree = session.getTree();
			expect(tree).toHaveLength(1);

			const root = tree[0];
			expect(root.entry.id).toBe(id1);
			expect(root.children).toHaveLength(1);
			expect(root.children[0].entry.id).toBe(id2);
			expect(root.children[0].children).toHaveLength(1);
			expect(root.children[0].children[0].entry.id).toBe(id3);
			expect(root.children[0].children[0].children).toHaveLength(0);
		});

		it("returns tree with branches after branch", async () => {
			const session = SessionManager.inMemory();

			const id1 = await session.appendMessage(userMsg("1"));
			const id2 = await session.appendMessage(assistantMsg("2"));
			const id3 = await session.appendMessage(userMsg("3"));

			session.branch(id2);
			const id4 = await session.appendMessage(userMsg("4-branch"));

			const tree = session.getTree();
			expect(tree).toHaveLength(1);

			const root = tree[0];
			expect(root.entry.id).toBe(id1);
			expect(root.children).toHaveLength(1);

			const node2 = root.children[0];
			expect(node2.entry.id).toBe(id2);
			expect(node2.children).toHaveLength(2); // id3 and id4 are siblings

			const childIds = node2.children.map((c) => c.entry.id).sort();
			expect(childIds).toEqual([id3, id4].sort());
		});

		it("handles multiple branches at same point", async () => {
			const session = SessionManager.inMemory();

			const _id1 = await session.appendMessage(userMsg("root"));
			const id2 = await session.appendMessage(assistantMsg("response"));

			session.branch(id2);
			const idA = await session.appendMessage(userMsg("branch-A"));

			session.branch(id2);
			const idB = await session.appendMessage(userMsg("branch-B"));

			session.branch(id2);
			const idC = await session.appendMessage(userMsg("branch-C"));

			const tree = session.getTree();
			const node2 = tree[0].children[0];
			expect(node2.entry.id).toBe(id2);
			expect(node2.children).toHaveLength(3);

			const branchIds = node2.children.map((c) => c.entry.id).sort();
			expect(branchIds).toEqual([idA, idB, idC].sort());
		});

		it("handles deep branching", async () => {
			const session = SessionManager.inMemory();

			// Main path: 1 -> 2 -> 3 -> 4
			const _id1 = await session.appendMessage(userMsg("1"));
			const id2 = await session.appendMessage(assistantMsg("2"));
			const id3 = await session.appendMessage(userMsg("3"));
			const _id4 = await session.appendMessage(assistantMsg("4"));

			session.branch(id2);
			const id5 = await session.appendMessage(userMsg("5"));
			const _id6 = await session.appendMessage(assistantMsg("6"));

			// Branch from 5: 5 -> 7
			session.branch(id5);
			const _id7 = await session.appendMessage(userMsg("7"));

			const tree = session.getTree();

			const node2 = tree[0].children[0];
			expect(node2.children).toHaveLength(2); // id3 and id5

			const node5 = node2.children.find((c) => c.entry.id === id5)!;
			expect(node5.children).toHaveLength(2); // id6 and id7

			const node3 = node2.children.find((c) => c.entry.id === id3)!;
			expect(node3.children).toHaveLength(1); // id4
		});
	});

	describe("branch", () => {
		it("moves leaf pointer to specified entry", async () => {
			const session = SessionManager.inMemory();

			const id1 = await session.appendMessage(userMsg("1"));
			const _id2 = await session.appendMessage(assistantMsg("2"));
			const id3 = await session.appendMessage(userMsg("3"));

			expect(session.getLeafId()).toBe(id3);

			session.branch(id1);
			expect(session.getLeafId()).toBe(id1);
		});

		it("throws for non-existent entry", async () => {
			const session = SessionManager.inMemory();
			await session.appendMessage(userMsg("hello"));

			expect(() => session.branch("nonexistent")).toThrow("Entry nonexistent not found");
		});

		it("new appends become children of branch point", async () => {
			const session = SessionManager.inMemory();

			const id1 = await session.appendMessage(userMsg("1"));
			const _id2 = await session.appendMessage(assistantMsg("2"));

			session.branch(id1);
			const id3 = await session.appendMessage(userMsg("branched"));

			const entries = session.getEntries();
			const branchedEntry = entries.find((e) => e.id === id3)!;
			expect(branchedEntry.parentId).toBe(id1); // sibling of id2
		});
	});

	describe("branchWithSummary", () => {
		it("inserts branch summary and advances leaf", async () => {
			const session = SessionManager.inMemory();

			const id1 = await session.appendMessage(userMsg("1"));
			const _id2 = await session.appendMessage(assistantMsg("2"));
			const _id3 = await session.appendMessage(userMsg("3"));

			const summaryId = await session.branchWithSummary(id1, "Summary of abandoned work");

			expect(session.getLeafId()).toBe(summaryId);

			const entries = session.getEntries();
			const summaryEntry = entries.find((e) => e.type === "branch_summary");
			expect(summaryEntry).toBeDefined();
			expect(summaryEntry?.parentId).toBe(id1);
			if (summaryEntry?.type === "branch_summary") {
				expect(summaryEntry.summary).toBe("Summary of abandoned work");
			}
		});

		it("throws for non-existent entry", async () => {
			const session = SessionManager.inMemory();
			await session.appendMessage(userMsg("hello"));

			await expect(session.branchWithSummary("nonexistent", "summary")).rejects.toThrow(
				"Entry nonexistent not found",
			);
		});
	});

	describe("getLeafEntry", () => {
		it("returns undefined for empty session", async () => {
			const session = SessionManager.inMemory();
			expect(session.getLeafEntry()).toBeUndefined();
		});

		it("returns current leaf entry", async () => {
			const session = SessionManager.inMemory();

			await session.appendMessage(userMsg("1"));
			const id2 = await session.appendMessage(assistantMsg("2"));

			const leaf = session.getLeafEntry();
			expect(leaf).toBeDefined();
			expect(leaf!.id).toBe(id2);
		});
	});

	describe("getEntry", () => {
		it("returns undefined for non-existent id", async () => {
			const session = SessionManager.inMemory();
			expect(session.getEntry("nonexistent")).toBeUndefined();
		});

		it("returns entry by id", async () => {
			const session = SessionManager.inMemory();

			const id1 = await session.appendMessage(userMsg("first"));
			const id2 = await session.appendMessage(assistantMsg("second"));

			const entry1 = session.getEntry(id1);
			expect(entry1).toBeDefined();
			expect(entry1?.type).toBe("message");
			if (entry1?.type === "message" && entry1.message.role === "user") {
				expect(entry1.message.content).toBe("first");
			}

			const entry2 = session.getEntry(id2);
			expect(entry2).toBeDefined();
			if (entry2?.type === "message" && entry2.message.role === "assistant") {
				expect(entry2.message.content[0]).toMatchObject({ type: "text", text: "second" });
			}
		});
	});

	describe("buildSessionContext with branches", () => {
		it("returns messages from current branch only", async () => {
			const session = SessionManager.inMemory();

			// Main: 1 -> 2 -> 3
			await session.appendMessage(userMsg("msg1"));
			const id2 = await session.appendMessage(assistantMsg("msg2"));
			await session.appendMessage(userMsg("msg3"));

			session.branch(id2);
			await session.appendMessage(assistantMsg("msg4-branch"));

			const ctx = session.buildSessionContext();
			expect(ctx.messages).toHaveLength(3); // msg1, msg2, msg4-branch (not msg3)

			expect(ctx.messages[0]).toMatchObject({ role: "user", content: "msg1" });
			expect(ctx.messages[1]).toMatchObject({ role: "assistant", content: [{ type: "text", text: "msg2" }] });
			expect(ctx.messages[2]).toMatchObject({ role: "assistant", content: [{ type: "text", text: "msg4-branch" }] });
		});
	});
});

describe("createBranchedSession", () => {
	it("throws for non-existent entry", async () => {
		const session = SessionManager.inMemory();
		await session.appendMessage(userMsg("hello"));

		await expect(session.createBranchedSession("nonexistent")).rejects.toThrow("Entry nonexistent not found");
	});

	it("creates new session with path to specified leaf (in-memory)", async () => {
		const session = SessionManager.inMemory();

		const id1 = await session.appendMessage(userMsg("1"));
		const id2 = await session.appendMessage(assistantMsg("2"));
		const id3 = await session.appendMessage(userMsg("3"));
		await session.appendMessage(assistantMsg("4"));

		// Branch from 3: 3 -> 5
		session.branch(id3);
		const _id5 = await session.appendMessage(userMsg("5"));

		// Create branched session from id2 (should only have 1 -> 2)
		const result = await session.createBranchedSession(id2);
		expect(result).toBeUndefined(); // in-memory returns null

		const entries = session.getEntries();
		expect(entries).toHaveLength(2);
		expect(entries[0].id).toBe(id1);
		expect(entries[1].id).toBe(id2);
	});

	it("extracts correct path from branched tree", async () => {
		const session = SessionManager.inMemory();

		const id1 = await session.appendMessage(userMsg("1"));
		const id2 = await session.appendMessage(assistantMsg("2"));
		await session.appendMessage(userMsg("3"));

		session.branch(id2);
		const id4 = await session.appendMessage(userMsg("4"));
		const id5 = await session.appendMessage(assistantMsg("5"));

		// Create branched session from id5 (should have 1 -> 2 -> 4 -> 5)
		await session.createBranchedSession(id5);

		const entries = session.getEntries();
		expect(entries).toHaveLength(4);
		expect(entries.map((e) => e.id)).toEqual([id1, id2, id4, id5]);
	});

	it("does not duplicate entries when forking from first user message", async () => {
		const tempDir = join(tmpdir(), `session-fork-dedup-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		let session: SessionManager | undefined;
		try {
			session = await SessionManager.create(tempDir, tempDir);
			const id1 = await session.appendMessage(userMsg("first question"));
			await session.appendMessage(assistantMsg("first answer"));
			await session.appendMessage(userMsg("second question"));
			await session.appendMessage(assistantMsg("second answer"));

			// Fork from the very first user message (no assistant in the branched path)
			const newFile = await session.createBranchedSession(id1);
			expect(newFile).toBeDefined();

			// The returned path names an acknowledged source even without an assistant.
			expect(existsSync(newFile!)).toBe(true);

			// Simulate extension adding entry before assistant (like preset on turn_start)
			await session.appendCustomEntry("preset-state", { name: "plan" });

			// Now the assistant responds
			await session.appendMessage(assistantMsg("new answer"));

			expect(existsSync(newFile!)).toBe(true);
			const records = loadEntriesFromFile(newFile!);

			expect(records.filter((r) => r.type === "session")).toHaveLength(1);

			const entryIds = records
				.filter((r) => r.type !== "session")
				.map((r) => r.id)
				.filter((id): id is string => typeof id === "string");
			expect(new Set(entryIds).size).toBe(entryIds.length);
		} finally {
			await session?.close();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("writes file immediately when forking from a point with assistant messages", async () => {
		const tempDir = join(tmpdir(), `session-fork-with-assistant-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		let session: SessionManager | undefined;
		try {
			session = await SessionManager.create(tempDir, tempDir);
			await session.appendMessage(userMsg("first question"));
			const id2 = await session.appendMessage(assistantMsg("first answer"));
			await session.appendMessage(userMsg("second question"));
			await session.appendMessage(assistantMsg("second answer"));

			// Fork including the assistant message
			const newFile = await session.createBranchedSession(id2);
			expect(newFile).toBeDefined();

			expect(existsSync(newFile!)).toBe(true);
			const records = loadEntriesFromFile(newFile!);
			expect(records.filter((r) => r.type === "session")).toHaveLength(1);
		} finally {
			await session?.close();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
