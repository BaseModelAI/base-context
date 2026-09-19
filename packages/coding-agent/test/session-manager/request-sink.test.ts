import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@ponythewhite/base-context-ai";
import { afterEach, beforeEach, expect, it } from "vitest";
import { InferenceCoordinator } from "../../src/core/inference-coordinator.js";
import { COMPACTION_OUTCOME_CUSTOM_TYPE } from "../../src/core/messages.js";
import type { BoundRequestSink, NativeRequestEvent } from "../../src/core/request-events.js";
import { loadEntriesFromFile, SessionManager } from "../../src/core/session-manager.js";
import { emptyUsage } from "../../src/core/usage.js";

let dir: string;
let managers: SessionManager[];
let sinks: BoundRequestSink[];
let captures: InferenceCoordinator[];
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "base-context-request-sink-"));
	managers = [];
	sinks = [];
	captures = [];
});
afterEach(async () => {
	await Promise.all(captures.map((capture) => capture.dispose()));
	await Promise.all(sinks.map((sink) => sink.release()));
	await Promise.all(managers.map((manager) => manager.close()));
	rmSync(dir, { recursive: true, force: true });
});

async function admitted(sink: BoundRequestSink): Promise<NativeRequestEvent> {
	const source = await sink.source;
	return {
		type: "attempt_admitted",
		attemptId: "attempt",
		operationId: "operation",
		timestamp: 1,
		source,
		owner: { sessionId: source.sessionId },
		purpose: "summary",
		modelContract: {
			api: "openai-responses",
			provider: "openai",
			model: "fixture",
			profile: { id: "native", status: "unvalidated" },
			pricing: { status: "unavailable" },
		},
		descriptor: {
			api: "openai-responses",
			provider: "openai",
			model: "fixture",
			transport: "http",
			ordinal: 0,
			kind: "initial",
		},
	};
}
function settled(event: NativeRequestEvent): NativeRequestEvent {
	if (event.type !== "attempt_admitted") throw new Error("fixture expected admission");
	return {
		...event,
		type: "attempt_settled",
		timestamp: 2,
		receipt: {
			...event.descriptor,
			attemptId: event.attemptId,
			outcome: "completed",
			rawUsage: [],
			usage: {},
			usageCompleteness: "none",
			timing: { queuedAt: 1, admittedAt: 1, sentAt: 1, settledAt: 2 },
		},
	};
}

it("retains late settlement in the captured history without changing either conversation leaf", async () => {
	const manager = await SessionManager.create(dir, join(dir, "sessions"));
	managers.push(manager);
	const appended = manager.appendMessage({ role: "user", content: "original request", timestamp: 1 });
	expect(manager.getLeafId()).toBeNull();
	await appended;
	const leaf = manager.getLeafId();
	const sink = manager.bindRequestSink();
	sinks.push(sink);
	const requests = new InferenceCoordinator(() => sink);
	const capture = requests.capture();
	captures.push(capture);
	const path = manager.getSessionFile()!;
	const original = await admitted(sink);
	const event = { ...original, modelContract: { ...original.modelContract, model: 'fixture\u0000é"\n' } };
	await sink.persist(event);
	expect(await manager.readEntry(`${event.attemptId}:${event.type}`)).toMatchObject({ request: event });
	expect(manager.getLeafId()).toBe(leaf);
	await manager.newSession();
	await manager.appendSessionInfo("new history");
	const currentPath = manager.getSessionFile()!;
	const currentLeaf = manager.getLeafId();
	const currentBytes = readFileSync(currentPath);
	await sink.persist(settled(event));
	await sink.persist(settled(event));
	expect(readFileSync(currentPath)).toEqual(currentBytes);
	expect(manager.getLeafId()).toBe(currentLeaf);
	let disposal: Promise<void> | undefined;
	const readPage = await capture.readHistory(async (view) => {
		expect(view.source).toEqual(original.source);
		expect(requests.pendingCount).toBe(2); // capture plus this admitted read
		disposal = capture.dispose(); // joins this read; it does not cancel accepted recovery
		expect((await view.get(leaf!))?.locator.path).toBe(path);
		expect(await view.get(currentLeaf!)).toBeUndefined();
		expect((await view.readPayload(leaf!))?.text).toContain("original request");
		return view.page();
	});
	await disposal;
	expect(readPage.events.map((entry) => entry.id)).toEqual([leaf]);
	expect(requests.hasPending).toBe(false);
	await sink.release();
	const restored = await SessionManager.open(path);
	managers.push(restored);
	expect(restored.getLeafId()).toBe(leaf);
	expect(loadEntriesFromFile(path).filter((entry) => entry.type === "request")).toHaveLength(2);
	expect((await restored.readFlatTree()).map(({ entry }) => entry.type)).not.toContain("request");
});

