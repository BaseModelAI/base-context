import { describe, expect, test } from "vitest";
import { buildChildAgentDoctrine, buildRlmPrompt, buildSubagentGuidance } from "../src/core/prompts/rlm.js";
import { buildSystemPrompt } from "../src/core/system-prompt.js";

describe("general task-input guidance", () => {
	test.each([
		{ depth: 0, activeTools: ["ipython"], allowRecursion: true },
		{ depth: 1, activeTools: ["ipython"], allowRecursion: true },
		{ depth: 0, activeTools: ["bash"], allowRecursion: false },
		{ depth: 1, activeTools: [], allowRecursion: false },
	])("preserves meanings and consumer expectations with %j", (options) => {
		const prompt = buildRlmPrompt({ ...options, cwd: "/repo", messagesPath: "/session/log" });
		expect(prompt).toContain("Preserve literal requirements, priorities, and acceptance metrics");
		expect(prompt).toContain(
			"do not turn a prohibition into a penalty, a target into a hard bound, or exact acceptance into approximate similarity",
		);
		expect(prompt).toContain("Preserve required behavior outside the edited part");
		expect(prompt).toContain("each stage's input and output meanings");
		expect(prompt).toContain(
			"Successful downstream execution does not establish that the upstream interpretation was correct",
		);
		expect(prompt).toContain("Keep unspecified conventions explicit as assumptions or unresolved questions");
		expect(prompt).toContain("actual consumer interface in its native environment");
		expect(prompt).toContain("required input meaning and expected behavior");
		expect(prompt).toContain("not an indiscriminate suite");
		expect(prompt).toContain("not an instruction to repeat unchanged checks");
	});

	test.each([true, false])("keeps analytical briefs neutral with messaging=%s", (hasAgentMessage) => {
		const prompt = buildSubagentGuidance({ hasAgentMessage, includeRefineExamples: false });
		expect(prompt).toContain(
			"original requirements, source evidence, and a neutral question before your preferred answer",
		);
		expect(prompt).toContain("observations, assumptions, and competing interpretations, not confirmation");
		expect(prompt).toContain("agreement from workers given the same premise is not independent support");
		expect(prompt).toContain("does not require another analysis phase for a straightforward implementation");
		expect(prompt).toContain("reproduced defects, corrected premises, and explicit child caveats");
		expect(prompt).toContain("unresolved conflicts with their report references");
		expect(prompt).toContain("explain why the user scope excludes them, or report the remaining uncertainty");
		expect(prompt).toContain("Child claims remain evidence, not established truth");
	});

	test("distinguishes a native dependency failure from an orchestration probe", () => {
		const prompt = buildRlmPrompt({ cwd: "/repo", messagesPath: "/session/log" });
		expect(prompt).toContain("A dependency probe establishes availability only in the environment probed");
		expect(prompt).toContain("a REPL import failure does not establish absence from the project's runtime");
		expect(prompt).toContain(
			"boundary_case can describe the consumer, runtime, cwd, and expected behavior; it does not run a check",
		);
	});

	test("describes active deletion as cancellation without forbidding it", () => {
		const prompt = buildRlmPrompt({ cwd: "/repo", messagesPath: "/session/log" });
		expect(prompt).toContain("cancels active work and can discard an unsent correction");
		expect(prompt).toContain("first receive the requested result and observe idle");
		expect(prompt).toContain("Intentional cancellation remains allowed");
		expect(prompt).toContain("report it as cancellation, not completed work");
		const nonrecursive = buildRlmPrompt({ cwd: "/repo", messagesPath: "/session/log", allowRecursion: false });
		expect(nonrecursive).not.toContain("await rlm.delete_subagent(child)");
	});

	test("puts decisive corrections in child capsules rather than only archives", () => {
		const prompt = buildChildAgentDoctrine({ depth: 1, installedSkills: ["agent_message"] });
		expect(prompt).toContain("decisive contrary evidence");
		expect(prompt).toContain("in the summary, not only archived findings");
		expect(prompt).toContain("retain unrelated unresolved caveats");
		expect(buildChildAgentDoctrine({ depth: 0, installedSkills: ["agent_message"] })).toBeUndefined();
		expect(buildChildAgentDoctrine({ depth: 1, installedSkills: [] })).not.toContain("send_result");
	});

	test("reaches the public system prompt without a task contract or skills", () => {
		const prompt = buildSystemPrompt({ selectedTools: ["ipython"], contextFiles: [], skills: [], cwd: "/repo" });
		expect(prompt).toContain("Preserve literal requirements, priorities, and acceptance metrics");
		expect(prompt).toContain("a neutral question before your preferred answer");
		expect(prompt).toContain("actual consumer interface in its native environment");
		expect(prompt).toContain("unresolved conflicts with their report references");
	});
});
