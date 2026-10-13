import { fauxAssistantMessage } from "@ponythewhite/base-context-ai";
import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../src/core/session-manager.js";
import { createHarness } from "./harness.js";
import { createDeferred } from "./scheduling.js";

describe("compaction append cancellation", () => {
	it.each([false, true])("checks cancellation after preparing the append (cancel=%s)", async (cancel) => {
		const harness = await createHarness({
			persistSession: true,
			tools: [],
			settings: { compaction: { enabled: false, keepRecentTokens: 1 }, autoRefine: { enabled: false } },
		});
		const entered = createDeferred();
		const release = createDeferred();
		const manager = harness.sessionManager as unknown as {
			_prepareOwnedMetadata(
				state: unknown,
				entry: SessionEntry,
				history: unknown,
				advance: boolean,
			): Promise<unknown>;
		};
		const prepare = manager._prepareOwnedMetadata.bind(manager);
		const preparing = vi.spyOn(manager, "_prepareOwnedMetadata").mockImplementation(async (...args) => {
			const metadata = await prepare(...args);
			if (args[1].type === "compaction") {
				entered.resolve();
				await release.promise;
			}
			return metadata;
		});
		let compacting: Promise<unknown> | undefined;
		try {
			harness.setResponses([
				fauxAssistantMessage("first response"),
				fauxAssistantMessage("second response"),
				fauxAssistantMessage("history summary"),
				fauxAssistantMessage("turn summary"),
			]);
			await harness.session.prompt("first");
			await harness.session.prompt("second");
			compacting = harness.session.compact();
			const outcome = compacting.then(
				(result) => ({ result }),
				(error: unknown) => ({ error }),
			);
			await entered.promise;
			if (cancel) harness.session.abortCompaction();
			release.resolve();
			if (cancel) {
				expect(await outcome).toMatchObject({
					error: { name: "CompactionCancelledError", message: "Compaction cancelled" },
				});
			} else {
				expect(await outcome).toHaveProperty("result.summary");
			}
			const branch = await harness.sessionManager.readBranch();
			expect(branch.filter((entry) => entry.type === "compaction")).toHaveLength(cancel ? 0 : 1);
		} finally {
			release.resolve();
			await compacting?.catch(() => undefined);
			preparing.mockRestore();
			await harness.cleanup();
		}
	});
	it.each([false, true])("does not append a cancelled branch summary (extension=%s)", async (extension) => {
		const harness = await createHarness({
			persistSession: true,
			tools: [],
			settings: { autoRefine: { enabled: false } },
			extensionFactories: extension
				? [
						(pi) => {
							pi.on("session_before_tree", () => ({ summary: { summary: "extension summary" } }));
						},
					]
				: [],
		});
		const entered = createDeferred();
		const release = createDeferred();
		const manager = harness.sessionManager as unknown as {
			_prepareOwnedMetadata(
				state: unknown,
				entry: SessionEntry,
				history: unknown,
				advance: boolean,
			): Promise<unknown>;
		};
		const prepare = manager._prepareOwnedMetadata.bind(manager);
		const preparing = vi.spyOn(manager, "_prepareOwnedMetadata").mockImplementation(async (...args) => {
			const metadata = await prepare(...args);
			if (args[1].type === "branch_summary") {
				entered.resolve();
				await release.promise;
			}
			return metadata;
		});
		let navigating: Promise<unknown> | undefined;
		try {
			const target = await harness.sessionManager.appendMessage(fauxAssistantMessage("branch point"));
			await harness.sessionManager.appendMessage({ role: "user", content: "abandoned branch", timestamp: 0 });
			const sourceLeaf = harness.sessionManager.getLeafId();
			harness.setResponses([fauxAssistantMessage("branch summary")]);
			navigating = harness.session.navigateTree(target, { summarize: true });
			await entered.promise;
			harness.session.abortBranchSummary();
			release.resolve();
			expect(await navigating).toEqual({ cancelled: true, aborted: true });
			expect(harness.sessionManager.getLeafId()).toBe(sourceLeaf);
			expect((await harness.sessionManager.readBranch()).some((entry) => entry.type === "branch_summary")).toBe(
				false,
			);
		} finally {
			release.resolve();
			await navigating?.catch(() => undefined);
			preparing.mockRestore();
			await harness.cleanup();
		}
	});

	it("does not select a branch after cancellation during its source read", async () => {
		let selecting = false;
		const harness = await createHarness({
			persistSession: true,
			tools: [],
			settings: { autoRefine: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", () => {
						selecting = true;
					});
				},
			],
		});
		const entered = createDeferred();
		const release = createDeferred();
		const manager = harness.sessionManager as unknown as {
			_acknowledgedHistory(...args: unknown[]): Promise<unknown>;
		};
		const read = manager._acknowledgedHistory.bind(manager);
		const reading = vi.spyOn(manager, "_acknowledgedHistory").mockImplementation(async (...args) => {
			const history = await read(...args);
			if (selecting) {
				selecting = false;
				entered.resolve();
				await release.promise;
			}
			return history;
		});
		let navigating: Promise<unknown> | undefined;
		try {
			const target = await harness.sessionManager.appendMessage(fauxAssistantMessage("branch point"));
			await harness.sessionManager.appendMessage({ role: "user", content: "abandoned branch", timestamp: 0 });
			const sourceLeaf = harness.sessionManager.getLeafId();
			navigating = harness.session.navigateTree(target);
			await entered.promise;
			harness.session.abortBranchSummary();
			release.resolve();
			expect(await navigating).toEqual({ cancelled: true, aborted: true });
			expect(harness.sessionManager.getLeafId()).toBe(sourceLeaf);
		} finally {
			release.resolve();
			await navigating?.catch(() => undefined);
			reading.mockRestore();
			await harness.cleanup();
		}
	});
});