it("preserves ephemeral mode and blocks later appends after a failed journal write", async () => {
	const memory = SessionManager.inMemory(dir);
	managers.push(memory);
	const inMemorySink = memory.bindRequestSink();
	sinks.push(inMemorySink);
	await inMemorySink.persist(await admitted(inMemorySink));
	expect((await inMemorySink.source).persistent).toBe(false);
	await expect(inMemorySink.readHistory(async () => undefined)).rejects.toThrow("owned canonical session");
	expect(memory.getSessionFile()).toBeUndefined();
	expect(memory.hasUserContent()).toBe(true);
	const manager = await SessionManager.create(dir, join(dir, "sessions"));
	managers.push(manager);
	const sink = manager.bindRequestSink();
	sinks.push(sink);
	const path = manager.getSessionFile()!;
	const original = await admitted(sink);
	const oversized = { ...original, modelContract: { ...original.modelContract, model: "x".repeat(1024 * 1024 + 1) } };
	const clean = readFileSync(path);
	await expect(sink.persist(oversized)).rejects.toThrow("JSON byte limit");
	expect(readFileSync(path)).toEqual(clean);
	writeFileSync(path, `${readFileSync(path, "utf8")}{"torn":`);
	const before = readFileSync(path);
	await expect(sink.persist(await admitted(sink))).rejects.toThrow("recovery is required");
	await expect(manager.appendSessionInfo("must not follow a damaged tail")).rejects.toThrow("outcome may be unknown");
	expect(readFileSync(path)).toEqual(before);
	expect(loadEntriesFromFile(path).some((entry) => entry.type === "request")).toBe(false);
	await sink.release();
	await manager.recover();
	await manager.appendSessionInfo("recovered");
	expect(manager.getSessionName()).toBe("recovered");
	expect(() => sink.retain()).toThrow("owner is closed");
	await expect(sink.readHistory(async () => undefined)).rejects.toThrow("not retained");
});

