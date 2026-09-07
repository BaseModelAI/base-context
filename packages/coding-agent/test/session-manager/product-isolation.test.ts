import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
		await session.appendSessionInfo("owned");
		expect(readFileSync(session.getSessionFile()!, "utf8")).toContain("owned");
		expect(loadEntriesFromFile(legacyFile)[0]).toMatchObject({ id: "legacy", version: 2 });
		const fork = await SessionManager.forkFrom(legacyFile, dir, ownedDir);
		managers.push(fork);
		await fork.appendSessionInfo("copied");
		expect(fork.getSessionFile()).not.toBe(legacyFile);
		expect(readFileSync(legacyFile, "utf8")).toBe(original);
	});

	it("rejects legacy writable targets, including a symlink changed after opening", async () => {
		await expect(SessionManager.open(legacyFile)).rejects.toThrow("cannot write legacy state");
		await expect(SessionManager.create(dir, join(dir, ".prime", "new"))).rejects.toThrow("cannot write legacy state");
		const session = await SessionManager.create(dir, join(dir, "owned"));
		managers.push(session);
		await session.appendSessionInfo("owned");
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
