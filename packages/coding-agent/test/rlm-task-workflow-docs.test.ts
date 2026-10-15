import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import { expect, test, vi } from "vitest";
import { buildRlmPrompt, buildSubagentGuidance } from "../src/core/prompts/rlm.js";
import { PRODUCT_ENV } from "../src/product-identity.js";

test("prints the package task workflow guide location from an unrelated cwd", () => {
	const originalCwd = process.cwd();
	const consumerCwd = mkdtempSync(join(tmpdir(), "rlm-prompt-docs-"));
	try {
		vi.stubEnv(PRODUCT_ENV.packageDirectory, undefined);
		process.chdir(consumerCwd);
		const prompt = buildRlmPrompt({
			cwd: consumerCwd,
			messagesPath: join(consumerCwd, "session.jsonl"),
			installedSkills: ["agent_message"],
			activeTools: ["ipython"],
		});
		const expectedPath = fileURLToPath(new URL("../docs/task-workflows.md", import.meta.url));
		expect(prompt.match(/^Task workflow documentation: (.+)$/m)?.[1]).toBe(expectedPath);
		expect(existsSync(expectedPath)).toBe(true);
	} finally {
		vi.unstubAllEnvs();
		process.chdir(originalCwd);
		rmSync(consumerCwd, { recursive: true, force: true });
	}
});

test("connects delivery and job-result guidance to the available workflow", () => {
	const prompt = buildRlmPrompt({
		cwd: "/work",
		messagesPath: "/work/session.jsonl",
		installedSkills: ["job_watch"],
	});
	expect(prompt).toContain("explicit total wait budget");
	expect(prompt).toContain("Inspect consumed terminal results");
	expect(prompt).toContain("if `parked` is false, this call acquired no new continuation hold");
	expect(prompt).toContain("An earlier hold may remain");
	expect(prompt).toContain("Let queued/in-flight evidence arrive normally");
	const delegation = buildSubagentGuidance();
	expect(delegation).toContain("supplied consumer transfer paths, exclusions, and execution mode");
	expect(delegation).toContain("Keep unknown constraints unknown");
});

test("does not recommend unavailable job-watch APIs", () => {
	const prompt = buildRlmPrompt({
		cwd: "/work",
		messagesPath: "/work/session.jsonl",
		installedSkills: [],
	});
	expect(prompt).toContain("use a nonblocking control loop");
	expect(prompt).not.toContain("explicit total wait budget");
	expect(prompt).not.toContain("if `parked` is false");
});
