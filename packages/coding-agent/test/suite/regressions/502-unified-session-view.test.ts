import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { AgentConnectionSavedSessionInfo } from "../../../src/modes/agent-connection/types.js";
import { AgentsViewMode, type AgentsViewPersistentState } from "../../../src/modes/agents-view/agents-view-mode.js";
import type { AgentsViewRow } from "../../../src/modes/agents-view/agents-view-state.js";
import type { DaemonSavedSessionInfo } from "../../../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../../../src/modes/daemon/daemon-session-list.js";
import type { SavedSessionPage } from "../../../src/modes/daemon/saved-session-page.js";
import { initTheme } from "../../../src/modes/interactive/theme/theme.js";
import { createDeferred as deferred } from "../scheduling.js";

function summary(id: string): SessionSummary {
	return {
		id,
		activeSessionId: id,
		sessionId: `session-${id}`,
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		cwd: "/tmp/project",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
	};
}

function rawSavedSession(id: string): DaemonSavedSessionInfo {
	return {
		path: `/tmp/${id}.jsonl`,
		id,
		cwd: "/tmp/project",
		state: { status: "archived" },
		created: new Date(0).toISOString(),
		modified: new Date(0).toISOString(),
		messageCount: 1,
		firstMessage: id,
		allMessagesText: id,
	};
}

function savedSession(id: string): AgentConnectionSavedSessionInfo {
	return { ...rawSavedSession(id), created: new Date(0), modified: new Date(0) };
}

function savedPage(id: string): { success: true; data: SavedSessionPage } {
	const session = rawSavedSession(id);
	return {
		success: true,
		data: {
			status: "page",
			sessions: [session],
			primary: [`file:${session.path}`],
			sourceOrder: [{ path: session.path, source: "catalog", ordinal: 0 }],
			moreBefore: false,
			moreAfter: false,
			limited: true,
			hints: {
				liveMatches: [],
				liveEnrichment: [],
				busyAncestors: [],
				moreChildren: [],
				allChildren: [],
				groups: [],
			},
		},
	};
}

function refreshHarness() {
	const persistentState: AgentsViewPersistentState = {};
	const fields = {
		reconnectPromise: undefined as Promise<void> | undefined,
		daemonShutdownReceived: false,
		options: {},
		savedCatalogGeneration: 0,
		heartbeatCatalogGeneration: 0,
		savedCatalogRefreshPending: false,
		savedSearchFetchStarted: false,
		savedCatalogReady: false,
		savedPage: undefined as AgentsViewPersistentState["savedPage"],
		savedSessions: [] as AgentConnectionSavedSessionInfo[],
		lastSuccessfulSavedSessions: [] as AgentConnectionSavedSessionInfo[],
		heartbeats: [] as unknown[],
		lastListedSummaries: [] as SessionSummary[],
		inactiveAgentIdentities: new Set<string>(),
		expandedSubagentParents: new Set<string>(),
		programShownParents: new Set<string>(),
		rows: [] as AgentsViewRow[],
		selectedIndex: 0,
		persistentState,
		editor: { getText: () => "" },
		ui: { requestRender: vi.fn() },
		getSavedSessionCatalogContext: () => ({ cwd: "/tmp/project" }),
		applySessionList: vi.fn(
			privateMethod<(sessions: SessionSummary[], successful?: boolean) => void>("applySessionList"),
		),
		reconcileCatalogs: vi.fn(privateMethod<() => void>("reconcileCatalogs")),
		resolveMissingSelectionAnchor: vi.fn(privateMethod<() => void>("resolveMissingSelectionAnchor")),
		setStatusMessage: vi.fn(),
	};
	const harness = Object.assign(Object.create(AgentsViewMode.prototype) as typeof fields, fields);
	persistentState.savedPageKey = privateMethod<() => { key: string }>("savedPageRequest").call(harness).key;
	return harness;
}

function privateMethod<T>(name: string): T {
	const member = Reflect.get(AgentsViewMode.prototype, name) as T;
	if (typeof member !== "function") {
		throw new Error(`AgentsViewMode.${name} no longer exists; update this regression harness`);
	}
	return member;
}

