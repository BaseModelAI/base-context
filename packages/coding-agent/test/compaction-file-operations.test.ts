import type { AgentMessage } from "@ponythewhite/base-context-agent";
import type { AssistantMessage } from "@ponythewhite/base-context-ai";
import { describe, expect, it } from "vitest";
import { prepareBranchEntries } from "../src/core/compaction/branch-summarization.js";
import {
	DEFAULT_COMPACTION_SETTINGS,
	estimateTokens,
	prepareCompaction,
	prepareViewCompaction,
} from "../src/core/compaction/compaction.js";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	formatFileOperations,
} from "../src/core/compaction/utils.js";
import { createBranchSummaryMessage, createCompactionSummaryMessage } from "../src/core/messages.js";
import { renderPublicHistory } from "../src/core/public-context.js";
import type { CompactionEntry, SessionEntry, SessionMessageEntry } from "../src/core/session-manager.js";

function entry(id: string, message: AgentMessage): SessionMessageEntry {
	return { type: "message", id, parentId: null, timestamp: new Date(0).toISOString(), message };
}

function call(id: string): SessionMessageEntry {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "ipython", arguments: { code: "edit()" } }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 0,
	};
	return entry(id, message);
}

function result(id: string, diffs?: unknown): SessionMessageEntry {
	return entry(`${id}-result`, {
		role: "toolResult",
		toolCallId: id,
		toolName: "ipython",
		content: [{ type: "text", text: "edited" }],
		details: { diffs },
		isError: false,
		timestamp: 0,
	});
}

function prior(firstKeptEntryId: string): CompactionEntry {
	return {
		type: "compaction",
		id: "prior",
		parentId: null,
		timestamp: new Date(0).toISOString(),
		summary: "Prior progress",
		firstKeptEntryId,
		tokensBefore: 100,
		details: { readFiles: ["payroll.py", "read-only.py"], modifiedFiles: ["prior.py"] },
	};
}

function chain(entries: SessionEntry[]): SessionEntry[] {
	return entries.map((value, index) => ({ ...value, parentId: entries[index - 1]?.id ?? null }));
}

