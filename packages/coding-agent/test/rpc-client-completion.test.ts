import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentEvent, AgentOutputLimitError } from "@ponythewhite/base-context-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DAEMON_PROTOCOL_VERSION, DAEMON_SCHEMA_REVISION } from "../src/modes/daemon/daemon-protocol.js";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";

const directories: string[] = [];

function startup(schemaRevision: number) {
	const directory = mkdtempSync(join(tmpdir(), "rpc-schema-"));
	directories.push(directory);
	const cliPath = join(directory, "mock-rpc.mjs");
	const stopped = join(directory, "stopped");
	// Real child transport/cleanup; this is a mock server, not an installed CLI or provider.
	writeFileSync(
		cliPath,
		String.raw`
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
if (process.argv[process.argv.indexOf("--rpc-protocol-version") + 1] !== "${DAEMON_PROTOCOL_VERSION}") process.exit(2);
process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(stopped)}, "stopped"); process.exit(0); });
createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type !== "get_state") throw new Error("Unexpected work before startup checks");
  process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true,
    data: { protocolVersion: ${DAEMON_PROTOCOL_VERSION}, schemaRevision: ${schemaRevision} } }) + "\n");
});
`,
	);
	return { client: new RpcClient({ cliPath, cwd: directory }), stopped };
}

function completion(terminal: Extract<AgentEvent, { type: "agent_end" }>) {
	const client = new RpcClient();
	let listener: ((event: AgentEvent) => void) | undefined;
	const unsubscribe = vi.fn();
	const events: AgentEvent[] = [{ type: "agent_start" }, terminal];
	vi.spyOn(client, "onEvent").mockImplementation((callback) => {
		listener = callback;
		return unsubscribe;
	});
	// Synthetic local client events, not a spawned server or provider attempt.
	vi.spyOn(client, "prompt").mockImplementation(async () => {
		for (const event of events) listener?.(event);
	});
	return { client, unsubscribe, events };
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("RpcClient completion", () => {
	it("returns the complete event collection after successful completion", async () => {
		const { client, unsubscribe, events } = completion({ type: "agent_end", messages: [] });
		await expect(client.promptAndWait("work")).resolves.toEqual(events);
		expect(unsubscribe).toHaveBeenCalledOnce();
		const server = startup(DAEMON_SCHEMA_REVISION);
		try {
			await server.client.start();
			expect(await server.client.getState()).toMatchObject({ schemaRevision: DAEMON_SCHEMA_REVISION });
		} finally {
			await server.client.stop();
		}
		expect(existsSync(server.stopped)).toBe(true);
	});

	it("rejects output refusal instead of treating terminal idle as success", async () => {
		const { client, unsubscribe } = completion({
			type: "agent_end",
			refusal: { kind: "output_limit", limit: "source_bytes", maxMessages: 2, maxSourceBytes: 1024 },
		});
		await expect(client.promptAndWait("work")).rejects.toBeInstanceOf(AgentOutputLimitError);
		expect(unsubscribe).toHaveBeenCalledOnce();
		const server = startup(30);
		try {
			await expect(server.client.start()).rejects.toThrow("Incompatible RPC schema: expected at least 31, got 30");
			expect(existsSync(server.stopped)).toBe(true);
		} finally {
			await server.client.stop();
		}
	});
});
