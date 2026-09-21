import type { AgentMessage } from "@ponythewhite/base-context-agent";
import type { AssistantMessage, Usage } from "@ponythewhite/base-context-ai";
import { getModel } from "@ponythewhite/base-context-ai";
import { readFileSync } from "fs";
import { join } from "path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	buildSummarizationPrompt,
	type CompactionSettings,
	calculateContextTokens,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	estimateFixedCompactionTokens,
	findCutPoint,
	getLastAssistantUsage,
	prepareCompaction,
	prepareViewCompaction,
	shouldCompact,
} from "../src/core/compaction/index.js";
import { HARNESS_SNAPSHOT_CUSTOM_TYPE } from "../src/core/messages.js";
import { renderPublicHistory } from "../src/core/public-context.js";
import {
	buildSessionContext,
	type CompactionEntry,
	type ModelChangeEntry,
	migrateSessionEntries,
	parseSessionEntries,
	type SessionEntry,
	type SessionMessageEntry,
	type ThinkingLevelChangeEntry,
} from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { TASK_FRAME_CUSTOM_TYPE } from "../src/core/task-frame.js";

// ============================================================================
// Test fixtures
// ============================================================================

function loadLargeSessionEntries(): SessionEntry[] {
	const sessionPath = join(__dirname, "fixtures/large-session.jsonl");
	const content = readFileSync(sessionPath, "utf-8");
	const entries = parseSessionEntries(content);
	migrateSessionEntries(entries); // Add id/parentId for v1 fixtures
	return entries.filter((e): e is SessionEntry => e.type !== "session");
}

function createMockUsage(input: number, output: number, cacheRead = 0, cacheWrite = 0): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createUserMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function createAssistantMessage(text: string, usage?: Usage): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: usage || createMockUsage(100, 50),
		stopReason: "stop",
		timestamp: Date.now(),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
	};
}

let entryCounter = 0;
let lastId: string | null = null;

function resetEntryCounter() {
	entryCounter = 0;
	lastId = null;
}

// Reset counter before each test to get predictable IDs
beforeEach(() => {
	resetEntryCounter();
});

function createMessageEntry(message: AgentMessage): SessionMessageEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: SessionMessageEntry = {
		type: "message",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		message,
	};
	lastId = id;
	return entry;
}

function createCompactionEntry(summary: string, firstKeptEntryId: string): CompactionEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: CompactionEntry = {
		type: "compaction",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		summary,
		firstKeptEntryId,
		tokensBefore: 10000,
	};
	lastId = id;
	return entry;
}

function createModelChangeEntry(provider: string, modelId: string): ModelChangeEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: ModelChangeEntry = {
		type: "model_change",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		provider,
		modelId,
	};
	lastId = id;
	return entry;
}

function createThinkingLevelEntry(thinkingLevel: string): ThinkingLevelChangeEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: ThinkingLevelChangeEntry = {
		type: "thinking_level_change",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		thinkingLevel,
	};
	lastId = id;
	return entry;
}

function extractText(messages: AgentMessage[]): string {
	return messages
		.map((message) => {
			switch (message.role) {
				case "user":
					return typeof message.content === "string"
						? message.content
						: message.content
								.filter((block): block is { type: "text"; text: string } => block.type === "text")
								.map((block) => block.text)
								.join(" ");
				case "assistant":
					return message.content
						.filter((block): block is { type: "text"; text: string } => block.type === "text")
						.map((block) => block.text)
						.join(" ");
				case "branchSummary":
				case "compactionSummary":
					return message.summary;
				case "custom":
				case "toolResult":
					return typeof message.content === "string"
						? message.content
						: message.content
								.filter((block): block is { type: "text"; text: string } => block.type === "text")
								.map((block) => block.text)
								.join(" ");
				case "bashExecution":
					return `${message.command}\n${message.output}`;
				default:
					return "";
			}
		})
		.join("\n");
}

// ============================================================================
// Unit tests
// ============================================================================