describe("#502 unified session view regressions", () => {
	beforeAll(() => initTheme("dark"));
	test("an older overlapping heartbeat poll cannot overwrite the newer response", async () => {
		const old = deferred<unknown>();
		const newer = { job: { id: "new" } };
		const client = {
			isConnected: true,
			hello: { protocol: { version: 3 } },
			supportsServerCapability: () => true,
			request: vi
				.fn()
				.mockReturnValueOnce(old.promise)
				.mockResolvedValueOnce({ success: true, data: { heartbeats: [newer] } }),
		};
		const harness = Object.assign(refreshHarness(), { client, requireClient: () => client });
		const refresh = privateMethod<(this: typeof harness) => Promise<unknown>>("refreshHeartbeats");

		const oldPoll = refresh.call(harness);
		await refresh.call(harness);
		old.resolve({ success: true, data: { heartbeats: [{ job: { id: "old" } }] } });
		await oldPoll;

		expect(harness.heartbeats).toEqual([newer]);
		expect(harness.reconcileCatalogs).toHaveBeenCalledOnce();
	});

	test("overlapping saved pages release stale rows and expose the newest refusal", async () => {
		const previous = [savedSession("previous")];
		const older = deferred<ReturnType<typeof savedPage>>();
		const client = {
			request: vi.fn().mockReturnValueOnce(older.promise).mockRejectedValueOnce(new Error("scan failed")),
		};
		const harness = Object.assign(refreshHarness(), {
			client,
			savedSessions: previous,
			lastSuccessfulSavedSessions: previous,
			requireClient: () => client,
		});
		harness.persistentState.savedSessions = previous;
		const refresh = privateMethod<(this: typeof harness) => Promise<boolean>>("refreshSavedSessions");

		const oldScan = refresh.call(harness);
		await Promise.resolve();
		expect(client.request).toHaveBeenCalledOnce();
		const latest = refresh.call(harness);
		expect(latest).toBe(oldScan);
		expect(harness.savedSessions).toEqual([]);
		older.resolve(savedPage("stale"));
		expect(await latest).toBe(false);

		expect(client.request).toHaveBeenCalledTimes(2);
		expect([harness.savedSessions, harness.persistentState.savedSessions]).toEqual([[], []]);
		expect(harness.savedPage).toMatchObject({ status: "refused", message: "scan failed" });
		expect(harness.savedCatalogRefreshPending).toBe(false);
	});

	test("reconnect retries the saved page and fences a stale startup request", async () => {
		const startup = deferred<ReturnType<typeof savedPage>>();
		const retried = deferred<ReturnType<typeof savedPage>>();
		const retryStarted = deferred<void>();
		const client = {
			request: vi
				.fn()
				.mockReturnValueOnce(startup.promise)
				.mockImplementationOnce(() => {
					retryStarted.resolve();
					return retried.promise;
				}),
		};
		const harness = Object.assign(refreshHarness(), { client, requireClient: () => client });
		const refresh =
			privateMethod<
				(
					this: typeof harness,
					options?: { duringReconnect?: boolean; preserveStatusOnError?: boolean },
				) => Promise<boolean>
			>("refreshSavedSessions");

		const startupScan = refresh.call(harness);
		await Promise.resolve();
		harness.reconnectPromise = Promise.resolve();
		const retry = refresh.call(harness, { duringReconnect: true, preserveStatusOnError: true });
		expect(retry).toBe(startupScan);
		expect(harness.savedCatalogGeneration).toBe(2);
		expect(harness.persistentState.savedCatalogGeneration).toBe(2);

		startup.resolve(savedPage("stale"));
		await retryStarted.promise;
		expect(harness.savedSessions).toEqual([]);
		retried.resolve(savedPage("retried"));
		expect(await retry).toBe(true);
		expect(harness.savedSessions).toEqual([expect.objectContaining({ path: "/tmp/retried.jsonl" })]);
		expect(harness.rows.filter((row) => row.selectable).map((row) => row.summary.sessionId)).toEqual(["retried"]);
	});

	test("a refused saved page during reconnect preserves status without retaining stale rows", async () => {
		const previous = [savedSession("previous")];
		const client = {
			request: vi.fn(async () => ({
				success: true,
				data: { status: "refused", reason: "busy", message: "retry failed" },
			})),
		};
		const harness = Object.assign(refreshHarness(), {
			client,
			reconnectPromise: Promise.resolve(),
			savedSessions: previous,
			lastSuccessfulSavedSessions: previous,
			requireClient: () => client,
		});
		harness.persistentState.savedSessions = previous;

		const refreshed = await privateMethod<
			(
				this: typeof harness,
				options: { duringReconnect: boolean; preserveStatusOnError: boolean },
			) => Promise<boolean>
		>("refreshSavedSessions").call(harness, { duringReconnect: true, preserveStatusOnError: false });

		expect(refreshed).toBe(false);
		expect(harness.savedSessions).toEqual([]);
		expect(harness.persistentState.savedSessions).toEqual([]);
		expect(harness.savedPage).toEqual({ status: "refused", reason: "busy", message: "retry failed" });
		expect(harness.setStatusMessage).not.toHaveBeenCalled();
	});

	test("reconnect stays active until the heartbeat catalog refresh succeeds", async () => {
		vi.useFakeTimers();
		try {
			const firstHeartbeatAttempt = deferred<void>();
			let heartbeatAttempts = 0;
			const client = {
				hello: { protocol: { version: 3 } },
				supportsServerCapability: () => true,
				reconnect: vi.fn(async () => {}),
				request: vi.fn(async (command: { type: string }) => {
					if (command.type === "list") return { success: true, data: { sessions: [summary("live")] } };
					heartbeatAttempts += 1;
					if (heartbeatAttempts === 1) {
						firstHeartbeatAttempt.resolve();
						throw new Error("heartbeat connection lost");
					}
					return { success: true, data: { heartbeats: [{ job: { id: "healthy" } }] } };
				}),
			};
			const harness = Object.assign(refreshHarness(), {
				stopped: false,
				reconnectTimedOut: false,
				client,
				options: { reconnectTimeoutMs: 10_000 },
				requireClient: () => client,
				rosterStore: { attach: vi.fn(async () => true), summaries: () => [summary("live")] },
				refreshSavedSessions: vi.fn(async () => true),
				refreshHeartbeats: vi.fn(async (_options?: { duringReconnect?: boolean }) => false),
				armSavedSearchFetch: vi.fn(),
				reconnectClient: vi.fn(async (_reconnectingClient: typeof client, _error: unknown) => {}),
			});
			const refreshHeartbeats =
				privateMethod<(this: typeof harness, options?: { duringReconnect?: boolean }) => Promise<boolean>>(
					"refreshHeartbeats",
				);
			const reconnectClient =
				privateMethod<(this: typeof harness, reconnectingClient: typeof client, error: unknown) => Promise<void>>(
					"reconnectClient",
				);
			harness.refreshHeartbeats.mockImplementation((options) => refreshHeartbeats.call(harness, options));
			harness.reconnectClient.mockImplementation((reconnectingClient, error) =>
				reconnectClient.call(harness, reconnectingClient, error),
			);

			privateMethod<(this: typeof harness, reconnectingClient: typeof client, error: unknown) => void>(
				"startClientReconnect",
			).call(harness, client, new Error("disconnected"));
			await firstHeartbeatAttempt.promise;
			await Promise.resolve();

			expect(harness.reconnectPromise).toBeDefined();
			expect(harness.applySessionList).not.toHaveBeenCalled();
			expect(harness.setStatusMessage).not.toHaveBeenCalledWith("Daemon reconnected", { render: false });
			expect(client.reconnect).toHaveBeenCalledOnce();

			await vi.advanceTimersByTimeAsync(1_000);
			await harness.reconnectPromise;

			expect(client.reconnect).toHaveBeenCalledTimes(2);
			expect(harness.applySessionList).toHaveBeenCalledWith([summary("live")], true);
			expect(harness.heartbeats).toEqual([{ job: { id: "healthy" } }]);
			// A query that outlived the outage re-fetches the saved catalog through the one arm predicate.
			expect(harness.armSavedSearchFetch).toHaveBeenCalledWith({ duringReconnect: true });
			expect(harness.reconnectPromise).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	test("a pending saved scan cannot overwrite daemon shutdown status", async () => {
		const scan = deferred<void>();
		const scanStarted = deferred<void>();
		const client = {
			request: async () => {
				scanStarted.resolve();
				await scan.promise;
				throw new Error("scan failed");
			},
		};
		const harness = Object.assign(refreshHarness(), {
			client,
			savedSessions: [],
			lastSuccessfulSavedSessions: [],
			requireClient: () => client,
			getSavedSessionCatalogContext: () => ({ cwd: "/tmp/project" }),
		});

		const pending = privateMethod<(this: typeof harness) => Promise<boolean>>("refreshSavedSessions").call(harness);
		await scanStarted.promise;
		privateMethod<(this: typeof harness, client: unknown, error: Error) => void>("handleDaemonShutdown").call(
			harness,
			client,
			new Error("shutdown"),
		);
		expect(harness.setStatusMessage).toHaveBeenCalledOnce();
		const shutdownStatus = harness.setStatusMessage.mock.calls[0];
		scan.resolve();
		expect(await pending).toBe(false);
		expect(harness.setStatusMessage.mock.calls).toEqual([shutdownStatus]);
	});

	test("a missing selection anchor blocks open only until both catalogs settle", () => {
		const finish = vi.fn();
		const fallback = summary("fallback");
		const harness = {
			selectionAnchorPending: true,
			savedCatalogRefreshPending: true,
			selectedIndex: 0,
			selectedActiveSessionId: undefined as string | undefined,
			selectedRowIdentity: "identity-intended",
			rows: [{ selectable: true, kind: "agent", summary: fallback }],
			isPendingDeleteRow: () => false,
			setStatusMessage: vi.fn(),
			finish,
		};

		privateMethod<(this: typeof harness) => void>("openSelected").call(harness);
		expect(finish).not.toHaveBeenCalled();
		privateMethod<(this: typeof harness) => void>("resolveMissingSelectionAnchor").call(harness);
		expect(harness.selectionAnchorPending).toBe(true);
		harness.savedCatalogRefreshPending = false;
		privateMethod<(this: typeof harness) => void>("resolveMissingSelectionAnchor").call(harness);
		// Open unblocks on the visible fallback row...
		expect(harness.selectionAnchorPending).toBe(false);
		expect(harness.selectedActiveSessionId).toBe(fallback.activeSessionId ?? fallback.id);
		// ...but the restored anchor identity survives so a late poll can still re-anchor.
		expect(harness.selectedRowIdentity).toBe("identity-intended");
	});
	test("rename uses the captured row after refresh removes it", async () => {
		const captured = summary("captured");
		const request = vi.fn(async () => ({ success: true, data: {} }));
		const harness = {
			renameTarget: { activeSessionId: captured.activeSessionId, summary: captured },
			rows: [],
			exitRenameMode: vi.fn(),
			setStatusMessage: vi.fn(),
			refreshSessions: vi.fn(async () => true),
			requireClient: () => ({ request }),
			renameSession: Reflect.get(AgentsViewMode.prototype, "renameSession"),
		};

		await privateMethod<(this: typeof harness, value: string) => Promise<void>>("confirmRename").call(
			harness,
			"Renamed",
		);

		expect(request).toHaveBeenCalledWith({
			type: "rename",
			activeSessionId: captured.activeSessionId,
			name: "Renamed",
		});
	});

	test("saved-only delete confirmation remains in the inactive catalog", () => {
		const savedOnly = { ...summary("saved"), lifecycle: "archived" as const, activeSessionId: undefined };
		const harness = {
			pendingDeleteAgent: { identity: "saved", summary: savedOnly, stopped: false },
			isDeleteConfirmationVisible: () => true,
		};

		expect(
			privateMethod<(this: typeof harness, sessions: SessionSummary[]) => SessionSummary[]>(
				"withPendingDeleteSession",
			).call(harness, []),
		).toEqual([]);
	});

	test.each([
		{ mode: "search", prompt: ["prompt top", "prompt input", "prompt bottom"] },
		{ mode: "reply", prompt: ["prompt top", "reply header", "reply gap", "prompt input", "prompt bottom"] },
	])("short content reserves the $mode editor and a session row ahead of startup chrome", ({ prompt }) => {
		const renderSessionRows = vi.fn(() => ["session row"]);
		const harness = {
			splash: { render: () => Array.from({ length: 8 }, () => "splash") },
			renderStartupNotices: () => Array.from({ length: 8 }, () => "notice"),
			renderPrompt: () => prompt,
			renderSessionRows,
			savedPageNotice: privateMethod<() => string>("savedPageNotice"),
		};
		const height = prompt.length + 2;

		const lines = privateMethod<(this: typeof harness, width: number, height: number) => string[]>(
			"renderContent",
		).call(harness, 80, height);

		expect(lines).toHaveLength(height);
		expect(lines).toEqual(expect.arrayContaining([...prompt, "session row"]));
		expect(renderSessionRows).toHaveBeenCalledWith(80, 1);
	});

	test.each(["reply", "rename"] as const)("%s refresh keeps the captured search filter", (mode) => {
		const harness = {
			replyTarget: mode === "reply" ? { key: "active", summary: {} } : undefined,
			renameTarget: mode === "rename" ? { identity: "target" } : undefined,
			actionModeSearchQuery: "needle",
			savedPageHints: privateMethod<() => undefined>("savedPageHints"),
			editor: { getText: () => "action editor text" },
			scopedRecords: [
				{ identity: "match", identityAliases: [], section: "idle", searchableText: "needle session" },
				{ identity: "other", identityAliases: [], section: "idle", searchableText: "other session" },
			],
		};

		const filtered =
			privateMethod<(this: typeof harness) => Array<{ identity: string }>>("getFilteredRecords").call(harness);
		expect(filtered.map((record) => record.identity)).toEqual(["match"]);
	});

	test("inactive rows give usage and age their full responsive cell", () => {
		const inactive = {
			kind: "agent" as const,
			section: "inactive" as const,
			summary: {
				...summary("archived"),
				activeSessionId: undefined,
				lifecycle: "archived" as const,
				messageCount: 123456,
				modified: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
			},
			title: "archived",
			subtitle: "",
			statusLabel: "inactive",
			depth: 0,
			selectable: true,
			runningSubagentCount: 0,
			recursiveCost: 0,
			descendantCount: 0,
			identity: "archived",
		};
		const harness = {
			rows: [inactive],
			selectedIndex: 0,
			isPendingDeleteRow: () => false,
			isPendingKillSubagentRow: () => false,
			getRowIcon: () => "x",
			formatRowIcon: (_section: string, icon: string) => icon,
		};

		const rendered = stripAnsi(
			privateMethod<(this: typeof harness, row: typeof inactive, width: number) => string>("renderRow").call(
				harness,
				inactive,
				50,
			),
		);
		expect(rendered).toMatch(/↑0\s+↓0 ·\s+\$0\.00 ·\s+0 ·\s+\$0\.00 ·\s+2h\s*$/);
	});

	test("scoped subagent rows keep model and effort ahead of summaries", () => {
		initTheme("dark");
		const subagent = {
			// Direct children in a scoped Agents View render as agent rows while
			// retaining their persisted subagent runtime kind.
			kind: "agent" as const,
			section: "idle" as const,
			summary: {
				...summary("effort-child"),
				runtimeKind: "subagent" as const,
				summary: "Investigate a variable background status that can be truncated",
				model: { provider: "openai", id: "gpt-5.6-terra" } as SessionSummary["model"],
				thinkingLevel: "high" as SessionSummary["thinkingLevel"],
			} as SessionSummary,
			title: "Inspect agents view",
			subtitle: "",
			statusLabel: "idle",
			depth: 1,
			selectable: true,
			runningSubagentCount: 0,
			recursiveCost: 0,
			descendantCount: 0,
			identity: "effort-child",
			parentIdentity: "parent",
		};
		const harness = {
			rows: [subagent],
			selectedIndex: -1,
			isPendingDeleteRow: () => false,
			isPendingKillSubagentRow: () => false,
			getRowIcon: () => "·",
			formatRowIcon: (_section: string, icon: string) => icon,
		};
		const render = (width: number) =>
			stripAnsi(
				privateMethod<(this: typeof harness, row: typeof subagent, width: number) => string>("renderRow").call(
					harness,
					subagent,
					width,
				),
			);

		const full = render(160);
		expect(full).toContain(
			"Inspect agents view · openai/gpt-5.6-terra:high · Investigate a variable background status",
		);
		const narrow = render(100);
		expect(narrow).toContain("openai/gpt-5.6-terra:high");
		expect(narrow).not.toContain("Investigate a variable background status");

		subagent.summary.summary = "";
		expect(render(100)).toContain("Inspect agents view · openai/gpt-5.6-terra:high");

		// Older daemons identify subagents through persisted linkage instead of runtimeKind.
		subagent.summary.runtimeKind = undefined;
		subagent.summary.rlmChildId = "effort-child";
		expect(render(100)).toContain("Inspect agents view · openai/gpt-5.6-terra:high");

		subagent.summary.thinkingLevel = "off";
		subagent.summary.summary = "A later summary";
		expect(render(120)).toContain("Inspect agents view · openai/gpt-5.6-terra · A later summary");
		expect(render(120)).not.toContain(":off");

		expect(render(20)).toHaveLength(20);
	});
});
