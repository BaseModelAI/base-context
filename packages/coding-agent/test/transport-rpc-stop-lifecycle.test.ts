import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DAEMON_PROTOCOL_VERSION, DAEMON_SCHEMA_REVISION } from "../src/modes/daemon/daemon-protocol.js";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";

describe("RPC process ownership during stop", () => {
	it.each([false, true])("joins physical exit before releasing ownership (ignore SIGTERM=%s)", async (ignoreTerm) => {
		const directory = mkdtempSync(join(tmpdir(), "rpc-stop-lifecycle-"));
		const cliPath = join(directory, "mock-rpc.mjs");
		writeFileSync(
			cliPath,
			String.raw`import { createInterface } from "node:readline";
if (${ignoreTerm}) process.on("SIGTERM", () => {});
createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  process.stdout.write(JSON.stringify({ type: "response", id: command.id,
    command: command.type, success: true, data: {
      protocolVersion: ${DAEMON_PROTOCOL_VERSION}, schemaRevision: ${DAEMON_SCHEMA_REVISION}
    } }) + "\n");
});
`,
		);
		const client = new RpcClient({ cliPath, cwd: directory });
		let exited: Promise<unknown> | undefined;
		try {
			await client.start();
			const child = (client as unknown as { process: ChildProcess }).process;
			exited = once(child, "exit");
			await client.stop();
			expect(child.signalCode).toBe(ignoreTerm ? "SIGKILL" : "SIGTERM");
			await expect(client.getState()).rejects.toThrow("Client not started");
		} finally {
			await client.stop();
			await exited;
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
