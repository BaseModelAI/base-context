import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { readSessionInfo, SessionManager } from "../src/core/session-manager.js";
import { DaemonCatalogClient } from "../src/modes/daemon/daemon-catalog-process.js";

describe("daemon catalog entrypoint", () => {
	it("starts the dedicated catalog process over IPC", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pa-catalog-entry-"));
		const previousAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
		const client = new DaemonCatalogClient(() => {});
		try {
			await expect(client.start()).resolves.toBeUndefined();
			await expect(client.list()).resolves.toEqual([]);

			const sessionDir = join(agentDir, "sessions");
			const manager = await SessionManager.create(agentDir, sessionDir);
			let sessionPath: string;
			let sessionId: string;
			try {
				await manager.appendMessage({ role: "user", content: "catalog drain fixture", timestamp: 1 });
				sessionPath = manager.getSessionFile()!;
				sessionId = manager.getSessionId();
			} finally {
				await manager.close();
			}
			// Fill ordinary admission before its send microtasks. Shutdown must not need a 33rd slot.
			const reads = Array.from({ length: 31 }, () => client.resolve(sessionId, agentDir, sessionDir));
			const write = client.rename(sessionPath, "accepted-before-stop");
			const stopping = client.stop();
			expect(client.stop()).toBe(stopping);
			await expect(client.rename(sessionPath, "not-admitted-during-stop")).rejects.toThrow("shutting down");
			await expect(Promise.all(reads)).resolves.toEqual(Array(31).fill(sessionPath));
			await expect(write).resolves.toBeUndefined();
			await stopping;
			expect((await readSessionInfo(sessionPath))?.name).toBe("accepted-before-stop");
		} finally {
			await client.stop();
			if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = previousAgentDir;
			rmSync(agentDir, { recursive: true, force: true });
		}
	}, 10_000);
});
