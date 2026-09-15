import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { findMostRecentSessionForCwd, SessionManager } from "../src/core/session-manager.js";
import { runMigrations } from "../src/migrations.js";

describe("session migrations", () => {
	const tempDirs: string[] = [];
	const previousAgentDir = process.env[ENV_AGENT_DIR];

	afterEach(() => {
		if (previousAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = previousAgentDir;
		}
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("retains legacy per-cwd sources and discovers them without relocation", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "prime-agent-migrations-"));
		tempDirs.push(agentDir);
		process.env[ENV_AGENT_DIR] = agentDir;

		const sessionsDir = join(agentDir, "sessions");
		const legacyDir = join(sessionsDir, "--tmp-project--");
		mkdirSync(legacyDir, { recursive: true });
		const legacyFile = join(legacyDir, "session-1.jsonl");
		const sessionLines = [
			{
				type: "session",
				version: 3,
				id: "session-1",
				timestamp: new Date().toISOString(),
				cwd: "/tmp/project",
			},
			{
				type: "message",
				id: "entry-1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "hello", timestamp: Date.now() },
			},
		];
		writeFileSync(legacyFile, `${sessionLines.map((line) => JSON.stringify(line)).join("\n")}\n`);

		const before = readFileSync(legacyFile);
		runMigrations(agentDir);
		expect(readFileSync(legacyFile)).toEqual(before);
		expect(existsSync(legacyDir)).toBe(true);
		expect(existsSync(join(sessionsDir, "session-1.jsonl"))).toBe(false);
		expect((await SessionManager.list("/tmp/project", sessionsDir)).map((session) => session.path)).toEqual([
			legacyFile,
		]);
		expect(findMostRecentSessionForCwd(sessionsDir, "/tmp/project")).toBe(legacyFile);
	});

	it("retains malformed root sources rather than relocating or repairing them", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "prime-agent-migrations-"));
		tempDirs.push(agentDir);
		process.env[ENV_AGENT_DIR] = agentDir;

		const legacyFile = join(agentDir, "session-root.jsonl");
		writeFileSync(
			legacyFile,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "session-root",
				timestamp: new Date().toISOString(),
				cwd: "/tmp/project",
			})}\n${"x".repeat(128 * 1024)}\n`,
		);

		const before = readFileSync(legacyFile);
		runMigrations(agentDir);
		expect(readFileSync(legacyFile)).toEqual(before);
		expect(existsSync(join(agentDir, "sessions", "session-root.jsonl"))).toBe(false);
		expect(await SessionManager.list("/tmp/project", join(agentDir, "sessions"))).toEqual([]);
	});

	it("does not move or discover session files from unrelated subdirectories", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "prime-agent-migrations-"));
		tempDirs.push(agentDir);
		process.env[ENV_AGENT_DIR] = agentDir;

		const sessionsDir = join(agentDir, "sessions");
		const nonLegacyDir = join(sessionsDir, "exports");
		mkdirSync(nonLegacyDir, { recursive: true });
		const nestedFile = join(nonLegacyDir, "session-2.jsonl");
		writeFileSync(
			nestedFile,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "session-2",
				timestamp: new Date().toISOString(),
				cwd: "/tmp/project",
			})}\n`,
		);

		runMigrations(agentDir);

		expect(existsSync(nestedFile)).toBe(true);
		expect(existsSync(join(sessionsDir, "session-2.jsonl"))).toBe(false);
		expect(await SessionManager.list("/tmp/project", sessionsDir)).toEqual([]);
	});
});
