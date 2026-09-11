/**
 * System prompt construction and project context loading
 */

import { buildChildAgentDoctrine, buildRlmPrompt, buildSubagentGuidance } from "./prompts/index.js";
import { formatHarnessStateForPrompt, type HarnessState, REFINE_SKILL_NAME } from "./refinement/index.js";
import { formatSkillsForPrompt, getPythonSkillRuntimeInfo, type Skill } from "./skills.js";

// User-approved policy shared by every main model, including custom system prompts.
const ABSOLUTE_PROHIBITION = [
	"## Absolute Prohibition: No Verification Theater / Proof Boilerplate",
	"",
	"You are FORBIDDEN from inventing, adding, or expanding any of the following unless the user explicitly requests them in the current message:",
	"",
	'- Proofs of correctness, formal verification, or "proof harnesses"',
	'- Ledgers, audit logs, provenance tracking, or event sourcing "for safety"',
	"- Cryptographic hashes, checksums, integrity checks, or signature schemes",
	'- Review loops, multi-stage validation pipelines, or "ensure this works" rituals',
	"- Extra test suites, property-based tests, or mutation testing that go beyond the minimal happy-path + one edge case",
	"- Over-cautious guardrails, legacy-compatibility layers, or defensive code for failure modes the user did not mention",
	"",
	"### Core Rule",
	"**Build the actual thing first.**  ",
	"Your job is to ship working, minimal, readable code that solves the stated problem.  ",
	"Do **not** turn a simple feature request into a research project on correctness.",
	"",
	"### Enforcement",
	"1. If the task is a prototype, MVP, script, or simple project → write the direct implementation. Stop.",
	'2. Only add verification mechanisms when the user says words like "prove", "formally verify", "add ledger", "hash everything", or "make it bulletproof".',
	"3. If you feel the urge to add any of the banned items, rewrite the plan to remove them before writing any code.",
	"4. Prefer deleting code over adding protective boilerplate.",
	"5. When in doubt: less is more. KISS is mandatory.",
	"",
	"Violation of this rule is considered a failure. Re-plan and ship the real feature instead.",
].join("\n");

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces the default body; shared main-prompt policy remains). */
	customPrompt?: string;
	/** Active tools. Tool schemas carry tool descriptions outside the prompt body. */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. Used only for custom prompts. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the system prompt. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. */
	cwd: string;
	/** Conversation log path. */
	messagesPath?: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
	/** Actual native recovery authorization at this owned prompt build. */
	nativeSkillSelection?: "enabled" | "unavailable";
	/** Whether to include the model-facing rlm recursion guidance. */
	allowRecursion?: boolean;
	/** Fixed recursive-agent depth for this session. */
	rlmDepth?: number;
	/** Human-readable parent name or id for child communication doctrine. */
	rlmParentAgent?: string;
	/** Global harness state to inject as compact persistent context. */
	harnessState?: HarnessState;
	/** Enabled user-configured servers available through the generic kernel MCP API. */
	genericMcpServers?: string[];
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const {
		customPrompt,
		selectedTools,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		messagesPath,
		contextFiles: providedContextFiles,
		skills: providedSkills,
		allowRecursion,
		harnessState,
	} = options;
	const promptCwd = cwd.replace(/\\/g, "/");
	const promptMessagesPath = (messagesPath ?? "not persisted").replace(/\\/g, "/");

	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	const date = `${year}-${month}-${day}`;

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = options.nativeSkillSelection === "unavailable" ? [] : (providedSkills ?? []);
	const tools = selectedTools ?? ["ipython"];
	const hasIpython = tools.includes("ipython");
	const hasBash = tools.includes("bash");
	// Admit and capture the catalog before constructing skill-derived prompt text.
	const skillCatalog =
		(options.nativeSkillSelection === "enabled" || hasIpython || hasBash) && skills.length > 0
			? formatSkillsForPrompt(skills, options.nativeSkillSelection === "enabled")
			: "";
	const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
	const visiblePythonSkillImportNames = getPythonSkillRuntimeInfo(visibleSkills).map((skill) => skill.importName);
	const hasRefineSkill = visibleSkills.some((skill) => skill.name === REFINE_SKILL_NAME);
	const genericMcpSection = hasIpython ? formatGenericMcpGuidance(options.genericMcpServers) : "";

	if (customPrompt) {
		let prompt = `${customPrompt}\n\n${ABSOLUTE_PROHIBITION}`;

		// Append project context files
		if (contextFiles.length > 0) {
			prompt += "\n\n# Project Context\n\n";
			prompt += "Project-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `## ${filePath}\n\n${content}\n\n`;
			}
		}

		prompt += skillCatalog;

		// Add date and working directory last
		prompt += `\nCurrent date: ${date}`;
		prompt += `\nCurrent working directory: ${promptCwd}`;

		const childDoctrine = buildChildAgentDoctrine({
			depth: options.rlmDepth,
			parentAgent: options.rlmParentAgent,
			installedSkills: visiblePythonSkillImportNames,
			activeTools: tools,
		});
		if (childDoctrine) {
			prompt += `\n\n${childDoctrine}`;
		}

		if (harnessState) {
			prompt += `\n\n${formatHarnessStateForPrompt(harnessState, { includeIpythonExamples: hasIpython, includeShellExamples: hasBash, includeRefineExamples: hasIpython && hasRefineSkill })}`;
		}

		if (genericMcpSection) {
			prompt += `\n\n${genericMcpSection}`;
		}

		if (appendSection) {
			prompt += appendSection;
		}

		return prompt;
	}

	let prompt = buildRlmPrompt({
		cwd: promptCwd,
		messagesPath: promptMessagesPath,
		installedSkills: visiblePythonSkillImportNames,
		activeTools: tools.filter((name) => name === "ipython" || name === "bash" || name === "edit"),
		allowRecursion,
		depth: options.rlmDepth,
		parentAgent: options.rlmParentAgent,
	});

	prompt += `\n\n${ABSOLUTE_PROHIBITION}`;

	// Appended AFTER the trained buildRlmPrompt prefix, and before the harness-state
	// menu, so the model reads when/why to delegate and then sees the concrete subagent
	// specs it can match against — the same ordering as Claude Code's Agent tool.
	if ((allowRecursion ?? true) && hasIpython) {
		const visiblePythonSkillNames = new Set(
			getPythonSkillRuntimeInfo(visibleSkills).map((skill) => skill.importName),
		);
		prompt += `\n\n${buildSubagentGuidance({
			includeRefineExamples: hasRefineSkill,
			hasAgentMessage: visiblePythonSkillNames.has("agent_message"),
			hasAgentObserve: visiblePythonSkillNames.has("agent_observe"),
		})}`;
	}

	if (harnessState) {
		prompt += `\n\n${formatHarnessStateForPrompt(harnessState, { includeIpythonExamples: hasIpython, includeShellExamples: hasBash, includeRefineExamples: hasIpython && hasRefineSkill })}`;
	}

	if (genericMcpSection) {
		prompt += `\n\n${genericMcpSection}`;
	}

	const guidelines = formatPromptGuidelines(promptGuidelines);
	if (guidelines) {
		prompt += `\n\n# Additional Guidance\n\n${guidelines}`;
	}

	// Append project context files
	if (contextFiles.length > 0) {
		prompt += "\n\n# Project Context\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `## ${filePath}\n\n${content}\n\n`;
		}
	}

	prompt += skillCatalog;

	if (appendSection) {
		prompt += appendSection;
	}

	return prompt;
}

function formatGenericMcpGuidance(servers: string[] | undefined): string {
	const enabledServers = [...new Set(servers ?? [])].sort((left, right) => left.localeCompare(right));
	if (enabledServers.length === 0) return "";

	return [
		"# Generic MCP Connections",
		"",
		"Generic MCP connections are accessed through the pre-imported Python `mcp` object in the Python REPL, not as top-level native tool namespaces or installed Python skills.",
		`Enabled generic MCP servers: ${enabledServers.map((server) => `\`${server}\``).join(", ")}.`,
		...enabledServers.map(
			(server) =>
				`For \`${server}\`, first discover its tools with \`await mcp.list_tools("${server}")\`, then call one with \`await mcp.call_tool("${server}", "<tool>", arguments)\`.`,
		),
	].join("\n");
}

function formatPromptGuidelines(promptGuidelines: string[] | undefined): string {
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0 && !guidelinesSet.has(normalized)) {
			guidelinesSet.add(normalized);
			guidelinesList.push(normalized);
		}
	}

	return guidelinesList.map((guideline) => `- ${guideline}`).join("\n");
}
