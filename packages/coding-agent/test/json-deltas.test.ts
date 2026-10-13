import type { AgentMessage } from "@ponythewhite/base-context-agent";
import type { AssistantMessage, AssistantMessageEvent } from "@ponythewhite/base-context-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli/args.js";
import { formatTopLevelHelp } from "../src/cli/command-registry.js";
import type {
	AgentConnection,
	AgentConnectionEventListener,
	AgentConnectionSessionEvent,
} from "../src/modes/agent-connection/types.js";
import { runPrintModeWithConnection } from "../src/modes/print-mode.js";

const output = vi.hoisted(() => ({ write: vi.fn<(text: string) => void>(), flush: vi.fn(async () => {}) }));
vi.mock("../src/core/output-guard.js", () => ({
	writeRawStdout: output.write,
	flushRawStdout: output.flush,
}));

const header = { type: "session" as const, version: 3, id: "session-1", timestamp: "2026-01-01", cwd: "/tmp" };

function assistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "offline-fixture",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 1,
	};
}

function update(message: AssistantMessage, event: AssistantMessageEvent): AgentConnectionSessionEvent {
	return { type: "message_update", message: structuredClone(message), assistantMessageEvent: structuredClone(event) };
}

function connectionFor(events: AgentConnectionSessionEvent[], messages: AgentMessage[]): AgentConnection {
	let listener: AgentConnectionEventListener | undefined;
	const connection: Pick<
		AgentConnection,
		"subscribe" | "getSessionHeader" | "promptAndWait" | "waitForHeadlessCompletion" | "getMessages" | "dispose"
	> = {
		subscribe(callback) {
			listener = callback;
			return () => {
				listener = undefined;
			};
		},
		getSessionHeader: async () => header,
		promptAndWait: async () => {
			for (const event of events) await listener?.({ type: "session_event", event });
		},
		waitForHeadlessCompletion: async () => ({
			enabled: false,
			continuationsUsed: 0,
			turnsUsed: 0,
			tokensUsed: 0,
			limits: { maxContinuations: 3, maxTurns: 12, maxTokens: 80_000, timeoutMs: 1_800_000 },
			gates: { commands: [], maxRetries: 3, timeoutMs: 300_000 },
			gateAttempts: {},
		}),
		getMessages: async () => messages,
		dispose: async () => {},
	};
	return connection as AgentConnection;
}

interface JsonEvent {
	type: string;
	messageId?: number;
	message?: AgentMessage;
	assistantMessageEvent?: {
		type: string;
		contentIndex?: number;
		delta?: string;
		toolCall?: { id: string; name: string; arguments?: Record<string, unknown> };
	};
}

function emittedEvents(): JsonEvent[] {
	return output.write.mock.calls.map(([line]) => JSON.parse(line));
}

beforeEach(() => {
	output.write.mockClear();
});
afterEach(() => {
	vi.restoreAllMocks();
});

