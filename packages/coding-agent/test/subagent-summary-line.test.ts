import { Container, setKeybindings } from "@ponythewhite/base-context-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { emptyGoalState, type GoalState } from "../src/core/goals.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type {
	AgentConnectionEventListener,
	AgentConnectionRlmChildAgentSnapshot,
	AgentConnectionSnapshot,
	AgentConnectionState,
} from "../src/modes/agent-connection/types.js";
import { isDirectAgentChild } from "../src/modes/agents-view/agents-view-state.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { AgentActivityTracker } from "../src/modes/interactive/agent-activity.js";
import {
	countDirectSubagentStatuses,
	countRosterSubagentStatuses,
	SubagentSummaryLine,
} from "../src/modes/interactive/components/subagent-summary-line.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";

function child(
	id: string,
	status: AgentConnectionRlmChildAgentSnapshot["status"],
	overrides: Partial<AgentConnectionRlmChildAgentSnapshot> = {},
): AgentConnectionRlmChildAgentSnapshot {
	return { id, label: id, status, sessionDir: `/tmp/${id}`, ...overrides };
}

describe("SubagentSummaryLine", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("renders nothing without children and a bordered agents tile with counts otherwise", () => {
		const line = new SubagentSummaryLine();
		expect(line.render(120)).toEqual([]);

		line.setSubagentCounts({ total: 1, running: 1, idle: 0, inactive: 0 });
		let rendered = line.render(120).map(stripAnsi);
		expect(rendered).toHaveLength(3);
		expect(rendered[0]).toContain("╭─ subagents ─");
		expect(rendered[1]).toContain("● 1 running   ◐ 0 idle   ○ 0 inactive");

		line.setSubagentCounts({ total: 2, running: 1, idle: 1, inactive: 0 });
		rendered = line.render(120).map(stripAnsi);
		expect(rendered[1]).toContain("● 1 running   ◐ 1 idle   ○ 0 inactive");
	});

	it("hints ↓ select when unfocused and Enter/→ open when focused", () => {
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 1, running: 1, idle: 0, inactive: 0 });
		line.setOpenable(true);

		expect(stripAnsi(line.render(120)[1])).toContain("↓ select");

		line.focused = true;
		const focused = stripAnsi(line.render(120)[1]);
		expect(focused).toContain("open");
		expect(focused).not.toContain("↓ select");
	});

	it("keeps the selection background across truncation resets when focused", () => {
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 3, running: 1, idle: 1, inactive: 1 });
		line.setOpenable(true);
		line.focused = true;
		// Narrow enough that the colored counts truncate and inject a full reset.
		const content = line.render(20)[1];
		expect(content).toContain("\x1b[0m");
		for (const segment of content.split("\x1b[0m").slice(1, -1)) {
			expect(segment.startsWith("\x1b[4") || segment.startsWith("\x1b[10")).toBe(true);
		}
	});

	it("never emits lines wider than the allocated width", () => {
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 3, running: 1, idle: 1, inactive: 1 });
		line.setOpenable(true);
		for (const width of [120, 40, 24, 12, 6, 3, 2, 1]) {
			for (const rendered of line.render(width).map(stripAnsi)) {
				expect(rendered.length).toBeLessThanOrEqual(width);
			}
		}
	});

	it("counts only direct children using running, idle, and inactive status projections", () => {
		const children = [
			child("running", "running"),
			child("queued", "queued"),
			child("active", "done", { activity: { kind: "writing" } }),
			child("heartbeat", "done", { activeSessionId: "heartbeat-session" }),
			child("idle-done", "done", { activeSessionId: "idle-done-session" }),
			child("idle-error", "error", { activeSessionId: "idle-error-session" }),
			child("inactive-done", "done"),
			child("inactive-error", "error"),
			child("cancelled", "cancelled"),
			child("grandchild", "running", { parentId: "running" }),
		];

		expect(countDirectSubagentStatuses(children, undefined)).toEqual({
			total: 8,
			running: 3,
			idle: 3,
			inactive: 2,
		});
	});

	it("opens on Enter or Right only when the daemon-backed line is selectable", () => {
		const line = new SubagentSummaryLine();
		const onOpen = vi.fn();
		line.onOpen = onOpen;
		line.setSubagentCounts({ total: 2, running: 0, idle: 2, inactive: 0 });
		line.setOpenable(true);

		line.handleInput("\r");
		line.handleInput("\x1b[C");

		expect(onOpen).toHaveBeenCalledTimes(2);
	});

	it("stays visible but non-selectable for an in-process connection", () => {
		const line = new SubagentSummaryLine();
		const onOpen = vi.fn();
		line.onOpen = onOpen;
		line.setSubagentCounts({ total: 1, running: 0, idle: 0, inactive: 1 });
		line.setOpenable(false);

		expect(stripAnsi(line.render(100).join("\n"))).toContain("● 0 running   ◐ 0 idle   ○ 1 inactive");
		expect(line.isSelectable()).toBe(false);
		line.handleInput("\r");
		expect(onOpen).not.toHaveBeenCalled();
	});

	it("updates the rendered counts from consecutive child-status events", () => {
		const line = new SubagentSummaryLine();
		line.setOpenable(true);
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			subagentSnapshots: new Map<string, AgentConnectionRlmChildAgentSnapshot>(),
			rlmNodeId: undefined,
			heartbeatCatalog: [],
			subagentSummaryLine: line,
			updateWorkingPulse: vi.fn(),
			syncWorkingLoader: vi.fn(),
			updateWorkingLoaderMessage: vi.fn(),
			ui: { requestRender: vi.fn() },
		});
		const update = Reflect.get(InteractiveMode.prototype, "updateSubagentSummary") as (
			this: typeof mode,
			value: AgentConnectionRlmChildAgentSnapshot,
		) => void;

		update.call(mode, child("worker", "running"));
		expect(stripAnsi(line.render(100).join("\n"))).toContain("● 1 running   ◐ 0 idle   ○ 0 inactive");

		update.call(mode, child("worker", "done", { activeSessionId: "active-worker" }));
		expect(stripAnsi(line.render(100).join("\n"))).toContain("● 0 running   ◐ 1 idle   ○ 0 inactive");
	});

	it("counts a retained completed child as running while a follow-up turn is active", () => {
		const line = new SubagentSummaryLine();
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			subagentSnapshots: new Map<string, AgentConnectionRlmChildAgentSnapshot>(),
			rlmNodeId: undefined,
			heartbeatCatalog: [],
			subagentSummaryLine: line,
			updateWorkingPulse: vi.fn(),
			syncWorkingLoader: vi.fn(),
			updateWorkingLoaderMessage: vi.fn(),
			ui: { requestRender: vi.fn() },
		});
		const update = Reflect.get(InteractiveMode.prototype, "updateSubagentSummary") as (
			this: typeof mode,
			value: AgentConnectionRlmChildAgentSnapshot,
		) => void;

		update.call(mode, child("worker", "done", { activeSessionId: "resident-worker" }));
		expect(stripAnsi(line.render(100).join("\n"))).toContain("● 0 running   ◐ 1 idle   ○ 0 inactive");

		update.call(mode, child("worker", "done", { activeSessionId: "resident-worker", activity: { kind: "waiting" } }));
		expect(stripAnsi(line.render(100).join("\n"))).toContain("● 1 running   ◐ 0 idle   ○ 0 inactive");

		update.call(mode, child("worker", "done", { activeSessionId: "resident-worker" }));
		expect(stripAnsi(line.render(100).join("\n"))).toContain("● 0 running   ◐ 1 idle   ○ 0 inactive");
	});

	it("refreshes counts when startup seeding follows an early live child update", () => {
		const line = new SubagentSummaryLine();
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			subagentSnapshots: new Map<string, AgentConnectionRlmChildAgentSnapshot>(),
			rlmNodeId: undefined,
			heartbeatCatalog: [],
			subagentSummaryLine: line,
			updateWorkingPulse: vi.fn(),
			syncWorkingLoader: vi.fn(),
			updateWorkingLoaderMessage: vi.fn(),
			ui: { requestRender: vi.fn() },
		});
		const worker = child("worker", "done", { parentId: "me" });
		const update = Reflect.get(InteractiveMode.prototype, "updateSubagentSummary") as (
			this: typeof mode,
			value: AgentConnectionRlmChildAgentSnapshot,
		) => void;
		const seed = Reflect.get(InteractiveMode.prototype, "seedSubagentSummary") as (
			this: typeof mode,
			children: readonly AgentConnectionRlmChildAgentSnapshot[],
		) => void;

		update.call(mode, worker);
		expect(line.render(100)).toEqual([]);
		Reflect.set(mode, "rlmNodeId", "me");
		seed.call(mode, [worker]);

		expect(stripAnsi(line.render(100).join("\n"))).toContain("╭─ subagents ─");
	});

	it("clears a resident session id when a terminal update reports an evicted child", () => {
		const line = new SubagentSummaryLine();
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			subagentSnapshots: new Map<string, AgentConnectionRlmChildAgentSnapshot>(),
			rlmNodeId: undefined,
			heartbeatCatalog: [],
			subagentSummaryLine: line,
			updateWorkingPulse: vi.fn(),
			syncWorkingLoader: vi.fn(),
			updateWorkingLoaderMessage: vi.fn(),
			ui: { requestRender: vi.fn() },
		});
		const update = Reflect.get(InteractiveMode.prototype, "updateSubagentSummary") as (
			this: typeof mode,
			value: AgentConnectionRlmChildAgentSnapshot,
		) => void;

		update.call(mode, child("worker", "running", { activeSessionId: "resident-worker" }));
		// Active partial updates retain the last known resident id.
		update.call(mode, child("worker", "running"));
		update.call(mode, child("worker", "done"));

		expect(stripAnsi(line.render(100).join("\n"))).toContain("● 0 running   ◐ 0 idle   ○ 1 inactive");
	});

	it("removes a run on the producer's cancelled signal and keeps transcript-backed rows through repeated dones", () => {
		const line = new SubagentSummaryLine();
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			subagentSnapshots: new Map<string, AgentConnectionRlmChildAgentSnapshot>(),
			rlmNodeId: undefined,
			heartbeatCatalog: [],
			subagentSummaryLine: line,
			updateWorkingPulse: vi.fn(),
			syncWorkingLoader: vi.fn(),
			updateWorkingLoaderMessage: vi.fn(),
			ui: { requestRender: vi.fn() },
		});
		const update = Reflect.get(InteractiveMode.prototype, "updateSubagentSummary") as (
			this: typeof mode,
			value: AgentConnectionRlmChildAgentSnapshot,
		) => void;
		const snapshots = Reflect.get(mode, "subagentSnapshots") as Map<string, AgentConnectionRlmChildAgentSnapshot>;

		// A pre-bind failure arrives as cancelled: the queued row goes, never an inactive phantom.
		update.call(mode, child("never-bound", "queued"));
		update.call(mode, child("never-bound", "cancelled", { error: "boom" }));
		expect(snapshots.has("never-bound")).toBe(false);

		update.call(mode, child("worker", "running", { activeSessionId: "resident-worker" }));
		update.call(mode, child("worker", "done"));
		update.call(mode, child("worker", "done"));
		expect(snapshots.has("worker")).toBe(true);
		expect(stripAnsi(line.render(100).join("\n"))).toContain("● 0 running   ◐ 0 idle   ○ 1 inactive");
	});

	it("counts parentSessionId-only roster children exactly like the agents view", () => {
		const rosterChild = {
			id: "c1",
			sessionId: "c1",
			lifecycle: "live",
			runtimeKind: "subagent",
			rlmChildId: "c1",
			parentSessionId: "root-session",
			rosterStatus: "idle",
		} as SessionSummary;
		expect(isDirectAgentChild(rosterChild, { sessionId: "root-session" })).toBe(true);
		expect(countRosterSubagentStatuses([rosterChild], { sessionId: "root-session" })).toEqual({
			total: 1,
			running: 0,
			idle: 1,
			inactive: 0,
		});
	});

	it("keeps chat alive with the snapshot-fed bar when the roster subscribe fails", async () => {
		const line = new SubagentSummaryLine();
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			agentConnection: {
				subscribeAgentRoster: vi.fn(async () => {
					throw new Error("Daemon is stale");
				}),
			},
			subagentSnapshots: new Map<string, AgentConnectionRlmChildAgentSnapshot>(),
			rlmNodeId: undefined,
			heartbeatCatalog: [],
			subagentSummaryLine: line,
			connectionState: undefined,
			scheduleHeartbeatManagerRefresh: vi.fn(),
			updateWorkingPulse: vi.fn(),
			syncWorkingLoader: vi.fn(),
			updateWorkingLoaderMessage: vi.fn(),
			ui: { requestRender: vi.fn() },
		});
		const subscribe = Reflect.get(InteractiveMode.prototype, "subscribeToRosterBar") as (
			this: typeof mode,
		) => Promise<void>;

		await expect(subscribe.call(mode)).resolves.toBeUndefined();
		expect(Reflect.get(mode, "rosterBar")).toBeUndefined();
	});

	type GoalTrayHarness = {
		agentConnection: { getInitialSnapshot(): Promise<AgentConnectionSnapshot> };
		connectionState: AgentConnectionState;
		getTrayContextLabel(): string | undefined;
		subscribeToAgent(): void;
		renderInitialMessages(): Promise<void>;
		stopGoalTrayTimer(): void;
		stopWorkingPulse(): void;
	};

	function createGoalTrayHarness() {
		const mode = Object.create(InteractiveMode.prototype) as GoalTrayHarness;
		const line = new SubagentSummaryLine(
			() => "model",
			() => mode.getTrayContextLabel(),
		);
		const showError = vi.fn();
		let listener: AgentConnectionEventListener | undefined;
		const state: AgentConnectionState = {
			cwd: "/tmp/project",
			thinkingLevel: "medium",
			serviceTier: "default",
			availableThinkingLevels: ["medium"],
			isStreaming: false,
			isCompacting: false,
			isBashRunning: false,
			retryAttempt: 0,
			steeringMode: "all",
			followUpMode: "all",
			sessionId: "goal-tray-session",
			leafId: null,
			autoCompactionEnabled: true,
			messageCount: 1,
			sessionActions: { queuedCount: 0, steering: [], followUps: [] },
			compactionCount: 0,
			goal: emptyGoalState(),
			scopedModels: [],
			activeToolNames: [],
			contextUsage: undefined,
		};
		const goal: GoalState = {
			...emptyGoalState(),
			active: true,
			status: "active",
			goalId: "goal-tray-1",
			objective: "finish the offline fixture",
			timeUsedSeconds: 65,
		};
		Object.assign(mode, {
			connectionState: state,
			isInitialized: true,
			workingVisible: true,
			sessionEventQueue: Promise.resolve(),
			sessionEventGeneration: 0,
			agentConnection: {
				subscribe: (next: AgentConnectionEventListener) => {
					listener = next;
					return () => {};
				},
				getInitialSnapshot: async () => ({ state: { ...state, goal }, messages: [] }),
			},
			subagentSummaryLine: line,
			subagentSnapshots: new Map<string, AgentConnectionRlmChildAgentSnapshot>(),
			heartbeatCatalog: [],
			activityTracker: new AgentActivityTracker(),
			chatContainer: new Container(),
			footer: { invalidate: vi.fn(), setAutoCompactEnabled: vi.fn() },
			ui: { requestRender: vi.fn(), terminal: { columns: 217 } },
			bindPromptStashSession: vi.fn(),
			scheduleHeartbeatManagerRefresh: vi.fn(),
			renderRecap: vi.fn(),
			renderSessionContext: vi.fn(async () => {}),
			showError,
		});
		return { mode, line, goal, showError, getListener: () => listener };
	}

	it("renders an active goal delivered through the interactive event subscription", async () => {
		const { mode, line, goal, showError, getListener } = createGoalTrayHarness();
		mode.connectionState.isStreaming = true;
		try {
			mode.subscribeToAgent();
			const listener = getListener();
			expect(listener).toBeDefined();
			await listener!({ type: "session_event", event: { type: "goal_update", goal } });

			expect(showError).not.toHaveBeenCalled();
			expect(mode.connectionState.goal).toEqual(goal);
			const rendered = stripAnsi(line.render(217).join("\n"));
			expect(rendered).toContain("Pursuing goal (1m 05s)");
			expect(rendered).not.toContain(goal.objective);
		} finally {
			mode.stopGoalTrayTimer();
			mode.stopWorkingPulse();
		}
	});

	it("renders an initially active goal from the attach snapshot without a live goal event", async () => {
		const { mode, line, goal, showError } = createGoalTrayHarness();
		try {
			await mode.renderInitialMessages();

			expect(showError).not.toHaveBeenCalled();
			expect(mode.connectionState.goal).toEqual(goal);
			const rendered = stripAnsi(line.render(217).join("\n"));
			expect(rendered).toContain("Pursuing goal (1m 05s)");
			expect(rendered).not.toContain(goal.objective);
		} finally {
			mode.stopGoalTrayTimer();
			mode.stopWorkingPulse();
		}
	});

	it("keeps an errored goal visible after attach, ordinary renders, and a post-compaction resync", async () => {
		const { mode, line, goal, showError, getListener } = createGoalTrayHarness();
		const erroredGoal: GoalState = { ...goal, active: false, status: "error", lastError: "Request failed" };
		const snapshot: AgentConnectionSnapshot = {
			state: { ...mode.connectionState, goal: erroredGoal },
			messages: [],
		};
		vi.spyOn(mode.agentConnection, "getInitialSnapshot").mockResolvedValue(snapshot);
		Object.assign(mode, {
			refreshCommandCatalogForCurrentSession: vi.fn(async () => {}),
			refreshQueueSelectionFromState: vi.fn(),
			updatePendingMessagesDisplay: vi.fn(),
			updateTerminalTitle: vi.fn(),
		});
		try {
			await mode.renderInitialMessages();
			for (let render = 0; render < 2; render++) {
				const rendered = line.render(217).join("\n");
				expect(rendered).toContain(theme.fg("error", "Goal error"));
				expect(stripAnsi(rendered)).not.toContain("Pursuing goal");
			}

			mode.subscribeToAgent();
			await getListener()!({
				type: "session_resynced",
				snapshot: {
					...snapshot,
					state: {
						...snapshot.state,
						compactionCount: 1,
						contextUsage: { tokens: null, percent: null, contextWindow: 100_000 },
					},
				},
			});

			expect(showError).not.toHaveBeenCalled();
			expect(stripAnsi(line.render(217).join("\n"))).toMatch(/Goal error\s*$/);
			expect(mode.connectionState.goal).toEqual(erroredGoal);
			expect(Reflect.get(mode, "goalTrayTimer")).toBeUndefined();
		} finally {
			mode.stopGoalTrayTimer();
			mode.stopWorkingPulse();
		}
	});

	it("hides a live goal error only when the goal is explicitly cleared", async () => {
		const { mode, line, goal, showError, getListener } = createGoalTrayHarness();
		const erroredGoal: GoalState = { ...goal, active: false, status: "error", lastError: "Request failed" };
		try {
			mode.subscribeToAgent();
			await getListener()!({ type: "session_event", event: { type: "goal_update", goal: erroredGoal } });
			expect(stripAnsi(line.render(217).join("\n"))).toContain("Goal error");

			await getListener()!({ type: "session_event", event: { type: "goal_update", goal: emptyGoalState() } });

			expect(showError).not.toHaveBeenCalled();
			expect(mode.getTrayContextLabel()).toBeUndefined();
			expect(stripAnsi(line.render(217).join("\n"))).not.toContain("Goal error");
			expect(mode.connectionState.goal).toEqual(emptyGoalState());
		} finally {
			mode.stopGoalTrayTimer();
			mode.stopWorkingPulse();
		}
	});

	it.each([false, true])("keeps a live goal update over an older pending snapshot (cleared=%s)", async (cleared) => {
		const { mode, line, goal, showError, getListener } = createGoalTrayHarness();
		mode.connectionState.goal = cleared ? goal : emptyGoalState();
		const olderSnapshot: AgentConnectionSnapshot = {
			state: structuredClone(mode.connectionState),
			messages: [],
		};
		let finishSnapshot!: (snapshot: AgentConnectionSnapshot) => void;
		const pendingSnapshot = new Promise<AgentConnectionSnapshot>((resolve) => {
			finishSnapshot = resolve;
		});
		vi.spyOn(mode.agentConnection, "getInitialSnapshot").mockReturnValue(pendingSnapshot);
		const updatedGoal = cleared ? emptyGoalState() : goal;
		try {
			mode.subscribeToAgent();
			const rendering = mode.renderInitialMessages();
			await getListener()!({ type: "session_event", event: { type: "goal_update", goal: updatedGoal } });
			finishSnapshot(olderSnapshot);
			await rendering;

			expect(showError).not.toHaveBeenCalled();
			const rendered = stripAnsi(line.render(217).join("\n"));
			if (cleared) expect(rendered).not.toContain("Pursuing goal");
			else expect(rendered).toContain("Pursuing goal (1m 05s)");
			expect(mode.connectionState.goal).toEqual(updatedGoal);
		} finally {
			mode.stopGoalTrayTimer();
			mode.stopWorkingPulse();
		}
	});

	it("turns a selection into the scoped agents-view run result", async () => {
		const returnToAgentsView = vi.fn(async () => undefined);
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			editor: { getText: () => "" },
			options: { returnToAgentsView: true },
			returnToAgentsView,
		});
		const open = Reflect.get(InteractiveMode.prototype, "openScopedAgentsView") as (
			this: typeof mode,
		) => Promise<void>;
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 1, running: 1, idle: 0, inactive: 0 });
		line.setOpenable(true);
		line.onOpen = () => void open.call(mode);

		line.handleInput("\r");
		await vi.waitFor(() => expect(returnToAgentsView).toHaveBeenCalledWith("scoped_agents_view"));
	});
});