describe("buildSummarizationPrompt", () => {
	it("omits user instructions block when no instructions given", () => {
		const prompt = buildSummarizationPrompt();
		expect(prompt).not.toContain("<user-instructions>");
		expect(prompt).toContain("## Goal");
		expect(prompt).toContain("does not establish whether a Python kernel is live");
		expect(prompt).toContain("do not infer either survival or loss from compaction");
		expect(prompt).not.toContain("Python kernel keeps running");
		expect(prompt).not.toMatch(/wiped|restarted/);
	});

	it("includes user instructions in a delimited block before the kernel note", () => {
		const prompt = buildSummarizationPrompt("focus on the auth refactor, remember the migration command");
		expect(prompt).toContain("<user-instructions>");
		expect(prompt).toContain("focus on the auth refactor, remember the migration command");
		expect(prompt).toContain("</user-instructions>");
		expect(prompt.indexOf("</user-instructions>")).toBeLessThan(prompt.indexOf("Python kernel"));
	});

	it("uses the update template when a previous summary exists", () => {
		const initial = buildSummarizationPrompt("focus on xyz");
		const update = buildSummarizationPrompt("focus on xyz", "## Goal\nprevious summary");
		expect(initial).not.toContain("existing summary provided in <previous-summary> tags");
		expect(update).toContain("existing summary provided in <previous-summary> tags");
		expect(update).toContain("<user-instructions>");
		expect(update).toContain("Preserve useful names and their last observed state, including uncertainty");
		expect(update).toContain("Use current runtime reports before relying on them");
		expect(update).not.toContain("every Python variable");
		expect(update.slice(update.indexOf("Runtime note:"))).toBe(initial.slice(initial.indexOf("Runtime note:")));
	});
});

describe("Token calculation", () => {
	it("should calculate total context tokens from usage", () => {
		const usage = createMockUsage(1000, 500, 200, 100);
		expect(calculateContextTokens(usage)).toBe(1800);
	});

	it("should handle zero values", () => {
		const usage = createMockUsage(0, 0, 0, 0);
		expect(calculateContextTokens(usage)).toBe(0);
	});
});

describe("getLastAssistantUsage", () => {
	it("should find the last non-aborted assistant message usage", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("Hello")),
			createMessageEntry(createAssistantMessage("Hi", createMockUsage(100, 50))),
			createMessageEntry(createUserMessage("How are you?")),
			createMessageEntry(createAssistantMessage("Good", createMockUsage(200, 100))),
		];

		const usage = getLastAssistantUsage(entries);
		expect(usage).not.toBeNull();
		expect(usage!.input).toBe(200);
	});

	it("should skip aborted messages", () => {
		const abortedMsg: AssistantMessage = {
			...createAssistantMessage("Aborted", createMockUsage(300, 150)),
			stopReason: "aborted",
		};

		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("Hello")),
			createMessageEntry(createAssistantMessage("Hi", createMockUsage(100, 50))),
			createMessageEntry(createUserMessage("How are you?")),
			createMessageEntry(abortedMsg),
		];

		const usage = getLastAssistantUsage(entries);
		expect(usage).not.toBeNull();
		expect(usage!.input).toBe(100);
	});

	it("should return undefined if no assistant messages", () => {
		const entries: SessionEntry[] = [createMessageEntry(createUserMessage("Hello"))];
		expect(getLastAssistantUsage(entries)).toBeUndefined();
	});
});

