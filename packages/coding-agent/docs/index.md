# Synerise base-context documentation

Base Context is a coding and research agent built around a persistent Python workspace, recursive agents, and source-backed context management. It is an MIT-licensed fork of Prime Agent by Synerise.

## Quick start

On macOS or Linux:

```bash
curl -fsSL https://github.com/BaseModelAI/base-context/releases/latest/download/install.sh | bash
```

The installer prepares missing prerequisites and managed Python before activating the CLI. Run its final PATH command, then start `base-context` in your project. Use `/login` for your provider, `/model` for your model, and `/effort` for its reasoning level.

Follow the [ten-minute workflow](quickstart.md) for a first session. Use [installation](installation.md) for npm, Windows, source builds, updates, rollback, and uninstall. Coming from Codex? See [goals, worker limits, and side questions](long-running-agents.md).

Read [why we forked Prime Agent](fork-philosophy.md) and [how context management works](context-management.md) for the design and its limits.

## Start Here

- [Quickstart](quickstart.md) - install, authenticate, and run a first session.
- [Using Base Context](usage.md) - interactive mode, RLM subagents, slash commands, context files, and CLI reference.
- [Architecture overview](architecture.md) - client, daemon, worker, session, kernel, provider, and storage boundaries.
- [RLM programming model](rlm.md) - programmatic execution, native subagents, Python skills, and durable state.
- [Long-running and background agents](long-running-agents.md) - daemon workers, messaging, heartbeats, goals, schedules, and autonomous mode.
- [Providers](providers.md) - subscription and API-key setup for built-in providers.
- [Settings](settings.md) - global and project settings.
- [Request token budgets](request-token-budgets.md) - opt-in CLI/settings profile, supported routes, and field meanings.
- [Keybindings](keybindings.md) - default shortcuts and custom keybindings.
- [Sessions](sessions.md) - session management, branching, and tree navigation.
- [Compaction](compaction.md) - context compaction and branch summarization.

## Customization

- [Extensions](extensions.md) - TypeScript modules for tools, commands, events, and custom UI.
- [Skills](skills.md) - markdown and Python-backed skills, including how to ask Base Context to create them.
- [MCP integrations](mcp-integrations.md) - use MCP servers through Python skills without expanding the model's tool surface.
- [Prompt templates](prompt-templates.md) - reusable prompts that expand from slash commands.
- [Themes](themes.md) - built-in and custom terminal themes.
- [Base Context packages](packages.md) - bundle and share extensions, skills, prompts, and themes.
- [Custom models](models.md) - add model entries for supported provider APIs.
- [Custom providers](custom-provider.md) - implement custom APIs and OAuth flows.

## Programmatic Usage

- [SDK](sdk.md) - embed Base Context in Node.js applications.
- [ACP mode](acp.md) - drive Base Context from any Agent Client Protocol client.
- [RPC mode](rpc.md) - integrate over stdin/stdout JSONL.
- [JSON event stream mode](json.md) - print mode with structured events.
- [TUI components](tui.md) - build custom terminal UI for extensions.

## Reference

- [Session format](session-format.md) - Native framed session format, entry types, and SessionManager API.
- [CLI reference](usage.md#cli-reference) - commands, flags, modes, and environment variables.
- [Benchmark results](../../../benchmarks/python-realworld-30/README.md) - Base Context 1.1.1 versus Codex 0.160.0 on two model/effort profiles.

## Platform Setup

- [Windows](windows.md)
- [Termux on Android](termux.md)
- [tmux](tmux.md)
- [Terminal setup](terminal-setup.md)
- [Shell aliases](shell-aliases.md)

## Development

- [Development](development.md) - local setup, configuration, debugging, and validation.
- [Architecture overview](architecture.md) - system topology and end-to-end prompt flow.
- [Daemon Architecture](daemon.md) - supervisor, catalog, worker, lifecycle, and recovery details.
- [Agent Connection Architecture](agent-connection.md) - client/runtime connection boundary.
- [RLM Runtime Architecture](rlm-runtime.md) - stdio kernel transport and recursive subagent execution.
