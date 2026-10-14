import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import { expect, test, vi } from "vitest";
import { buildRlmPrompt } from "../src/core/prompts/rlm.js";
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