describe("shouldCompact", () => {
	it("uses a model-aware working target while preserving the model ceiling and recent-context headroom", () => {
		const settings = SettingsManager.inMemory().getCompactionSettings();
		expect(shouldCompact(96_000, 272_000, settings)).toBe(false);
		expect(shouldCompact(96_001, 272_000, settings)).toBe(true);
		expect(shouldCompact(80_000, 128_000, settings)).toBe(false);
		expect(shouldCompact(80_001, 128_000, settings)).toBe(true);
		expect(shouldCompact(47_617, 64_000, settings)).toBe(true);
		const configured = SettingsManager.inMemory({ compaction: { targetTokens: 120_000 } }).getCompactionSettings();
		expect(shouldCompact(100_000, 272_000, configured)).toBe(false);
		expect(shouldCompact(120_001, 272_000, configured)).toBe(true);
		expect(shouldCompact(47_617, 64_000, configured)).toBe(true);
		const full = SettingsManager.inMemory({ compaction: { targetTokens: "model-limit" } }).getCompactionSettings();
		expect(shouldCompact(255_616, 272_000, full)).toBe(false);
		expect(shouldCompact(255_617, 272_000, full)).toBe(true);
	});

	it("leaves working room above fixed instructions but never raises the model ceiling", () => {
		const settings = SettingsManager.inMemory().getCompactionSettings();
		expect(shouldCompact(200_000, 272_000, settings, 120_000)).toBe(false);
		expect(shouldCompact(200_001, 272_000, settings, 120_000)).toBe(true);
		expect(shouldCompact(255_617, 272_000, settings, 300_000)).toBe(true);
		const explicit = { ...settings, targetTokens: 160_000 };
		expect(shouldCompact(160_000, 272_000, explicit, 10_000)).toBe(false);
		expect(shouldCompact(160_001, 272_000, explicit, 10_000)).toBe(true);
		expect(shouldCompact(200_000, 272_000, explicit, 120_000)).toBe(false);
		const full = { ...settings, targetTokens: "model-limit" as const };
		expect(shouldCompact(255_616, 272_000, full, 300_000)).toBe(false);
		expect(shouldCompact(255_617, 272_000, full, 300_000)).toBe(true);
	});

	it("estimates only fixed schemas, current TaskFrame pieces and the latest harness snapshot", () => {
		const custom = (customType: string, content: string): AgentMessage => ({
			role: "custom",
			customType,
			content,
			display: false,
			timestamp: 0,
		});
		const oldSnapshot = custom(HARNESS_SNAPSHOT_CUSTOM_TYPE, "old ".repeat(1_000));
		const frame = custom(TASK_FRAME_CUSTOM_TYPE, "frame ".repeat(20));
		const revision = custom(TASK_FRAME_CUSTOM_TYPE, "new ".repeat(10));
		const snapshot = custom(HARNESS_SNAPSHOT_CUSTOM_TYPE, "current ".repeat(10));
		const user: AgentMessage = { role: "user", content: "history ".repeat(1_000), timestamp: 0 };
		const messages = [
			oldSnapshot,
			frame,
			user,
			revision,
			snapshot,
			createAssistantMessage("archived history ".repeat(1_000)),
			custom("ordinary", "history ".repeat(1_000)),
		];
		const tools = [{ name: "inspect", description: "inspect selected data", parameters: { type: "object" } }];
		const expected = Math.ceil((40 + JSON.stringify(tools).length) / 4) + 30 + 10 + 20;
		expect(estimateFixedCompactionTokens("s".repeat(40), tools, messages)).toBe(expected);
		expect(
			estimateFixedCompactionTokens(
				"s".repeat(40),
				tools,
				messages.map((message, index) => renderPublicHistory(message, String(index), 100_000)),
			),
		).toBe(expected);
	});

	it("rejects a nonpositive working target", () => {
		expect(() => SettingsManager.inMemory({ compaction: { targetTokens: 0 } }).getCompactionSettings()).toThrow(
			"compaction.targetTokens",
		);
	});

	it("should return true when context exceeds threshold", () => {
		const settings: CompactionSettings = {
			enabled: true,
			reserveTokens: 10000,
			keepRecentTokens: 20000,
		};

		expect(shouldCompact(95000, 100000, settings)).toBe(true);
		expect(shouldCompact(80000, 100000, settings)).toBe(false);
	});

	it("should return false when disabled", () => {
		const settings: CompactionSettings = {
			enabled: false,
			reserveTokens: 10000,
			keepRecentTokens: 20000,
		};

		expect(shouldCompact(95000, 100000, settings)).toBe(false);
	});

	it("should return false when context window is unknown", () => {
		const settings: CompactionSettings = {
			enabled: true,
			reserveTokens: 10000,
			keepRecentTokens: 20000,
		};

		expect(shouldCompact(95000, 0, settings)).toBe(false);
	});
});

