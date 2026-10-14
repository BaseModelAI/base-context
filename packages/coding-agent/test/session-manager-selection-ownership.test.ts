import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HistoryIndex } from "../src/core/history-index.js";
import { SessionManager } from "../src/core/session-manager.js";
import * as gitContext from "../src/utils/git.js";

describe("SessionManager selected-state publication", () => {
	let directory: string;
	let managers: SessionManager[];

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "session-selection-ownership-"));
		managers = [];
		vi.spyOn(gitContext, "captureGitContext").mockResolvedValue(null);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.all(managers.map((manager) => manager.close()));
		rmSync(directory, { recursive: true, force: true });
	});

	it.each(["cancel", "read failure"] as const)(
		"preserves the selected state after a late metadata %s",
		async (failure) => {
			const manager = await SessionManager.create(directory, directory);
			managers.push(manager);
			await manager.appendGitState({ commit: "earlier" });
			const earlierStatus = { summary: "earlier", basedOnMessageCount: 0 };
			const earlier = await manager.appendAgentStatus(earlierStatus);
			await manager.appendGitState({ commit: "current" });
			const currentStatus = { summary: "current", basedOnMessageCount: 0 };
			const current = await manager.appendAgentStatus(currentStatus);
			await manager.flushNow();
			const originalBytes = readFileSync(manager.getSessionFile()!);
			const ownsSource = manager.captureCompactionSourceOwner();
			let reached!: () => void;
			const reading = new Promise<void>((resolve) => {
				reached = resolve;
			});
			let release!: () => void;
			const blocked = new Promise<void>((resolve) => {
				release = resolve;
			});
			const aborted = new AbortController();
			const expected = new Error(failure);
			const originalRead = HistoryIndex.prototype.readSourcePayload;
			const read = vi.spyOn(HistoryIndex.prototype, "readSourcePayload").mockImplementation(async function (
				this: HistoryIndex,
				...args
			) {
				if (args[1] === earlier) {
					reached();
					await blocked;
					if (failure === "read failure") throw expected;
				}
				return originalRead.apply(this, args);
			});
			const selecting = manager.branchTo(earlier, () => {
				if (aborted.signal.aborted) throw expected;
			});
			const outcome = selecting.then(
				() => undefined,
				(error: unknown) => error,
			);
			try {
				await reading;
				aborted.abort();
			} finally {
				release();
			}
			expect(await outcome).toBe(expected);
			read.mockRestore();
			expect(manager.getLeafId()).toBe(current);
			expect(manager.getLatestAgentStatus()).toEqual(currentStatus);
			expect(ownsSource()).toBe(true);
			vi.mocked(gitContext.captureGitContext).mockResolvedValue({ commit: "current" });
			expect(await manager.recordGitStateIfChanged()).toBeUndefined();
			expect(readFileSync(manager.getSessionFile()!)).toEqual(originalBytes);

			await manager.branchTo(earlier);
			expect(manager.getLeafId()).toBe(earlier);
			expect(manager.getLatestAgentStatus()).toEqual(earlierStatus);
			expect(ownsSource()).toBe(false);
			expect(readFileSync(manager.getSessionFile()!)).toEqual(originalBytes);
		},
	);

	it.each(["earlier", "root"] as const)(
		"keeps the %s selection when materializing a memory session",
		async (selection) => {
			const manager = SessionManager.inMemory(directory, directory);
			managers.push(manager);
			const earlier = await manager.appendMessage({ role: "user", content: "earlier", timestamp: 1 });
			await manager.appendMessage({ role: "user", content: "later", timestamp: 2 });
			await manager.flushNow();
			const selected = selection === "earlier" ? earlier : null;
			await manager.branchTo(selected);
			await manager.materializeSessionFile();
			expect(manager.getLeafId()).toBe(selected);
			const appended = await manager.appendCustomMessageEntry("restart", "continue selected branch", false);
			expect((await manager.readEntry(appended))?.parentId).toBe(selected);
			expect(await manager.readEntries()).toHaveLength(3);
		},
	);
});
