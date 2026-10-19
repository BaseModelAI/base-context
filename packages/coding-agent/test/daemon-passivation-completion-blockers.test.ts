import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompletionBlocker } from "../src/core/completion.js";
import type { IdleEvictionMinutes } from "../src/core/session-action-store.js";
import type { ActiveSessionState } from "../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";

interface DaemonInternals {
	sessions: Map<string, ActiveSessionState>;
	listPassiveRlmSubagents(): Promise<[]>;
	passivateIdleChildren(threshold: IdleEvictionMinutes, now: number, limit: number): Promise<number>;
	log(message: string): void;
}

const directories: string[] = [];
const now = Date.parse("2036-08-01T12:00:00Z");

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "daemon-passivation-blockers-"));
	directories.push(directory);
	const daemon = new AgentDaemon(join(directory, "daemon.sock"), {
		defaultSessionConfig: { agentDir: directory, cwd: directory },
		createRuntime: vi.fn(),
	});
	const internals = daemon as unknown as DaemonInternals;
	const passiveList = vi.spyOn(internals, "listPassiveRlmSubagents").mockResolvedValue([]);
	vi.spyOn(internals, "log").mockImplementation(() => {});
	const unsubscribeChild = vi.fn();
	const makeState = (id: string, parentActiveSessionId?: string) => {
		const session = {
			sessionId: id,
			sessionFile: join(directory, `${id}.jsonl`),
			sessionName: id,
			messages: [{ role: "user", content: "Retained task report", timestamp: now - 91 * 60_000 }],
			isSessionActive: false,
			isStreaming: false,
			isCompacting: false,
			isBashRunning: false,
			hasPendingAdmissionWaiters: false,
			unfinishedActionCount: 0,
			state: { pendingToolCalls: new Set(), streamingMessage: undefined },
			sessionManager: { getCwd: () => directory },
			hasRunningRlmChildren: () => false,
			getSessionActionSnapshot: () => ({ queuedCount: 0, steering: [], followUps: [] }),
			getCompletionBlockers: vi.fn((): CompletionBlocker[] => []),
			releaseRlmChildSession: vi.fn(() => unsubscribeChild),
			abort: vi.fn(async () => {}),
		};
		const dispose = vi.fn(async () => {});
		const state: ActiveSessionState = {
			activeSessionId: id,
			clients: new Set(),
			pendingAttaches: 0,
			extensionUiRequests: new Map(),
			eventGeneration: id,
			lastEventSequence: 0,
			runtime: {
				cwd: directory,
				diagnostics: [],
				metadata: {
					kind: parentActiveSessionId ? "subagent" : "top-level",
					createdAt: 1,
					parentActiveSessionId,
					rlmChildId: parentActiveSessionId ? id : undefined,
				},
				session,
				dispose,
			} as unknown as ActiveSessionState["runtime"],
		};
		internals.sessions.set(id, state);
		return { state, session, dispose };
	};
	const parent = makeState("parent");
	const child = makeState("child", parent.state.activeSessionId);
	return { internals, passiveList, parent, child, unsubscribeChild };
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("child passivation completion blockers", () => {
	it("rechecks a parked watch before disposing a selected idle child", async () => {
		const { internals, passiveList, parent, child, unsubscribeChild } = fixture();
		passiveList
			.mockImplementationOnce(async () => [])
			.mockImplementationOnce(async () => {
				child.session.getCompletionBlockers.mockReturnValue([
					{ kind: "parked_watches", sessionId: child.session.sessionId, count: 1 },
				]);
				return [];
			});

		await expect(internals.passivateIdleChildren(90, now, 1)).resolves.toBe(0);

		expect(passiveList).toHaveBeenCalledTimes(2);
		expect(child.session.getCompletionBlockers).toHaveBeenCalledTimes(2);
		expect(child.dispose).not.toHaveBeenCalled();
		expect(child.session.abort).not.toHaveBeenCalled();
		expect(parent.session.releaseRlmChildSession).not.toHaveBeenCalled();
		expect(unsubscribeChild).not.toHaveBeenCalled();
		expect(internals.sessions.get(child.state.activeSessionId)).toBe(child.state);
	});

	it("permits ordinary timed passivation after host completion work drains", async () => {
		const { internals, parent, child, unsubscribeChild } = fixture();
		child.session.getCompletionBlockers.mockReturnValue([
			{ kind: "terminal_notices", sessionId: child.session.sessionId, count: 1 },
		]);
		await expect(internals.passivateIdleChildren(90, now, 1)).resolves.toBe(0);
		expect(child.dispose).not.toHaveBeenCalled();

		child.session.getCompletionBlockers.mockReturnValue([]);
		await expect(internals.passivateIdleChildren(90, now, 1)).resolves.toBe(1);

		expect(child.dispose).toHaveBeenCalledOnce();
		expect(parent.session.releaseRlmChildSession).toHaveBeenCalledWith("child", child.session);
		expect(unsubscribeChild).toHaveBeenCalledOnce();
		expect(internals.sessions.has(child.state.activeSessionId)).toBe(false);
		expect(internals.sessions.get(parent.state.activeSessionId)).toBe(parent.state);
		expect(child.session.messages[0]?.content).toBe("Retained task report");
	});
});