it.each(["resident", "indexed"] as const)(
	"commits captured compaction after bookkeeping appends in %s storage",
	async (storage) => {
		const manager =
			storage === "indexed" ? await SessionManager.create(dir, join(dir, "sessions")) : SessionManager.inMemory(dir);
		managers.push(manager);
		const userId = await manager.appendMessage({ role: "user", content: "Summarize this work", timestamp: 1 });
		const assistantId = await manager.appendMessage({
			...fauxAssistantMessage("Started child work"),
			usage: { ...emptyUsage(), input: 10, totalTokens: 10 },
		});
		const sink = manager.bindCompactionSink();
		sinks.push(sink);
		const source = await sink.source;
		const capturedBranch = await sink.readBranch();
		expect(sink.isCurrent()).toBe(true);
		const request = await admitted(sink);
		await sink.persist(request);

		await expect(
			manager.appendCompaction("not committed", userId, 10, undefined, false, undefined, undefined, () => {
				throw new Error("rejected before ACK");
			}),
		).rejects.toThrow("rejected before ACK");
		expect(manager.getLeafId()).toBe(source.leafId);
		await manager.appendCustomMessageEntry(COMPACTION_OUTCOME_CUSTOM_TYPE, "Previous compaction failed", true, {
			reason: "threshold",
			outcome: "failed",
		});
		expect(sink.isCurrent()).toBe(true);
		await manager.appendSessionState({ status: "active" });
		await manager.appendAgentStatus({ summary: "Waiting for child work", basedOnMessageCount: 2 });
		await manager.appendGitState({ branch: "work" });
		await sink.persist(settled(request));
		const attribution = manager.appendChildUsageAttributionWithAggregate(assistantId, {
			...emptyUsage(),
			input: 50,
			totalTokens: 50,
		});
		const compaction = sink.appendCompaction("Work summary", userId, 10);
		const [usage, compactionId] = await Promise.all([attribution, compaction]);

		expect(usage.aggregateUsage).toMatchObject({ input: 60, totalTokens: 10 });
		expect(sink.isCurrent()).toBe(true);
		expect(await sink.source).toEqual(source);
		expect(await sink.readBranch()).toEqual(capturedBranch);
		expect(await manager.readEntry(compactionId)).toMatchObject({
			type: "compaction",
			parentId: usage.entryId,
			summary: "Work summary",
		});
		expect((await manager.readBranch()).map((entry) => entry.type)).toEqual([
			"message",
			"message",
			"custom_message",
			"session_state",
			"agent_status",
			"git_state",
			"child_usage_attributed",
			"compaction",
		]);
		const restoredAssistant = await manager.readEntry(assistantId);
		expect(restoredAssistant).toMatchObject({
			type: "message",
			message: { usage: { input: 60, totalTokens: 10 } },
		});
		await manager.appendSessionState({ status: "active" });
		expect(sink.isCurrent()).toBe(true);
		await expect(sink.appendCompaction("duplicate summary", userId, 10)).rejects.toThrow(
			"Compaction source or branch changed",
		);
		await sink.release();
		await manager.appendAgentStatus({ summary: "Done", basedOnMessageCount: 2 });
		await manager.appendCustomMessageEntry(COMPACTION_OUTCOME_CUSTOM_TYPE, "Compaction skipped", true, {
			reason: "threshold",
			outcome: "skipped",
		});
		expect(sink.isCurrent()).toBe(true);
		await manager.appendMessage({ role: "user", content: "New work", timestamp: 3 });
		expect(sink.isCurrent()).toBe(false);
	},
);

it.each(["resident", "indexed"] as const)(
	"rejects real context, branch, and source changes without poisoning %s compaction writes",
	async (storage) => {
		const manager =
			storage === "indexed" ? await SessionManager.create(dir, join(dir, "sessions")) : SessionManager.inMemory(dir);
		managers.push(manager);
		const first = await manager.appendMessage({ role: "user", content: "Original work", timestamp: 1 });
		await manager.appendMessage({ role: "user", content: "More work", timestamp: 2 });
		const changes = [
			() => manager.appendMessage({ role: "user" as const, content: "New input", timestamp: 3 }),
			() => manager.appendCustomMessageEntry("context", "New context", false),
			() => manager.appendCustomEntry("goal", { active: true }),
			async () => {
				const leaf = manager.getLeafId();
				await manager.branchTo(first);
				await manager.branchTo(leaf);
			},
		];
		for (const change of changes) {
			const sink = manager.bindCompactionSink();
			sinks.push(sink);
			await sink.source;
			await change();
			expect(sink.isCurrent()).toBe(false);
			const leaf = manager.getLeafId();
			await expect(sink.appendCompaction("stale summary", first, 10)).rejects.toThrow(
				"Compaction source or branch changed",
			);
			expect(manager.getLeafId()).toBe(leaf);
			await sink.release();
			const fresh = manager.bindCompactionSink();
			sinks.push(fresh);
			await expect(fresh.appendCompaction("current summary", first, 10)).resolves.toEqual(expect.any(String));
			await fresh.release();
		}

		const oldSource = manager.bindCompactionSink();
		sinks.push(oldSource);
		await oldSource.source;
		await manager.newSession();
		expect(oldSource.isCurrent()).toBe(false);
		await expect(oldSource.appendCompaction("old session summary", first, 10)).rejects.toThrow(
			"Compaction source or branch changed",
		);
		expect(manager.getLeafId()).toBeNull();
		await expect(manager.appendMessage({ role: "user", content: "New session", timestamp: 4 })).resolves.toEqual(
			expect.any(String),
		);
	},
);
