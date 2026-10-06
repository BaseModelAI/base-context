import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverAgents } from "../examples/extensions/subagent/agents.js";
import bashToolExtension from "../examples/extensions/subagent/bash-tool.js";
import { buildSubagentArgs, buildSubagentEnv } from "../examples/extensions/subagent/index.js";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/index.js";
import type { createBashToolDefinition } from "../src/core/tools/bash.js";

vi.mock("@ponythewhite/base-context", async () => import("../src/index.js"));

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function projectAgent(tools: string) {
	const directory = mkdtempSync(join(tmpdir(), "base-context-subagent-example-"));
	directories.push(directory);
	const agentsDirectory = join(directory, ".base-context", "agents");
	mkdirSync(agentsDirectory, { recursive: true });
	writeFileSync(
		join(agentsDirectory, "scout.md"),
		`---
name: scout
description: Local test profile
tools: ${tools}
model: anthropic/claude-haiku-4-5
---
Read the supplied files.
`,
	);
	const discovered = discoverAgents(directory, "project");
	expect(discovered.projectAgentsDir).toBe(agentsDirectory);
	expect(discovered.agents).toHaveLength(1);
	return discovered.agents[0];
}

describe("subagent example", () => {
	it("discovers a Base Context profile and supplies an executable Bash-only tool", async () => {
		const agent = projectAgent("bash");
		const companion = fileURLToPath(new URL("../examples/extensions/subagent/bash-tool.ts", import.meta.url));
		expect(existsSync(companion)).toBe(true);
		expect(buildSubagentArgs(agent)).toEqual([
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--model",
			"anthropic/claude-haiku-4-5",
			"--tools",
			"bash",
			"--extension",
			companion,
		]);

		const registerTool = vi.fn();
		bashToolExtension({ registerTool } as unknown as ExtensionAPI);
		expect(registerTool).toHaveBeenCalledTimes(1);
		const tool = registerTool.mock.calls[0][0] as ReturnType<typeof createBashToolDefinition>;
		expect(tool.name).toBe("bash");
		const result = await tool.execute(
			"local-bash-test",
			{ command: "printf 'subagent-bash-ready'" },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(result.content).toEqual([{ type: "text", text: "subagent-bash-ready" }]);
	});

	it("does not add Bash or reuse the parent worker identity for an independent profile", async () => {
		const agent = projectAgent("ipython, prime_context");
		expect(buildSubagentArgs(agent)).toEqual([
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--model",
			"anthropic/claude-haiku-4-5",
			"--tools",
			"ipython,prime_context",
		]);
		expect(buildSubagentArgs({ ...agent, tools: undefined })).not.toContain("--extension");

		const inherited: NodeJS.ProcessEnv = {
			...process.env,
			BASE_CONTEXT_INTERNAL_OWNED_WORKER: "1",
			BASE_CONTEXT_INTERNAL_SESSION_LEASE_OWNER_ID: "parent-owner",
		};
		const environment = buildSubagentEnv(inherited);
		expect(environment.BASE_CONTEXT_INTERNAL_OWNED_WORKER).toBeUndefined();
		expect(environment.BASE_CONTEXT_INTERNAL_SESSION_LEASE_OWNER_ID).toBeUndefined();
		expect(environment.BASE_CONTEXT_HOME).toBe(inherited.BASE_CONTEXT_HOME);
		expect(environment.NODE_OPTIONS).toBe(inherited.NODE_OPTIONS);
		const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
		const result = await promisify(execFile)(process.execPath, ["--import", "tsx", cli, "--help"], {
			env: environment,
		});
		expect(result.stdout + result.stderr).toContain("Usage:");
	});
});
