import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DAEMON_PROTOCOL_VERSION, DAEMON_SCHEMA_REVISION } from "../src/modes/daemon/daemon-protocol.js";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";

describe("RPC input failure does not cancel admitted work", () => {
	it.each([false, true])("settles requests and keeps output observers (closed input=%s)", async (closeInput) => {
		const directory = mkdtempSync(join(tmpdir(), "rpc-input-failure-"));
		const cliPath = join(directory, "mock-rpc.mjs");
		writeFileSync(
			cliPath,
			String.raw`import { closeSync } from "node:fs";
import { createInterface } from "node:readline";
const send = (event) => process.stdout.write(JSON.stringify(event) + "\n");
setInterval(() => {}, 1000);
createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  send({ type: "response", id: command.id, command: command.type, success: true,
    data: { protocolVersion: ${DAEMON_PROTOCOL_VERSION}, schemaRevision: ${DAEMON_SCHEMA_REVISION} } });
  if (command.type === "prompt") {
    const started = () => {
      send({ type: "agent_start" });
      setTimeout(() => send({ type: "agent_end", messages: [] }), 100);
    };
    if (${closeInput}) {
      process.stdin.once("close", started);
      closeSync(0);
      process.stdin.destroy();
    } else started();
  }
});`,
		);
		const client = new RpcClient({ cliPath, cwd: directory });
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await client.start();
			const child = (client as unknown as { process: ChildProcess }).process;
			const started = new Promise<void>((resolve) => {
				const unsubscribe = client.onEvent((event) => {
					if (event.type === "agent_start") {
						unsubscribe();
						resolve();
					}
				});
			});
			const completion = client.collectEvents(2000);
			await client.prompt("work");
			await started;
			const request = Promise.race([
				client.getState(),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("Request remained pending")), 1000);
				}),
			]);
			if (closeInput) await expect(request).rejects.toThrow(/EPIPE|input is closed/);
			else expect((await request).protocolVersion).toBe(DAEMON_PROTOCOL_VERSION);
			clearTimeout(timer);
			expect((await completion).at(-1)?.type).toBe("agent_end");
			expect(child.exitCode).toBeNull();
			expect(child.signalCode).toBeNull();
			if (closeInput) await expect(client.getState()).rejects.toThrow("input is closed");
		} finally {
			clearTimeout(timer);
			await client.stop();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
