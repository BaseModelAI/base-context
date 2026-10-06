/** Provider/network integration tests are opt-in, never part of the offline CI gate. */
export const credentialTests = {
	ai: [
		"test/abort.test.ts",
		"test/anthropic-eager-tool-input-e2e.test.ts",
		"test/anthropic-long-cache-retention-e2e.test.ts",
		"test/anthropic-opus-4-7-smoke.test.ts",
		"test/anthropic-thinking-disable.test.ts",
		"test/anthropic-tool-name-normalization.test.ts",
		"test/context-overflow.test.ts",
		"test/cross-provider-handoff.test.ts",
		"test/empty.test.ts",
		"test/google-thinking-disable.test.ts",
		"test/image-tool-result.test.ts",
		"test/interleaved-thinking.test.ts",
		"test/openai-codex-cache-affinity-e2e.test.ts",
		"test/openai-responses-cache-affinity-e2e.test.ts",
		"test/openai-responses-reasoning-replay-e2e.test.ts",
		"test/openai-responses-tool-result-images.test.ts",
		"test/openrouter-cache-write-repro.test.ts",
		"test/responseid.test.ts",
		"test/stream.test.ts",
		"test/tokens.test.ts",
		"test/tool-call-id-normalization.test.ts",
		"test/tool-call-without-result.test.ts",
		"test/total-tokens.test.ts",
		"test/unicode-surrogate.test.ts",
		"test/xhigh.test.ts",
		"test/zen.test.ts",
	],
	"coding-agent": ["test/agent-session-tree-navigation.test.ts", "test/rpc.test.ts"],
};

export const kernelTests = [
	"test/acp-cold-cli.test.ts",
	"test/acp-kernel-features.test.ts",
	"test/kernel-goal-skill.test.ts",
	"test/repl-kernel-mcp-shutdown.test.ts",
	"test/repl-kernel-parent-watchdog.test.ts",
	"test/repl-kernel-state-roundtrip.test.ts",
];
export const processStressTests = ["test/daemon-supervisor-process.test.ts"];
