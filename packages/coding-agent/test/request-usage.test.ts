import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAttemptUsage } from "@ponythewhite/base-context-ai";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	type ContextTreeNode,
	loadContextTreeChildrenFromDisk,
	readContextTreeUsage,
	readResidentContextTreeUsage,
} from "../src/core/context-tree.js";
import type { NativeRequestEvent, RequestPurpose } from "../src/core/request-events.js";
import { RequestUsageAccumulator } from "../src/core/request-usage.js";
import { SessionManager } from "../src/core/session-manager.js";
import { emptyUsage } from "../src/core/usage.js";
import { DaemonAgentConnection } from "../src/modes/agent-connection/daemon-agent-connection.js";
import type { DaemonTransportClient } from "../src/modes/daemon/daemon-client.js";
import { formatContextTree } from "../src/modes/interactive/components/context-tree-format.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { createDeferred } from "./suite/scheduling.js";

const dirs: string[] = [];
const managers: SessionManager[] = [];
beforeAll(() => initTheme("dark"));
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(managers.splice(0).map((manager) => manager.close()));
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "request-usage-"));
	dirs.push(dir);
	return dir;
}
function settled(
	sessionId: string,
	attemptId: string,
	purpose: RequestPurpose = "main",
	purposeDetail?: string,
	usage: ProviderAttemptUsage = {
		input: 10,
		inputTotal: 100,
		output: 5,
		cacheRead: 80,
		cacheWrite: 10,
		totalTokens: 105,
	},
): Extract<NativeRequestEvent, { type: "attempt_settled" }> {
	return {
		type: "attempt_settled",
		attemptId,
		operationId: `operation-${attemptId}`,
		timestamp: 1,
		source: { sessionId, leafId: null, sourceSequence: 0, persistent: false },
		owner: { sessionId },
		purpose,
		purposeDetail,
		modelContract: {
			api: "openai-responses",
			provider: "openai",
			model: "test",
			profile: { id: "test", status: "unvalidated" },
			pricing: {
				status: "unvalidated",
				currency: "USD",
				unit: "million-tokens",
				catalogRates: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
			},
		},
		receipt: {
			api: "openai-responses",
			provider: "openai",
			model: "test",
			transport: "http",
			ordinal: 1,
			kind: "initial",
			attemptId,
			outcome: "completed",
			rawUsage: [{ duplicate: usage }],
			usage,
			usageCompleteness: "complete",
			timing: { queuedAt: 1, admittedAt: 1, settledAt: 2 },
		},
	};
}
function admitted(event: ReturnType<typeof settled>): NativeRequestEvent {
	const { receipt, type: _type, ...metadata } = event;
	return { ...metadata, type: "attempt_admitted", descriptor: receipt };
}
async function persist(manager: SessionManager, event: NativeRequestEvent): Promise<void> {
	const sink = manager.bindRequestSink();
	try {
		await sink.persist({ ...event, source: await sink.source, owner: { sessionId: manager.getSessionId() } });
	} finally {
		await sink.release();
	}
}
function node(ownRequestUsage?: ReturnType<RequestUsageAccumulator["finish"]>): ContextTreeNode {
	return {
		id: "root",
		label: "main agent",
		status: "active",
		ownUsage: emptyUsage(),
		totalUsage: emptyUsage(),
		children: [],
		ownRequestUsage,
	};
}

