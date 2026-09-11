import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeOwnAndTotalUsage } from "../../src/core/context-tree.js";
import {
	findMostRecentSession,
	loadEntriesFromFile,
	loadEntriesFromFileAsync,
	readSessionInfo,
	resolveSessionRlmDepth,
	SessionManager,
} from "../../src/core/session-manager.js";
import { sessionUsageSummaryFrom } from "../../src/core/usage.js";

const managers = new Set<SessionManager>();
async function createSession(...args: Parameters<typeof SessionManager.create>): Promise<SessionManager> {
	const manager = await SessionManager.create(...args);
	managers.add(manager);
	return manager;
}
async function openSession(...args: Parameters<typeof SessionManager.open>): Promise<SessionManager> {
	const manager = await SessionManager.open(...args);
	managers.add(manager);
	return manager;
}
async function forkSession(...args: Parameters<typeof SessionManager.forkFrom>): Promise<SessionManager> {
	const manager = await SessionManager.forkFrom(...args);
	managers.add(manager);
	return manager;
}
async function closeManagers(): Promise<void> {
	await Promise.all([...managers].map((manager) => manager.close()));
	managers.clear();
}

describe("loadEntriesFromFile", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await closeManagers();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns empty array for non-existent file", async () => {
		const entries = loadEntriesFromFile(join(tempDir, "nonexistent.jsonl"));
		expect(entries).toEqual([]);
	});

	it("returns empty array for empty file", async () => {
		const file = join(tempDir, "empty.jsonl");
		writeFileSync(file, "");
		expect(loadEntriesFromFile(file)).toEqual([]);
	});

	it("rejects a file without a valid session header", async () => {
		const file = join(tempDir, "no-header.jsonl");
		writeFileSync(file, '{"type":"message","id":"1"}\n');
		expect(() => loadEntriesFromFile(file)).toThrow("valid header");
	});

	it("rejects malformed complete JSON", async () => {
		const file = join(tempDir, "malformed.jsonl");
		writeFileSync(file, "not json\n");
		expect(() => loadEntriesFromFile(file)).toThrow();
	});

	it("loads valid session file", async () => {
		const file = join(tempDir, "valid.jsonl");
		writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);
		const entries = loadEntriesFromFile(file);
		expect(entries).toHaveLength(2);
		expect(entries[0].type).toBe("session");
		expect(entries[1].type).toBe("message");
	});

	it("rejects corrupt interior instead of omitting source records", async () => {
		const file = join(tempDir, "mixed.jsonl");
		writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				"not valid json\n" +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);
		expect(() => loadEntriesFromFile(file)).toThrow();
	});

	it("yields while parsing a multi-megabyte session below the streaming threshold", async () => {
		const file = join(tempDir, "buffered.jsonl");
		writeFileSync(
			file,
			`${[
				'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}',
				JSON.stringify({
					type: "message",
					id: "1",
					parentId: null,
					timestamp: "2025-01-01T00:00:01Z",
					message: { role: "user", content: "x".repeat(5 * 1024 * 1024), timestamp: 1 },
				}),
			].join("\n")}\n`,
		);
		const setImmediateSpy = vi.spyOn(globalThis, "setImmediate");
		try {
			const entries = await loadEntriesFromFileAsync(file, { streamThresholdBytes: Number.MAX_SAFE_INTEGER });
			expect(entries).toHaveLength(2);
			expect(setImmediateSpy).toHaveBeenCalled();
		} finally {
			setImmediateSpy.mockRestore();
		}
	});

	it("streams large sessions with the same parsing semantics as the Buffer loader", async () => {
		const file = join(tempDir, "streamed.jsonl");
		writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\r\n' +
				"\r\n" +
				"not valid json\n" +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"héllo 世界","timestamp":1}}',
		);

		const before = readFileSync(file);
		await expect(loadEntriesFromFileAsync(file, { streamThresholdBytes: 0 })).rejects.toThrow();
		expect(() => loadEntriesFromFile(file)).toThrow();
		expect(readFileSync(file)).toEqual(before);
	});

	it("only treats LF bytes as JSONL record boundaries", async () => {
		const file = join(tempDir, "unicode-separators.jsonl");
		const content = "before\u2028middle\u2029after";
		writeFileSync(
			file,
			`${[
				'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}',
				JSON.stringify({
					type: "message",
					id: "1",
					parentId: null,
					timestamp: "2025-01-01T00:00:01Z",
					message: { role: "user", content, timestamp: 1 },
				}),
			].join("\n")}\n`,
		);

		const streamed = await loadEntriesFromFileAsync(file, { streamThresholdBytes: 0 });
		expect(streamed).toEqual(loadEntriesFromFile(file));
		expect(streamed[1]).toMatchObject({ type: "message", message: { content } });
		expect((await readSessionInfo(file))?.firstMessage).toBe(content);

		const complete = readFileSync(file);
		const incomplete = complete.subarray(0, complete.length - 1);
		writeFileSync(file, incomplete);
		const destinationDir = join(tempDir, "retained-import");
		await expect(SessionManager.importRetainedFrom(file, tempDir, destinationDir)).rejects.toThrow(
			"Captured session source has an incomplete final record",
		);
		expect(existsSync(destinationDir)).toBe(false); // Refusal precedes destination construction.
		expect(readFileSync(file)).toEqual(incomplete);
		// Ordinary --fork/captured-prefix semantics are not tightened by explicit import.
		const forked = await forkSession(file, tempDir, join(tempDir, "prefix-fork"));
		expect(await forked.readEntries()).toEqual([]);
	});

	it("streams a multi-megabyte JSONL record without losing following entries", async () => {
		const file = join(tempDir, "large-record.jsonl");
		const largeContent = "x".repeat(2 * 1024 * 1024);
		writeFileSync(
			file,
			`${[
				'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}',
				JSON.stringify({
					type: "message",
					id: "1",
					parentId: null,
					timestamp: "2025-01-01T00:00:01Z",
					message: { role: "user", content: largeContent, timestamp: 1 },
				}),
				'{"type":"message","id":"2","parentId":"1","timestamp":"2025-01-01T00:00:02Z","message":{"role":"user","content":"after","timestamp":2}}',
			].join("\n")}\n`,
		);

		const entries = await loadEntriesFromFileAsync(file, { streamThresholdBytes: 0 });
		expect(entries).toHaveLength(3);
		expect(entries[2]).toMatchObject({ type: "message", id: "2" });
	});
});

