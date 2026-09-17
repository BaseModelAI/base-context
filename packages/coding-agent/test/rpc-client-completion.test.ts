import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentEvent, AgentOutputLimitError } from "@ponythewhite/base-context-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DAEMON_PROTOCOL_VERSION, DAEMON_SCHEMA_REVISION } from "../src/modes/daemon/daemon-protocol.js";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";

const directories: string[] = [];

function startup(schemaRevision: number, promptError?: string, exitOnState?: number) {
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
let stateRequests = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type === "prompt" && ${JSON.stringify(promptError)}) {
    process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: command.type, success: false,
      error: ${JSON.stringify(promptError)} }) + "\n");
    return;
  }
  if (command.type !== "get_state") throw new Error("Unexpected work before startup checks");
  if (++stateRequests === ${JSON.stringify(exitOnState)}) {
    process.stderr.write("mock RPC exit\n", () => process.exit(7));
    return;
  }
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
	// RPC forwards ordinary extension errors as observable, nonterminal events.
	const extensionError = {
		type: "extension_error",
		extensionPath: "test-extension",
		event: "prompt_completion",
		error: "nonterminal",
	} as unknown as AgentEvent;
	const events: AgentEvent[] = [{ type: "agent_start" }, extensionError, terminal];
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
	it.each([1, 2])(
		"rejects pending state request %i when the child exits",
		async (exitOnState) => {
			const server = startup(DAEMON_SCHEMA_REVISION, undefined, exitOnState);
			try {
				if (exitOnState === 2) await server.client.start();
				const request = exitOnState === 1 ? server.client.start() : server.client.getState();
				await expect(request).rejects.toThrow("Agent process exited with code 7. Stderr: mock RPC exit");
				const stoppedAt = performance.now();
				await server.client.stop();
				expect(performance.now() - stoppedAt).toBeLessThan(500);
				await expect(server.client.getState()).rejects.toThrow("Client not started");
			} finally {
				await server.client.stop();
			}
		},
		2000,
	);

	it("rejects failed prompt admission and cancels its completion waiter", async () => {
		const failure = "No API key found for openai";
		const server = startup(DAEMON_SCHEMA_REVISION, failure);
		try {
			await server.client.start();
			await expect(server.client.prompt("work")).rejects.toThrow(failure);
			vi.useFakeTimers();
			await expect(server.client.promptAndWait("work")).rejects.toThrow(failure);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
			await server.client.stop();
		}
	});

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
		const server = startup(DAEMON_SCHEMA_REVISION - 1);
		try {
			await expect(server.client.start()).rejects.toThrow(
				`Incompatible RPC schema: expected at least ${DAEMON_SCHEMA_REVISION}, got ${DAEMON_SCHEMA_REVISION - 1}`,
			);
			expect(existsSync(server.stopped)).toBe(true);
		} finally {
			await server.client.stop();
		}
	});
});