describe("findCutPoint", () => {
	it("should find cut point based on actual token differences", () => {
		// Create entries with cumulative token counts
		const entries: SessionEntry[] = [];
		for (let i = 0; i < 10; i++) {
			entries.push(createMessageEntry(createUserMessage(`User ${i}`)));
			entries.push(
				createMessageEntry(createAssistantMessage(`Assistant ${i}`, createMockUsage(0, 100, (i + 1) * 1000, 0))),
			);
		}

		// 20 entries, last assistant has 10000 tokens
		// keepRecentTokens = 2500: keep entries where diff < 2500
		const result = findCutPoint(entries, 0, entries.length, 2500);

		// Should cut at a valid cut point (user or assistant message)
		expect(entries[result.firstKeptEntryIndex].type).toBe("message");
		const role = (entries[result.firstKeptEntryIndex] as SessionMessageEntry).message.role;
		expect(role === "user" || role === "assistant").toBe(true);
	});

	it("should return startIndex if no valid cut points in range", () => {
		const entries: SessionEntry[] = [createMessageEntry(createAssistantMessage("a"))];
		const result = findCutPoint(entries, 0, entries.length, 1000);
		expect(result.firstKeptEntryIndex).toBe(0);
	});

	it("should keep everything if all messages fit within budget", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("1")),
			createMessageEntry(createAssistantMessage("a", createMockUsage(0, 50, 500, 0))),
			createMessageEntry(createUserMessage("2")),
			createMessageEntry(createAssistantMessage("b", createMockUsage(0, 50, 1000, 0))),
		];

		const result = findCutPoint(entries, 0, entries.length, 50000);
		expect(result.firstKeptEntryIndex).toBe(0);
	});

	it("should indicate split turn when cutting at assistant message", () => {
		// Create a scenario where we cut at an assistant message mid-turn
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("Turn 1")),
			createMessageEntry(createAssistantMessage("A1", createMockUsage(0, 100, 1000, 0))),
			createMessageEntry(createUserMessage("Turn 2")), // index 2
			createMessageEntry(createAssistantMessage("A2-1", createMockUsage(0, 100, 5000, 0))), // index 3
			createMessageEntry(createAssistantMessage("A2-2", createMockUsage(0, 100, 8000, 0))), // index 4
			createMessageEntry(createAssistantMessage("A2-3", createMockUsage(0, 100, 10000, 0))), // index 5
		];

		// With keepRecentTokens = 3000, should cut somewhere in Turn 2
		const result = findCutPoint(entries, 0, entries.length, 3000);

		// If cut at assistant message (not user), should indicate split turn
		const cutEntry = entries[result.firstKeptEntryIndex] as SessionMessageEntry;
		if (cutEntry.message.role === "assistant") {
			expect(result.isSplitTurn).toBe(true);
			expect(result.turnStartIndex).toBe(2); // Turn 2 starts at index 2
		}
	});
});

