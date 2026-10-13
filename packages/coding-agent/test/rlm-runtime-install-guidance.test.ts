import { describe, expect, it } from "vitest";
import { buildRlmPrompt } from "../src/core/prompts/rlm.js";

describe("REPL dependency installation guidance", () => {
	it.each([
		{ cwd: "/workspace", depth: 0 },
		{ cwd: "/tmp/task with spaces", depth: 1 },
	])("targets the REPL interpreter from $cwd at depth $depth", ({ cwd, depth }) => {
		const prompt = buildRlmPrompt({
			cwd,
			depth,
			messagesPath: "/tmp/session.jsonl",
			activeTools: ["ipython"],
		});
		expect(prompt).toContain("get its interpreter from `sys.executable`");
		expect(prompt).toContain("`uv pip install --python <interpreter-path> <pkg>`");
		expect(prompt).toContain("with that path shell-quoted");
		expect(prompt).toContain("Use the project's own environment for project dependencies.");
		expect(prompt).not.toContain("`uv pip install <pkg>`");
	});
});
