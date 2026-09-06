import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEntriesFromFile, SessionManager } from "../../src/core/session-manager.js";

describe("session write isolation", () => {
	let dir: string;
	let legacyFile: string;
	let original: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "base-context-session-isolation-"));
		legacyFile = join(dir, ".prime", "agent", "sessions", "legacy.jsonl");
		mkdirSync(join(dir, ".prime", "agent", "sessions"), { recursive: true });
		original = `${JSON.stringify({ type: "session", version: 2, id: "legacy", timestamp: new Date().toISOString(), cwd: dir })}\n`;
		writeFileSync(legacyFile, original);
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("persists owned sessions and permits explicit read/copy from a legacy input", () => {
		const ownedDir = join(dir, "owned");
		const session = SessionManager.create(dir, ownedDir);
		session.appendSessionInfo("owned");
		expect(readFileSync(session.getSessionFile()!, "utf8")).toContain("owned");
		expect(loadEntriesFromFile(legacyFile)[0]).toMatchObject({ id: "legacy", version: 2 });
		const fork = SessionManager.forkFrom(legacyFile, dir, ownedDir);
		fork.appendSessionInfo("copied");
		expect(fork.getSessionFile()).not.toBe(legacyFile);
		expect(readFileSync(legacyFile, "utf8")).toBe(original);
	});

	it("rejects legacy writable targets, including a symlink changed after opening", () => {
		expect(() => SessionManager.open(legacyFile)).toThrow("cannot write legacy state");
		expect(() => SessionManager.create(dir, join(dir, ".prime", "new"))).toThrow("cannot write legacy state");
		const session = SessionManager.create(dir, join(dir, "owned"));
		session.appendSessionInfo("owned");
		const path = session.getSessionFile()!;
		rmSync(path);
		symlinkSync(legacyFile, path);
		expect(() => session.appendSessionInfo("must not append")).toThrow("cannot write legacy state");
		expect(() => session.setSessionFile(legacyFile)).toThrow("cannot write legacy state");
		expect(readFileSync(legacyFile, "utf8")).toBe(original);
	});
});
