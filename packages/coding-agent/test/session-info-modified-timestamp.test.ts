import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
		await mgr.appendMessage({
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

		const sessions = await SessionManager.list("/tmp", dirname(filePath));
		const s = sessions.find((x) => x.path === filePath);
		expect(s).toBeDefined();
		expect(s!.modified.getTime()).toBe(msgTime);
		expect(s!.modified.getTime()).not.toBe(before.mtime.getTime());

		const expected = structuredClone(s!);
		const scans = vi.spyOn(sessionJournalReader, "readSessionJournal");
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
		const beforeSessionRescan = scans.mock.calls.filter(([path]) => path === filePath).length;
		expect((await SessionManager.list("/tmp", dirname(filePath))).find((item) => item.path === filePath)).toEqual(
			expected,
		);
		expect(scans.mock.calls.filter(([path]) => path === filePath)).toHaveLength(beforeSessionRescan + 1);
	});
});
