export interface TaskArtifact {
	path: string;
	dependencies?: string[];
}

export interface TaskContract {
	rules?: string[];
	hard_bounds?: string[];
	targets?: string[];
	references?: string[];
	assumptions?: string[];
	output_meanings?: Record<string, string>;
	objective?: {
		components: string[];
		direction: "maximize" | "minimize";
		target?: string;
		work_limit: number;
	};
	delivery?: {
		workspace: string;
		consumer_root?: string;
		mode?: string;
		files: TaskArtifact[];
	};
	integration_owner?: string;
	activation_owner?: string;
	boundary_case?: { description: string; command?: string };
}

export interface TaskOutcome {
	facts?: { source: string; field: string; value: string }[];
	interpretations?: string[];
	assumptions?: string[];
	conflicts?: string[];
	artifacts?: TaskArtifact[];
	readiness?: {
		stage: "prepared" | "integrated" | "loaded" | "exercised";
		target?: string;
		owner?: string;
		unmet: string[];
	};
	objective?: { values: string[]; status: "feasible" | "optimal" | "limit_reached"; evaluated?: number };
}

type Validator = (value: unknown, path: string) => void;

function record(value: unknown, path: string): Record<string, unknown> {
	if (
		value === null ||
		typeof value !== "object" ||
		(Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
	) {
		throw new Error(`${path} must be a plain object`);
	}
	return value as Record<string, unknown>;
}

const string: Validator = (value, path) => {
	if (typeof value !== "string") throw new Error(`${path} must be a string`);
};

function array(validate: Validator): Validator {
	return (value, path) => {
		if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
		for (const [index, item] of value.entries()) validate(item, `${path}[${index}]`);
	};
}

function optional(validate: Validator): Validator {
	return (value, path) => {
		if (value !== undefined) validate(value, path);
	};
}

function object(fields: Record<string, Validator>): Validator {
	return (value, path) => {
		const data = record(value, path);
		for (const key of Object.keys(data)) {
			if (!Object.hasOwn(fields, key)) throw new Error(`${path}.${key} is not supported`);
		}
		for (const [key, validate] of Object.entries(fields)) validate(data[key], `${path}.${key}`);
	};
}

function choice(options: readonly string[]): Validator {
	return (value, path) => {
		if (typeof value !== "string" || !options.includes(value)) {
			throw new Error(`${path} must be one of ${options.join(", ")}`);
		}
	};
}

function integer(minimum: number): Validator {
	return (value, path) => {
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
			throw new Error(`${path} must be a safe integer >= ${minimum}`);
		}
	};
}

const strings = array(string);
const artifact = object({ path: string, dependencies: optional(strings) });
const contract = object({
	rules: optional(strings),
	hard_bounds: optional(strings),
	targets: optional(strings),
	references: optional(strings),
	assumptions: optional(strings),
	output_meanings: optional((value, path) => {
		for (const [key, item] of Object.entries(record(value, path))) string(item, `${path}.${key}`);
	}),
	objective: optional(
		object({
			components: strings,
			direction: choice(["maximize", "minimize"]),
			target: optional(string),
			work_limit: integer(1),
		}),
	),
	delivery: optional(
		object({
			workspace: string,
			consumer_root: optional(string),
			mode: optional(string),
			files: array(artifact),
		}),
	),
	integration_owner: optional(string),
	activation_owner: optional(string),
	boundary_case: optional(object({ description: string, command: optional(string) })),
});
const outcome = object({
	facts: optional(array(object({ source: string, field: string, value: string }))),
	interpretations: optional(strings),
	assumptions: optional(strings),
	conflicts: optional(strings),
	artifacts: optional(array(artifact)),
	readiness: optional(
		object({
			stage: choice(["prepared", "integrated", "loaded", "exercised"]),
			target: optional(string),
			owner: optional(string),
			unmet: strings,
		}),
	),
	objective: optional(
		object({
			values: strings,
			status: choice(["feasible", "optimal", "limit_reached"]),
			evaluated: optional(integer(0)),
		}),
	),
});

export function normalizeTaskContract(value: unknown): TaskContract {
	contract(value, "task_contract");
	return structuredClone(value) as TaskContract;
}

export function normalizeTaskOutcome(value: unknown): TaskOutcome {
	outcome(value, "outcome");
	return structuredClone(value) as TaskOutcome;
}

export function renderTaskContract(value: TaskContract): string {
	return [
		"Task contract (parent-authored brief, not independently verified user instructions):",
		JSON.stringify(value),
		"Keep supplied rules, bounds, targets, reference meanings, and assumptions distinct. Do not promote an interpretation to a supplied rule.",
		...(value.objective
			? [
					"Use the declared objective order, prune infeasible partial candidates, and keep the best feasible incumbent within work_limit. Feasibility alone is not objective attainment.",
				]
			: []),
		...(value.delivery
			? [
					"Deliver required dependencies with the declared files. Keep workspace and consumer paths and execution modes distinct. Do not infer an export allowlist.",
				]
			: []),
		...(value.integration_owner || value.activation_owner
			? [
					"The named owners handle integration and activation. Report prepared, integrated, loaded, and exercised states separately; these fields do not authorize a launch.",
				]
			: []),
		...(value.boundary_case
			? [
					"Use the declared public-interface boundary case within the existing edge-case budget; it does not authorize extra checks.",
				]
			: []),
	].join("\n");
}

export function renderTaskOutcome(value: TaskOutcome): string {
	return `Task outcome (child-reported facts and interpretations, not independently verified):\n${JSON.stringify(value)}`;
}
