import { type Context, fauxAssistantMessage } from "@ponythewhite/base-context-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS, prepareCompaction } from "../../src/core/compaction/compaction.js";
import { computeFileLists } from "../../src/core/compaction/utils.js";
import { createHarness, getMessageText, type Harness } from "./harness.js";
import { createDeferred } from "./scheduling.js";

describe("native summary boundaries", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length) await harnesses.pop()!.cleanup();
	});

	it("preserves cumulative files when branch summary content exceeds its input budget", async () => {
		const harness = await createHarness({
			persistSession: true,
			models: [{ id: "bounded-summary", contextWindow: 1024, maxTokens: 64 }],
			settings: { branchSummary: { reserveTokens: 64 }, autoRefine: { enabled: false } },
		});
		harnesses.push(harness);
		const manager = harness.sessionManager;
		const target = await manager.appendMessage(fauxAssistantMessage("branch point"));
		const modifiedFiles = Array.from({ length: 205 }, (_, index) => `file-${String(index).padStart(3, "0")}.py`);
		await manager.branchWithSummary(
			target,
			"Prior branch progress",
			{
				readFiles: ["read-only.py"],
				modifiedFiles,
			},
			false,
		);
		await manager.appendMessage({ role: "user", content: "x".repeat(8192), timestamp: 0 });

		const result = await harness.session.navigateTree(target, { summarize: true });
		expect(result.cancelled).toBe(false);
		expect(result.summaryEntry?.details).toEqual({ readFiles: ["read-only.py"], modifiedFiles });
		expect(result.summaryEntry?.summary).toContain("No content to summarize");
		expect(result.summaryEntry?.summary).toContain("[... 5 more files omitted]");
		expect(result.summaryEntry?.summary).not.toContain("file-200.py");
		expect((await manager.readEntry(result.summaryEntry!.id))?.type).toBe("branch_summary");

		await manager.appendMessage({ role: "user", content: "retained tail".repeat(500), timestamp: 1 });
		const preparation = prepareCompaction(await manager.readBranch(), {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 100,
		})!;
		expect(computeFileLists(preparation.fileOps)).toEqual({ readFiles: ["read-only.py"], modifiedFiles });
	});

	it("does not switch branches when cancellation arrives during the final flush", async () => {
		const harness = await createHarness({ persistSession: true, settings: { autoRefine: { enabled: false } } });
		harnesses.push(harness);
		const manager = harness.sessionManager;
		const target = await manager.appendMessage(fauxAssistantMessage("branch point"));
		await manager.appendMessage({ role: "user", content: "explore another branch", timestamp: 0 });
		const sourceLeaf = manager.getLeafId();
		let summaryProduced = false;
		harness.setResponses([
			() => {
				summaryProduced = true;
				return fauxAssistantMessage("completed branch summary");
			},
		]);
		const reached = createDeferred();
		const release = createDeferred();
		const originalFlush = manager.flushNow.bind(manager);
		const flush = vi.spyOn(manager, "flushNow").mockImplementation(async () => {
			await originalFlush();
			if (summaryProduced) {
				reached.resolve();
				await release.promise;
			}
		});
		try {
			const navigation = harness.session.navigateTree(target, { summarize: true });
			await reached.promise;
			harness.session.abortBranchSummary();
			release.resolve();
			expect(await navigation).toEqual({ cancelled: true, aborted: true });
			expect(manager.getLeafId()).toBe(sourceLeaf);
			expect((await manager.readBranch()).some((entry) => entry.type === "branch_summary")).toBe(false);
		} finally {
			release.resolve();
			flush.mockRestore();
		}
	});

	it.each([
		{ persistSession: true, abortedPart: "history" },
		{ persistSession: false, abortedPart: "turn-prefix" },
	])("does not commit a provider-aborted $abortedPart summary", async ({ persistSession, abortedPart }) => {
		const harness = await createHarness({
			persistSession,
			settings: { compaction: { enabled: false, keepRecentTokens: 1 }, autoRefine: { enabled: false } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first response"), fauxAssistantMessage("retained response")]);
		await harness.session.prompt("Keep the original rules.");
		await harness.session.prompt("Continue the work.");
		const sourceLeaf = harness.sessionManager.getLeafId();
		const response = (text: string) => (context: Context) => {
			const turnPrefix = context.messages.some((message) => getMessageText(message).includes("PREFIX of a turn"));
			return fauxAssistantMessage(
				text,
				(turnPrefix ? "turn-prefix" : "history") === abortedPart
					? { stopReason: "aborted", errorMessage: "provider stopped summary" }
					: {},
			);
		};
		harness.setResponses([response("partial summary must not commit"), response("partial summary must not commit")]);
		await expect(harness.session.compact()).rejects.toMatchObject({
			name: "AbortError",
			message: "provider stopped summary",
		});
		expect(harness.sessionManager.getLeafId()).toBe(sourceLeaf);
		expect((await harness.sessionManager.readBranch()).some((entry) => entry.type === "compaction")).toBe(false);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({ aborted: true, result: undefined });

		harness.setResponses([fauxAssistantMessage("complete summary"), fauxAssistantMessage("complete prefix")]);
		await harness.session.compact();
		expect((await harness.sessionManager.readBranch()).filter((entry) => entry.type === "compaction")).toHaveLength(
			1,
		);
	});
});
