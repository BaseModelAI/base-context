import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@ponythewhite/base-context-agent";
import { fauxAssistantMessage } from "@ponythewhite/base-context-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.js";
import * as autonomous from "../../src/core/autonomous.js";
import type { HostRequestHandlers } from "../../src/core/kernel/index.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { createHarness, type Harness } from "./harness.js";

const sessions: Harness[] = [];

async function create(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
	const harness = await createHarness(options);
	sessions.push(harness);
	return harness;
}

function hostHandlers(session: AgentSession): HostRequestHandlers {
	const createHandlers = Reflect.get(session, "_createKernelHostHandlers") as () => HostRequestHandlers;
	return createHandlers.call(session);
}

async function continuation(harness: Harness): Promise<AgentMessage[]> {
	Reflect.set(harness.session, "_goalContinuationHasProgress", true);
	const getMessages = Reflect.get(harness.session, "_getGoalContinuationMessages") as (context: {
		message: unknown;
		context: unknown;
	}) => Promise<AgentMessage[]>;
	return getMessages.call(harness.session, {
		message: fauxAssistantMessage("Required input unavailable. I cannot proceed."),
		context: { messages: [] },
	});
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const harness of sessions.splice(0).reverse()) await harness.cleanup();
});

describe("explicit continuation holds", () => {
	it("persists a kernel-created hold through reopen and ordinary user input", async () => {
		const harness = await create({ persistSession: true });
		harness.setResponses([fauxAssistantMessage("Prepared.")]);
		await harness.session.prompt("Prepare.");
		const handlers = hostHandlers(harness.session);
		const blocked = {
			status: "blocked_external",
			hold: { kind: "external_blocker", reason: "required input unavailable" },
		};
		expect(await handlers.continuation_block({ reason: "required input unavailable" })).toEqual(blocked);
		expect(await handlers.continuation_status({})).toEqual(blocked);
		const file = harness.sessionManager.getSessionFile();
		expect(file).toBeDefined();
		await harness.session.disposeAsync();
		const reopened = await create({ sessionManager: await SessionManager.open(file!) });
		expect(await hostHandlers(reopened.session).continuation_status({})).toEqual(blocked);
		reopened.setResponses([fauxAssistantMessage("Input received.")]);
		await reopened.session.prompt("Here is another message.");
		expect(reopened.session.getContinuationStatus()).toEqual(blocked);
	});

	it("does not spend goal continuations while held or infer a hold from prose", async () => {
		const harness = await create({ initialGoal: { objective: "Finish work" } });
		await harness.session.blockContinuation("required input unavailable");
		expect(await continuation(harness)).toEqual([]);
		expect(harness.session.goalState.continuationsUsed).toBe(0);
		await harness.session.resumeContinuation();
		expect(await continuation(harness)).toHaveLength(1);
		expect(harness.session.goalState.continuationsUsed).toBe(1);
		expect(harness.session.getContinuationStatus()).toEqual({ status: "ready" });
	});

	it("user resume leaves a paused goal and its counters unchanged", async () => {
		const harness = await create({ initialGoal: { objective: "Finish work" } });
		await continuation(harness);
		await harness.session.prompt("/goal pause");
		await harness.session.blockContinuation("waiting for required input");
		const before = harness.session.goalState;
		await harness.session.prompt("/continuation resume");
		expect(harness.session.getContinuationStatus()).toEqual({ status: "ready" });
		expect(harness.session.goalState).toMatchObject({
			status: "paused",
			continuationsUsed: before.continuationsUsed,
			tokensUsed: before.tokensUsed,
		});
	});

	it("discards a gate result that arrives after commands are replaced", async () => {
		const harness = await create({ autonomous: { enabled: true, gates: { commands: ["OldCase"] } } });
		let started!: () => void;
		let release!: () => void;
		const gateStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const gateRelease = new Promise<void>((resolve) => {
			release = resolve;
		});
		const gateSpy = vi.spyOn(autonomous, "refreshAutonomousQualityGates").mockImplementation(async (state) => {
			started();
			await gateRelease;
			state.gateAttempts = { OldCase: 1 };
			state.lastGateFailure = { command: "OldCase", attempt: 1, exitText: "1", output: "old failure" };
			return undefined;
		});
		const refreshing = harness.session.refreshAutonomousGates();
		await gateStarted;
		try {
			await harness.session.prompt('/autonomous gates set ["NewCase"]');
		} finally {
			release();
			await refreshing;
			gateSpy.mockRestore();
		}
		expect(harness.session.getAutonomousStatus()).toMatchObject({
			gates: { commands: ["NewCase"] },
			gateAttempts: {},
		});
		expect(harness.session.getAutonomousStatus().lastGateFailure).toBeUndefined();
	});

	it("executes case-preserved replacement gates without changing autonomous totals", async () => {
		const harness = await create({ autonomous: { enabled: true } });
		writeFileSync(
			join(harness.tempDir, "CaseSensitive.cjs"),
			'process.exit(process.argv[2] === "CaseSensitive" ? 0 : 1);',
		);
		expect(harness.session.recordHostAutonomousContinuation()).toBe(true);
		const before = harness.session.getAutonomousStatus();
		const oldRevision = harness.session.getAutonomousRevision();
		const command = "node CaseSensitive.cjs CaseSensitive";
		await harness.session.prompt(`/autonomous gates set ${JSON.stringify([command])}`);
		await harness.session.refreshAutonomousGates();
		const after = harness.session.getAutonomousStatus();
		expect(after.gates.commands).toEqual([command]);
		expect(after.gateAttempts[command]).toBe(0);
		expect(after.lastGateFailure).toBeUndefined();
		expect(after).toMatchObject({
			continuationsUsed: before.continuationsUsed,
			turnsUsed: before.turnsUsed,
			tokensUsed: before.tokensUsed,
			startedAt: before.startedAt,
		});
		expect(harness.session.recordHostAutonomousContinuation(oldRevision)).toBe(false);
	});

	it("rejects a threshold gate capture after a block and explicit resume", async () => {
		const harness = await create({ autonomous: { enabled: true } });
		const capture = Reflect.get(harness.session, "_captureThresholdAutonomousOwner") as () => unknown;
		const queue = Reflect.get(harness.session, "_queueAutonomousContinuationForThresholdCompaction") as (
			message: ReturnType<typeof fauxAssistantMessage>,
			owner: undefined,
			captured: unknown,
		) => Promise<unknown>;
		const captured = capture.call(harness.session);
		const next = vi.spyOn(autonomous, "nextAutonomousContinuation").mockResolvedValue(undefined);
		const message = fauxAssistantMessage("Required input unavailable.");
		await queue.call(harness.session, message, undefined, captured);
		expect(next).toHaveBeenCalledTimes(1);
		await harness.session.blockContinuation("required input unavailable");
		await harness.session.resumeContinuation();
		await queue.call(harness.session, message, undefined, captured);
		expect(next).toHaveBeenCalledTimes(1);
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(0);
	});

	it("removes an automatic goal prompt queued before the hold is set", async () => {
		const harness = await create({ initialGoal: { objective: "Finish work" } });
		const messages = await continuation(harness);
		expect(messages).toHaveLength(1);
		harness.session.agent.followUp(messages);
		await harness.session.blockContinuation("required input unavailable");
		harness.setResponses([fauxAssistantMessage("Input received.")]);
		await harness.session.prompt("Ordinary user input.");
		expect(
			harness.session.messages.filter(
				(message) =>
					message.role === "custom" &&
					message.customType === "goal_context" &&
					(message.details as { kind?: string } | undefined)?.kind === "continuation",
			),
		).toEqual([]);
		expect(harness.session.getContinuationStatus().status).toBe("blocked_external");
	});
});
