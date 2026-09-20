import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { HistoryIndex } from "../src/core/history-index.js";
import * as sessionJournalReader from "../src/core/session-journal-reader.js";
import type { SessionHeader } from "../src/core/session-manager.js";
import { readSessionInfo, SessionManager } from "../src/core/session-manager.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const managers: SessionManager[] = [];
const tempDirs: string[] = [];

async function createSessionFile(path: string): Promise<void> {
	const header: SessionHeader = {
		type: "session",
		id: "test-session",
		version: 3,
		timestamp: new Date(0).toISOString(),
		cwd: "/tmp",
	};
	writeFileSync(path, `${JSON.stringify(header)}\n`, "utf8");

	const mgr = await SessionManager.open(path);
	managers.push(mgr);
	await mgr.migrateLegacy();
	await mgr.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "hi" }],
		api: "openai-completions",
		provider: "openai",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
	await mgr.close();
}

describe("SessionInfo.modified", () => {
	beforeAll(() => initTheme("dark"));

	afterEach(async () => {
		await Promise.all(managers.splice(0).map((manager) => manager.close()));
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("uses last user/assistant message timestamp instead of file mtime", async () => {
		const dir = mkdtempSync(join(tmpdir(), "base-context-modified-"));
		tempDirs.push(dir);
		const filePath = join(dir, "session.jsonl");
		await createSessionFile(filePath);

		const before = await stat(filePath);
		await new Promise((r) => setTimeout(r, 10));

		const mgr = await SessionManager.open(filePath);
		managers.push(mgr);
		const msgTime = Date.now();
		const assistantId = await mgr.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "later" }],
			api: "openai-completions",
			provider: "openai",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: msgTime,
		});

		await mgr.appendSessionInfo("indexed catalog fixture");
		await mgr.readSourceHistory(async () => undefined); // Original owner publishes the covered projection.
		const scans = vi.spyOn(sessionJournalReader, "readSessionJournal");
		const payloads = vi.spyOn(HistoryIndex.prototype, "readSourcePayload");
		const payloadsForSession = () => payloads.mock.calls.filter(([id]) => id === mgr.getSessionId()).length;
		const sessions = await SessionManager.list("/tmp", dirname(filePath));
		const s = sessions.find((x) => x.path === filePath);
		expect(s).toBeDefined();
		expect(s!.modified.getTime()).toBe(msgTime);
		expect(s!.modified.getTime()).not.toBe(before.mtime.getTime());

		const expected = structuredClone(s!);
		const cachedPayloadReads = payloadsForSession();
		s!.name = "caller-only name";
		s!.created.setTime(42);
		s!.modified.setTime(0);
		const cached = await readSessionInfo(filePath);
		expect(cached).toEqual(expected);
		expect(cached!.created).toBeInstanceOf(Date);
		expect(cached!.modified).toBeInstanceOf(Date);
		cached!.modified.setTime(1);
		expect((await SessionManager.list("/tmp", dirname(filePath))).find((item) => item.path === filePath)).toEqual(
			expected,
		);
		expect(scans).not.toHaveBeenCalled();
		expect(payloadsForSession()).toBe(cachedPayloadReads);

		// Empty readable files retain null metadata too. Fill the real item bound,
		// without inserting cache records or changing/resetting its limits.
		let lastEmpty = "";
		for (let index = 0; index < 256; index++) {
			lastEmpty = join(dir, `cache-empty-${index}.jsonl`);
			writeFileSync(lastEmpty, "");
			expect(await readSessionInfo(lastEmpty)).toBeNull();
		}
		const beforeNullHit = scans.mock.calls.length;
		expect(await readSessionInfo(lastEmpty)).toBeNull();
		expect(scans).toHaveBeenCalledTimes(beforeNullHit);
		const beforeSessionRead = payloadsForSession();
		expect((await SessionManager.list("/tmp", dirname(filePath))).find((item) => item.path === filePath)).toEqual(
			expected,
		);
		expect(payloadsForSession()).toBeGreaterThan(beforeSessionRead);
		expect(scans.mock.calls.filter(([path]) => path === filePath)).toHaveLength(0);

		const usage = (input: number, output: number, cost: number) => ({
			input,
			output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: input + output,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
		});
		await mgr.appendChildUsageAttribution(assistantId, usage(3, 5, 0.125));
		await mgr.appendChildUsageAttribution(assistantId, usage(2, 4, 0.25));
		await mgr.branchTo(null);
		await mgr.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "another source branch" }],
			api: "openai-completions",
			provider: "openai",
			model: "test",
			stopReason: "stop",
			timestamp: msgTime + 1,
			usage: usage(4, 6, 0.375),
		});
		await mgr.readSourceHistory(async () => undefined);
		const wholeSource = (await SessionManager.list("/tmp", dirname(filePath))).find(
			(item) => item.path === filePath,
		)!;
		expect(wholeSource.messageCount).toBe(3);
		expect(wholeSource.usage).toEqual({ inputTokens: 6, outputTokens: 8, cost: 0.375 });
		expect(wholeSource.modified.getTime()).toBe(msgTime + 1);
		expect(scans.mock.calls.filter(([path]) => path === filePath)).toHaveLength(0);

		const ownUsageBeforeAppend = mgr.readOwnUsageSummary();
		const compaction = mgr.appendCompaction(
			"summary",
			mgr.getLeafId()!,
			100,
			undefined,
			false,
			undefined,
			usage(2, 3, 0.125),
		);
		expect(await ownUsageBeforeAppend).toEqual(wholeSource.usage);
		await compaction;
		await mgr.branchWithSummary(null, "branch summary", undefined, false, usage(3, 4, 0.25));
		await mgr.appendCustomEntry("usage-shaped-control", { usage: usage(100, 100, 100) });
		const sink = mgr.bindRequestSink();
		try {
			await sink.persist({
				type: "attempt_settled",
				operationId: "catalog-duplicate-receipt",
				attemptId: "catalog-attempt",
				timestamp: msgTime,
				source: await sink.source,
				owner: { sessionId: mgr.getSessionId() },
				purpose: "main",
				modelContract: {
					api: "openai-completions",
					provider: "openai",
					model: "test",
					profile: { id: "test", status: "unvalidated" },
					pricing: { status: "unavailable" },
				},
				receipt: {
					api: "openai-completions",
					provider: "openai",
					model: "test",
					transport: "http",
					ordinal: 1,
					kind: "initial",
					attemptId: "catalog-attempt",
					outcome: "completed",
					rawUsage: [],
					usage: { input: 1, output: 1, totalTokens: 2 },
					usageCompleteness: "complete",
					timing: { queuedAt: msgTime, admittedAt: msgTime, settledAt: msgTime },
				},
			});
		} finally {
			await sink.release();
		}
		const beforeOwnPayloads = payloadsForSession();
		const ownUsage = await mgr.readOwnUsageSummary();
		expect(ownUsage).toEqual({ inputTokens: 11, outputTokens: 15, cost: 0.75 });
		ownUsage!.cost = -1;
		expect(await mgr.readOwnUsageSummary()).toEqual({ inputTokens: 11, outputTokens: 15, cost: 0.75 });
		expect(payloadsForSession()).toBe(beforeOwnPayloads);
	});

	it("reads own usage above the source byte limit without hydrating the archive", async () => {
		const dir = mkdtempSync(join(tmpdir(), "base-context-own-usage-"));
		tempDirs.push(dir);
		const filePath = join(dir, "session.jsonl");
		await createSessionFile(filePath);
		const mgr = await SessionManager.open(filePath);
		managers.push(mgr);
		const padding = "x".repeat(8 * 1024 * 1024);
		for (let index = 0; index < 9; index++) await mgr.appendCustomEntry("large-control", padding);
		expect((await stat(filePath)).size).toBeGreaterThan(64 * 1024 * 1024);
		const pages = vi.spyOn(HistoryIndex.prototype, "page");
		const payloads = vi.spyOn(HistoryIndex.prototype, "readSourcePayload");
		const entries = vi.spyOn(mgr, "readEntries");
		expect(await mgr.readOwnUsageSummary()).toEqual({ inputTokens: 1, outputTokens: 1, cost: 0 });
		expect(pages).not.toHaveBeenCalled();
		expect(payloads).not.toHaveBeenCalled();
		expect(entries).not.toHaveBeenCalled();
	}, 30_000);
});