describe("session tree metadata", () => {
	it.each(["2.5", "2oops", "9007199254740993"])("rejects invalid BASE_CONTEXT_RLM_DEPTH value %s", async (value) => {
		const tempDir = join(tmpdir(), `invalid-root-depth-test-${Date.now()}-${Math.random()}`);
		mkdirSync(tempDir, { recursive: true });
		vi.stubEnv("BASE_CONTEXT_RLM_DEPTH", value);
		try {
			await expect(createSession(tempDir, tempDir)).rejects.toThrow(
				"BASE_CONTEXT_RLM_DEPTH must be a non-negative integer",
			);
		} finally {
			vi.unstubAllEnvs();
			await closeManagers();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not persist an unsafe derived depth", async () => {
		const tempDir = join(tmpdir(), `max-parent-depth-test-${Date.now()}-${Math.random()}`);
		mkdirSync(tempDir, { recursive: true });
		try {
			const parent = await createSession(tempDir, tempDir);
			await parent.newSession({ rlmDepth: Number.MAX_SAFE_INTEGER });
			await parent.flushNow();
			const parentFile = parent.getSessionFile();
			if (!parentFile) throw new Error("Missing parent session file");

			const child = await createSession(tempDir, tempDir);
			await child.newSession({ parentSession: parentFile });

			expect(child.getHeader()?.rlmDepth).toBeUndefined();
		} finally {
			await closeManagers();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("persists a derived depth and exposes parent linkage from the header", async () => {
		const tempDir = join(tmpdir(), `session-tree-test-${Date.now()}-${Math.random()}`);
		mkdirSync(tempDir, { recursive: true });
		try {
			const parent = await createSession(tempDir, tempDir);
			await parent.newSession({ rlmDepth: 2 });
			await parent.flushNow();
			const parentFile = parent.getSessionFile();
			if (!parentFile) throw new Error("Missing parent session file");

			const child = await createSession(tempDir, tempDir);
			await child.newSession({ parentSession: parentFile });
			await child.flushNow();
			const childFile = child.getSessionFile();
			if (!childFile) throw new Error("Missing child session file");

			const header = loadEntriesFromFile(childFile).find((entry) => entry.type === "session")!;
			expect(header).toMatchObject({ parentSession: parentFile, rlmDepth: 3 });
			expect(await readSessionInfo(childFile)).toMatchObject({
				parentSessionPath: parentFile,
				rlmDepth: 3,
			});
		} finally {
			await closeManagers();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it.each([0, 2])("copies source depth %i across branch and fork reference edges", async (depth) => {
		const tempDir = join(tmpdir(), `session-reference-depth-test-${depth}-${Date.now()}-${Math.random()}`);
		mkdirSync(tempDir, { recursive: true });
		try {
			const source = await createSession(tempDir, tempDir);
			await source.newSession({ rlmDepth: depth });
			const leafId = await source.appendMessage({ role: "user", content: "fork here", timestamp: 1 });
			await source.flushNow();
			const sourceFile = source.getSessionFile();
			if (!sourceFile) throw new Error("Missing source session file");

			const forked = await forkSession(sourceFile, tempDir, tempDir);
			expect(forked.getHeader()?.rlmDepth).toBe(depth);

			await source.close();
			const branched = await openSession(sourceFile, tempDir);
			await branched.createBranchedSession(leafId);
			expect(branched.getHeader()?.rlmDepth).toBe(depth);
		} finally {
			await closeManagers();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("resolves legacy root depth across branch and fork reference edges", async () => {
		const tempDir = join(tmpdir(), `legacy-session-reference-depth-test-${Date.now()}-${Math.random()}`);
		mkdirSync(tempDir, { recursive: true });
		try {
			const source = await createSession(tempDir, tempDir);
			await source.newSession({ rlmDepth: undefined });
			const leafId = await source.appendMessage({ role: "user", content: "fork here", timestamp: 1 });
			await source.flushNow();
			const sourceFile = source.getSessionFile();
			if (!sourceFile) throw new Error("Missing source session file");

			expect((await forkSession(sourceFile, tempDir, tempDir)).getHeader()?.rlmDepth).toBe(0);
			await source.close();
			const branched = await openSession(sourceFile, tempDir);
			await branched.createBranchedSession(leafId);
			expect(branched.getHeader()?.rlmDepth).toBe(0);
		} finally {
			await closeManagers();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("leaves derived child depth unknown when a legacy parent has no depth", async () => {
		const tempDir = join(tmpdir(), `legacy-parent-depth-test-${Date.now()}-${Math.random()}`);
		mkdirSync(tempDir, { recursive: true });
		try {
			const parentFile = join(tempDir, "legacy-parent.jsonl");
			writeFileSync(
				parentFile,
				`${JSON.stringify({ type: "session", id: "parent", timestamp: "2025-01-01T00:00:00Z", cwd: tempDir })}\n`,
			);
			const child = await createSession(tempDir, tempDir);
			await child.newSession({ parentSession: parentFile });
			expect(child.getHeader()).toMatchObject({ parentSession: parentFile });
			expect(child.getHeader()?.rlmDepth).toBeUndefined();
		} finally {
			await closeManagers();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("infers root depth when materializing a legacy fork", async () => {
		const tempDir = join(tmpdir(), `materialized-legacy-depth-test-${Date.now()}-${Math.random()}`);
		mkdirSync(tempDir, { recursive: true });
		try {
			const parentFile = join(tempDir, "legacy-parent.jsonl");
			const session = SessionManager.inMemory(tempDir);
			managers.add(session);
			await session.newSession({ parentSession: parentFile, rlmDepth: undefined });

			const sessionFile = await session.materializeSessionFile(tempDir);
			const header = loadEntriesFromFile(sessionFile).find((entry) => entry.type === "session")!;
			expect(header).toMatchObject({ parentSession: parentFile });
			expect(header.rlmDepth).toBe(0);
		} finally {
			await closeManagers();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("infers legacy child depth on open without changing its source", async () => {
		const tempDir = join(tmpdir(), `legacy-session-tree-test-${Date.now()}-${Math.random()}`);
		const parentFile = join(tempDir, "parent.jsonl");
		const childDir = join(tempDir, "session-artifacts", "root", "sub-1234abcd", "sub-deadbeef");
		const childFile = join(childDir, "child.jsonl");
		mkdirSync(childDir, { recursive: true });
		try {
			const header = {
				type: "session" as const,
				id: "child",
				timestamp: "2025-01-01T00:00:01Z",
				cwd: tempDir,
				parentSession: parentFile,
			};
			writeFileSync(childFile, `${JSON.stringify(header)}\n`);

			expect(resolveSessionRlmDepth(header, childFile)).toBe(2);
			expect((await readSessionInfo(childFile))?.rlmDepth).toBe(2);
			expect(loadEntriesFromFile(childFile).find((entry) => entry.type === "session")!.rlmDepth).toBeUndefined();

			expect((await openSession(childFile)).getHeader()?.rlmDepth).toBe(2);
			expect(loadEntriesFromFile(childFile).find((entry) => entry.type === "session")!.rlmDepth).toBeUndefined();
		} finally {
			await closeManagers();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("projects a readable source depth for a legacy fork without backfill", async () => {
		const tempDir = join(tmpdir(), `legacy-fork-source-depth-test-${Date.now()}-${Math.random()}`);
		mkdirSync(tempDir, { recursive: true });
		try {
			const sourceFile = join(tempDir, "source.jsonl");
			const forkFile = join(tempDir, "fork.jsonl");
			writeFileSync(
				sourceFile,
				`${JSON.stringify({
					type: "session",
					id: "source",
					timestamp: "2025-01-01T00:00:00Z",
					cwd: tempDir,
					rlmDepth: 2,
				})}
`,
			);
			const forkHeader = {
				type: "session" as const,
				id: "fork",
				timestamp: "2025-01-01T00:00:01Z",
				cwd: tempDir,
				parentSession: sourceFile,
			};
			writeFileSync(
				forkFile,
				`${JSON.stringify(forkHeader)}
`,
			);

			expect(resolveSessionRlmDepth(forkHeader, forkFile)).toBe(2);
			expect((await readSessionInfo(forkFile))?.rlmDepth).toBe(2);
			expect(loadEntriesFromFile(forkFile).find((entry) => entry.type === "session")!.rlmDepth).toBeUndefined();

			expect((await openSession(forkFile)).getHeader()?.rlmDepth).toBe(2);
			expect(loadEntriesFromFile(forkFile).find((entry) => entry.type === "session")!.rlmDepth).toBeUndefined();
		} finally {
			await closeManagers();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("treats a legacy fork in the sessions directory as a root", async () => {
		const tempDir = join(tmpdir(), `legacy-fork-depth-test-${Date.now()}-${Math.random()}`);
		mkdirSync(tempDir, { recursive: true });
		try {
			const forkFile = join(tempDir, "fork.jsonl");
			const header = {
				type: "session" as const,
				id: "fork",
				timestamp: "2025-01-01T00:00:01Z",
				cwd: tempDir,
				parentSession: join(tempDir, "source.jsonl"),
			};
			writeFileSync(forkFile, `${JSON.stringify(header)}\n`);

			expect(resolveSessionRlmDepth(header, forkFile)).toBe(0);
			expect((await readSessionInfo(forkFile))?.rlmDepth).toBe(0);
			expect((await openSession(forkFile)).getHeader()?.rlmDepth).toBe(0);
		} finally {
			await closeManagers();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not count a matching segment outside the trailing subagent path", async () => {
		const sessionFile = join(tmpdir(), "sub-deadbeef", "sessions", "child.jsonl");
		expect(resolveSessionRlmDepth({ parentSession: "/missing-parent.jsonl" }, sessionFile)).toBe(0);
	});

	it("prefers the parent header depth over path inference", async () => {
		const tempDir = join(tmpdir(), `parent-header-depth-test-${Date.now()}-${Math.random()}`);
		const parentFile = join(tempDir, "parent.jsonl");
		const childFile = join(tempDir, "sub-1234abcd", "sub-deadbeef", "child.jsonl");
		mkdirSync(tempDir, { recursive: true });
		try {
			writeFileSync(
				parentFile,
				`${JSON.stringify({
					type: "session",
					id: "parent",
					timestamp: "2025-01-01T00:00:00Z",
					cwd: tempDir,
					rlmDepth: 4,
				})}
`,
			);

			expect(resolveSessionRlmDepth({ parentSession: parentFile }, childFile)).toBe(5);
		} finally {
			await closeManagers();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("resolves relative parent paths from each legacy session directory", async () => {
		const tempDir = join(tmpdir(), `relative-parent-depth-test-${Date.now()}-${Math.random()}`);
		const grandparentFile = join(tempDir, "grandparent.jsonl");
		const parentFile = join(tempDir, "parent.jsonl");
		const childDir = join(tempDir, "sub-1234abcd");
		const childFile = join(childDir, "child.jsonl");
		mkdirSync(childDir, { recursive: true });
		try {
			writeFileSync(
				grandparentFile,
				`${JSON.stringify({
					type: "session",
					id: "grandparent",
					timestamp: "2025-01-01T00:00:00Z",
					cwd: tempDir,
					rlmDepth: 4,
				})}
`,
			);
			writeFileSync(
				parentFile,
				`${JSON.stringify({
					type: "session",
					id: "parent",
					timestamp: "2025-01-01T00:00:01Z",
					cwd: tempDir,
					parentSession: "grandparent.jsonl",
				})}
`,
			);

			expect(resolveSessionRlmDepth({ parentSession: "../parent.jsonl" }, childFile)).toBe(5);
		} finally {
			await closeManagers();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("prefers a valid persisted depth over path inference", async () => {
		const sessionFile = join(tmpdir(), "sub-1234abcd", "sub-deadbeef", "session.jsonl");
		expect(resolveSessionRlmDepth({ parentSession: "/parent.jsonl", rlmDepth: 7 }, sessionFile)).toBe(7);
	});
});

describe("findMostRecentSession", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await closeManagers();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns null for empty directory", async () => {
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("returns null for non-existent directory", async () => {
		expect(findMostRecentSession(join(tempDir, "nonexistent"))).toBeNull();
	});

	it("ignores non-jsonl files", async () => {
		writeFileSync(join(tempDir, "file.txt"), "hello");
		writeFileSync(join(tempDir, "file.json"), "{}");
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("ignores jsonl files without valid session header", async () => {
		writeFileSync(join(tempDir, "invalid.jsonl"), '{"type":"message"}\n');
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("returns single valid session file", async () => {
		const file = join(tempDir, "session.jsonl");
		writeFileSync(file, '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');
		expect(findMostRecentSession(tempDir)).toBe(file);
	});

	it("returns most recently modified session", async () => {
		const file1 = join(tempDir, "older.jsonl");
		const file2 = join(tempDir, "newer.jsonl");

		writeFileSync(file1, '{"type":"session","id":"old","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');
		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(file2, '{"type":"session","id":"new","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');

		expect(findMostRecentSession(tempDir)).toBe(file2);
	});

	it("skips invalid files and returns valid one", async () => {
		const invalid = join(tempDir, "invalid.jsonl");
		const valid = join(tempDir, "valid.jsonl");

		writeFileSync(invalid, '{"type":"not-session"}\n');
		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(valid, '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');

		expect(findMostRecentSession(tempDir)).toBe(valid);
	});
});

describe("SessionManager source opening", () => {
	let tempDir: string;
	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});
	afterEach(async () => {
		await closeManagers();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("does not replace an existing empty source with an invented header", async () => {
		const path = join(tempDir, "empty.jsonl");
		writeFileSync(path, "");
		await expect(openSession(path, tempDir)).rejects.toThrow("valid header");
		expect(readFileSync(path, "utf8")).toBe("");
	});

	it("does not replace a source whose header is missing", async () => {
		const path = join(tempDir, "no-header.jsonl");
		const bytes =
			'{"type":"message","id":"abc","parentId":"orphaned","message":{"role":"user","content":"retained"}}\n';
		writeFileSync(path, bytes);
		await expect(openSession(path, tempDir)).rejects.toThrow("valid header");
		expect(readFileSync(path, "utf8")).toBe(bytes);
	});

	it("preserves an explicit path when creating a new source", async () => {
		const path = join(tempDir, "my-session.jsonl");
		const manager = await openSession(path, tempDir);
		expect(manager.getSessionFile()).toBe(path);
		expect(loadEntriesFromFile(path)[0]).toMatchObject({ type: "session", id: manager.getSessionId() });
	});

	it("repeated rejected opens do not rewrite corrupt source bytes", async () => {
		const path = join(tempDir, "corrupted.jsonl");
		writeFileSync(path, "garbage content\n");
		await expect(openSession(path, tempDir)).rejects.toThrow();
		await expect(openSession(path, tempDir)).rejects.toThrow();
		expect(readFileSync(path, "utf8")).toBe("garbage content\n");
	});
});

describe("session info usage totals", () => {
	it("scan and resident computation agree on whole-file own spend, forks and attributions included", async () => {
		const tempDir = join(tmpdir(), `session-usage-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		try {
			const usage = (input: number, output: number, cost: number, cacheRead = 10, cacheWrite = 5) => ({
				input,
				output,
				cacheRead,
				cacheWrite,
				totalTokens: input + output,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
			});
			const msg = (id: string, parentId: string | null, role: string, u?: unknown) =>
				({ type: "message", id, parentId, message: { role, content: "x", timestamp: 1, usage: u } }) as const;
			const file = join(tempDir, "usage.jsonl");
			const lines = [
				{ type: "session", version: 3, id: "s1", timestamp: "2026-01-01T00:00:00Z", cwd: "/tmp" },
				msg("m1", null, "user"),
				msg("m2", "m1", "assistant", usage(1000, 200, 0.5)),
				// On-disk original usage; the loader folds the aggregate below onto it in memory.
				msg("m3", "m1", "assistant", usage(2000, 300, 1.0)),
				{
					type: "child_usage_attributed",
					id: "a1",
					parentId: "m3",
					targetId: "m3",
					childUsage: usage(500, 100, 0.4),
					aggregateUsage: usage(2500, 400, 1.4, 20, 10),
				},
				{
					type: "compaction",
					id: "c1",
					parentId: "m3",
					summary: "compacted",
					firstKeptEntryId: "m3",
					tokensBefore: 5000,
					usage: usage(100, 20, 0.05),
				},
				{
					type: "branch_summary",
					id: "b1",
					parentId: "c1",
					fromId: "m1",
					summary: "left",
					usage: usage(60, 8, 0.02),
				},
			];
			writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

			const manager = await openSession(file);
			const entries = manager.getEntries();
			const resident = sessionUsageSummaryFrom(computeOwnAndTotalUsage(entries, entries).ownUsage);

			const scanned = (await readSessionInfo(file))?.usage;
			expect(scanned).toMatchObject({ inputTokens: 3220, outputTokens: 528 });
			expect(scanned?.cost).toBeCloseTo(1.57);
			expect(resident).toEqual(scanned);

			await manager.migrateLegacy();
			const parent = manager.getEntry("m3");
			if (parent?.type !== "message" || parent.message.role !== "assistant")
				throw new Error("fixture parent missing");
			const before = structuredClone(parent.message.usage);
			const first = manager.appendChildUsageAttribution("m3", usage(10, 2, 0.01));
			const second = manager.appendChildUsageAttribution("m3", usage(20, 3, 0.02));
			expect(parent.message.usage).toEqual(before); // The queued projection is not yet acknowledged.
			await Promise.all([first, second]);
			expect(parent.message.usage.input).toBe(before.input + 30);
			expect(parent.message.usage.output).toBe(before.output + 5);
			expect(parent.message.usage.totalTokens).toBe(before.totalTokens);
			expect(parent.message.usage.cost.total).toBeCloseTo(before.cost.total + 0.03);
			expect((await readSessionInfo(file))?.usage?.cost).toBeCloseTo(scanned!.cost);
		} finally {
			await closeManagers();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
