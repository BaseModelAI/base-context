# Plan Mode Extension

A planning workflow with a restricted named-tool list and a Bash command allowlist. It is not a read-only filesystem or security sandbox.

## Features

- **Tool selection**: Restricts available tool names to `bash` and `questionnaire`; both must be registered
- **Bash allowlist**: Filters command text for intended read-only operations; this is not a complete shell parser or an operating-system restriction
- **Plan extraction**: Extracts numbered steps from `Plan:` sections
- **Progress tracking**: Widget shows completion status during execution
- **[DONE:n] markers**: Explicit step completion tracking
- **Session persistence**: State survives session resume

## Commands

- `/plan` - Toggle plan mode
- `/todos` - Show current plan progress
- `Ctrl+Alt+P` - Toggle plan mode (shortcut)

## Prerequisites

Load this extension together with a custom `bash` tool and the [questionnaire example](../questionnaire.ts). Bash is not a default Base Context built-in. The subagent example includes a small explicit registration extension. From the repository root, start all three examples with:

```bash
./base-context.sh --extension packages/coding-agent/examples/extensions/subagent/bash-tool.ts \
  --extension packages/coding-agent/examples/extensions/questionnaire.ts \
  --extension packages/coding-agent/examples/extensions/plan-mode
```

This registers Bash with the SDK's `createBashToolDefinition`. Do not replace the planning tool list with unrestricted `ipython` and assume the Bash filter still applies.

Only use trusted projects. Allowed shell programs can have side effects, and the command filter does not constrain their operating-system permissions.

## Usage

1. Enable plan mode with `/plan` or `--plan` flag
2. Ask the agent to analyze code and create a plan
3. The agent should output a numbered plan under a `Plan:` header:

```
Plan:
1. First step description
2. Second step description
3. Third step description
```

4. Choose "Execute the plan" when prompted
5. During execution, the agent marks steps complete with `[DONE:n]` tags
6. Progress widget shows completion status

## How It Works

### Plan Mode (Read-Only)
- Only bash and questionnaire are available
- Bash commands filtered through allowlist
- Agent is instructed to create a plan without making changes; this is not a sandbox guarantee

### Execution Mode
- Switches to the example's execution list: `ipython`, `bash`, and `edit` (when registered); it does not restore an arbitrary previous list
- Agent executes steps in order
- `[DONE:n]` markers track completion
- Widget shows progress

### Command Allowlist

Examples of command names accepted by the filter (not a guarantee of no side effects):
- File inspection: `cat`, `head`, `tail`, `less`, `more`
- Search: `grep`, `find`, `rg`, `fd`
- Directory: `ls`, `pwd`, `tree`
- Git read: `git status`, `git log`, `git diff`, `git branch`
- Package info: `npm list`, `npm outdated`, `yarn info`
- System info: `uname`, `whoami`, `date`, `uptime`

Blocked commands:
- File modification: `rm`, `mv`, `cp`, `mkdir`, `touch`
- Git write: `git add`, `git commit`, `git push`
- Package install: `npm install`, `yarn add`, `pip install`
- System: `sudo`, `kill`, `reboot`
- Editors: `vim`, `nano`, `code`