describe("structured compaction file operations", () => {
	it("tracks structured diff paths and native edits without inferring arbitrary writes", () => {
		const fileOps = createFileOps();
		fileOps.read.add("payroll.py");
		fileOps.read.add("read-only.py");
		extractFileOpsFromMessage(
			result("edit", [{ path: "payroll.py" }, { path: "payroll.py" }, { path: "" }, null, { path: 3 }]).message,
			fileOps,
		);
		const native = call("native").message as AssistantMessage;
		native.content = [{ type: "toolCall", id: "native", name: "edit", arguments: { path: "native.py" } }];
		extractFileOpsFromMessage(native, fileOps);
		extractFileOpsFromMessage(result("without-diffs").message, fileOps);
		expect(computeFileLists(fileOps)).toEqual({
			readFiles: ["read-only.py"],
			modifiedFiles: ["native.py", "payroll.py"],
		});
	});

	it("reseeds prior metadata and uses only summarized captured sources for native and public views", () => {
		const user = entry("user", { role: "user", content: "Edit payroll", timestamp: 0 });
		const older = [call("omitted"), result("omitted", [{ path: "omitted.py" }])];
		const summarized = [user, call("payroll"), result("payroll", [{ path: "payroll.py" }])];
		const previous = prior(user.id);
		const retained = [
			entry("tail", { role: "user", content: "keep".repeat(2000), timestamp: 0 }),
			call("tail-edit"),
			result("tail-edit", [{ path: "tail.py" }]),
		];
		const entries = chain([...older, ...summarized, previous, ...retained]);
		const settings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1000 };
		const native = prepareCompaction(entries, settings)!;
		const selected = [...summarized, ...retained];
		const messages = [
			createCompactionSummaryMessage(previous.summary, previous.tokensBefore, previous.timestamp),
			...selected.map((value) => renderPublicHistory(value.message, value.id, 64 * 1024)),
		];
		const publicView = prepareViewCompaction(
			messages,
			[previous.id, ...selected.map((value) => value.id)],
			entries,
			settings,
		)!;
		for (const preparation of [native, publicView]) {
			expect(preparation.firstKeptEntryId).toBe("tail");
			expect(computeFileLists(preparation.fileOps)).toEqual({
				readFiles: ["read-only.py"],
				modifiedFiles: ["payroll.py", "prior.py"],
			});
		}
		expect(JSON.stringify(publicView.messagesToSummarize)).not.toContain("payroll.py");
	});

	it("keeps public call/result tails whole outside budget-pressure compaction", () => {
		const entries = chain([
			entry("user", { role: "user", content: "earlier task", timestamp: 0 }),
			call("earlier"),
			result("earlier", [{ path: "earlier.py" }]),
			call("kept"),
			result("kept", [{ path: "kept.py" }]),
		]);
		const messages = entries.map((value) =>
			renderPublicHistory((value as SessionMessageEntry).message, value.id, 65536),
		);
		const preparation = prepareViewCompaction(
			messages,
			entries.map((value) => value.id),
			entries,
			{ ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1 },
		)!;
		expect(preparation.firstKeptEntryId).toBe("kept");
		expect(computeFileLists(preparation.fileOps).modifiedFiles).toEqual(["earlier.py"]);
		expect(JSON.stringify(preparation.messagesToSummarize)).not.toContain("kept-result");
	});

	it("keeps a native call/result group whole across an interposed custom message", () => {
		const entries = chain([
			entry("user", { role: "user", content: "earlier task", timestamp: 0 }),
			call("earlier"),
			result("earlier", [{ path: "earlier.py" }]),
			call("kept"),
			{
				type: "custom_message",
				id: "interposed",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				customType: "agent_message",
				content: "A child reported progress while the tool was running.",
				display: true,
			},
			result("kept", [{ path: "kept.py" }]),
		]);
		const preparation = prepareCompaction(entries, { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1 })!;
		expect(preparation.firstKeptEntryId).toBe("kept");
		expect(computeFileLists(preparation.fileOps).modifiedFiles).toEqual(["earlier.py"]);
	});

	it("carries selected native branch summary metadata through compaction but excludes hooks and retained tails", () => {
		const branch = (id: string, fromHook = false): SessionEntry => ({
			type: "branch_summary",
			id,
			parentId: null,
			timestamp: new Date(0).toISOString(),
			fromId: "abandoned",
			summary: "Branch progress",
			fromHook,
			details: { readFiles: ["read.py"], modifiedFiles: [`${id}.py`] },
		});
		const entries = chain([
			branch("selected"),
			branch("hook", true),
			entry("tail", { role: "user", content: "keep".repeat(2000), timestamp: 0 }),
			branch("retained"),
		]);
		const settings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1000 };
		const messages = entries.map((value) =>
			value.type === "branch_summary"
				? createBranchSummaryMessage(value.summary, value.fromId, value.timestamp)
				: (value as SessionMessageEntry).message,
		);
		for (const preparation of [
			prepareCompaction(entries, settings)!,
			prepareViewCompaction(
				messages,
				entries.map((value) => value.id),
				entries,
				settings,
			)!,
		]) {
			expect(preparation.firstKeptEntryId).toBe("tail");
			expect(computeFileLists(preparation.fileOps)).toEqual({
				readFiles: ["read.py"],
				modifiedFiles: ["selected.py"],
			});
		}
		const largeSummary = {
			...branch("large"),
			type: "branch_summary" as const,
			fromId: "abandoned",
			summary: "x".repeat(6000),
		};
		const largeTail = prepareCompaction(chain([...entries, largeSummary]), settings)!;
		expect(largeTail.firstKeptEntryId).toBe("large");
		expect(computeFileLists(largeTail.fileOps).modifiedFiles).toEqual(["retained.py", "selected.py"]);
	});

	it("caps generated lists at 200 paths without dropping cumulative structured metadata", () => {
		const fileOps = createFileOps();
		for (let index = 204; index >= 0; index--) {
			const path = `file-${String(index).padStart(3, "0")}.py`;
			fileOps.edited.add(path);
			fileOps.read.add(path);
			fileOps.read.add(`read-${path}`);
		}
		const { readFiles, modifiedFiles } = computeFileLists(fileOps);
		const rendered = formatFileOperations(readFiles, modifiedFiles);
		expect(rendered.match(/\[\.\.\. 5 more files omitted\]/g)).toHaveLength(2);
		expect(rendered).toContain("file-000.py");
		expect(rendered).toContain("file-199.py");
		expect(rendered).not.toContain("file-200.py");
		expect(readFiles).toHaveLength(205);
		expect(modifiedFiles).toHaveLength(205);
		expect(readFiles.every((path) => path.startsWith("read-"))).toBe(true);
		expect(computeFileLists(fileOps)).toEqual({ readFiles, modifiedFiles });
	});

	it("keeps branch results out of summary messages but tracks only results of selected calls", () => {
		const newer = call("new");
		const entries = chain([
			prior("old"),
			call("old"),
			result("old", [{ path: "old.py" }]),
			newer,
			result("new", [{ path: "new.py" }]),
		]);
		const all = prepareBranchEntries(entries);
		expect(computeFileLists(all.fileOps).modifiedFiles).toEqual(["new.py", "old.py", "prior.py"]);
		const bounded = prepareBranchEntries(entries, estimateTokens(newer.message));
		expect(bounded.messages).toEqual([newer.message]);
		expect(computeFileLists(bounded.fileOps).modifiedFiles).toEqual(["new.py", "prior.py"]);
		expect(all.messages.some((message) => message.role === "toolResult")).toBe(false);
	});
});
