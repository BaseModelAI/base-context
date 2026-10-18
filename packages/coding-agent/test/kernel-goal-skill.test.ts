import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBundledSkillsDir } from "../src/config.js";
import type { HostRequestHandlers } from "../src/core/kernel/index.js";
import { SessionManager } from "../src/core/session-manager.js";
import type { PythonSkillRuntimeInfo } from "../src/core/skills.js";
import { IpythonKernelProvisioner } from "../src/core/tools/ipython.js";
import { createHarness, type Harness } from "./suite/harness.js";

function bundledGoalSkill(): PythonSkillRuntimeInfo {
	const packagePath = join(getBundledSkillsDir(), "goal");
	return {
		name: "goal",
		importName: "goal",
		packagePath,
		pyprojectPath: join(packagePath, "pyproject.toml"),
	};
}

describe("goal skill over the kernel host bridge", { tags: ["kernel-heavy"] }, () => {
	let tempDir: string;
	let provisioner: IpythonKernelProvisioner | undefined;
	const sessions: Harness[] = [];

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-goal-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await provisioner?.dispose();
		provisioner = undefined;
		for (const harness of sessions.splice(0).reverse()) await harness.cleanup();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("round-trips goal.create and goal.complete through a live kernel", async () => {
		const requests: Array<{ type: string; payload: Record<string, unknown> }> = [];
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledGoalSkill()],
			hostHandlers: {
				"goal.create": async (payload) => {
					requests.push({ type: "goal.create", payload });
					return {
						goal: { objective: payload.objective, status: "active", tokens_used: 0 },
						remaining_tokens: payload.token_budget ?? null,
						completion_budget_report: null,
					};
				},
				"goal.complete": async (payload) => {
					requests.push({ type: "goal.complete", payload });
					return {
						goal: { objective: "ship it", status: "complete", tokens_used: 7 },
						remaining_tokens: 3,
						completion_budget_report:
							"Goal achieved. Report final budget usage to the user: tokens used: 7 of 10.",
					};
				},
			},
		});

		const manager = await provisioner.ensure();
		const created = await manager.execute(`
import json
_created = await goal.create("ship it", token_budget=10)
print(json.dumps(_created, sort_keys=True))
`);
		expect(created.status).toBe("ok");
		expect(JSON.parse(created.stdout.trim())).toEqual({
			goal: { objective: "ship it", status: "active", tokens_used: 0 },
			remaining_tokens: 10,
			completion_budget_report: null,
		});

		const completed = await manager.execute(`
_completed = await goal.complete()
print(_completed["goal"]["status"], _completed["completion_budget_report"])
`);
		expect(completed.status).toBe("ok");
		expect(completed.stdout.trim()).toBe(
			"complete Goal achieved. Report final budget usage to the user: tokens used: 7 of 10.",
		);

		expect(requests.map((request) => request.type)).toEqual(["goal.create", "goal.complete"]);
		expect(requests[0].payload).toMatchObject({ type: "goal.create", objective: "ship it", token_budget: 10 });
	});

	it("surfaces host errors and missing handlers as Python exceptions", async () => {
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledGoalSkill()],
			hostHandlers: {
				"goal.complete": async () => {
					throw new Error("cannot complete goal because this thread has no goal");
				},
			},
		});

		const manager = await provisioner.ensure();
		const completeError = await manager.execute(`
try:
    await goal.complete()
except RuntimeError as error:
    print(f"RuntimeError: {error}")
`);
		expect(completeError.status).toBe("ok");
		expect(completeError.stdout.trim()).toBe("RuntimeError: cannot complete goal because this thread has no goal");

		const unavailable = await manager.execute(`
try:
    await goal.get()
except RuntimeError as error:
    print(f"RuntimeError: {error}")
`);
		expect(unavailable.status).toBe("ok");
		expect(unavailable.stdout.trim()).toBe(
			'RuntimeError: host request type "goal.get" is not available in this session',
		);

		const reroute = await manager.execute(`
import rlm as _rlm
try:
    await _rlm.host_request("goal.get", {"type": "goal.complete"})
except RuntimeError as error:
    print(f"RuntimeError: {error}")
`);
		expect(reroute.status).toBe("ok");
		expect(reroute.stdout.trim()).toBe('RuntimeError: host request type "goal.get" is not available in this session');
	});

	it("loads bundled continuation through the live kernel and persists its hold without completing the goal", async () => {
		const harness = await createHarness({
			persistSession: true,
			initialGoal: { objective: "Finish the pending task" },
		});
		sessions.push(harness);
		const createHandlers = Reflect.get(harness.session, "_createKernelHostHandlers") as () => HostRequestHandlers;
		const packagePath = join(getBundledSkillsDir(), "continuation");
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [
				{
					name: "continuation",
					importName: "continuation",
					packagePath,
					pyprojectPath: join(packagePath, "pyproject.toml"),
				},
			],
			hostHandlers: createHandlers.call(harness.session),
		});
		const manager = await provisioner.ensure();
		const result = await manager.execute(`
import json
initial = await continuation.status()
blocked = await continuation.block(reason="required input unavailable")
print(json.dumps([initial, blocked, await continuation.status()], sort_keys=True))
`);
		expect(result.status).toBe("ok");
		const blocked = {
			status: "blocked_external",
			hold: { kind: "external_blocker", reason: "required input unavailable" },
		};
		expect(JSON.parse(result.stdout.trim())).toEqual([{ status: "ready" }, blocked, blocked]);
		expect(harness.session.goalState).toMatchObject({ status: "active", continuationsUsed: 0 });
		const file = harness.sessionManager.getSessionFile();
		expect(file).toBeDefined();
		await provisioner.dispose();
		provisioner = undefined;
		await harness.session.disposeAsync();
		const reopened = await createHarness({ sessionManager: await SessionManager.open(file!) });
		sessions.push(reopened);
		expect(reopened.session.getContinuationStatus()).toEqual(blocked);
		expect(reopened.session.goalState).toMatchObject({ status: "active", continuationsUsed: 0 });
		await reopened.session.prompt("/continuation resume");
		expect(reopened.session.getContinuationStatus()).toEqual({ status: "ready" });
		expect(reopened.session.goalState).toMatchObject({ status: "active", continuationsUsed: 0 });
	});

	it("round-trips handler records with a status field", async () => {
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledGoalSkill()],
			hostHandlers: {
				"goal.get": async () => ({ status: "partial" }),
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
import json
print(json.dumps(await goal.get(), sort_keys=True))
`);
		expect(result.status).toBe("ok");
		expect(JSON.parse(result.stdout.trim())).toEqual({ status: "partial" });
	});
});
