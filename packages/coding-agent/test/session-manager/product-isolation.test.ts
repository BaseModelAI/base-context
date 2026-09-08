import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@ponythewhite/base-context-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSessionJournal } from "../../src/core/session-journal-reader.js";
import { loadEntriesFromFile, SessionManager } from "../../src/core/session-manager.js";

describe("session write isolation", () => {
	let dir: string;
	let legacyFile: string;
	let original: string;
	const managers: SessionManager[] = [];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "base-context-session-isolation-"));
		legacyFile = join(dir, ".prime", "agent", "sessions", "legacy.jsonl");
		mkdirSync(join(dir, ".prime", "agent", "sessions"), { recursive: true });
		original = `${JSON.stringify({ type: "session", version: 2, id: "legacy", timestamp: new Date().toISOString(), cwd: dir })}\n`;
		writeFileSync(legacyFile, original);
	});

	afterEach(async () => {
		await Promise.all(managers.splice(0).map((manager) => manager.close()));
		rmSync(dir, { recursive: true, force: true });
	});

	it("persists owned sessions and permits explicit read/copy from a legacy input", async () => {
		const ownedDir = join(dir, "owned");
		const session = await SessionManager.create(dir, ownedDir);
		managers.push(session);
		expect(await session.readBranchHistory((history) => history.parentPath())).toMatchObject({
			events: [],
			nextCursor: null,
			totalEntries: 0,
			source: { sessionId: session.getSessionId(), leafId: null },
		});
		expect(await session.readBranchHistory((history) => history.branchBootstrap())).toMatchObject({
			model: null,
			thinkingLevel: null,
			serviceTier: null,
			goalState: null,
			rlmMaxDepth: null,
			latestCompaction: null,
			contextUsageAssistant: null,
			hasBranchMessage: false,
			hasContextMessages: false,
			goalSeedable: true,
			source: { sessionId: session.getSessionId(), leafId: null },
		});
		const ownedInfoId = await session.appendSessionInfo("owned");
		expect(readFileSync(session.getSessionFile()!, "utf8")).toContain("owned");
		expect(loadEntriesFromFile(legacyFile)[0]).toMatchObject({ id: "legacy", version: 2 });
		const fork = await SessionManager.forkFrom(legacyFile, dir, ownedDir);
		managers.push(fork);
		await fork.appendSessionInfo("copied");
		expect(fork.getSessionFile()).not.toBe(legacyFile);
		expect(readFileSync(legacyFile, "utf8")).toBe(original);

		const nativeFork = await session.forkBranch(ownedInfoId, { persist: false });
		managers.push(nativeFork);
		expect(nativeFork.getEntryRetention(ownedInfoId)).toBeUndefined();
		const explicitImport = await SessionManager.importRetainedFrom(session.getSessionFile()!, dir, ownedDir);
		managers.push(explicitImport);
		expect(explicitImport.getEntryRetention(ownedInfoId)).toBe("retained-import");

		const branchText = `Full inactive branch: ${"x".repeat(9000)}`;
		const branchA = await session.appendMessage({ role: "user", content: branchText, timestamp: 1 });
		session.branch(ownedInfoId);
		const branchB = await session.appendMessage({ role: "user", content: "Current branch", timestamp: 2 });
		const limits = { maxEntries: 64, maxSourceBytes: 2 * 1024 * 1024 };
		const branchHistory = await session.materializeBranchHistory(limits);
		const sourceHistory = await session.materializeSourceHistory(limits);
		const parentHistory = await session.materializeParentPathHistory(limits);
		expect(parentHistory.entries.map((item) => item.entry.id)).toEqual([ownedInfoId, branchB]);
		expect(parentHistory).not.toHaveProperty("scope");
		expect(parentHistory.source.leafId).toBe(branchB);
		expect(parentHistory.sourceBytes).toBe(
			parentHistory.entries.reduce((bytes, item) => bytes + item.source.locator.length, 0),
		);
		expect(parentHistory.entries[0].entry).not.toBe(session.getEntry(ownedInfoId));
		expect(branchHistory.scope).toBe("branch");
		expect(branchHistory.entries.map((item) => item.entry.id)).toEqual([ownedInfoId, branchB]);
		expect(sourceHistory.scope).toBe("source");
		expect(sourceHistory.entries.map((item) => item.entry.id)).toEqual([ownedInfoId, branchA, branchB]);
		await session.readSourceHistory(async (history) => {
			const first = await history.parentPath({ limit: 1 });
			expect(first.totalEntries).toBe(2);
			expect(first.events.map((entry) => entry.id)).toEqual([ownedInfoId]);
			expect(first.nextCursor).not.toBeNull();
			const second = await history.parentPath({ cursor: first.nextCursor!, limit: 1 });
			expect(second.events.map((entry) => entry.id)).toEqual([branchB]);
			expect(second.nextCursor).toBeNull();
			expect(second.source).toBe(first.source);
		});
		expect(await session.getHistoryEntry(branchA)).toBeUndefined();
		const hydrated = await session.readSourceHistory((history) => history.hydrateEntry(branchA, 64 * 1024));
		expect(hydrated?.entry).toMatchObject({ id: branchA, message: { role: "user", content: branchText } });
		expect(hydrated?.entry).not.toBe(session.getEntry(branchA));
		expect(hydrated?.source.retention).toBeUndefined();
		const iterated = await session.readSourceHistory(async (history) => {
			const ids: string[] = [];
			for await (const item of history.iterateEntries(limits)) ids.push(item.entry.id);
			return ids;
		});
		expect(iterated).toEqual([ownedInfoId, branchA, branchB]);
		await session.readSourceHistory(async (history) => {
			const maxSourceBytes = Math.max(...sourceHistory.entries.map((item) => item.source.locator.length));
			const iterator = history.iterateEntries({ ...limits, maxSourceBytes });
			const first = await iterator.next();
			if (first.done) throw new Error("Expected the first history entry");
			first.value.source.locator.length = 0;
			await expect(iterator.next()).rejects.toThrow("source byte budget exceeded");
		});
		await expect(session.materializeParentPathHistory({ ...limits, maxEntries: 1 })).rejects.toThrow(
			"entry budget exceeded",
		);
		await expect(session.materializeParentPathHistory({ ...limits, maxSourceBytes: 1 })).rejects.toThrow(
			"source byte budget exceeded",
		);
		await expect(session.materializeSourceHistory({ ...limits, maxEntries: 1 })).rejects.toThrow(
			"entry budget exceeded",
		);
		await expect(session.materializeSourceHistory({ ...limits, maxSourceBytes: 1 })).rejects.toThrow(
			"source byte budget exceeded",
		);
		await expect(session.readSourceHistory((history) => history.hydrateEntry(branchA, 1))).rejects.toThrow(
			"entry source byte budget exceeded",
		);

		session.resetLeaf();
		const modelId = await session.appendModelChange("openai", "gpt-4.1");
		const thinkingId = await session.appendThinkingLevelChange("high");
		const tierId = await session.appendServiceTierChange("priority");
		const capturedBootstrap = await session.readBranchHistory(async (history) => {
			const firstPath = await history.parentPath({ limit: 1 });
			expect(firstPath.events.map((entry) => entry.id)).toEqual([modelId]);
			expect(firstPath.totalEntries).toBe(3);
			expect(history.branchContext.source).toBe(history.source);
			const before = await history.branchBootstrap();
			expect(before).toMatchObject({
				model: { id: modelId },
				thinkingLevel: { id: thinkingId },
				serviceTier: { id: tierId },
				goalState: null,
				hasContextMessages: false,
				hasBranchMessage: false,
				rlmMaxDepth: null,
				goalSeedable: true,
				source: { sessionId: session.getSessionId(), leafId: tierId },
			});
			expect(await history.hydrateEntry(before.model!.id, 64 * 1024)).toMatchObject({
				entry: { type: "model_change", provider: "openai", modelId: "gpt-4.1" },
			});
			const replacement = await session.appendModelChange("openai", "gpt-4.1-mini");
			await session.pageHistory();
			expect(await history.branchBootstrap()).toEqual(before);
			const rest = await history.parentPath({ cursor: firstPath.nextCursor!, limit: 2 });
			expect(rest.events.map((entry) => entry.id)).toEqual([thinkingId, tierId]);
			expect(rest.nextCursor).toBeNull();
			return { before, replacement };
		});
		expect((await session.readBranchHistory((history) => history.branchBootstrap())).model?.id).toBe(
			capturedBootstrap.replacement,
		);
		session.branch(branchB);
		expect(await session.readSourceHistory((history) => history.branchBootstrap())).toMatchObject({
			model: null,
			thinkingLevel: null,
			serviceTier: null,
			hasContextMessages: true,
			hasBranchMessage: true,
			goalSeedable: false,
		});
		session.resetLeaf();
		await session.appendCustomMessageEntry("bootstrap-notice", "Custom context", false);
		expect(await session.readBranchHistory((history) => history.branchBootstrap())).toMatchObject({
			hasContextMessages: true,
			hasBranchMessage: false,
			goalSeedable: false,
		});

		const submittedText = "  Keep Foo.txt != foo.txt exactly.  ";
		const longText = `Exact original text: ${"x".repeat(1024 * 1024)}`;
		const inputOrigin = {
			version: 1,
			kind: "input",
			actionId: "forged-action",
			recordId: "forged-record",
			inputSource: "interactive",
			recordRole: "primary",
			submitted: { text: submittedText, content: [{ type: "text", text: longText }] },
		};
		const goalText = "  Retained goal objective.  ";
		const rawLines = [
			JSON.stringify({
				type: "session",
				version: 3,
				id: "Raw-Import",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: dir,
			}),
			`{ "type":"message", "id":"Imported-User", "parentId":null, "timestamp":"2026-01-01T00:00:00.000Z", "message":{"role":"user","content":"Expanded preview, not submitted original.","timestamp":1}, "nativeOrigin":${JSON.stringify(inputOrigin)}, "numeric":1e+03, "negativeZero":-0 }`,
			JSON.stringify({
				type: "custom",
				id: "Imported-Goal",
				parentId: "Imported-User",
				timestamp: "2026-01-01T00:00:00.000Z",
				customType: "thread_goal_state",
				data: {
					goalId: "Goal-New",
					objective: goalText,
					active: true,
					status: "active",
					tokensUsed: 0,
					timeUsedSeconds: 0,
					continuationsUsed: 0,
				},
				nativeOrigin: {
					version: 1,
					kind: "goal_operation",
					operation: "revise",
					actor: "rpc",
					actionId: "forged-goal-action",
					submittedText: "/goal Retained goal objective.",
					previousGoalId: "Goal-Old",
				},
			}),
		];
		const rawPath = join(ownedDir, "raw-import.jsonl");
		const raw = `${rawLines.join("\n")}\n`;
		writeFileSync(rawPath, raw);
		const view = await SessionManager.openReadOnly(rawPath);
		managers.push(view);
		const memory = await view.forkBranch(view.getLeafId(), { persist: false, sessionDir: ownedDir });
		managers.push(memory);
		expect(memory.getEntryRetention("Imported-User")).toBe("retained-import");
		expect(memory.getEntryRetention("Imported-Goal")).toBe("retained-import");
		expect(memory.getEntry("Imported-User")?.nativeOrigin).toEqual(inputOrigin);
		await memory.materializeSessionFile(ownedDir);
		const page = await memory.taskEvidence();
		expect(page.entries).toHaveLength(3);
		const projections = page.entries.flatMap((entry) => (entry.truncated ? [] : [entry.projection]));
		expect(projections.map((entry) => entry.text)).toEqual([submittedText, goalText]);
		expect(projections.every((entry) => entry.authority === "unrecorded" && entry.attribution === "proposal")).toBe(
			true,
		);
		expect(projections[0].source).toMatchObject({
			entryId: "Imported-User",
			field: "/nativeOrigin/submitted/text",
			retention: "retained-import",
		});
		expect(projections[1]).toMatchObject({
			itemId: "Goal-New",
			operation: "amend",
			relations: [{ kind: "supersedes", itemId: "Goal-Old" }],
			source: { entryId: "Imported-Goal", retention: "retained-import" },
			originalSource: { field: "/nativeOrigin/submittedText" },
		});
		expect(page.entries.find((entry) => entry.truncated)).toMatchObject({
			truncated: true,
			source: {
				entryId: "Imported-User",
				field: "/nativeOrigin/submitted/content/0/text",
				retention: "retained-import",
			},
		});
		const newNativeId = await memory.appendSessionInfo("new native entry");
		expect(memory.getEntryRetention(newNativeId)).toBeUndefined();
		const copied = await SessionManager.forkFrom(memory.getSessionFile()!, dir, ownedDir);
		managers.push(copied);
		expect(copied.getEntryRetention("Imported-User")).toBe("retained-import");
		expect(copied.getEntryRetention("Imported-Goal")).toBe("retained-import");
		expect(copied.getEntryRetention(newNativeId)).toBeUndefined();
		expect(copied.getEntry("Imported-User")?.nativeOrigin).toEqual(inputOrigin);
		const cold = await copied.readSourceHistory((history) =>
			history.hydrateEntry("Imported-User", limits.maxSourceBytes),
		);
		expect(cold?.entry.nativeOrigin).toEqual(inputOrigin);
		expect(cold?.entry).not.toBe(copied.getEntry("Imported-User"));
		expect(cold?.source).toMatchObject({ id: "Imported-User", retention: "retained-import" });
		await copied.readBranchHistory(async (history) => {
			const path = await history.parentPath();
			expect(path.events.map((entry) => entry.id)).toEqual(["Imported-User", "Imported-Goal", newNativeId]);
			expect(path.events.map((entry) => entry.retention)).toEqual(["retained-import", "retained-import", undefined]);
			expect(path.nextCursor).toBeNull();
		});
		const retainedParentHistory = await copied.materializeParentPathHistory(limits);
		expect(retainedParentHistory.entries.map((item) => item.source.retention)).toEqual([
			"retained-import",
			"retained-import",
			undefined,
		]);
		const retainedHistory = await copied.materializeSourceHistory(limits);
		expect(retainedHistory.entries.map((item) => item.source.retention)).toEqual([
			"retained-import",
			"retained-import",
			undefined,
		]);

		expect(await copied.readBranchHistory((history) => history.branchBootstrap())).toMatchObject({
			goalState: null,
			hasContextMessages: true,
			goalSeedable: false,
		});
		const nativeGoal = {
			active: true,
			status: "active",
			goalId: "Native-Goal",
			tokensUsed: 0,
			timeUsedSeconds: 0,
			continuationsUsed: 0,
		};
		const nativeGoalId = await copied.appendCustomEntry("thread_goal_state", nativeGoal);
		await copied.appendCustomEntry("thread_goal_state", { active: false });
		await copied.readBranchHistory(async (history) => {
			const bootstrap = await history.branchBootstrap();
			expect(bootstrap.goalState?.id).toBe(nativeGoalId);
			expect(bootstrap.goalState?.retention).toBeUndefined();
			expect(await history.hydrateEntry(bootstrap.goalState!.id, 64 * 1024)).toMatchObject({
				entry: { data: nativeGoal },
			});
		});
		const depthId = await copied.appendCustomEntry("rlm_max_depth_state", { maxDepth: 0 });
		await copied.appendCustomEntry("rlm_max_depth_state", { maxDepth: -1 });
		await copied.readBranchHistory(async (history) => {
			const bootstrap = await history.branchBootstrap();
			expect(bootstrap.rlmMaxDepth?.id).toBe(depthId);
			expect(bootstrap.hasBranchMessage).toBe(true);
			expect(await history.hydrateEntry(bootstrap.rlmMaxDepth!.id, 64 * 1024)).toMatchObject({
				entry: { data: { maxDepth: 0 } },
			});
		});
		const usageAssistant = {
			role: "assistant",
			content: [],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-4.1",
			usage: {
				input: 1000,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		} satisfies AssistantMessage;
		const preCompactionAssistantId = await copied.appendMessage(usageAssistant);
		expect(await copied.readBranchHistory((history) => history.branchBootstrap())).toMatchObject({
			contextUsageAssistant: { id: preCompactionAssistantId },
		});
		const compactionId = await copied.appendCompaction("Exact compacted context", "Imported-User", 1200);
		const compactionTimestamp = copied.getEntry(compactionId)!.timestamp;
		await copied.readBranchHistory(async (history) => {
			const bootstrap = await history.branchBootstrap();
			expect(bootstrap.latestCompaction?.id).toBe(compactionId);
			expect(bootstrap.contextUsageAssistant).toBeNull();
			expect(await history.hydrateEntry(bootstrap.latestCompaction!.id, 64 * 1024)).toMatchObject({
				entry: {
					type: "compaction",
					summary: "Exact compacted context",
					tokensBefore: 1200,
					timestamp: compactionTimestamp,
				},
			});
		});
		// Path position, not the assistant timestamp, defines the compaction boundary.
		await copied.appendMessage(usageAssistant);
		const zeroUsageId = await copied.appendMessage({
			...usageAssistant,
			usage: { ...usageAssistant.usage, input: 0, totalTokens: 0 },
		});
		await copied.appendMessage({ ...usageAssistant, stopReason: "error" });
		const abortedUsageId = await copied.appendMessage({ ...usageAssistant, stopReason: "aborted" });
		await copied.readBranchHistory(async (history) => {
			const bootstrap = await history.branchBootstrap();
			expect(bootstrap.contextUsageAssistant?.id).toBe(zeroUsageId);
			expect(await history.hydrateEntry(bootstrap.contextUsageAssistant!.id, 64 * 1024)).toMatchObject({
				entry: { message: { usage: { input: 0, totalTokens: 0 } } },
			});
		});
		copied.branch(depthId);
		expect(await copied.readBranchHistory((history) => history.branchBootstrap())).toMatchObject({
			latestCompaction: null,
			contextUsageAssistant: null,
		});
		copied.branch(abortedUsageId);
		const retainedDepth = await SessionManager.importRetainedFrom(copied.getSessionFile()!, dir, ownedDir);
		managers.push(retainedDepth);
		expect(await retainedDepth.readBranchHistory((history) => history.branchBootstrap())).toMatchObject({
			rlmMaxDepth: { id: depthId, retention: "retained-import" },
			latestCompaction: { id: compactionId, retention: "retained-import" },
			contextUsageAssistant: { id: zeroUsageId, retention: "retained-import" },
			goalState: null,
			hasBranchMessage: true,
		});
		expect(readFileSync(rawPath, "utf8")).toBe(raw);

		const migrated = await SessionManager.open(rawPath, ownedDir);
		managers.push(migrated);
		await migrated.migrateLegacy();
		const payloads: string[] = [];
		for await (const record of readSessionJournal(rawPath)) {
			payloads.push(record.json);
			expect(record.retention).toBe("retained-import");
		}
		expect(payloads).toEqual(rawLines);
		expect(readFileSync(`${rawPath}.legacy-v3`, "utf8")).toBe(raw);
	});

	it("rejects legacy writable targets, including a symlink changed after opening", async () => {
		await expect(SessionManager.open(legacyFile)).rejects.toThrow("cannot write legacy state");
		await expect(SessionManager.create(dir, join(dir, ".prime", "new"))).rejects.toThrow("cannot write legacy state");
		const session = await SessionManager.create(dir, join(dir, "owned"));
		managers.push(session);
		const rootModelId = await session.appendModelChange("openai", "gpt-4.1");
		const ownedId = await session.appendSessionInfo("owned");
		const originalSource = session.getSessionId();
		const escaped = await session.readSourceHistory(async (history) => {
			const firstPath = await history.parentPath({ limit: 1 });
			expect(firstPath.events.map((entry) => entry.id)).toEqual([rootModelId]);
			const bootstrap = await history.branchBootstrap();
			expect(bootstrap).toMatchObject({
				hasContextMessages: false,
				hasBranchMessage: false,
				rlmMaxDepth: null,
				latestCompaction: null,
				contextUsageAssistant: null,
				goalSeedable: false,
				model: { id: rootModelId },
			});
			const lateId = await session.appendSessionInfo("outside captured prefix");
			await session.pageHistory();
			expect(await history.get(lateId)).toBeUndefined();
			await session.newSession();
			const replacementId = await session.appendSessionInfo("owned replacement");
			await session.appendModelChange("openai", "gpt-4.1");
			expect(await history.branchBootstrap()).toEqual(bootstrap);
			expect(history.source.sessionId).toBe(originalSource);
			expect(await history.hydrateEntry(ownedId, 64 * 1024)).toMatchObject({
				entry: { id: ownedId, name: "owned" },
			});
			expect(await history.get(replacementId)).toBeUndefined();
			const lastPath = await history.parentPath({ cursor: firstPath.nextCursor!, limit: 1 });
			expect(lastPath.events.map((entry) => entry.id)).toEqual([ownedId]);
			expect(lastPath.nextCursor).toBeNull();
			await expect(
				session.readBranchHistory((current) => current.parentPath({ cursor: firstPath.nextCursor! })),
			).rejects.toThrow("cursor");
			return history;
		});
		await expect(escaped.get(ownedId)).rejects.toThrow("Captured history read has ended");
		await expect(escaped.branchBootstrap()).rejects.toThrow("Captured history read has ended");
		await expect(escaped.parentPath()).rejects.toThrow("Captured history read has ended");
		const path = session.getSessionFile()!;
		rmSync(path);
		symlinkSync(legacyFile, path);
		await expect(session.appendSessionInfo("must not append")).rejects.toThrow("cannot write legacy state");
		await expect(session.setSessionFile(legacyFile)).rejects.toThrow("cannot write legacy state");
		await expect(session.close()).rejects.toThrow("canonical path changed");
		managers.splice(managers.indexOf(session), 1); // The failed close already waited for actor exit.
		expect(readFileSync(legacyFile, "utf8")).toBe(original);
	});
});
