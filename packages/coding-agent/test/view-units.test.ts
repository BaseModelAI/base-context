import type { AgentMessage } from "@ponythewhite/base-context-agent";
import { expect, it } from "vitest";
import { bindMessageReplayUnits, closeViewSelection, type ViewUnit } from "../src/core/view-units.js";

const limits = { maxUnits: 16, maxDependencies: 32, maxMetadataBytes: 8192 };
function unit(id: string, dependencies: string[] = []): ViewUnit {
	return {
		id,
		sourceRevision: `${id}:revision1`,
		kind: "literal",
		exactSources: [`source:${id}`],
		requiredVisibleDependencies: dependencies,
		authority: "tool-data",
		tokenEstimate: null,
		immutableWithinEpoch: true,
	};
}
function messages(): AgentMessage[] {
	return [
		{ role: "user", content: "baseline", timestamp: 0 },
		{
			role: "assistant",
			api: "openai-responses",
			provider: "openai",
			model: "fixture",
			timestamp: 1,
			content: [
				{ type: "thinking", thinking: "", thinkingSignature: "opaque-original", redacted: true },
				{ type: "toolCall", id: "a", name: "read", arguments: { path: "CaseSensitive.py" } },
				{ type: "toolCall", id: "b", name: "read", arguments: {} },
			],
			stopReason: "toolUse",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
		{
			role: "toolResult",
			toolCallId: "b",
			toolName: "read",
			timestamp: 2,
			isError: false,
			content: [{ type: "image", data: "original-image", mimeType: "image/png" }],
		},
		{
			role: "toolResult",
			toolCallId: "a",
			toolName: "read",
			timestamp: 3,
			isError: true,
			content: [{ type: "text", text: "CaseSensitive.py:4 decisive error" }],
		},
		{ role: "user", content: "changed from baseline", timestamp: 4 },
	];
}

it("closes whole-message tool and delta dependencies without rewriting source content", () => {
	const source = messages();
	const before = structuredClone(source);
	const units = [unit("base"), unit("call"), unit("b"), unit("a"), unit("delta", ["base"])];
	const grouped = bindMessageReplayUnits(source, units, limits, "message-groups");
	expect(closeViewSelection(grouped, ["a"], limits).map((value) => value.id)).toEqual(["call", "b", "a"]);
	expect(closeViewSelection(grouped, ["a", "delta"], limits).map((value) => value.id)).toEqual([
		"base",
		"call",
		"b",
		"a",
		"delta",
	]);
	const conservative = bindMessageReplayUnits(source, units, limits);
	expect(closeViewSelection(conservative, ["delta"], limits)).toHaveLength(5);
	expect(source).toEqual(before);
	expect(grouped[2].authority).toBe("tool-data");
	expect(grouped[2].tokenEstimate).toBeNull();
	expect(Object.isFrozen(grouped[2].requiredVisibleDependencies)).toBe(true);
	const revised = units.map((value) => (value.id === "a" ? { ...value, sourceRevision: "a:revision2" } : value));
	expect(bindMessageReplayUnits(source, revised, limits, "message-groups")[3].sourceRevision).toBe("a:revision2");
});

it("refuses missing replay or delta sources and bounded-closure overflow", () => {
	const units = [unit("base"), unit("call"), unit("b")];
	const open = bindMessageReplayUnits(messages().slice(0, 3), units, limits, "message-groups");
	expect(() => closeViewSelection(open, ["b"], limits)).toThrow("replay group is incomplete");
	expect(() => closeViewSelection([unit("delta", ["missing"])], ["delta"], limits)).toThrow("unavailable");
	expect(() => closeViewSelection([unit("same"), unit("same")], ["same"], limits)).toThrow("Duplicate");
	expect(() => closeViewSelection(units, ["base"], { ...limits, maxUnits: 1 })).toThrow("item budget");
	expect(() =>
		bindMessageReplayUnits(messages(), [...units, unit("a"), unit("delta")], { ...limits, maxDependencies: 1 }),
	).toThrow("dependency budget");
	expect(() => closeViewSelection(units, ["base"], { ...limits, maxMetadataBytes: 1 })).toThrow("JSON byte limit");
});
