import { describe, expect, it, vi } from "vitest";
import { type AgentSessionMessageSendInput, createAgentMessageHostHandlers } from "../src/core/agent-messages.js";
import {
	normalizeTaskContract,
	normalizeTaskOutcome,
	renderTaskContract,
	type TaskContract,
	type TaskOutcome,
} from "../src/core/task-contract.js";

const contract: TaskContract = {
	rules: ["Use only supplied tables"],
	hard_bounds: ["Mass <= 10"],
	targets: ["Ship 9 units"],
	references: ["Preserve rolling-window semantics"],
	assumptions: ["Input times share a timezone"],
	output_meanings: { reserve: "Holding reserve, not landing floor" },
	objective: { components: ["orders", "units"], direction: "maximize", target: "9 units", work_limit: 20 },
	delivery: {
		workspace: "/work",
		consumer_root: "/app",
		mode: "server",
		files: [{ path: "main.py", dependencies: ["helper.py"] }],
	},
	integration_owner: "parent",
	activation_owner: "operator",
	boundary_case: { description: "Late state update at current clock", command: "python main.py late.json" },
};
const outcome: TaskOutcome = {
	facts: [{ source: "claim.json", field: "serial", value: "001234567890123456789" }],
	interpretations: ["The serial matches"],
	assumptions: ["Claim data is current"],
	conflicts: ["The earlier report says mismatch"],
	artifacts: [{ path: "main.py", dependencies: ["helper.py"] }],
	readiness: { stage: "prepared", target: "/app", owner: "parent", unmet: ["Not loaded into target"] },
	objective: { values: ["9", "910"], status: "limit_reached", evaluated: 20 },
};

function bridge() {
	const roster = vi.fn(() => ({
		current: { name: "worker", id: "worker", depth: 1 },
		entries: [{ relationship: "parent" as const, name: "root", id: "root", depth: 0, status: "running" as const }],
	}));
	const sendAgentMessage = vi.fn(async (input: AgentSessionMessageSendInput) => ({
		id: "result",
		source: "agent_message" as const,
		target: { activeSessionId: "root", sessionId: "root" },
		message: input.message,
		deliveryStatus: "delivered" as const,
	}));
	return {
		roster,
		sendAgentMessage,
		send: createAgentMessageHostHandlers({ roster, sendAgentMessage })["agent_message.send_result"]!,
	};
}

describe("optional task contracts and outcomes", () => {
	it("preserves the declared distinctions and exact source values", () => {
		const normalized = normalizeTaskContract(contract);
		expect(normalized).toEqual(contract);
		expect(normalized).not.toBe(contract);
		expect(renderTaskContract(normalized)).toContain("Feasibility alone is not objective attainment");
		expect(renderTaskContract(normalized)).toContain("do not authorize a launch");
		expect(normalizeTaskOutcome(outcome)).toEqual(outcome);
	});

	it("rejects non-record inputs and never invokes serialization hooks while normalizing", () => {
		for (const normalize of [normalizeTaskContract, normalizeTaskOutcome]) {
			expect(() => normalize(new Date())).toThrow("must be a plain object");
			expect(normalize({ assumptions: ["Reported, not verified"] })).toEqual({
				assumptions: ["Reported, not verified"],
			});
		}
		const toJSON = vi.fn(() => "changed");
		const rules = Object.assign(["Keep the reference"], { toJSON });
		expect(() => normalizeTaskContract({ rules })).toThrow();
		expect(toJSON).not.toHaveBeenCalled();
	});

	it("rejects unknown keys and invalid nested types without coerced numbers", () => {
		for (const value of [
			{ rules: "rule" },
			{ output_meanings: { reserve: 1 } },
			{ objective: { ...contract.objective, work_limit: 0 } },
			{ objective: { ...contract.objective, work_limit: Number.MAX_SAFE_INTEGER + 1 } },
			{ delivery: { ...contract.delivery, allowlist: [] } },
			{ boundary_case: { description: "case", retry: true } },
		])
			expect(() => normalizeTaskContract(value)).toThrow();
		expect(() => normalizeTaskOutcome({ facts: [{ source: "file", field: "value", value: 100 }] })).toThrow(
			"value must be a string",
		);
		expect(() => normalizeTaskOutcome({ readiness: { stage: "prepared" } })).toThrow("unmet must be an array");
		expect(() => normalizeTaskOutcome({ objective: { values: [], status: "optimal", evaluated: -1 } })).toThrow();
	});

	it("keeps unstructured calls unchanged and sends all structured claims through strings", async () => {
		const { send, sendAgentMessage } = bridge();
		await send({ summary: "done", findings: "full report" });
		expect(sendAgentMessage).toHaveBeenLastCalledWith({
			target: "root",
			message: "done",
			findings: "full report",
			receiverRole: "parent",
		});
		await send({ summary: "Prepared", findings: "Details", outcome });
		const input = sendAgentMessage.mock.lastCall![0];
		expect(input.message).toContain(JSON.stringify(outcome));
		expect(input.findings).toContain(JSON.stringify(outcome));
		expect(input.message).toContain("not independently verified");
		expect(input).not.toHaveProperty("outcome");
	});

	it("rejects malformed or oversized capsules before family lookup or delivery", async () => {
		const { send, roster, sendAgentMessage } = bridge();
		await expect(
			send({ summary: "Prepared", findings: "Details", outcome: { ...outcome, unknown: true } }),
		).rejects.toThrow("outcome.unknown");
		await expect(send({ summary: "x".repeat(2000), findings: "Details", outcome })).rejects.toThrow("2,000");
		await expect(send({ summary: "", findings: "Details", outcome })).rejects.toThrow("must not be empty");
		expect(roster).not.toHaveBeenCalled();
		expect(sendAgentMessage).not.toHaveBeenCalled();
	});
});
