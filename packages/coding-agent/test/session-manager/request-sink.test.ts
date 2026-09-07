import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { BoundRequestSink, NativeRequestEvent } from "../../src/core/request-events.js";
import { loadEntriesFromFile, SessionManager } from "../../src/core/session-manager.js";

let dir: string;
let managers: SessionManager[];
let sinks: BoundRequestSink[];
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "base-context-request-sink-"));
	managers = [];
	sinks = [];
});
afterEach(async () => {
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
	const path = manager.getSessionFile()!;
	const original = await admitted(sink);
	const event = { ...original, modelContract: { ...original.modelContract, model: 'fixture\u0000é"\n' } };
	await sink.persist(event);
	expect(manager.getEntries().find((entry) => entry.type === "request")?.request).toEqual(event);
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
	await sink.release();
	const restored = await SessionManager.open(path);
	managers.push(restored);
	expect(restored.getLeafId()).toBe(leaf);
	expect(restored.getEntries().filter((entry) => entry.type === "request")).toHaveLength(2);
	expect(restored.getFlatTree().map(({ entry }) => entry.type)).not.toContain("request");
});

it("preserves ephemeral mode and blocks later appends after a failed journal write", async () => {
	const memory = SessionManager.inMemory(dir);
	managers.push(memory);
	const inMemorySink = memory.bindRequestSink();
	sinks.push(inMemorySink);
	await inMemorySink.persist(await admitted(inMemorySink));
	expect((await inMemorySink.source).persistent).toBe(false);
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
});