describe("--json-deltas", () => {
	it("requires explicit JSON mode and appears in help", () => {
		expect(parseArgs(["--json-deltas", "--mode", "json", "prompt"])).toMatchObject({
			jsonDeltas: true,
			mode: "json",
			messages: ["prompt"],
			diagnostics: [],
		});
		expect(parseArgs(["--mode", "json"]).jsonDeltas).toBeUndefined();
		for (const args of [[], ["--mode", "text"], ["--mode", "rpc"], ["--mode", "acp"], ["--mode", "daemon"]]) {
			expect(parseArgs([...args, "--json-deltas"]).diagnostics).toContainEqual({
				type: "error",
				message: "--json-deltas requires --mode json",
			});
		}
		expect(formatTopLevelHelp()).toContain("--json-deltas");
	});

	it("preserves the default JSON event stream exactly", async () => {
		const message = assistant([{ type: "text", text: "Hello" }]);
		const events: AgentConnectionSessionEvent[] = [
			{ type: "message_start", message: assistant([]) },
			update(message, { type: "text_delta", contentIndex: 0, delta: "Hello", partial: message }),
			{ type: "message_end", message },
		];
		expect(
			await runPrintModeWithConnection(connectionFor(events, [message]), { mode: "json", initialMessage: "prompt" }),
		).toBe(0);
		expect(output.write.mock.calls.map(([line]) => line).join("")).toBe(
			[header, ...events].map((event) => `${JSON.stringify(event)}\n`).join(""),
		);
	});

	it("reconstructs text, thinking and tool arguments without snapshots or source mutations", async () => {
		const toolCall = { type: "toolCall" as const, id: "call-1", name: "ipython", arguments: { code: "print(1)" } };
		const message = assistant(
			[{ type: "text", text: "Hello" }, { type: "thinking", thinking: "Plan" }, toolCall],
			"toolUse",
		);
		const final = assistant([{ type: "text", text: "Done" }]);
		const user: AgentMessage = { role: "user", content: "prompt", timestamp: 1 };
		const events: AgentConnectionSessionEvent[] = [
			{ type: "message_start", message: user },
			{ type: "message_end", message: user },
			{ type: "message_start", message: assistant([]) },
			update(message, { type: "text_start", contentIndex: 0, partial: message }),
			update(message, { type: "text_delta", contentIndex: 0, delta: "Hel", partial: message }),
			update(message, { type: "text_delta", contentIndex: 0, delta: "lo", partial: message }),
			update(message, { type: "text_end", contentIndex: 0, content: "Hello", partial: message }),
			update(message, { type: "thinking_delta", contentIndex: 1, delta: "Plan", partial: message }),
			update(message, { type: "toolcall_start", contentIndex: 2, partial: message }),
			update(message, { type: "toolcall_delta", contentIndex: 2, delta: '{"code":', partial: message }),
			update(message, { type: "toolcall_delta", contentIndex: 2, delta: '"print(1)"}', partial: message }),
			update(message, { type: "toolcall_end", contentIndex: 2, toolCall, partial: message }),
			{ type: "message_end", message },
			{ type: "message_start", message: assistant([]) },
			update(final, { type: "text_delta", contentIndex: 0, delta: "Done", partial: final }),
			{ type: "message_end", message: final },
			{ type: "agent_end", messages: [message, final] },
		];
		const original = structuredClone(events);
		expect(
			await runPrintModeWithConnection(connectionFor(events, [message, final]), {
				mode: "json",
				jsonDeltas: true,
				initialMessage: "prompt",
			}),
		).toBe(0);
		const emitted = emittedEvents();
		const updates = emitted.filter((event) => event.type === "message_update");
		for (const event of updates) {
			expect(event).not.toHaveProperty("message");
			expect(event.assistantMessageEvent).not.toHaveProperty("partial");
		}
		const deltas = (messageId: number, contentIndex: number) =>
			updates
				.filter(
					(event) => event.messageId === messageId && event.assistantMessageEvent?.contentIndex === contentIndex,
				)
				.map((event) => event.assistantMessageEvent?.delta ?? "")
				.join("");
		expect(deltas(1, 0)).toBe("Hello");
		expect(deltas(1, 1)).toBe("Plan");
		expect(JSON.parse(deltas(1, 2))).toEqual(toolCall.arguments);
		expect(deltas(2, 0)).toBe("Done");
		expect(
			updates.find((event) => event.assistantMessageEvent?.type === "toolcall_start")?.assistantMessageEvent,
		).toEqual({
			type: "toolcall_start",
			contentIndex: 2,
			toolCall: { id: "call-1", name: "ipython" },
		});
		expect(
			updates.find((event) => event.assistantMessageEvent?.type === "toolcall_end")?.assistantMessageEvent?.toolCall,
		).toEqual(toolCall);
		expect(
			emitted
				.filter((event) => event.type === "message_start" && event.message?.role === "assistant")
				.map((event) => event.messageId),
		).toEqual([1, 2]);
		expect(emitted.filter((event) => event.type === "message_end" && event.message?.role === "assistant")).toEqual([
			{ type: "message_end", messageId: 1, message },
			{ type: "message_end", messageId: 2, message: final },
		]);
		expect(emitted[1]).toEqual(events[0]);
		expect(emitted.at(-1)).toEqual(events.at(-1));
		expect(events).toEqual(original);
	});

	it("retains a terminal error with no deltas and its failing exit status", async () => {
		const message = { ...assistant([], "error"), errorMessage: "offline failure" };
		const events: AgentConnectionSessionEvent[] = [
			{ type: "message_start", message: structuredClone(message) },
			{ type: "message_end", message },
		];
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(
			await runPrintModeWithConnection(connectionFor(events, [message]), {
				mode: "json",
				jsonDeltas: true,
				initialMessage: "prompt",
			}),
		).toBe(1);
		expect(emittedEvents()).toEqual([header, ...events.map((event) => ({ ...event, messageId: 1 }))]);
		expect(error).toHaveBeenCalledWith("offline failure");
	});
});
