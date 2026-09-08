import { type AgentEvent, AgentOutputLimitError } from "@ponythewhite/base-context-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";

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

afterEach(() => vi.restoreAllMocks());

describe("RpcClient completion", () => {
	it("returns the complete event collection after successful completion", async () => {
		const { client, unsubscribe, events } = completion({ type: "agent_end", messages: [] });
		await expect(client.promptAndWait("work")).resolves.toEqual(events);
		expect(unsubscribe).toHaveBeenCalledOnce();
	});

	it("rejects output refusal instead of treating terminal idle as success", async () => {
		const { client, unsubscribe } = completion({
			type: "agent_end",
			refusal: { kind: "output_limit", limit: "source_bytes", maxMessages: 2, maxSourceBytes: 1024 },
		});
		await expect(client.promptAndWait("work")).rejects.toBeInstanceOf(AgentOutputLimitError);
		expect(unsubscribe).toHaveBeenCalledOnce();
	});
});
