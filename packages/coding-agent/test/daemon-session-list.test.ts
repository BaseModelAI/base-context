import { resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import type { AgentMessage } from "@ponythewhite/base-context-agent";
import { describe, expect, it } from "vitest";
import type { RlmChildAgentSnapshot } from "../src/core/agent-session.js";
import type { AgentCronJob } from "../src/core/cron-jobs.js";
import type { SessionInfo } from "../src/core/session-manager.js";
import type { SessionUsageSummary } from "../src/core/usage.js";
import type { ActiveSessionState, DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import { passivatedWorkerRosterEntry, workerRosterEntryFromSummary } from "../src/modes/daemon/agent-roster.js";
import {
	buildRlmChildSnapshots,
	buildSessionList,
	resolveAttachModelFallbackMessage,
	type SessionSummary,
	snapshotActiveSessionSummary,
	summaryForActiveSession,
} from "../src/modes/daemon/daemon-session-list.js";

describe("buildSessionList", () => {
	it("derives active session lifecycle and activity", async () => {
		const oneMessage = [{ role: "user", content: "hi" }] as unknown as AgentMessage[];
		const currentSummary = { basedOnMessageCount: 1 } as ActiveSessionState["summaryState"];
		const entries = await buildSessionList(
			[
				makeState({
					activeSessionId: "model",
					sessionFile: "/tmp/model.jsonl",
					isStreaming: true,
					messages: oneMessage,
				}),
				makeState({
					activeSessionId: "tool",
					sessionFile: "/tmp/tool.jsonl",
					isStreaming: true,
					pendingToolCalls: ["tool-1"],
					messages: oneMessage,
				}),
				makeState({
					activeSessionId: "needs-user",
					sessionFile: "/tmp/needs-user.jsonl",
					clients: 1,
					messages: oneMessage,
					summaryState: currentSummary,
				}),
				makeState({
					activeSessionId: "done",
					sessionFile: "/tmp/done.jsonl",
					messages: oneMessage,
					summaryState: currentSummary,
				}),
			],
			[],
		);

		expect(entries.map((entry) => [entry.id, entry.lifecycle, entry.activity])).toEqual([
			["model", "live", "working"],
			["tool", "live", "working"],
			["needs-user", "live", "idle"],
			["done", "live", "idle"],
		]);
	});

	it("counts direct peers separately so the supervisor can add them to its own attachment count", async () => {
		const state = makeState({ activeSessionId: "direct", sessionFile: "/tmp/direct.jsonl" });
		state.clients.add({ id: "supervisor", authenticationRole: "supervisor" } as unknown as DaemonSocketClient);
		state.clients.add({ id: "peer", authenticationRole: "session_client" } as unknown as DaemonSocketClient);

		const [summary] = await buildSessionList([state], []);

		expect(summary).toMatchObject({ attachedClients: 2, directAttachedClients: 1 });
		// Passivated roster rows describe a session without a runtime; the live-only count must not survive.
		expect(
			passivatedWorkerRosterEntry(workerRosterEntryFromSummary(summary!)).summary.directAttachedClients,
		).toBeUndefined();
	});

	it("uses the stable session header time for active rows without a saved catalog entry", async () => {
		const state = makeState({ activeSessionId: "active", sessionFile: "/tmp/active.jsonl" });
		const first = await summaryForActiveSession(state);
		const second = await summaryForActiveSession(state);
		expect(first.created).toBe("2026-05-01T00:00:00.000Z");
		expect(first.lastActivityAt).toBe("2026-05-01T00:00:00.000Z");
		expect(second.created).toBe(first.created);
	});

	it("takes last activity from custom messages and tool results", async () => {
		const oldMessage = {
			role: "user",
			content: "old",
			timestamp: Date.parse("2026-05-02T00:00:00.000Z"),
		} as AgentMessage;
		const customTimestamp = Date.parse("2026-05-03T00:00:00.000Z");
		const customMessage = {
			role: "custom",
			customType: "activity",
			content: "newer",
			display: false,
			timestamp: customTimestamp,
		} as AgentMessage;
		const toolResultTimestamp = Date.parse("2026-05-04T00:00:00.000Z");
		const toolResult = {
			role: "toolResult",
			toolCallId: "tool-1",
			toolName: "example",
			content: [],
			isError: false,
			timestamp: toolResultTimestamp,
		} as AgentMessage;

		expect(
			(
				await summaryForActiveSession(
					makeState({ activeSessionId: "custom-active", messages: [oldMessage, customMessage] }),
				)
			).lastActivityAt,
		).toBe(new Date(customTimestamp).toISOString());
		expect(
			(
				await summaryForActiveSession(
					makeState({ activeSessionId: "tool-active", messages: [oldMessage, toolResult] }),
				)
			).lastActivityAt,
		).toBe(new Date(toolResultTimestamp).toISOString());
	});

	it("ignores message timestamps outside the valid Date range", async () => {
		const validTimestamp = Date.parse("2026-05-04T00:00:00.000Z");
		const messages = [
			{ role: "user", content: "valid", timestamp: validTimestamp },
			{ role: "assistant", content: "corrupt", timestamp: 8.64e15 + 1 },
		] as AgentMessage[];

		const summary = await summaryForActiveSession(makeState({ activeSessionId: "invalid-timestamp", messages }));

		expect(summary.lastActivityAt).toBe(new Date(validTimestamp).toISOString());
	});

	it("publishes own-session usage on active and saved rows", async () => {
		const usage: SessionUsageSummary = { inputTokens: 12437, outputTokens: 1234, cost: 0.42 };
		const usageRead = deferredUsage();
		const state = makeState({
			activeSessionId: "spender",
			usage,
			messages: [{ role: "user", content: "before usage", timestamp: Date.parse("2026-05-03T00:00:00.000Z") }],
			summaryState: { summary: "Before usage", taskState: "completed", basedOnMessageCount: 1 },
		});
		let usageStarted = false;
		state.runtime.session.getOwnUsageSummary = async () => {
			usageStarted = true;
			return usageRead.promise;
		};
		const metadata = snapshotActiveSessionSummary(state);
		expect(usageStarted).toBe(false);
		expect(metadata.sessionId).toBe("session-spender");
		expect(metadata.usage).toBeUndefined();
		const pending = buildSessionList(
			[state],
			[makeSessionInfo({ id: "saved-spender", path: "/tmp/saved-spender.jsonl", usage })],
		);
		expect(usageStarted).toBe(true);
		Object.assign(state.runtime.session, {
			sessionId: "changed-session",
			sessionName: "changed name",
			isStreaming: true,
			isSessionActive: true,
			unfinishedActionCount: 2,
			messages: [],
			getSessionActionSnapshot: () => ({ queuedCount: 2, steering: [], followUps: [] }),
		});
		state.clients.add({ id: "late-client", authenticationRole: "session_client" } as unknown as DaemonSocketClient);
		state.summaryState = undefined;
		usageRead.resolve(usage);
		const [saved, active] = await pending;
		expect(active?.usage).toEqual(usage);
		expect(saved?.usage).toEqual(usage);
		expect([saved?.id, active?.id]).toEqual(["saved-spender", "spender"]);
		expect(active).toMatchObject({
			sessionId: "session-spender",
			sessionName: "session spender",
			lifecycle: "live",
			activity: "idle",
			isStreaming: false,
			isSessionActive: false,
			attachedClients: 0,
			messageCount: 1,
			unfinishedActionCount: 0,
			sessionActions: { queuedCount: 0, steering: [], followUps: [] },
			firstMessage: "before usage",
			lastActivityAt: "2026-05-03T00:00:00.000Z",
			summary: "Before usage",
			taskState: "completed",
		});
		expect(active?.directAttachedClients).toBeUndefined();
		expect(Object.getPrototypeOf(active)).toBe(Object.prototype);
		expect(Object.getPrototypeOf(active?.usage)).toBe(Object.prototype);
		expect(JSON.parse(JSON.stringify(active)).usage).toEqual(usage);
	});

	it("keeps background subagents on the wire while the settled parent goes idle", async () => {
		const oneMessage = [{ role: "user", content: "hi" }] as unknown as AgentMessage[];
		const entries = await buildSessionList(
			[
				makeState({
					activeSessionId: "parent",
					sessionFile: "/tmp/parent.jsonl",
					isStreaming: false,
					hasRunningRlmChildren: true,
					messages: oneMessage,
					summaryState: { basedOnMessageCount: 1 } as ActiveSessionState["summaryState"],
				}),
			],
			[],
		);
		expect(entries[0]?.activity).toBe("idle");
		expect(entries[0]?.hasRunningRlmChildren).toBe(true);
	});

	it("marks sessions with active standard or RLM heartbeats", async () => {
		const messages = [{ role: "user", content: "hi" }] as unknown as AgentMessage[];
		const summaryState = { basedOnMessageCount: 1 } as ActiveSessionState["summaryState"];
		const activeSessionIds = ["heartbeat", "rlm-heartbeat", "paused-heartbeat", "cron"];
		const entries = await buildSessionList(
			activeSessionIds.map((activeSessionId) => makeState({ activeSessionId, messages, summaryState })),
			[makeSessionInfo({ id: "passive", path: "/tmp/passive.jsonl" })],
			[
				makeCronJob({ id: "heartbeat-job", activeSessionId: "heartbeat", source: "heartbeat" }),
				makeCronJob({ id: "rlm-job", activeSessionId: "rlm-heartbeat", source: "rlm_heartbeat" }),
				makeCronJob({
					id: "paused-job",
					activeSessionId: "paused-heartbeat",
					source: "heartbeat",
					status: "paused",
				}),
				makeCronJob({ id: "cron-job", activeSessionId: "cron", source: "cron" }),
				makeCronJob({
					id: "passive-job",
					activeSessionId: "old-passive-active-id",
					sessionFile: "/tmp/passive.jsonl",
					source: "rlm_heartbeat",
				}),
			],
		);

		expect(Object.fromEntries(entries.map((entry) => [entry.id, entry.hasActiveHeartbeat]))).toEqual({
			heartbeat: true,
			"rlm-heartbeat": true,
			"paused-heartbeat": undefined,
			cron: undefined,
			passive: undefined,
		});
		expect(Object.fromEntries(entries.map((entry) => [entry.id, entry.hasRegisteredHeartbeat]))).toEqual({
			heartbeat: true,
			"rlm-heartbeat": true,
			"paused-heartbeat": undefined,
			cron: undefined,
			passive: true,
		});
		expect(Object.fromEntries(entries.map((entry) => [entry.id, entry.hasRegisteredCronJob]))).toEqual({
			heartbeat: undefined,
			"rlm-heartbeat": undefined,
			"paused-heartbeat": undefined,
			cron: true,
			passive: undefined,
		});
	});

	it("keeps file-keyed schedule pins on active rows while active ids are being rebound", async () => {
		const sessionFile = "/tmp/child.jsonl";
		const [entry] = await buildSessionList(
			[makeState({ activeSessionId: "new-active-id", sessionFile })],
			[makeSessionInfo({ id: "child-session", path: sessionFile })],
			[
				makeCronJob({
					id: "stale-heartbeat",
					activeSessionId: "old-active-id",
					sessionFile,
					source: "heartbeat",
				}),
				makeCronJob({
					id: "stale-cron",
					activeSessionId: "old-active-id",
					sessionFile,
					source: "cron",
				}),
			],
		);

		expect(entry).toMatchObject({ hasRegisteredHeartbeat: true, hasRegisteredCronJob: true });
	});

	it("reports accepted in-flight prompts as active with no queued work", async () => {
		const oneMessage = [{ role: "user", content: "hi" }] as unknown as AgentMessage[];
		const summary = await summaryForActiveSession(
			makeState({
				activeSessionId: "accepted",
				messages: oneMessage,
				summaryState: { basedOnMessageCount: 1 } as ActiveSessionState["summaryState"],
				hasAcceptedPromptInFlight: true,
			}),
		);

		expect(summary.sessionActions).toMatchObject({ queuedCount: 0, active: { kind: "turn", phase: "running" } });
		expect(summary.activity).toBe("working");
	});

	it("reports the exact unfinished action count independently of the visible action snapshot", async () => {
		const summary = await summaryForActiveSession(
			makeState({
				activeSessionId: "batched",
				unfinishedActionCount: 3,
				hasAcceptedPromptInFlight: true,
			}),
		);

		expect(summary.sessionActions).toMatchObject({ queuedCount: 0, active: { kind: "turn" } });
		expect(summary.unfinishedActionCount).toBe(3);
		expect(summary.activity).toBe("working");
	});

	it("marks an empty resident session idle instead of holding it at working", async () => {
		const summary = await summaryForActiveSession(makeState({ activeSessionId: "empty" }));
		expect(summary.activity).toBe("idle");
	});

	it("marks a finished subagent idle instead of holding it at working", async () => {
		const oneMessage = [{ role: "user", content: "hi" }] as unknown as AgentMessage[];
		const entries = await buildSessionList(
			[
				makeState({
					activeSessionId: "child",
					sessionFile: "/tmp/child.jsonl",
					isStreaming: false,
					hasRunningRlmChildren: false,
					messages: oneMessage,
					// No current summary verdict — a resident finished subagent never gets one.
					metadata: { kind: "subagent", createdAt: 1, parentActiveSessionId: "parent", rlmChildId: "c1" },
				}),
			],
			[],
		);
		expect(entries[0]?.activity).toBe("idle");
	});

	it("marks a retained completed subagent with an active RLM heartbeat", async () => {
		const messages = [{ role: "user", content: "initialize a heartbeat" }] as unknown as AgentMessage[];
		const entries = await buildSessionList(
			[
				makeState({
					activeSessionId: "parent",
					sessionId: "parent-session",
					messages,
				}),
				makeState({
					activeSessionId: "child",
					sessionId: "child-session",
					sessionFile: "/tmp/child.jsonl",
					messages,
					metadata: {
						kind: "subagent",
						createdAt: 1,
						parentActiveSessionId: "parent",
						parentSessionId: "parent-session",
						rlmChildId: "child-1",
					},
				}),
			],
			[],
			[makeCronJob({ id: "rlm-job", activeSessionId: "child", source: "rlm_heartbeat" })],
		);

		expect(entries.find((entry) => entry.id === "child")).toMatchObject({
			runtimeKind: "subagent",
			activity: "idle",
			hasActiveHeartbeat: true,
		});
	});

	it("merges active records with saved sessions and marks inactive sessions", async () => {
		const activePath = resolve("/tmp/project/active.jsonl");
		const sleepingPath = resolve("/tmp/project/sleeping.jsonl");
		const crashedPath = resolve("/tmp/project/crashed.jsonl");
		const savedSessions = [
			makeSessionInfo({ path: activePath, id: "saved-active", name: "active saved" }),
			makeSessionInfo({
				path: sleepingPath,
				id: "saved-sleeping",
				name: "sleeping saved",
				state: { status: "archived" },
			}),
			makeSessionInfo({ path: crashedPath, id: "saved-crashed", state: { status: "crash" } }),
		];

		const entries = await buildSessionList(
			[
				makeState({
					activeSessionId: "active-1",
					sessionFile: activePath,
					sessionId: "saved-active",
					messages: [{ role: "user", content: "hi" }] as unknown as AgentMessage[],
					summaryState: { basedOnMessageCount: 1 } as ActiveSessionState["summaryState"],
				}),
			],
			savedSessions,
		);

		expect(entries).toHaveLength(3);
		expect(entries.map((entry) => [entry.id, entry.sessionId, entry.lifecycle, entry.activity])).toEqual([
			["active-1", "saved-active", "live", "idle"],
			["saved-sleeping", "saved-sleeping", "archived", "idle"],
			["saved-crashed", "saved-crashed", "archived", "idle"],
		]);
		expect(entries[0]!.sessionName).toBe("session active-1");

		const firstError = new Error("first usage read failed");
		const secondError = new Error("second usage read failed");
		const usageReads = [deferredUsage(), deferredUsage(), deferredUsage()];
		const started: string[] = [];
		const states = usageReads.map((usageRead, index) => {
			const activeSessionId = `active-${index + 1}`;
			const state = makeState({ activeSessionId, sessionFile: index === 0 ? activePath : undefined });
			state.runtime.session.getOwnUsageSummary = async () => {
				started.push(activeSessionId);
				return usageRead.promise;
			};
			return state;
		});
		let settled = false;
		const failure = buildSessionList(states, savedSessions).then(
			() => {
				settled = true;
			},
			(error: unknown) => {
				settled = true;
				return error;
			},
		);
		expect(started).toEqual(["active-1", "active-2", "active-3"]);
		usageReads[0]!.reject(firstError);
		usageReads[2]!.reject(secondError);
		await setImmediate();
		expect(settled).toBe(false);
		usageReads[1]!.reject(firstError);
		const error = await failure;
		expect(error).toBeInstanceOf(AggregateError);
		expect((error as AggregateError).errors).toEqual([firstError, secondError]);
		expect((error as AggregateError).cause).toBe(firstError);
	});

	it("keeps a resident message-less subagent live while a top-level one stays a draft", async () => {
		const entries = await buildSessionList(
			[
				makeState({
					activeSessionId: "child",
					metadata: { kind: "subagent", createdAt: 1, rlmChildId: "child-1" },
				}),
				makeState({ activeSessionId: "top" }),
			],
			[],
		);

		expect(entries.map((entry) => [entry.id, entry.lifecycle])).toEqual([
			["child", "live"],
			["top", "draft"],
		]);
	});

	it("treats a message-less on-disk active session as a hidden draft", async () => {
		const emptyPath = resolve("/tmp/project/empty.jsonl");
		const usedPath = resolve("/tmp/project/used.jsonl");
		const entries = await buildSessionList(
			[],
			[
				// Active record, no messages: a draft, hidden from the view (lifecycle is
				// message-based; any config it holds is still preserved on disk).
				makeSessionInfo({
					path: emptyPath,
					id: "empty",
					messageCount: 0,
					name: "named draft",
					state: { status: "active" },
				}),
				// Active record with a message: a real conversation, stays live.
				makeSessionInfo({
					path: usedPath,
					id: "used",
					messageCount: 1,
					state: { status: "active" },
				}),
			],
		);
		expect(entries.map((entry) => [entry.id, entry.lifecycle])).toEqual([
			["empty", "draft"],
			["used", "live"],
		]);
	});

	it("shows an off-daemon session with messages but no lifecycle entry as live", async () => {
		// Older sessions never wrote a session_state entry; a missing state must not
		// be treated as archived, or those conversations vanish from the view.
		const [entry] = await buildSessionList(
			[],
			[
				makeSessionInfo({
					path: resolve("/tmp/project/legacy.jsonl"),
					id: "legacy",
					messageCount: 4,
					state: undefined,
				}),
			],
		);
		expect(entry?.lifecycle).toBe("live");
	});

	it("carries the persisted recap and verdict for off-daemon sessions", async () => {
		const path = resolve("/tmp/project/done.jsonl");
		const [entry] = await buildSessionList(
			[],
			[
				makeSessionInfo({
					path,
					id: "done",
					messageCount: 3,
					state: { status: "active" },
					agentStatus: { summary: "Shipped the fix", taskState: "completed", basedOnMessageCount: 3 },
				}),
			],
		);
		expect(entry).toMatchObject({ summary: "Shipped the fix", taskState: "completed" });
	});

	it("drops a stale persisted verdict when later messages outpaced it", async () => {
		const path = resolve("/tmp/project/stale.jsonl");
		const [entry] = await buildSessionList(
			[],
			[
				makeSessionInfo({
					path,
					id: "stale",
					messageCount: 5,
					state: { status: "active" },
					// Verdict was based on an earlier turn (3 < 5), so it must not show.
					agentStatus: { summary: "Old recap", taskState: "completed", basedOnMessageCount: 3 },
				}),
			],
		);
		expect(entry?.summary).toBeUndefined();
		expect(entry?.taskState).toBeUndefined();
	});

	it("includes active subagent parent metadata", async () => {
		const entries = await buildSessionList(
			[
				makeState({ activeSessionId: "parent", sessionFile: "/tmp/parent.jsonl", sessionId: "parent-session" }),
				makeState({
					activeSessionId: "child",
					sessionFile: "/tmp/child.jsonl",
					sessionId: "child-session",
					metadata: {
						kind: "subagent",
						createdAt: 1,
						parentActiveSessionId: "parent",
						parentSessionId: "parent-session",
						parentSessionFile: "/tmp/parent.jsonl",
						rlmChildId: "rlm-child",
						rlmParentNodeId: "rlm-child",
						prompt: "Audit the   retry\nlogic for races",
					},
				}),
			],
			[],
		);

		expect(entries.find((entry) => entry.id === "child")).toMatchObject({
			runtimeKind: "subagent",
			parentActiveSessionId: "parent",
			parentSessionId: "parent-session",
			parentSessionPath: "/tmp/parent.jsonl",
			rlmChildId: "rlm-child",
			rlmParentNodeId: "rlm-child",
			// The spawn prompt doubles as the subagent's display title.
			firstMessage: "Audit the retry logic for races",
		});
	});

	it("uses runtime depth for live rows and catalog depth for saved-only rows", async () => {
		const livePath = resolve("/tmp/project/live-depth.jsonl");
		const savedPath = resolve("/tmp/project/saved-depth.jsonl");
		const entries = await buildSessionList(
			[makeState({ activeSessionId: "live", sessionFile: livePath, rlmDepth: 2 })],
			[
				makeSessionInfo({ path: livePath, id: "live", rlmDepth: 99 }),
				makeSessionInfo({ path: savedPath, id: "saved", rlmDepth: 3 }),
			],
		);

		expect(entries.find((entry) => entry.activeSessionId === "live")?.rlmDepth).toBe(2);
		expect(entries.find((entry) => entry.sessionFile === savedPath)?.rlmDepth).toBe(3);
	});
});

describe("summaryForActiveSession recap currency", () => {
	const twoMessages = [
		{ role: "user", content: "hi" },
		{ role: "assistant", content: "ok" },
	] as AgentMessage[];

	it("surfaces both recap and verdict while the summary matches the turn", async () => {
		const summary = await summaryForActiveSession(
			makeState({
				activeSessionId: "s1",
				messages: twoMessages,
				summaryState: { summary: "Editing the router", taskState: "completed", basedOnMessageCount: 2 },
			}),
		);
		expect(summary.summary).toBe("Editing the router");
		expect(summary.taskState).toBe("completed");
	});

	it("keeps showing the prior recap once a new turn outpaces the summary", async () => {
		// New messages arrived (count 3) but the summary is still based on 2; the
		// recap text must survive so the agents view does not flicker to blank.
		const summary = await summaryForActiveSession(
			makeState({
				activeSessionId: "s1",
				messages: [...twoMessages, { role: "user", content: "next" } as AgentMessage],
				summaryState: { summary: "Editing the router", taskState: "completed", basedOnMessageCount: 2 },
			}),
		);
		expect(summary.summary).toBe("Editing the router");
		// ...but a stale "completed" verdict must not show on a turn that is active again.
		expect(summary.taskState).toBeUndefined();
	});

	it("omits the recap entirely when there is no summary yet", async () => {
		const summary = await summaryForActiveSession(makeState({ activeSessionId: "s1", messages: twoMessages }));
		expect(summary.summary).toBeUndefined();
		expect(summary.taskState).toBeUndefined();
	});
});

describe("buildRlmChildSnapshots", () => {
	it("uses the AgentSession projection and adds resident active session ids", () => {
		const queued = {
			id: "sub-queued",
			label: "Queued task",
			status: "queued" as const,
			sessionDir: "/tmp/artifacts/sub-queued",
		};
		const executing = {
			id: "sub-running",
			label: "Running task",
			status: "running" as const,
			sessionDir: "/tmp/artifacts/sub-running",
			activity: { kind: "executing" as const, toolName: "ipython" },
		};
		const parent = makeState({
			activeSessionId: "parent",
			childSnapshots: [queued, executing],
		});
		const residentChild = makeState({
			activeSessionId: "running-child",
			metadata: {
				kind: "subagent",
				createdAt: 1,
				parentActiveSessionId: "parent",
				rlmChildId: "sub-running",
			},
		});

		expect(buildRlmChildSnapshots("parent", [parent, residentChild])).toEqual([
			{ ...queued, activeSessionId: undefined },
			{ ...executing, activeSessionId: "running-child" },
		]);
	});

	it("returns no snapshots when the root is not resident", () => {
		expect(buildRlmChildSnapshots("missing", [])).toEqual([]);
	});
});

describe("resolveAttachModelFallbackMessage", () => {
	const startupMessage = "No models available. Use /login...";

	function makeSummary(overrides: Partial<SessionSummary>): SessionSummary {
		return {
			id: "active-1",
			lifecycle: "draft",
			activity: "idle",
			sessionId: "session-1",
			cwd: "/tmp/project",
			isStreaming: false,
			isCompacting: false,
			attachedClients: 0,
			messageCount: 0,
			sessionActions: { queuedCount: 0, steering: [], followUps: [] },
			...overrides,
			isSessionActive: overrides.isSessionActive ?? false,
		};
	}

	it("prefers the daemon's own fallback message", () => {
		const summary = makeSummary({ modelFallbackMessage: "Could not restore model a/b. Using c/d" });

		expect(resolveAttachModelFallbackMessage(summary, startupMessage)).toBe("Could not restore model a/b. Using c/d");
	});

	it("ignores the attaching process's snapshot when the session has a model", () => {
		const summary = makeSummary({ model: { provider: "prime-inference", id: "gpt-5.5" } as SessionSummary["model"] });

		expect(resolveAttachModelFallbackMessage(summary, startupMessage)).toBeUndefined();
	});

	it("falls back to the attaching process's snapshot when the session has no model", () => {
		expect(resolveAttachModelFallbackMessage(makeSummary({}), startupMessage)).toBe(startupMessage);
	});
});

function deferredUsage() {
	let resolve!: (usage: SessionUsageSummary | undefined) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<SessionUsageSummary | undefined>((onResolve, onReject) => {
		resolve = onResolve;
		reject = onReject;
	});
	return { promise, resolve, reject };
}

interface StateOptions {
	activeSessionId: string;
	model?: { provider: string; id: string };
	sessionFile?: string;
	sessionId?: string;
	isStreaming?: boolean;
	pendingToolCalls?: string[];
	clients?: number;
	messages?: AgentMessage[];
	hasUserContent?: boolean;
	summaryState?: ActiveSessionState["summaryState"];
	usage?: SessionUsageSummary;
	hasRunningRlmChildren?: boolean;
	hasAcceptedPromptInFlight?: boolean;
	unfinishedActionCount?: number;
	contextTokens?: number;
	streamingMessage?: AgentMessage;
	childSnapshots?: RlmChildAgentSnapshot[];
	rlmDepth?: number;
	metadata?: {
		kind: "top-level" | "subagent";
		createdAt: number;
		parentActiveSessionId?: string;
		parentSessionId?: string;
		parentSessionFile?: string;
		rlmChildId?: string;
		rlmParentNodeId?: string;
		prompt?: string;
		sessionDir?: string;
	};
}

function makeState(options: StateOptions): ActiveSessionState {
	const clients = new Set<DaemonSocketClient>();
	for (let index = 0; index < (options.clients ?? 0); index++) {
		clients.add({ id: `client-${index}` } as unknown as DaemonSocketClient);
	}

	return {
		activeSessionId: options.activeSessionId,
		clients,
		lastEventSequence: 0,
		summaryState: options.summaryState,
		runtime: {
			metadata: options.metadata ?? { kind: "top-level", createdAt: 1 },
			diagnostics: [],
			session: {
				model: options.model,
				thinkingLevel: "off",
				isStreaming: options.isStreaming ?? false,
				isCompacting: false,
				sessionFile: options.sessionFile,
				sessionId: options.sessionId ?? `session-${options.activeSessionId}`,
				rlmDepth: options.rlmDepth ?? 0,
				sessionName: `session ${options.activeSessionId}`,
				sessionManager: {
					getCwd: () => "/tmp/project",
					getHeader: () => ({ timestamp: "2026-05-01T00:00:00.000Z" }),
					getSessionDir: () => "/tmp/sessions",
					hasUserContent: () => options.hasUserContent ?? false,
				},
				messages: options.messages ?? ([] as AgentMessage[]),
				getRlmChildSnapshots: () => options.childSnapshots ?? [],
				getOwnUsageSummary: async () => options.usage,
				hasRunningRlmChildren: () => options.hasRunningRlmChildren ?? false,
				hasAcceptedPromptInFlight: options.hasAcceptedPromptInFlight ?? false,
				unfinishedActionCount: options.unfinishedActionCount ?? (options.hasAcceptedPromptInFlight ? 1 : 0),
				isSessionActive: options.isStreaming === true || options.hasAcceptedPromptInFlight === true,
				getCurrentRecap: () => undefined,
				_contextTokensForCurrentMessages: () => options.contextTokens,
				getSessionActionSnapshot: () => ({
					queuedCount: 0,
					steering: [],
					followUps: [],
					...(options.hasAcceptedPromptInFlight
						? { active: { kind: "turn" as const, phase: "running" as const } }
						: {}),
				}),
				state: {
					streamingMessage: options.streamingMessage,
					pendingToolCalls: new Set(options.pendingToolCalls ?? []),
				},
			},
		},
	} as unknown as ActiveSessionState;
}

function makeSessionInfo(overrides: Pick<SessionInfo, "path" | "id"> & Partial<SessionInfo>): SessionInfo {
	return {
		path: overrides.path,
		id: overrides.id,
		cwd: "/tmp/project",
		name: overrides.name,
		state: overrides.state,
		parentSessionPath: overrides.parentSessionPath,
		rlmDepth: overrides.rlmDepth ?? 0,
		created: new Date("2026-05-01T00:00:00.000Z"),
		modified: new Date("2026-05-02T00:00:00.000Z"),
		messageCount: overrides.messageCount ?? 2,
		firstMessage: "hello",
		allMessagesText: "hello world",
		agentStatus: overrides.agentStatus,
		usage: overrides.usage,
	};
}

function makeCronJob(overrides: Pick<AgentCronJob, "id" | "activeSessionId"> & Partial<AgentCronJob>): AgentCronJob {
	return {
		id: overrides.id,
		status: overrides.status ?? "active",
		source: overrides.source,
		activeSessionId: overrides.activeSessionId,
		sessionId: `session-${overrides.activeSessionId}`,
		sessionFile: overrides.sessionFile ?? `/tmp/${overrides.activeSessionId}.jsonl`,
		cwd: "/tmp/project",
		prompt: "Check for follow-up work",
		schedule: { kind: "interval", expression: "every 5m", intervalMs: 300_000 },
		createdAt: "2026-05-01T00:00:00.000Z",
		updatedAt: "2026-05-01T00:00:00.000Z",
		nextRunAt: "2026-05-01T00:05:00.000Z",
		runCount: 0,
	};
}
