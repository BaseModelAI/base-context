import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@ponythewhite/base-context-ai";
import { expect, it, vi } from "vitest";
import { CanonicalContextCompiler } from "../src/core/canonical-context.js";
import { HistoryIndex } from "../src/core/history-index.js";
import { InferenceCoordinator } from "../src/core/inference-coordinator.js";
import {
	appendSentAgentMessageToToolResult,
	IPYTHON_SENT_AGENT_MESSAGE_CUSTOM_ENTRY,
} from "../src/core/session-context-updates.js";
import { SessionManager } from "../src/core/session-manager.js";

it("reconstructs the whole retained context across pages and caches immutable source entries", async () => {
	const dir = mkdtempSync(join(tmpdir(), "base-context-compile-"));
	const manager = await SessionManager.create(dir, dir);
	const requests = new InferenceCoordinator(() => manager.bindRequestSink());
	let capture: InferenceCoordinator | undefined;
	try {
		await manager.appendMessage({ role: "user", content: "discarded prefix", timestamp: 0 });
		const sentMessage = {
			id: "sent",
			message: "delivered before compact",
			deliveryStatus: "delivered" as const,
			target: { activeSessionId: "recipient", sessionId: "recipient-session" },
		};
		await manager.appendCustomEntry(IPYTHON_SENT_AGENT_MESSAGE_CUSTOM_ENTRY, {
			toolCallId: "a",
			message: sentMessage,
		});
		let firstKept = "";
		for (let i = 0; i < 126; i++) {
			const id = await manager.appendMessage({ role: "user", content: `kept ${i}`, timestamp: i + 1 });
			if (i === 0) firstKept = id;
		}
		const assistant: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "openai",
			model: "fixture",
			timestamp: 128,
			content: [
				{ type: "toolCall", id: "a", name: "ipython", arguments: {} },
				{ type: "toolCall", id: "b", name: "ipython", arguments: {} },
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
		};
		const assistantId = await manager.appendMessage(assistant);
		await manager.appendMessage({
			role: "toolResult",
			toolCallId: "b",
			toolName: "ipython",
			content: [{ type: "text", text: "second result" }],
			isError: false,
			timestamp: 129,
		});
		await manager.appendCompaction("summary", firstKept, 500);
		await manager.appendMessage({
			role: "toolResult",
			toolCallId: "a",
			toolName: "ipython",
			content: [{ type: "text", text: "first result" }],
			isError: false,
			timestamp: 130,
		});
		const leaf = await manager.appendCustomEntry(IPYTHON_SENT_AGENT_MESSAGE_CUSTOM_ENTRY, {
			toolCallId: "a",
			message: { ...sentMessage, message: "must not replace first" },
		});
		await manager.appendMessage({ role: "user", content: "abandoned sibling", timestamp: 131 });
		await manager.appendCustomEntry(IPYTHON_SENT_AGENT_MESSAGE_CUSTOM_ENTRY, {
			toolCallId: "a",
			message: { ...sentMessage, id: "sibling", message: "not on selected branch" },
		});
		const aggregate = {
			...assistant.usage,
			input: 37,
			output: 4,
			totalTokens: 41,
			cost: { ...assistant.usage.cost, input: 0.5, total: 0.5 },
		};
		await manager.appendChildUsageAttribution(assistantId, aggregate, aggregate);
		manager.branch(leaf);
		const expected = structuredClone(manager.buildSessionContext().messages);
		for (const message of expected) appendSentAgentMessageToToolResult(message, "a", sentMessage);
		capture = requests.capture();
		const compiler = new CanonicalContextCompiler();
		const reads = vi.spyOn(HistoryIndex.prototype, "readPayload");
		const relatedReads = vi.spyOn(HistoryIndex.prototype, "readContextUpdatePayload");
		const limits = { maxMessages: 130, maxSourceBytes: 2 * 1024 * 1024 };
		const first = await capture.readHistory((view) => compiler.compile(view, limits));
		expect(first).toEqual(expected);
		expect(first[0]).toMatchObject({ role: "compactionSummary", retainedMessageCount: 128 });
		expect(
			first.slice(-2).map((message) => (message.role === "toolResult" ? message.toolCallId : "wrong role")),
		).toEqual(["a", "b"]);
		expect(first).toHaveLength(130);
		expect(first.find((message) => message.role === "assistant")).toMatchObject({ usage: aggregate });
		expect(first.find((message) => message.role === "toolResult" && message.toolCallId === "a")).toMatchObject({
			details: { sentAgentMessages: [sentMessage] },
		});
		const readCount = reads.mock.calls.length;
		const relatedCount = relatedReads.mock.calls.length;
		expect(relatedCount).toBe(3);
		const user = first.find((message) => message.role === "user");
		if (user?.role !== "user") throw new Error("fixture expected retained user input");
		user.content = "changed by a replaceable transform";
		const second = await capture.readHistory((view) => compiler.compile(view, limits));
		expect(second).toEqual(expected);
		expect(reads).toHaveBeenCalledTimes(readCount);
		expect(relatedReads).toHaveBeenCalledTimes(relatedCount);
	} finally {
		try {
			await capture?.dispose();
			await manager.close();
		} finally {
			vi.restoreAllMocks();
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

it("refuses budgets and invalid retained boundaries instead of silently dropping active context", async () => {
	const dir = mkdtempSync(join(tmpdir(), "base-context-compile-limit-"));
	const manager = await SessionManager.create(dir, dir);
	const requests = new InferenceCoordinator(() => manager.bindRequestSink());
	let capture: InferenceCoordinator | undefined;
	try {
		await manager.appendMessage({ role: "user", content: "one", timestamp: 1 });
		await manager.appendMessage({ role: "user", content: "two", timestamp: 2 });
		capture = requests.capture();
		const compiler = new CanonicalContextCompiler();
		const reads = vi.spyOn(HistoryIndex.prototype, "readPayload");
		await expect(
			capture.readHistory((view) => compiler.compile(view, { maxMessages: 1, maxSourceBytes: 4096 })),
		).rejects.toThrow("message budget exceeded");
		await expect(
			capture.readHistory((view) => compiler.compile(view, { maxMessages: 10, maxSourceBytes: 1 })),
		).rejects.toThrow("source byte budget exceeded");
		expect(reads).not.toHaveBeenCalled();
		await capture.dispose();
		await manager.appendCompaction("not a complete replacement", "missing boundary", 50);
		capture = requests.capture();
		await expect(
			capture.readHistory((view) => compiler.compile(view, { maxMessages: 10, maxSourceBytes: 4096 })),
		).rejects.toThrow("invalid-first-kept");
		expect(reads).not.toHaveBeenCalled();
	} finally {
		try {
			await capture?.dispose();
			await manager.close();
		} finally {
			vi.restoreAllMocks();
			rmSync(dir, { recursive: true, force: true });
		}
	}
});