describe("buildSessionContext", () => {
	it("should load all messages when no compaction", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("1")),
			createMessageEntry(createAssistantMessage("a")),
			createMessageEntry(createUserMessage("2")),
			createMessageEntry(createAssistantMessage("b")),
		];

		const loaded = buildSessionContext(entries);
		expect(loaded.messages.length).toBe(4);
		expect(loaded.thinkingLevel).toBe("off");
		expect(loaded.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
	});

	it("should handle single compaction", () => {
		// IDs: u1=test-id-0, a1=test-id-1, u2=test-id-2, a2=test-id-3, compaction=test-id-4, u3=test-id-5, a3=test-id-6
		const u1 = createMessageEntry(createUserMessage("1"));
		const a1 = createMessageEntry(createAssistantMessage("a"));
		const u2 = createMessageEntry(createUserMessage("2"));
		const a2 = createMessageEntry(createAssistantMessage("b"));
		const compaction = createCompactionEntry("Summary of 1,a,2,b", u2.id); // keep from u2 onwards
		const u3 = createMessageEntry(createUserMessage("3"));
		const a3 = createMessageEntry(createAssistantMessage("c"));

		const entries: SessionEntry[] = [u1, a1, u2, a2, compaction, u3, a3];

		const loaded = buildSessionContext(entries);
		// summary + kept (u2, a2) + after (u3, a3) = 5
		expect(loaded.messages.length).toBe(5);
		expect(loaded.messages[0]).toMatchObject({
			role: "compactionSummary",
			summary: expect.stringContaining("Summary of 1,a,2,b"),
			retainedMessageCount: 2,
		});
	});

	it("should handle multiple compactions (only latest matters)", () => {
		// First batch
		const u1 = createMessageEntry(createUserMessage("1"));
		const a1 = createMessageEntry(createAssistantMessage("a"));
		const compact1 = createCompactionEntry("First summary", u1.id);
		// Second batch
		const u2 = createMessageEntry(createUserMessage("2"));
		const b = createMessageEntry(createAssistantMessage("b"));
		const u3 = createMessageEntry(createUserMessage("3"));
		const c = createMessageEntry(createAssistantMessage("c"));
		const compact2 = createCompactionEntry("Second summary", u3.id); // keep from u3 onwards
		// After second compaction
		const u4 = createMessageEntry(createUserMessage("4"));
		const d = createMessageEntry(createAssistantMessage("d"));

		const entries: SessionEntry[] = [u1, a1, compact1, u2, b, u3, c, compact2, u4, d];

		const loaded = buildSessionContext(entries);
		// summary + kept from u3 (u3, c) + after (u4, d) = 5
		expect(loaded.messages.length).toBe(5);
		expect((loaded.messages[0] as any).summary).toContain("Second summary");
	});

	it("should keep all messages when firstKeptEntryId is first entry", () => {
		const u1 = createMessageEntry(createUserMessage("1"));
		const a1 = createMessageEntry(createAssistantMessage("a"));
		const compact1 = createCompactionEntry("First summary", u1.id); // keep from first entry
		const u2 = createMessageEntry(createUserMessage("2"));
		const b = createMessageEntry(createAssistantMessage("b"));

		const entries: SessionEntry[] = [u1, a1, compact1, u2, b];

		const loaded = buildSessionContext(entries);
		// summary + all messages (u1, a1, u2, b) = 5
		expect(loaded.messages.length).toBe(5);
	});

	it("should track model and thinking level changes", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("1")),
			createModelChangeEntry("openai", "gpt-4"),
			createMessageEntry(createAssistantMessage("a")),
			createThinkingLevelEntry("high"),
		];

		const loaded = buildSessionContext(entries);
		// model_change is later overwritten by assistant message's model info
		expect(loaded.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
		expect(loaded.thinkingLevel).toBe("high");
	});
});

describe("compaction token calibration", () => {
	it("retains the same 20k-token suffix in view and ordinary paths when chars/4 underestimates", () => {
		const entries = [
			createMessageEntry(createUserMessage("u".repeat(20000))),
			createMessageEntry(createAssistantMessage("a".repeat(20000))),
			createMessageEntry(createUserMessage("v".repeat(20000))),
			createMessageEntry(createAssistantMessage("b".repeat(20000), createMockUsage(38000, 2000))),
		];
		const messages = entries.map((entry) => entry.message);
		const ids = entries.map((entry) => entry.id);
		// 20k heuristic tokens, 40k observed: the last user/assistant pair is the retained 20k.
		const preparations = [
			prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS),
			prepareViewCompaction(messages, ids, entries, DEFAULT_COMPACTION_SETTINGS),
		];
		for (const preparation of preparations) {
			expect(preparation?.firstKeptEntryId).toBe(entries[2].id);
			expect(preparation?.messagesToSummarize).toEqual(messages.slice(0, 2));
			expect(preparation?.tokensBefore).toBe(40000);
		}
	});

	it("retains the whole tool group when its result crosses 20k before a later legal cut", () => {
		const entries = [
			createMessageEntry(createUserMessage("Previous task")),
			createMessageEntry(createAssistantMessage("Finished", createMockUsage(0, 0))),
			createMessageEntry(createUserMessage("Read the fixture")),
			createMessageEntry({
				...createAssistantMessage("", createMockUsage(0, 0)),
				content: [{ type: "toolCall", id: "read_fixture", name: "read_fixture", arguments: {} }],
				stopReason: "toolUse",
			}),
			createMessageEntry({
				role: "toolResult",
				toolCallId: "read_fixture",
				toolName: "read_fixture",
				content: [{ type: "text", text: "r".repeat(80_000) }],
				isError: false,
				timestamp: Date.now(),
			}),
			createMessageEntry(createUserMessage("Continue")),
		];
		const messages = entries.map((entry) => entry.message);
		const preparations = [
			prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS),
			prepareViewCompaction(
				messages,
				entries.map((entry) => entry.id),
				entries,
				DEFAULT_COMPACTION_SETTINGS,
			),
		];
		for (const preparation of preparations) {
			expect(preparation?.firstKeptEntryId).toBe(entries[3].id);
			expect(preparation?.messagesToSummarize).toEqual(messages.slice(0, 2));
			expect(preparation?.turnPrefixMessages).toEqual([messages[2]]);
		}
	});

	it("keeps ordinary suffix estimates when usage is unavailable or the heuristic is already higher", () => {
		for (const stopReason of ["error", "stop"] as const) {
			const entries = Array.from({ length: 3 }, () => [
				createMessageEntry(createUserMessage("u".repeat(20000))),
				createMessageEntry({
					...createAssistantMessage("a".repeat(20000), createMockUsage(14000, 1000)),
					stopReason,
				}),
			]).flat();
			// Error usage is ignored; otherwise observed 15k is below the 30k heuristic.
			const preparation = prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS);
			expect(preparation?.firstKeptEntryId).toBe(entries[2].id);
		}
	});
});

