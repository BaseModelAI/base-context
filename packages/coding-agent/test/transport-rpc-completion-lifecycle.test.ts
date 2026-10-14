import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DAEMON_PROTOCOL_VERSION, DAEMON_SCHEMA_REVISION } from "../src/modes/daemon/daemon-protocol.js";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";

describe("RPC completion observations during termination", () => {
	it.each(["exit", "stop"])("rejects admitted completion observers on %s", async (termination) => {
		const directory = mkdtempSync(join(tmpdir(), "rpc-completion-lifecycle-"));
		const cliPath = join(directory, "mock-rpc.mjs");
		writeFileSync(
			cliPath,
			String.raw`import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  process.stdout.write(JSON.stringify({ type: "response", id: command.id,
    command: command.type, success: true, data: {
      protocolVersion: ${DAEMON_PROTOCOL_VERSION}, schemaRevision: ${DAEMON_SCHEMA_REVISION}
    } }) + "\n", () => {
      if (command.type === "prompt" && ${JSON.stringify(termination)} === "exit") process.exit(7);
    });
});
`,
		);
		const client = new RpcClient({ cliPath, cwd: directory });
		try {
			await client.start();
			const outcomes = Promise.allSettled([
				client.waitForIdle(1000),
				client.collectEvents(1000),
				client.promptAndWait("work", undefined, 1000),
			]);
			if (termination === "stop") {
				await client.getState();
				await client.stop();
			}
			for (const outcome of await outcomes) {
				expect(outcome.status).toBe("rejected");
				if (outcome.status === "rejected") {
					expect(outcome.reason.message).toMatch(
						termination === "exit"
							? /Agent process exited with code 7/
							: /RPC client stopped|Agent process exited with signal SIGTERM/,
					);
				}
			}
			expect((client as unknown as { eventListeners: unknown[] }).eventListeners).toHaveLength(0);
		} finally {
			await client.stop();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
