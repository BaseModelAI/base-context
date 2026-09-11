<h1 align="center">Base Context CLI</h1>

<p align="center">
  RLM-native terminal coding and research harness.
</p>

Base Context is a pre-release fork of [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent), which descends from [pi-mono](https://github.com/badlogic/pi-mono). This application package is `@ponythewhite/base-context`, and its command is `base-context`. The workspace also contains `@ponythewhite/base-context-ai`, `@ponythewhite/base-context-agent`, and `@ponythewhite/base-context-tui`. The inherited `pi` package manifest key and Python import `rlm` remain unchanged.

**A public Base Context release has not been approved or published.** Do not expect an npm package, release binary, or installer endpoint to be available. Upstream Prime Agent installers do not install Base Context. Use the [source setup in the owned repository README](https://github.com/BaseModelAI/base-context#getting-started).

## Table of Contents

- [Quick Start](#quick-start)
- [Providers & Models](#providers--models)
- [Interactive Mode](#interactive-mode)
  - [Editor](#editor)
  - [Commands](#commands)
  - [Keyboard Shortcuts](#keyboard-shortcuts)
  - [Message Queue](#message-queue)
- [Sessions](#sessions)
  - [Branching](#branching)
  - [Compaction](#compaction)
- [Settings](#settings)
- [Context Files](#context-files)
- [Customization](#customization)
  - [Prompt Templates](#prompt-templates)
  - [Skills](#skills)
  - [MCP Integrations](#mcp-integrations)
  - [Extensions](#extensions)
  - [Themes](#themes)
  - [Base Context Packages](#base-context-packages)
- [Programmatic Usage](#programmatic-usage)
- [Upstream](#upstream)
- [CLI Reference](#cli-reference)

## Quick Start

Follow the [source build instructions](https://github.com/BaseModelAI/base-context#getting-started) for Node requirements, build commands, and the source-built CLI invocation. Examples below use `base-context` as shorthand; for a source build, use the documented Node invocation instead.

Base Context uses its own `~/.base-context` state. `BASE_CONTEXT_HOME` overrides that directory. Do not copy upstream credential stores into it. Configure a supported API-key or explicit subscription route as described in the [provider guide](docs/providers.md) and [SDK authentication guide](docs/sdk.md); copied OAuth clients are not globally authorized.

For example, after building from source and configuring a supported API-key route:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
base-context
```

The persistent Python kernel runs file operations, commands, edits, and data analysis through `ipython`. Native context also provides the `prime_context` selection/recovery route described under [Skills](#skills). Add capabilities through skills, prompt templates, and trusted extensions.

See [owned installer and rollback](https://github.com/BaseModelAI/base-context#owned-installer-and-rollback) for the **Base-Context** installer design; its release endpoints remain unpublished. Non-owned runtime setup can bootstrap Python on first use. `BASE_CONTEXT_KERNEL_PYTHON` selects an existing environment with a current `base-context-runtime`; the Python import remains `rlm`. See [Python-backed skills](docs/skills.md#python-backed-skills) for owned release-local environments and manual overrides.

**Terminal notes:** [Windows](docs/windows.md) | [Termux (Android)](docs/termux.md) | [tmux](docs/tmux.md) | [Terminal setup](docs/terminal-setup.md) | [Shell aliases](docs/shell-aliases.md). These inherited notes are not Base Context platform certification.

## Providers & Models

Base Context includes provider adapters and model definitions. Configure an authorized route before selecting a model with `/model` (or Ctrl+L). The provider identities below are not a claim that copied OAuth applications are authorized; follow the authentication guides linked above.

**Subscription provider identities:**
- Anthropic Claude Pro/Max
- OpenAI ChatGPT Plus/Pro (Codex)
- GitHub Copilot

**API keys:**
- Anthropic
- OpenAI
- Prime Inference
- Azure OpenAI
- DeepSeek
- Google Gemini
- Google Vertex
- Amazon Bedrock
- Mistral
- Groq
- Cerebras
- Cloudflare AI Gateway
- Cloudflare Workers AI
- xAI
- OpenRouter
- Vercel AI Gateway
- ZAI
- OpenCode Zen
- OpenCode Go
- Hugging Face
- Fireworks
- Kimi For Coding
- MiniMax
- Xiaomi MiMo
- Xiaomi MiMo Token Plan (China)
- Xiaomi MiMo Token Plan (Amsterdam)
- Xiaomi MiMo Token Plan (Singapore)

See [docs/providers.md](docs/providers.md) for detailed setup instructions.

**Custom providers & models:** Add providers via `~/.base-context/models.json` if they speak a supported API (OpenAI, Anthropic, Google). For custom APIs or OAuth, use extensions. See [docs/models.md](docs/models.md) and [docs/custom-provider.md](docs/custom-provider.md).

## Interactive Mode

<p align="center"><img src="docs/images/interactive-mode.png" alt="Interactive Mode" width="600"></p>

*Historical screenshot inherited through Prime Agent, not a current Base Context capture.*

The interface from top to bottom:

- **Startup header** - Shows a compact brand and runtime summary; use `--verbose` to list loaded AGENTS.md files, prompt templates, skills, and extensions
- **Messages** - Your messages, assistant responses, tool calls and results, notifications, errors, and extension UI
- **Editor** - Where you type
- **Footer** - Empty by default; use `/usage` for token, cost, and context details

The editor can be temporarily replaced by other UI, like built-in `/settings` or custom UI from extensions (e.g., a Q&A tool that lets the user answer model questions in a structured format). [Extensions](#extensions) can also replace the editor, add widgets above/below it, a status line, custom footer, or overlays.

### Editor

| Feature | How |
|---------|-----|
| File reference | Type `@` to fuzzy-search project files |
| Path completion | Tab to complete paths |
| Multi-line | Shift+Enter (or Ctrl+Enter on Windows Terminal) |
| Images | Ctrl+V to paste (Alt+V on Windows), or drag onto terminal |
| Bash commands | `!command` runs and sends output to LLM, `!!command` runs without sending |

Standard editing keybindings for delete word, undo, etc. See [docs/keybindings.md](docs/keybindings.md).

### Commands

Type `/` in the editor to trigger commands. [Extensions](#extensions) can register custom commands, [skills](#skills) are available as `/skill:name`, and [prompt templates](#prompt-templates) expand via `/templatename`.

| Command | Description |
|---------|-------------|
| `/login`, `/logout` | OAuth authentication |
| `/model` | Switch models |
| `/effort` | Set reasoning/thinking level |
| `/scoped-models` | Enable/disable models for Ctrl+P cycling |
| `/settings` | Thinking level, theme, message delivery, transport |
| `/resume [id\|path]` | Open the agents view, or resume a session directly |
| `/new`, `/clear` | Start a new session |
| `/name <name>` | Set session display name |
| `/session` | Show session info (file, ID, messages) |
| `/traces [status\|on\|off\|preview\|upload-current\|upload-all\|login]` | Preview traces, run one-shot current/all uploads, and manage automatic sharing (`upload` aliases `upload-current`) |
| `/usage` | Show token, cost, and context usage |
| `/tree` | Jump to any point in the session and continue from there |
| `/fork` | Create a new session from a previous user message |
| `/clone` | Duplicate the current active branch into a new session |
| `/compact [prompt]` | Manually compact context, optional custom instructions |
| `/copy` | Copy last assistant message to clipboard |
| `/btw <question>`, `/side <question>` | Ask an inline side question without adding it to the session; replies continue the side conversation, esc returns |
| `/export [file]` | Export session to HTML file |
| `/share` | Upload as private GitHub gist with shareable HTML link |
| `/reload` | Reload keybindings, extensions, skills, prompts, and context files (themes hot-reload automatically) |
| `/hotkeys` | Show all keyboard shortcuts |
| `/changelog` | Display version history |
| `/quit` | Quit Base Context |

### Keyboard Shortcuts

See `/hotkeys` for the full list. Customize via `~/.base-context/keybindings.json`. See [docs/keybindings.md](docs/keybindings.md).

**Commonly used:**

| Key | Action |
|-----|--------|
| Ctrl+C | Interrupt active work, or show the exit hint when idle |
| Ctrl+C twice | Exit while the exit hint is visible |
| Escape | Clear the input without interrupting active work |
| Escape twice | Open `/tree` |
| Ctrl+L | Open model selector |
| Ctrl+P / Shift+Ctrl+P | Cycle scoped models forward/backward |
| Ctrl+O | Collapse/expand tool output |
| Ctrl+T | Collapse/expand thinking blocks |

### Message Queue

Submit messages while the agent is working:

- **Enter** queues a *steering* message, delivered after the current assistant turn finishes executing its tool calls
- **Alt+Enter** queues a *follow-up* message, delivered only after the agent finishes all work
- **Ctrl+C** interrupts active work; queued messages are kept and resume after your next submit or edit
- **Escape** clears the input without interrupting active work
- **Alt+Up / Alt+Down** browse queued messages individually and return to the editor draft
- While browsing, **Enter** applies the edit as steering input and **Alt+Enter** applies it as a follow-up; submitting an empty edit deletes the item
- **Ctrl+Alt+Up / Ctrl+Alt+Down** move the selected item earlier or later within its queue

On Windows Terminal, `Alt+Enter` is fullscreen by default. Remap it in [docs/terminal-setup.md](docs/terminal-setup.md) so Base Context can receive the follow-up shortcut.

Configure delivery in [settings](docs/settings.md): `steeringMode` and `followUpMode` can be `"one-at-a-time"` (default, waits for response) or `"all"` (delivers all queued at once). `transport` selects provider transport preference (`"sse"`, `"websocket"`, or `"auto"`) for providers that support multiple transports.

## Sessions

Saved sessions use native session journals with a tree structure. Entries have an `id` and `parentId`, enabling in-place branching. Do not treat the journal as plain JSONL or edit it as a text log. See [docs/session-format.md](docs/session-format.md) for the format.

### Management

Sessions auto-save under `~/.base-context/sessions/`. Each session header records its working directory. Use the native saved-session view to search and reopen them.

```bash
base-context -c                  # Continue most recent session
base-context -r [path|id]        # Browse past sessions or resume one directly
base-context --no-session        # Ephemeral mode (don't save)
base-context --fork <path|id>    # Fork specific session file or ID into a new session
```

Use `/session` in interactive mode to see the current session ID before reusing it with `--resume <id>` or `--fork <id>`.

### Branching

**`/tree`** - Navigate the session tree in-place. Select any previous point, continue from there, and switch between branches. All history preserved in a single file.

<p align="center"><img src="docs/images/tree-view.png" alt="Tree View" width="600"></p>

*Historical screenshot inherited through Prime Agent, not a current Base Context capture.*

- Search by typing, fold/unfold and jump between branches with Ctrl+←/Ctrl+→ or Alt+←/Alt+→, page with ←/→
- Filter modes (Ctrl+O): default → no-tools → user-only → labeled-only → all
- Press Shift+L to label entries as bookmarks and Shift+T to toggle label timestamps

**`/fork`** - Create a new session file from a previous user message on the active branch. Opens a selector, copies the active path up to that point, and places the selected prompt in the editor for modification.

**`/clone`** - Duplicate the current active branch into a new session file at the current position. The new session keeps the full active-path history and opens with an empty editor.

**`--fork <path|id>`** - Fork an existing session file or partial session UUID directly from the CLI. This copies the full source session into a new session file in the current project.

### Compaction

Long sessions can exhaust context windows. Compaction summarizes older messages while keeping recent ones.

**Manual:** `/compact` or `/compact <custom instructions>`

**Automatic:** Enabled by default. Triggers on context overflow (recovers and retries) or when approaching the limit (proactive). Configure via `/settings` or `settings.json`.

Compaction is lossy; it does not delete the retained source history. Use `/tree` to revisit it. `compaction.model` and `branchSummary.model` can select independent summary models and effort; their absent-setting behavior differs. See [settings](docs/settings.md#compaction) and [compaction internals](docs/compaction.md).

## Settings

Use `/settings` to modify common options, or edit JSON files directly:

| Location | Scope |
|----------|-------|
| `~/.base-context/settings.json` | Global (all projects) |
| `.base-context/settings.json` | Project (overrides global) |

See [docs/settings.md](docs/settings.md) for all options.

### Update checks

Update lookup uses the owned `@ponythewhite/base-context` package by default. A private release destination requires explicit `BASE_CONTEXT_DOWNLOAD_BASE_URL`; there is no inherited upstream download destination. This does not imply that a public release is available. See [update settings](docs/settings.md#update-checks).

Set `BASE_CONTEXT_SKIP_VERSION_CHECK=1` to skip version checks. Use `--offline` or `BASE_CONTEXT_OFFLINE=1` to disable startup network operations, including version and package update checks.

## Context Files

Base Context loads `AGENTS.md` (or `CLAUDE.md`) at startup from:
- `~/.base-context/AGENTS.md` (global)
- Parent directories (walking up from cwd)
- Current directory

Use for project instructions, conventions, common commands. All matching files are concatenated.

Disable context file loading with `--no-context-files` (or `-nc`).

### System Prompt

Replace the default system prompt with `.base-context/SYSTEM.md` (project) or `~/.base-context/SYSTEM.md` (global). Append without replacing via `APPEND_SYSTEM.md`.

## Customization

### Prompt Templates

Reusable prompts as Markdown files. Type `/name` to expand.

```markdown
<!-- ~/.base-context/prompts/review.md -->
Review this code for bugs, security issues, and performance problems.
Focus on: {{focus}}
```

Place in `~/.base-context/prompts/`, `.base-context/prompts/`, or a [Base Context package](#base-context-packages) to share with others. See [docs/prompt-templates.md](docs/prompt-templates.md).

### Skills

On-demand capability packages follow the [Agent Skills standard](https://agentskills.io). Startup metadata advertises visible skill names, types, descriptions, and locations. Full instructions load on demand.

**Native epochs:** select an advertised skill with `prime_context` using `{"action":"skill","name":"..."}`. The result supplies the captured instructions and a canonical source reference. Use that returned ref and field with `action="read"` for bounded recovery. Do not reopen the mutable location to replace a selected version. A committed epoch retains its selected descriptor and instruction body; a later selection after a new epoch commits can capture updated content. File edits alone do not replace an active selection, and its captured body remains recoverable after rotation.

Native model-invocable skills are advertised only when the configured tools permit that selection/recovery route. A disabled, replaced, or disallowed tool is not enabled implicitly. Explicit `/skill:name` invocation remains available. **Generic non-native requests** retain the existing `ipython` file-read path. See [how skills work](docs/skills.md#how-skills-work).

```markdown
<!-- ~/.base-context/skills/my-skill/SKILL.md -->
---
name: my-skill
description: Use this skill when the user asks about X.
---

# My Skill

## Steps
1. Do this
2. Then that
```

Skills can also be Python-backed, with `SKILL.md`, `pyproject.toml`, and `src/<import_name>/`. Normal kernel setup installs these packages editable and exposes their import names. Owned installations use the selected release-local runtime; manual Python overrides have separate setup requirements. Captured skill instructions are not immutable snapshots of Python packages or filesystem contents. See [Python-backed skills](docs/skills.md#python-backed-skills).

Place in `~/.base-context/skills/`, `~/.agents/skills/`, `.base-context/skills/`, or `.agents/skills/` (from `cwd` up through parent directories) or a [Base Context package](#base-context-packages) to share with others. See [docs/skills.md](docs/skills.md).

Base Context includes a built-in `websearch` skill (Google search via the [Serper](https://serper.dev) API). It loads by default; run `/login`, switch to **MCP Connections**, and choose "Serper (web search)" to add your key. Disable it with `bundledSkills.websearch: false`, or override it with your own `websearch` skill in any location above. See [docs/skills.md#built-in-skills](docs/skills.md#built-in-skills).

### MCP Integrations

Connect external services (Linear, Notion, …) over the [Model Context Protocol](https://modelcontextprotocol.io). Consistent with the single-tool design, MCP is **not** exposed as new agent tools — each integration is a Python skill package the model imports and calls from the kernel:

```python
import linear
issues = await linear.list_issues(team="Engineering")   # tools auto-discovered from the server
help(linear.list_issues)                                 # description + argument schema
```

Built-in integrations for Linear and Notion ship disabled. **Logging in enables them**: open `/login`, switch to **MCP Connections**, pick the integration, and complete OAuth in the browser. The integration's skill then becomes visible and is auto-imported into the kernel. `/mcp` opens the same tab, while its subcommands support direct management:

```
/mcp                 list integrations and connection status
/mcp login <name>    connect via OAuth (browser)
/mcp logout <name>   disconnect
```

Credentials are stored once in `~/.base-context/auth.json` (under `mcp:<name>`); the kernel reads them directly and the host refreshes expired tokens. Enablement is derived from whether valid credentials exist, so there is no separate on/off switch.

**Add your own server.** Declare it under `mcpServers` in settings, then ship a tiny Python skill package that subclasses `McpIntegration`:

```jsonc
// ~/.base-context/settings.json
{
  "mcpServers": {
    "acme": { "type": "http", "url": "https://mcp.acme.com/mcp", "oauth": true }
  }
}
```

```python
# ~/.base-context/skills/acme/src/acme/__init__.py
from rlm import McpIntegration

class Acme(McpIntegration):
    server = "acme"
    url = "https://mcp.acme.com/mcp"

acme = Acme()

def __getattr__(name):     # so `import acme; await acme.<tool>(...)` works
    return getattr(acme, name)
```

The base class connects with the official `mcp` SDK, injects the bearer token from `auth.json`, and binds the server's tools as async methods. Use `await acme.call_tool("name", {...})` for tools whose names aren't valid Python identifiers, or a static `bearerTokenEnvVar` instead of OAuth.

See [docs/mcp-integrations.md](docs/mcp-integrations.md) for the full authoring guide (package layout, auth options, the `McpIntegration` API, and caveats).

### Extensions

<p align="center"><img src="docs/images/doom-extension.png" alt="Doom Extension" width="600"></p>

*Historical screenshot inherited through Prime Agent, not a current Base Context capture.*

TypeScript modules that extend Base Context with custom tools, commands, keyboard shortcuts, event handlers, and UI components.

```typescript
import type { ExtensionAPI } from "@ponythewhite/base-context";

export default function (pi: ExtensionAPI) {
  pi.registerTool({ name: "deploy", ... });
  pi.registerCommand("stats", { ... });
  pi.on("tool_call", async (event, ctx) => { ... });
}
```

The default export can also be `async`. Base Context waits for async extension factories before startup continues, which is useful for one-time initialization such as fetching remote model lists before calling `pi.registerProvider()`.

**What's possible:**
- Custom tools (or replace built-in tools entirely)
- Additional orchestration workflows and plan modes
- Custom compaction and summarization
- Permission gates and path protection
- Custom editors and UI components
- Status lines, headers, footers
- Git checkpointing and auto-commit
- SSH and sandbox execution
- MCP server integration
- Make Base Context look like Claude Code
- Games while waiting (yes, Doom runs)
- ...anything you can dream up

Place in `~/.base-context/extensions/`, `.base-context/extensions/`, or a [Base Context package](#base-context-packages) to share with others. See [docs/extensions.md](docs/extensions.md) and [examples/extensions/](examples/extensions/).

### Themes

Built-in: `dark`, `light`. Themes hot-reload: modify the active theme file and Base Context immediately applies changes.

Place in `~/.base-context/themes/`, `.base-context/themes/`, or a [Base Context package](#base-context-packages) to share with others. See [docs/themes.md](docs/themes.md).

### Base Context Packages

Bundle extensions, skills, prompts, and themes through npm or git sources you control. The example sources below are placeholders, not published Base Context release artifacts.

> **Security:** Base Context packages run with full system access. Extensions execute arbitrary code, and skills can instruct the model to perform any action including running executables. Review source code before installing third-party packages.

```bash
base-context package install npm:@foo/agent-tools
base-context package install npm:@foo/agent-tools@1.2.3  # pinned version
base-context package install git:github.com/user/repo
base-context package install git:github.com/user/repo@v1       # tag or commit
base-context package install git:git@github.com:user/repo
base-context package install https://github.com/user/repo
base-context package install ssh://git@github.com/user/repo
base-context package remove npm:@foo/agent-tools
base-context package list
base-context package update                                  # update packages, except pinned versions
base-context package update npm:@foo/agent-tools       # update one package
base-context update                                          # update Base Context
base-context update --force                                  # reinstall Base Context even if current
base-context config                                          # enable/disable package resources
```

Packages install to `~/.base-context/git/` (git) or global npm. Use `--local` for project-local installs (`.base-context/git/`, `.base-context/npm/`). Git packages install dependencies with `npm install --omit=dev` by default, so runtime deps must be listed under `dependencies`; when `npmCommand` is configured, git packages use plain `install` for compatibility with wrappers. If you use a Node version manager and want package installs to reuse a stable npm context, set `npmCommand` in `settings.json`, for example `["mise", "exec", "node@22.12.0", "--", "npm"]`.

Create a package by adding the inherited `pi` manifest key to `package.json`:

```json
{
  "name": "my-agent-package",
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

Without a `pi` manifest, Base Context auto-discovers from conventional directories (`extensions/`, `skills/`, `prompts/`, `themes/`).

See [docs/packages.md](docs/packages.md).

## Programmatic Usage

### SDK

These imports refer to the built source workspace packages, not an available public npm release.

```typescript
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager } from "@ponythewhite/base-context";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage,
  modelRegistry,
});

await session.prompt("What files are in the current directory?");
```

For advanced multi-session runtime replacement, use `createAgentSessionRuntime()` and `AgentSessionRuntime`.

See [docs/sdk.md](docs/sdk.md) and [examples/sdk/](examples/sdk/).

### RPC Mode

For non-Node.js integrations, use RPC mode over stdin/stdout:

```bash
base-context --mode rpc
```

RPC mode uses strict LF-delimited JSONL framing. Clients must split records on `\n` only. Do not use generic line readers like Node `readline`, which also split on Unicode separators inside JSON payloads.

See [docs/rpc.md](docs/rpc.md) for the protocol.

## Upstream

Base Context descends from [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent), which forked [pi-mono](https://github.com/badlogic/pi-mono) by Mario Zechner. The package architecture and extension model retain that lineage, including the `pi` manifest key. Copyright and MIT attribution remain in the [root license](../../LICENSE). Historical screenshots in this README are inherited through Prime Agent; they are not current Base Context captures.

## CLI Reference

```bash
base-context [options] [@files...] [messages...]
```

Run `base-context help` for the command list and `base-context help <command>` for details.

### Agent Commands

```bash
base-context agents                         # Search running, idle, and inactive sessions
base-context list [--all]                   # List active or saved agents
base-context attach <agent>                 # Attach the interactive UI
base-context stop <agent>                   # Stop one agent
base-context rename <agent> <name>          # Rename an agent
base-context send <agent> <message>         # Send an agent-to-agent message
base-context status                         # Show background service status
base-context doctor [--fix]                 # Inspect or safely clean up background services
base-context shutdown [--force]             # Stop every agent, worker, and background service
```

`shutdown` asks for confirmation. `shutdown --force` skips confirmation and kills unresponsive workers and their tracked child processes.

### Scheduled Prompts

```bash
base-context schedule list [--all] [agent]
base-context schedule add <agent> <schedule> -- <message>
base-context schedule cancel <job-id>
```

Schedules run prompts later or repeatedly. A schedule can be a supported one-time expression such as `in 5m` or a cron expression.

### Package and Update Commands

Packages bundle capabilities such as extensions, skills, prompts, and themes.

```bash
base-context package install <source> [--local]
base-context package remove <source> [--local]
base-context package list
base-context package update [source]
base-context update [--force]                   # Update Base Context itself
base-context config                             # Enable/disable package resources
```

### Modes

| Flag | Description |
|------|-------------|
| (default) | Interactive mode |
| `-p`, `--print` | Print response and exit |
| `--mode json` | Output all events as JSON lines (see [docs/json.md](docs/json.md)) |
| `--mode rpc` | RPC mode for process integration (see [docs/rpc.md](docs/rpc.md)) |

In print mode, Base Context also reads piped stdin and merges it into the initial prompt:

```bash
cat README.md | base-context -p "Summarize this text"
```

### Model Options

| Option | Description |
|--------|-------------|
| `--provider <name>` | Provider (anthropic, openai, google, etc.) |
| `--model <pattern>` | Model pattern or ID (supports `provider/id` and optional `:<thinking>`) |
| `--api-key <key>` | API key (overrides env vars) |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` (subject to model support) |
| `--models <patterns>` | Comma-separated patterns for Ctrl+P cycling |

Use `base-context model list [search]` to list available models.

### Session Options

| Option | Description |
|--------|-------------|
| `-c`, `--continue` | Continue most recent session |
| `-r`, `--resume [path\|id]` | Open the searchable session view, or resume a specific session file or partial UUID |
| `--fork <path\|id>` | Fork specific session file or partial UUID into a new session |
| `--session-dir <dir>` | Custom session storage directory |
| `--no-session` | Ephemeral mode (don't save) |

Use `base-context session export <file> [output]` to export a saved session to HTML.

### Tool Options

| Option | Description |
|--------|-------------|
| `--tools <list>`, `-t <list>` | Allowlist specific tool names across built-in, extension, and custom tools |
| `--no-builtin-tools`, `-nbt` | Disable built-in tools by default but keep extension/custom tools enabled |
| `--no-tools`, `-nt` | Disable all tools by default |

The persistent kernel tool is `ipython`. Native context selection and recovery use `prime_context` when permitted for the request. Tool allowlists also affect native skill advertisement; see [Skills](#skills).

### Resource Options

| Option | Description |
|--------|-------------|
| `-e`, `--extension <source>` | Load extension from path, npm, or git (repeatable) |
| `--no-extensions` | Disable extension discovery |
| `--skill <path>` | Load skill (repeatable) |
| `--no-skills` | Disable skill discovery |
| `--prompt-template <path>` | Load prompt template (repeatable) |
| `--no-prompt-templates` | Disable prompt template discovery |
| `--theme <path>` | Load theme (repeatable) |
| `--no-themes` | Disable theme discovery |
| `--no-context-files`, `-nc` | Disable AGENTS.md and CLAUDE.md context file discovery |

Combine `--no-*` with explicit flags to load exactly what you need, ignoring settings.json (e.g., `--no-extensions -e ./my-ext.ts`).

### Autonomous Options

Autonomous mode is disabled by default. `--autonomous` or any of its sub-options enables host-managed continuations for unattended work.

| Option | Description |
|--------|-------------|
| `--autonomous` | Continue until gates pass or a limit prevents another continuation |
| `--autonomous-gate <command>` | Add a repeatable shell command that must pass before completion |
| `--autonomous-gate-retries <n>` | Positive per-gate retry limit; default `3` |
| `--autonomous-gate-timeout-ms <n>` | Positive per-gate timeout in milliseconds; default `300000` |
| `--autonomous-max-continuations <n>` | Positive host follow-up limit; default `3` |
| `--autonomous-max-turns <n>` | Positive assistant-turn limit; default `12` |
| `--autonomous-max-tokens <n>` | Positive token limit; default `80000` |
| `--autonomous-timeout-ms <n>` | Positive wall-clock limit in milliseconds; default `1800000` |

Gates run before the continuation, turn, token, and wall-clock limits are evaluated; every configured gate must pass for autonomous completion. See the [usage guide](docs/usage.md#autonomous-options) for validation rules, retry behavior, and detailed limit interactions.

### Other Options

| Option | Description |
|--------|-------------|
| `--system-prompt <text>` | Replace default prompt (context files and skills still appended) |
| `--append-system-prompt <text>` | Append to system prompt |
| `--verbose` | Force verbose startup |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show version |

### File Arguments

Prefix files with `@` to include in the message:

```bash
base-context @prompt.md "Answer this"
base-context -p @screenshot.png "What's in this image?"
base-context @code.ts @test.ts "Review these files"
```

### Examples

```bash
# Interactive with initial prompt
base-context "List all .ts files in src/"

# Non-interactive
base-context -p "Summarize this codebase"

# Non-interactive with piped stdin
cat README.md | base-context -p "Summarize this text"

# Different model
base-context --provider openai --model gpt-4o "Help me refactor"

# Model with provider prefix (no --provider needed)
base-context --model openai/gpt-4o "Help me refactor"

# Model with thinking level shorthand
base-context --model sonnet:high "Solve this complex problem"

# Limit model cycling
base-context --models "claude-*,gpt-4o"

# Restrict to the built-in Python REPL tool
base-context --tools ipython -p "Review the code"

# High thinking level
base-context --thinking high "Solve this complex problem"
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `BASE_CONTEXT_HOME` | Absolute global state directory (default: `~/.base-context`) |
| `BASE_CONTEXT_SESSION_DIR` | Session storage directory (overridden by `--session-dir`) |
| `BASE_CONTEXT_PACKAGE_DIR` | Package directory override |
| `BASE_CONTEXT_OFFLINE` | Disable startup network operations, including version and package update checks |
| `BASE_CONTEXT_SKIP_VERSION_CHECK` | Skip the Base Context version update check |
| `BASE_CONTEXT_DOWNLOAD_BASE_URL` | Explicit private release manifest and tarball destination; not evidence of a published release |
| `BASE_CONTEXT_TELEMETRY` | Opt in to or disable aggregate usage analytics; off by default |
| `BASE_CONTEXT_TELEMETRY_ENDPOINT` | Explicit aggregate analytics endpoint |
| `BASE_CONTEXT_TELEMETRY_API_KEY` | Dedicated aggregate analytics credential |
| `DO_NOT_TRACK` | Disable aggregate usage analytics when set to `1`/`true`/`yes` |
| `PI_CACHE_RETENTION` | Provider-layer cache preference; `long` requests extended retention where supported |
| `PRIME_API_KEY` | Prime Inference API key |
| `BASE_CONTEXT_KERNEL_PYTHON` | Existing Python with a current `base-context-runtime`; manual override outside default owned pairing |
| `BASE_CONTEXT_KERNEL_VENV` | Select a different Python venv |
| `VISUAL`, `EDITOR` | External editor for Ctrl+G |

Provider and shared environment names retain their own contracts. They are not product-state aliases. See [settings](docs/settings.md) for update and analytics policy, and [skills](docs/skills.md#python-backed-skills) for Python environment behavior.

## Contributing & Development

Use the [Base Context repository](https://github.com/BaseModelAI/base-context) for project information and [discussions](https://github.com/BaseModelAI/base-context/discussions) for questions. Follow the owned [contribution guidelines](../../CONTRIBUTING.md) and [security policy](../../SECURITY.md). See [docs/development.md](docs/development.md) for source setup and debugging.

## License

[MIT](../../LICENSE). Preserve the upstream copyright and license notices.

## See Also

- [`@ponythewhite/base-context-ai`](../ai): Core LLM toolkit
- [`@ponythewhite/base-context-agent`](../agent): Agent framework
- [`@ponythewhite/base-context-tui`](../tui): Terminal UI components