describe("prepareViewCompaction under confirmed public budget pressure", () => {
	it("summarizes older whole tool groups while retaining the latest complete exchange below 20k", () => {
		const entries = [
			createMessageEntry(createUserMessage("Previous task")),
			createMessageEntry(createAssistantMessage("Finished", createMockUsage(0, 0))),
			createMessageEntry(createUserMessage("Read the fixtures")),
		];
		for (const group of ["older", "latest"]) {
			entries.push(
				createMessageEntry({
					...createAssistantMessage("", createMockUsage(0, 0)),
					content: ["a", "b"].map((part) => ({
						type: "toolCall" as const,
						id: `${group}_${part}`,
						name: "read",
						arguments: { path: `${group}_${part}.txt` },
					})),
					stopReason: "toolUse",
				}),
			);
			for (const part of ["a", "b"]) {
				entries.push(
					createMessageEntry({
						role: "toolResult",
						toolCallId: `${group}_${part}`,
						toolName: "read",
						content: [{ type: "text", text: group === "older" ? "r".repeat(40_000) : `${group}_${part}` }],
						isError: false,
						timestamp: Date.now(),
					}),
				);
			}
		}
		entries.push(
			createMessageEntry(createAssistantMessage("Read complete", createMockUsage(0, 0))),
			createMessageEntry(createUserMessage("Continue")),
		);
		const original = structuredClone(entries);
		const messages = entries.map((entry) => entry.message);
		const ids = entries.map((entry) => entry.id);
		const ordinary = prepareViewCompaction(messages, ids, entries, DEFAULT_COMPACTION_SETTINGS);
		const pressure = prepareViewCompaction(
			messages,
			ids,
			entries,
			DEFAULT_COMPACTION_SETTINGS,
			undefined,
			false,
			true,
		);

		expect(ordinary?.firstKeptEntryId).toBe(entries[3].id);
		expect(pressure?.firstKeptEntryId).toBe(entries[6].id);
		expect(pressure?.messagesToSummarize).toEqual(messages.slice(0, 2));
		expect(pressure?.turnPrefixMessages).toEqual(messages.slice(2, 6));
		expect(pressure?.settings.keepRecentTokens).toBe(20_000);
		expect(entries).toEqual(original);
	});

	it("keeps a lone current instruction and its first complete exchange under pressure", () => {
		const entries = [
			createMessageEntry(createUserMessage("u".repeat(90_000))),
			createMessageEntry({
				...createAssistantMessage("", createMockUsage(0, 0)),
				content: [{ type: "toolCall", id: "large_read", name: "read", arguments: { path: "large.txt" } }],
				stopReason: "toolUse",
			}),
			createMessageEntry({
				role: "toolResult",
				toolCallId: "large_read",
				toolName: "read",
				content: [{ type: "text", text: "r".repeat(70_000) }],
				isError: false,
				timestamp: Date.now(),
			}),
			createMessageEntry(createUserMessage("Continue")),
		];
		const original = structuredClone(entries);
		const preparation = prepareViewCompaction(
			entries.map((entry) => entry.message),
			entries.map((entry) => entry.id),
			entries,
			DEFAULT_COMPACTION_SETTINGS,
			undefined,
			false,
			true,
		);

		expect(preparation).toBeUndefined();
		expect(entries).toEqual(original);
	});
});

