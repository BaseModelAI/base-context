# Subagent Example

Delegate tasks to specialized subprocess agents with isolated context windows.

Base Context already provides native recursive delegation through `await rlm(...)`. That call returns a child handle; results arrive separately through messages or files. You do not need this extension for normal delegation.

This extension is a separate subprocess example for file-defined agent profiles and explicit single, parallel, or chained workflows. Its tool waits for the selected subprocess work and returns the result. It does not use the native RLM child lifecycle or `/agents` capacity limit.

## Features

- **Isolated context**: Each subagent runs in a separate Base Context process, not a security sandbox
- **Streaming output**: See tool calls and progress as they happen
- **Parallel streaming**: All parallel tasks stream updates simultaneously
- **Markdown rendering**: Final output rendered with proper formatting (expanded view)
- **Usage tracking**: Shows turns, tokens, cost, and context usage per agent
- **Abort support**: Ctrl+C propagates to kill subagent processes

## Structure

```
subagent/
├── README.md            # This file
├── index.ts             # The extension (entry point)
├── agents.ts            # Agent discovery logic
├── bash-tool.ts         # Explicit Bash registration for shell profiles
├── agents/              # Sample agent definitions
│   ├── scout.md         # Fast recon, returns compressed context
│   ├── planner.md       # Creates implementation plans
│   ├── reviewer.md      # Code review
│   └── worker.md        # General-purpose (full capabilities)
└── prompts/             # Workflow presets (prompt templates)
    ├── implement.md     # scout -> planner -> worker
    ├── scout-and-plan.md    # scout -> planner (no implementation)
    └── implement-and-review.md  # worker -> reviewer -> worker
```

## Installation

From the repository root, symlink the files into the default global state root. If you use `BASE_CONTEXT_HOME`, substitute that directory for `~/.base-context`:

```bash
# Symlink the extension (must be in a subdirectory with index.ts)
mkdir -p ~/.base-context/extensions/subagent
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/index.ts" ~/.base-context/extensions/subagent/index.ts
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/agents.ts" ~/.base-context/extensions/subagent/agents.ts
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/bash-tool.ts" ~/.base-context/extensions/subagent/bash-tool.ts

# Symlink agents
mkdir -p ~/.base-context/agents
for f in packages/coding-agent/examples/extensions/subagent/agents/*.md; do
  ln -sf "$(pwd)/$f" ~/.base-context/agents/$(basename "$f")
done

# Symlink workflow prompts
mkdir -p ~/.base-context/prompts
for f in packages/coding-agent/examples/extensions/subagent/prompts/*.md; do
  ln -sf "$(pwd)/$f" ~/.base-context/prompts/$(basename "$f")
done
```

The extension loads its companion `bash-tool.ts` only for profiles whose `tools` list includes `bash`. This registers the SDK Bash tool explicitly; Bash is not a default built-in. The supplied shell-only profiles keep `--tools bash` and do not gain unrestricted `ipython`. Keep the companion file next to `index.ts`.

Authenticate to each profile's provider before running it. The supplied profiles use explicit `anthropic/...` model IDs; edit them if you use another supported provider/model. No model or credential is borrowed from Prime Agent.

## Security Model

This tool executes a separate Base Context subprocess with a delegated system prompt and tool/model configuration. It uses your operating-system permissions and provider credentials. Separate context does not prevent filesystem writes or network access.

**Project-local agents** (`.base-context/agents/*.md`) are repo-controlled prompts that can instruct the model to run IPython, shell commands, and other tools.

**Default behavior:** Only loads **user-level agents** from `~/.base-context/agents`.

To enable project-local agents, pass `agentScope: "both"` (or `"project"`). Only do this for repositories you trust.

When running interactively, the tool prompts for confirmation before running project-local agents. Set `confirmProjectAgents: false` to disable. The scout, planner, and reviewer prompts ask for read-only shell use; Bash itself is not read-only enforcement. Use an external sandbox when you need an operating-system boundary.

## Usage

### Single agent
```
Use scout to find all authentication code
```

### Parallel execution
```
Run 2 scouts in parallel: one to find models, one to find providers
```

### Chained workflow
```
Use a chain: first have scout find the ipython tool, then have planner suggest improvements
```

### Workflow prompts
```
/implement add Redis caching to the session store
/scout-and-plan refactor auth to support OAuth
/implement-and-review add input validation to API endpoints
```

## Tool Modes

| Mode | Parameter | Description |
|------|-----------|-------------|
| Single | `{ agent, task }` | One agent, one task |
| Parallel | `{ tasks: [...] }` | Multiple agents run concurrently (max 8, 4 concurrent) |
| Chain | `{ chain: [...] }` | Sequential with `{previous}` placeholder |

## Output Display

**Collapsed view** (default):
- Status icon (✓/✗/⏳) and agent name
- Last 5-10 items (tool calls and text)
- Usage stats: `3 turns ↑input ↓output RcacheRead WcacheWrite $cost ctx:contextTokens model`

**Expanded view** (Ctrl+O):
- Full task text
- All tool calls with formatted arguments
- Final output rendered as Markdown
- Per-task usage (for chain/parallel)

**Parallel mode streaming**:
- Shows all tasks with live status (⏳ running, ✓ done, ✗ failed)
- Updates as each task makes progress
- Shows "2/3 done, 1 running" status

**Tool call formatting**:
- `$ command` for bash
- `ipython code` for ipython
- `edit ~/path` for edit

## Agent Definitions

Agents are markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: bash
model: anthropic/claude-haiku-4-5
---

System prompt for the agent goes here.
```

**Locations:**
- `~/.base-context/agents/*.md` - User-level (always loaded)
- `.base-context/agents/*.md` - Project-level (only with `agentScope: "project"` or `"both"`)

Project agents override user agents with the same name when `agentScope: "both"`.

## Sample Agents

| Agent | Purpose | Model | Tools |
|-------|---------|-------|-------|
| `scout` | Fast codebase recon | Haiku | bash |
| `planner` | Implementation plans | Sonnet | bash |
| `reviewer` | Code review | Sonnet | bash |
| `worker` | General-purpose | Sonnet | (all default) |

## Workflow Prompts

| Prompt | Flow |
|--------|------|
| `/implement <query>` | scout → planner → worker |
| `/scout-and-plan <query>` | scout → planner |
| `/implement-and-review <query>` | worker → reviewer → worker |

## Error Handling

- **Exit code != 0**: Tool returns error with stderr/output
- **stopReason "error"**: LLM error propagated with error message
- **stopReason "aborted"**: User abort (Ctrl+C) kills subprocess, throws error
- **Chain mode**: Stops at first failing step, reports which step failed

## Limitations

- Output truncated to last 10 items in collapsed view (expand to see all)
- Agents discovered fresh on each invocation (allows editing mid-session)
- Parallel mode limited to 8 tasks, 4 concurrent per extension call; this is separate from native `/agents` capacity