describe("existing generation receipt usage", () => {
	it("deduplicates attempts, counts all generation purposes once, and excludes token-count and foreign sources", () => {
		const reducer = new RequestUsageAccumulator("root");
		const main = settled("root", "main");
		reducer.add(admitted(main));
		reducer.add(main);
		reducer.add(main);
		reducer.add(admitted(main));
		for (const [purpose, detail] of [
			["child", undefined],
			["summary", "compaction"],
			["summary", "compaction-turn-prefix"],
			["refine", "plan"],
			["native-control", "daemon-status"],
		] as const) {
			reducer.add(settled("root", `${purpose}-${detail}`, purpose, detail));
		}
		reducer.add(settled("root", "count", "native-control", "input-token-count"));
		reducer.add(settled("foreign", "foreign"));
		const result = reducer.finish()!;
		expect(result.total).toMatchObject({
			attempts: 6,
			settledAttempts: 6,
			processedTokens: 630,
			input: 60,
			inputTotal: 600,
			output: 30,
			cacheRead: 480,
			cacheWrite: 60,
		});
		expect(result.total.catalogEstimateUsd).toBeCloseTo(6 * 0.000555);
		expect(result.byPurpose.compaction?.attempts).toBe(2);
		expect(Object.keys(result.byPurpose)).toEqual(["main", "child", "compaction", "refine", "status"]);
		const replaced = settled("root", "main", "main", undefined, {
			input: 1,
			inputTotal: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
		});
		reducer.add(replaced);
		expect(reducer.finish()?.total.processedTokens).toBe(527);
	});

	it("keeps unknown usage and pricing explicit, including incomplete and unsettled attempts", () => {
		const reducer = new RequestUsageAccumulator("root");
		const missing = settled("root", "missing", "child", undefined, {});
		reducer.add({ ...missing, receipt: { ...missing.receipt, outcome: "interrupted", usageCompleteness: "none" } });
		const partial = settled("root", "partial", "refine", undefined, { inputTotal: 100, output: 2, totalTokens: 999 });
		reducer.add({ ...partial, receipt: { ...partial.receipt, usageCompleteness: "partial" } });
		reducer.add(admitted(settled("root", "pending")));
		expect(reducer.finish()?.total).toMatchObject({
			attempts: 3,
			settledAttempts: 2,
			partialUsageAttempts: 1,
			missingUsageAttempts: 1,
			unsettledAttempts: 1,
			unpricedAttempts: 2,
			input: 0,
			inputTotal: 100,
			output: 2,
			processedTokens: 102,
			catalogEstimateUsd: 0,
		});
		const incomplete = new RequestUsageAccumulator("root");
		const first = settled("root", "retry-one", "main", undefined, { input: 10, output: 2 });
		incomplete.add({ ...first, receipt: { ...first.receipt, usageCompleteness: "partial" } });
		incomplete.add({ ...settled("root", "retry-two"), operationId: first.operationId });
		expect(incomplete.finish()?.total).toMatchObject({
			attempts: 2,
			processedTokens: 117,
			inputTotal: 110,
			partialUsageAttempts: 1,
			unpricedAttempts: 1,
		});
	});

	it("reads a fixed native frontier and never adds assistant or child attribution projections to receipts", async () => {
		const manager = await SessionManager.create(process.cwd(), tempDir());
		managers.push(manager);
		await manager.appendMessage({ role: "user", content: "work", timestamp: 0 });
		const assistantId = await manager.appendMessage({
			role: "assistant",
			content: [],
			api: "openai-responses",
			provider: "openai",
			model: "test",
			stopReason: "stop",
			timestamp: 0,
			usage: { ...emptyUsage(), input: 10000, totalTokens: 10000 },
		});
		await manager.appendChildUsageAttribution(assistantId, { ...emptyUsage(), input: 20000, totalTokens: 20000 });
		await persist(manager, settled(manager.getSessionId(), "main"));
		const entered = createDeferred();
		const gate = createDeferred();
		const original = manager.readSourceHistory.bind(manager);
		const capture = vi.spyOn(manager, "readSourceHistory").mockImplementation((read) =>
			original(async (history) => {
				entered.resolve();
				await gate.promise;
				return read(history);
			}),
		);
		const reading = readContextTreeUsage(manager);
		await entered.promise;
		await persist(manager, settled(manager.getSessionId(), "status", "native-control", "daemon-status"));
		gate.resolve();
		const usage = await reading;
		capture.mockRestore();
		expect(usage?.ownRequestUsage?.total.processedTokens).toBe(105);
		expect(usage?.totalUsage.input).toBe(30000);
		expect((await readContextTreeUsage(manager))?.ownRequestUsage?.total.processedTokens).toBe(210);
		const snapshots = vi.spyOn(manager, "materializeResidentHistory");
		await readContextTreeUsage(manager);
		expect(snapshots).not.toHaveBeenCalled();
		await manager.branchTo(null);
		const otherBranch = await readContextTreeUsage(manager);
		expect(otherBranch?.ownUsage.input).toBe(0);
		expect(otherBranch?.ownRequestUsage?.total.processedTokens).toBe(210);
	});

	it("reduces resident and disk receipts, and omits optional metadata when receipt read budgets are exceeded", async () => {
		const manager = SessionManager.inMemory();
		managers.push(manager);
		await persist(manager, settled(manager.getSessionId(), "resident", "refine", "plan"));
		expect(readResidentContextTreeUsage(manager).ownRequestUsage?.byPurpose.refine?.processedTokens).toBe(105);
		const dir = tempDir();
		const child = join(dir, "sub-child");
		mkdirSync(child);
		const header = {
			type: "session",
			version: 3,
			id: "disk",
			timestamp: new Date(0).toISOString(),
			cwd: process.cwd(),
		};
		const entries = [settled("disk", "one"), settled("disk", "two", "native-control", "daemon-status")].map(
			(request, i) => ({
				type: "request",
				id: `request-${i}`,
				parentId: null,
				timestamp: new Date(0).toISOString(),
				request,
			}),
		);
		writeFileSync(
			join(child, "disk.jsonl"),
			`${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
		);
		expect(
			(await loadContextTreeChildrenFromDisk(dir, () => undefined))[0]?.ownRequestUsage?.total.processedTokens,
		).toBe(210);
		expect(
			(await loadContextTreeChildrenFromDisk(dir, () => undefined, undefined, { maxEntries: 1 }))[0]
				?.ownRequestUsage,
		).toBeUndefined();
		const native = await SessionManager.create(process.cwd(), tempDir());
		managers.push(native);
		await persist(native, settled(native.getSessionId(), "one"));
		await persist(native, settled(native.getSessionId(), "two"));
		expect(
			(await readContextTreeUsage(native, { maxEntries: 1, maxSourceBytes: 1024 * 1024 }))?.ownRequestUsage,
		).toBeUndefined();
	});

	it("shows only receipt-based captured-family totals with unknown nodes and explicit goal/catalog scopes", () => {
		const rootReceipts = new RequestUsageAccumulator("root");
		rootReceipts.add(settled("root", "main"));
		rootReceipts.add(settled("root", "status", "native-control", "daemon-status"));
		const childReceipts = new RequestUsageAccumulator("child");
		childReceipts.add(settled("child", "child", "child"));
		const root = node(rootReceipts.finish());
		root.ownUsage.input = 999999;
		root.totalUsage.input = 99999999;
		root.children = [
			{ ...node(childReceipts.finish()), id: "sub-child", label: "child" },
			{ ...node(), id: "sub-missing", label: "missing" },
			{ ...node(childReceipts.finish()), id: "sub-alias", label: "same source" },
		];
		const output = stripAnsi(formatContextTree(root, 100));
		expect(output).toContain("Processed total: 315");
		expect(output).toContain("main: 105");
		expect(output).toContain("status: 105");
		expect(output).toContain("child: 105");
		expect(output).toContain("request usage unavailable: 1");
		expect(output).toContain("shared source (counted once)");
		expect(output).toContain("unvalidated rates, not an invoice");
		expect(output).toContain("Goal budget: root successful main uncached input + output only");
		expect(output).not.toContain("999,999");
		expect(stripAnsi(formatContextTree(node(), 100))).toContain("Legacy conversation projection");
	});

	it.each([false, true])(
		"gates optional response usage without blocking the existing command (capability=%s)",
		async (supported) => {
			const receipts = new RequestUsageAccumulator("root");
			receipts.add(settled("root", "one"));
			const tree = node(receipts.finish());
			tree.children = [node(receipts.finish())];
			const request = vi
				.fn()
				.mockResolvedValue({ type: "response", command: "get_context_tree", success: true, data: tree });
			const client = {
				onMessage: () => () => {},
				onClose: () => () => {},
				request,
				supportsServerCapability: (capability: string) => supported && capability === "context_request_usage",
			} as unknown as DaemonTransportClient;
			const connection = new DaemonAgentConnection(client, "active");
			const result = await connection.getContextTree();
			expect(request).toHaveBeenCalledWith(
				{ type: "get_context_tree", activeSessionId: "active" },
				undefined,
				undefined,
			);
			expect(Boolean(result.ownRequestUsage)).toBe(supported);
			expect(Boolean(result.children[0].ownRequestUsage)).toBe(supported);
			expect(tree.ownRequestUsage).toBeDefined();
		},
	);
});
