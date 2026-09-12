# Quickstart

This page gets you to a useful first Base Context session. Base Context is a fork of Prime Agent, which descends from pi-mono; it uses its own command, packages and state.

## Install or Build from Source

Public npm/GitHub publication remains approval-gated. Do not use Prime Agent's installer to install Base Context. Follow the [current source setup and release status](../../../README.md#getting-started).

Use Node.js `^22.12.0 || >=23.3.0` and a compatible npm version:

```bash
git clone --branch implement/base-context-v0.1 https://github.com/BaseModelAI/base-context.git
cd base-context
npm ci
npm run build:source
node packages/coding-agent/dist/bundle/cli.js
```

To use the source build in another project, keep that project as the working directory:

```bash
cd /path/to/project
node /absolute/path/to/base-context/packages/coding-agent/dist/bundle/cli.js
```

Examples below use `base-context` as shorthand for that Node invocation or the installed owned launcher. The [owned installer and rollback guide](../../../README.md#owned-installer-and-rollback) describes its separate versioned CLI/Python environment. The stable launcher is `<owned-root>/bin/base-context`; apply its PATH guidance after an approved installation. These instructions do not claim that public release endpoints are available.

## Authenticate

Base Context uses `~/.base-context/auth.json` under its own product root. Do not copy Prime credential stores or assume that upstream OAuth clients are authorized for the fork. Choose an explicitly supported route in the [provider guide](providers.md).

### Subscription or Stored API Credentials

Start Base Context and run:

```text
/login
```

Use only the provider/auth routes supported for your setup. A model catalog entry does not establish subscription entitlement or authentication. See [SDK authentication](sdk.md) for explicit subscription configuration.

### API Key

Set the real provider's environment variable before launching Base Context:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
base-context
```

You can also select a supported API-key provider in `/login` to store its credential under `~/.base-context/auth.json`. `BASE_CONTEXT_HOME` changes that product root. Provider variables such as `ANTHROPIC_API_KEY` and `PRIME_API_KEY` keep their real provider names; they are not product-prefix aliases.

## First Session

Once Base Context starts, type a request and press Enter:

```text
Summarize this repository and tell me how to run its checks.
```

Base Context uses the persistent `ipython` kernel for file operations, project commands, data analysis and installed skills. The owned installer prepares a fresh release-local Python environment before activation. A non-owned source setup bootstraps its default environment under `~/.base-context/runtime` on first use. `BASE_CONTEXT_KERNEL_PYTHON` selects an explicit manual Python executable with a current `base-context-runtime`; the Python import remains `rlm`. An upstream `prime-agent-runtime` environment is not a substitute.

Base Context runs in your current working directory and can modify files there. Use git or another checkpointing workflow if you want easy rollback.

## Recursive Subagents

Recursive subagents are a built-in Base Context capability. The model spawns independent work from the Python REPL with `await rlm("subtask")`; each call returns at admission with a child handle and never returns the answer. Children send requested results as explicit `agent_message` replies to the parent or write them to files. Child agents use the same TypeScript agent runtime, providers, tools, skills, and session machinery as the parent.

You can prompt the model to use that capability directly:

```text
Delegate the requested parser change as one bounded subtask. Work on the independent documentation update while it runs, then read its reply before integrating the change.
```

See [RLM Runtime Architecture](rlm-runtime.md) for the API and execution model.

## Give Base Context Project Instructions

Base Context loads context files at startup. Add an `AGENTS.md` file to tell it how to work in a project:

```markdown
# Project Instructions

- Run `npm run check` after code changes.
- Do not run production migrations locally.
- Keep responses concise.
```

Base Context loads:

- `~/.base-context/AGENTS.md` for global instructions
- `AGENTS.md` or `CLAUDE.md` from parent directories and the current directory

Restart Base Context, or run `/reload`, after changing context files.

## Common Things to Try

### Reference Files

Type `@` in the editor to fuzzy-search files, or pass files on the command line:

```bash
base-context @README.md "Summarize this"
base-context @src/app.ts @src/app.test.ts "Review these together"
```

Images can be pasted with Ctrl+V (Alt+V on Windows) or dragged into supported terminals.

### Run Shell Commands

In interactive mode:

```text
!npm run lint
```

The command output is sent to the model. Use `!!command` to run a command without adding its output to model context. During agent work, the model normally runs project commands from the Python REPL with `bash()`.

### Switch Models

Use `/model` or Ctrl+L to choose a model. Use `/effort` to set the reasoning level. Use Ctrl+P / Shift+Ctrl+P to cycle through scoped models.

### Continue Later

Native sessions are saved under `~/.base-context/sessions/` as framed journals, even though filenames end in `.jsonl`. They are not plain JSONL; use the native session/export commands. `BASE_CONTEXT_HOME` sets the product root, while `BASE_CONTEXT_SESSION_DIR` controls session storage independently:

```bash
base-context -c                  # Continue the most recent session
base-context -r [path|id]        # Browse sessions or open a specific session
```

Inside Base Context, use `/resume`, `/new`, `/tree`, `/fork`, and `/clone` to manage sessions. Persistent sessions run in worker processes, so closing the TUI detaches from the agent rather than necessarily stopping it. Use `base-context agents` to inspect or reattach to active work.

For legacy data, use the [offline migration steps](usage.md#import-an-offline-prime-export) and [current migration limits](../../../README.md#import-an-offline-prime-export), not `/resume` on a live Prime root. Imported packages stay inactive. Matched supported top-level schedules remain paused with new IDs; migration does not dispatch jobs, restore a kernel, reactivate historical goals or copy credentials.

### Non-Interactive Mode

For one-shot prompts:

```bash
base-context -p "Summarize this codebase"
cat README.md | base-context -p "Summarize this text"
base-context -p @screenshot.png "What's in this image?"
```

Use `--mode json` for JSON event output or `--mode rpc` for process integration.

## Next Steps

- [Using Base Context](usage.md) - interactive mode, slash commands, sessions, context files, and CLI reference.
- [Providers](providers.md) - authentication and model setup.
- [Settings](settings.md) - global and project configuration.
- [Keybindings](keybindings.md) - shortcuts and customization.
- [Base Context Packages](packages.md) - install shared extensions, skills, prompts, and themes.

Platform notes: [Windows](windows.md), [Termux](termux.md), [tmux](tmux.md), [Terminal setup](terminal-setup.md), [Shell aliases](shell-aliases.md).