describe("prepareCompaction with small sessions", () => {
	it("returns undefined when everything fits in the keep-recent window", () => {
		// Session well under keepRecentTokens (20k default): nothing to summarize,
		// so compaction should be skipped instead of summarizing an empty conversation
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("hello")),
			createMessageEntry(createAssistantMessage("hi there", createMockUsage(5000, 1000))),
			createMessageEntry(createUserMessage("how are you")),
			createMessageEntry(createAssistantMessage("great", createMockUsage(8000, 2000))),
		];

		const preparation = prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS);
		expect(preparation).toBeUndefined();
	});
});

describe("prepareCompaction with previous compaction", () => {
	it("should preserve kept messages across repeated compactions when they still fit", () => {
		const u1 = createMessageEntry(createUserMessage("user msg 1 (summarized by compaction1)"));
		const a1 = createMessageEntry(createAssistantMessage("assistant msg 1"));
		const u2 = createMessageEntry(createUserMessage("user msg 2 - kept by compaction1"));
		const a2 = createMessageEntry(createAssistantMessage("assistant msg 2"));
		const u3 = createMessageEntry(createUserMessage("user msg 3 - kept by compaction1"));
		const a3 = createMessageEntry(createAssistantMessage("assistant msg 3", createMockUsage(5000, 1000)));
		const compaction1 = createCompactionEntry("First summary", u2.id);
		const u4 = createMessageEntry(createUserMessage("user msg 4 (new after compaction1)"));
		const a4 = createMessageEntry(createAssistantMessage("assistant msg 4", createMockUsage(8000, 2000)));

		const pathEntries = [u1, a1, u2, a2, u3, a3, compaction1, u4, a4];
		const contextBefore = buildSessionContext(pathEntries);
		const preparation = prepareCompaction(pathEntries, DEFAULT_COMPACTION_SETTINGS);

		expect(preparation).toBeDefined();
		expect(preparation!.firstKeptEntryId).toBe(u2.id);
		expect(preparation!.previousSummary).toBe("First summary");
		expect(extractText(preparation!.messagesToSummarize)).not.toContain("First summary");
		expect(preparation!.tokensBefore).toBe(estimateContextTokens(contextBefore.messages).tokens);

		const compaction2: CompactionEntry = {
			type: "compaction",
			id: "compaction2-id",
			parentId: a4.id,
			timestamp: new Date().toISOString(),
			summary: "Second summary",
			firstKeptEntryId: preparation!.firstKeptEntryId,
			tokensBefore: preparation!.tokensBefore,
		};
		const contextAfter = buildSessionContext([...pathEntries, compaction2]);
		const contextAfterText = extractText(contextAfter.messages);

		expect(contextAfterText).toContain("user msg 2 - kept by compaction1");
		expect(contextAfterText).toContain("user msg 3 - kept by compaction1");
	});

	it("should re-summarize previously kept messages when the recent window moves past them", () => {
		const u1 = createMessageEntry(createUserMessage("user msg 1 (summarized by compaction1)".repeat(4)));
		const a1 = createMessageEntry(createAssistantMessage("assistant msg 1".repeat(4)));
		const u2 = createMessageEntry(createUserMessage("user msg 2 - kept by compaction1 ".repeat(12)));
		const a2 = createMessageEntry(createAssistantMessage("assistant msg 2 ".repeat(12)));
		const u3 = createMessageEntry(createUserMessage("user msg 3 - kept by compaction1 ".repeat(12)));
		const a3 = createMessageEntry(createAssistantMessage("assistant msg 3 ".repeat(12), createMockUsage(5000, 1000)));
		const compaction1 = createCompactionEntry("First summary", u2.id);
		const u4 = createMessageEntry(createUserMessage("user msg 4 (new after compaction1) ".repeat(12)));
		const a4 = createMessageEntry(createAssistantMessage("assistant msg 4 ".repeat(12), createMockUsage(8000, 2000)));

		const settings: CompactionSettings = {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 100,
		};
		const preparation = prepareCompaction([u1, a1, u2, a2, u3, a3, compaction1, u4, a4], settings);

		expect(preparation).toBeDefined();
		const summarizedText = extractText(preparation!.messagesToSummarize);
		expect(summarizedText).toContain("user msg 2 - kept by compaction1");
		expect(summarizedText).toContain("user msg 3 - kept by compaction1");
		expect(summarizedText).not.toContain("First summary");
		expect(preparation!.previousSummary).toBe("First summary");
	});
});

