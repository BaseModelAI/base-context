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
	stages: [
		{
			name: "read rows",
			input_meanings: { table: "UTF-8 CSV; identifiers are strings" },
			output_meanings: { rows: "Source order; preserve leading zeros" },
			assumptions: ["The supplied delimiter is correct"],
		},
		{
			name: "write report",
			input_meanings: { rows: "Source order; identifiers unchanged" },
			output_meanings: { report: "One JSON object per row, not a summary" },
		},
	],
	objective: { components: ["orders", "units"], direction: "maximize", target: "9 units", work_limit: 20 },
	delivery: {
		workspace: "/work",
		consumer_root: "/app",
		mode: "server",
		files: [{ path: "main.py", dependencies: ["helper.py"] }],
	},
	integration_owner: "parent",
	activation_owner: "operator",
	boundary_case: {
		description: "Late state update at current clock",
		command: ".venv/bin/python main.py late.json",
		expected_behavior: "Reconsider dependent decisions without changing source rows",
		consumer: "Transferred files under /app, not the development workspace",
		runtime: "Consumer .venv Python",
		cwd: "/app",
	},
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

	it("round-trips named stage interfaces and consumer context without changing literal clauses", () => {
		const supplied: TaskContract = {
			...contract,
			rules: ["Apply eligibility before preferences; reconsider preferences when eligibility changes"],
			hard_bounds: ["bytes <= 1024", "Keep this order"],
			targets: ["Prefer bytes <= 512", "Desired throughput >= 1000 rows/s, not a hard minimum"],
			assumptions: ["bytes <= 256 is an estimate, not a supplied bound"],
		};
		const normalized = normalizeTaskContract(JSON.parse(JSON.stringify(supplied)));
		const rendered = renderTaskContract(normalized);
		expect(JSON.parse(rendered.split("\n")[1]!)).toEqual(supplied);
		expect(normalized.stages).not.toBe(supplied.stages);
		expect(normalized.stages![0]!.input_meanings).not.toBe(supplied.stages![0]!.input_meanings);
		expect(normalized.boundary_case).not.toBe(supplied.boundary_case);
		expect(rendered).toContain("Do not promote a target to a hard bound");
		expect(rendered).toContain("do not require a review pipeline or authorize execution");
		expect(rendered).toContain("do not execute commands or authorize extra checks or a launch");
	});

	it("accepts a contrasting image interface without inferring stages or consumer context", () => {
		const image: TaskContract = {
			stages: [
				{
					name: "resize image",
					input_meanings: { image: "RGBA pixels; width and height in pixels" },
					output_meanings: { image: "Fit within requested dimensions; never enlarge; keep alpha" },
				},
			],
			boundary_case: {
				description: "Image already smaller than requested dimensions",
				expected_behavior: "Return unchanged dimensions and pixel values",
			},
		};
		expect(normalizeTaskContract(image)).toEqual(image);
		expect(JSON.parse(renderTaskContract(image).split("\n")[1]!)).toEqual(image);
		expect(normalizeTaskContract({})).toEqual({});
		expect(normalizeTaskContract({ stages: [] })).toEqual({ stages: [] });
		expect(
			normalizeTaskContract({ stages: [{ name: "no inputs", input_meanings: {}, output_meanings: {} }] }),
		).toEqual({
			stages: [{ name: "no inputs", input_meanings: {}, output_meanings: {} }],
		});
		expect(renderTaskContract({})).not.toContain("Stage interfaces");
		expect(renderTaskContract({})).not.toContain("boundary case");
	});

	it.each([
		["stages", { stages: {} }, "task_contract.stages must be an array"],
		["stage record", { stages: [null] }, "task_contract.stages[0] must be a plain object"],
		["stage name", { stages: [{ input_meanings: {}, output_meanings: {} }] }, "task_contract.stages[0].name"],
		[
			"stage name type",
			{ stages: [{ name: 1, input_meanings: {}, output_meanings: {} }] },
			"task_contract.stages[0].name",
		],
		["input meanings", { stages: [{ name: "read", output_meanings: {} }] }, "task_contract.stages[0].input_meanings"],
		[
			"output meanings",
			{ stages: [{ name: "read", input_meanings: {} }] },
			"task_contract.stages[0].output_meanings",
		],
		[
			"input array",
			{ stages: [{ ...contract.stages![0], input_meanings: [] }] },
			"task_contract.stages[0].input_meanings",
		],
		[
			"numeric input",
			{ stages: [{ ...contract.stages![0], input_meanings: { table: 10 } }] },
			"task_contract.stages[0].input_meanings.table",
		],
		[
			"null output",
			{ stages: [{ ...contract.stages![0], output_meanings: null }] },
			"task_contract.stages[0].output_meanings",
		],
		[
			"numeric output",
			{ stages: [{ ...contract.stages![0], output_meanings: { rows: 10 } }] },
			"task_contract.stages[0].output_meanings.rows",
		],
		[
			"assumption type",
			{ stages: [{ ...contract.stages![0], assumptions: "known" }] },
			"task_contract.stages[0].assumptions",
		],
		[
			"assumption item",
			{ stages: [{ ...contract.stages![0], assumptions: [false] }] },
			"task_contract.stages[0].assumptions[0]",
		],
		[
			"stage command",
			{ stages: [{ ...contract.stages![0], command: "run" }] },
			"task_contract.stages[0].command is not supported",
		],
		[
			"stage extra field",
			{ stages: [{ ...contract.stages![0], required: true }] },
			"task_contract.stages[0].required is not supported",
		],
		[
			"boundary description",
			{ boundary_case: { expected_behavior: "empty output" } },
			"task_contract.boundary_case.description",
		],
		[
			"boundary expectation",
			{ boundary_case: { description: "empty input", expected_behavior: [] } },
			"task_contract.boundary_case.expected_behavior",
		],
		[
			"boundary consumer",
			{ boundary_case: { description: "empty input", consumer: {} } },
			"task_contract.boundary_case.consumer",
		],
		[
			"boundary runtime",
			{ boundary_case: { description: "empty input", runtime: null } },
			"task_contract.boundary_case.runtime",
		],
		["boundary cwd", { boundary_case: { description: "empty input", cwd: 1 } }, "task_contract.boundary_case.cwd"],
		[
			"boundary authorization",
			{ boundary_case: { description: "empty input", authorized: true } },
			"task_contract.boundary_case.authorized is not supported",
		],
	])("rejects malformed %s", (_name, value, path) => {
		expect(() => normalizeTaskContract(value)).toThrow(path);
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