// ============================================================================
// Integration tests with real session data
// ============================================================================

describe("Large session fixture", () => {
	it("should parse the large session", () => {
		const entries = loadLargeSessionEntries();
		expect(entries.length).toBeGreaterThan(100);

		const messageCount = entries.filter((e) => e.type === "message").length;
		expect(messageCount).toBeGreaterThan(100);
	});

	it("should find cut point in large session", () => {
		const entries = loadLargeSessionEntries();
		const result = findCutPoint(entries, 0, entries.length, DEFAULT_COMPACTION_SETTINGS.keepRecentTokens);

		// Cut point should be at a message entry (user or assistant)
		expect(entries[result.firstKeptEntryIndex].type).toBe("message");
		const role = (entries[result.firstKeptEntryIndex] as SessionMessageEntry).message.role;
		expect(role === "user" || role === "assistant").toBe(true);
	});

	it("should load session correctly", () => {
		const entries = loadLargeSessionEntries();
		const loaded = buildSessionContext(entries);

		expect(loaded.messages.length).toBeGreaterThan(100);
		expect(loaded.model).not.toBeNull();
	});
});

// ============================================================================
// LLM integration tests (skipped without API key)
// ============================================================================

describe.skipIf(!process.env.ANTHROPIC_OAUTH_TOKEN)("LLM summarization", () => {
	it("should generate a compaction result for the large session", async () => {
		const entries = loadLargeSessionEntries();
		const model = getModel("anthropic", "claude-sonnet-4-5")!;

		const preparation = prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS);
		expect(preparation).toBeDefined();

		const compactionResult = await compact(preparation!, model, process.env.ANTHROPIC_OAUTH_TOKEN!);

		expect(compactionResult.summary.length).toBeGreaterThan(100);
		expect(compactionResult.firstKeptEntryId).toBeTruthy();
		expect(compactionResult.tokensBefore).toBeGreaterThan(0);

		console.log("Summary length:", compactionResult.summary.length);
		console.log("First kept entry ID:", compactionResult.firstKeptEntryId);
		console.log("Tokens before:", compactionResult.tokensBefore);
		console.log("\n--- SUMMARY ---\n");
		console.log(compactionResult.summary);
	}, 60000);

	it("should produce valid session after compaction", async () => {
		const entries = loadLargeSessionEntries();
		const loaded = buildSessionContext(entries);
		const model = getModel("anthropic", "claude-sonnet-4-5")!;

		const preparation = prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS);
		expect(preparation).toBeDefined();

		const compactionResult = await compact(preparation!, model, process.env.ANTHROPIC_OAUTH_TOKEN!);

		// Simulate appending compaction to entries by creating a proper entry
		const lastEntry = entries[entries.length - 1];
		const parentId = lastEntry.id;
		const compactionEntry: CompactionEntry = {
			type: "compaction",
			id: "compaction-test-id",
			parentId,
			timestamp: new Date().toISOString(),
			...compactionResult,
		};
		const newEntries = [...entries, compactionEntry];
		const reloaded = buildSessionContext(newEntries);

		// Should have summary + kept messages
		expect(reloaded.messages.length).toBeLessThan(loaded.messages.length);
		expect(reloaded.messages[0].role).toBe("compactionSummary");
		expect((reloaded.messages[0] as any).summary).toContain(compactionResult.summary);

		console.log("Original messages:", loaded.messages.length);
		console.log("After compaction:", reloaded.messages.length);
	}, 60000);
});
