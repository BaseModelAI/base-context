# A ten-minute workflow

Base Context gives a coding agent a persistent Python workspace. You ask for an outcome; the agent uses Python to keep data and command handles, run project tools, and coordinate workers. You do not need to write Python yourself.

## 1. Install, log in, and choose a model

On macOS or Linux:

```bash
curl -fsSL https://github.com/BaseModelAI/base-context/releases/latest/download/install.sh | bash
```

The installer offers missing prerequisites and prepares managed Python. Follow its final PATH instruction, then start in a project you trust:

```bash
cd /path/to/project
base-context
```

Use `/login`, `/model`, and `/effort` to choose your provider, model, and reasoning level. Authentication does not choose a model for you. Login credentials stay under `~/.base-context/auth.json`; provider environment variables keep their real names, such as `OPENAI_API_KEY`. Base Context does not borrow Prime Agent's login files.

For npm, Windows, source builds, updates, rollback, or uninstall, use the [installation guide](installation.md). Choose one installation route, not several.

## 2. Inspect once, then reuse the result

Try this prompt:

```text
Read the project instructions and README. Find the documented check command.
Keep a file list and a short project summary in Python variables for this session.
Do not install dependencies or edit files yet. Tell me which small check to run first.
```

Then:

```text
Use the file list you already kept. Run the suggested check in the project's own
environment. If its output is long, retain it and show only the first useful failure.
```

The workspace keeps parsed data and handles across tool calls. Long tool output can stay in retained history while the model reads a small excerpt. Ask for a particular failure or line later instead of rerunning the command just to recover its output.

This is not unlimited memory. Kernel restoration is best-effort, and some Python objects cannot be restored. Save important deliverables in project files.

## 3. Make one change with a clear constraint

If the check fails, ask:

```text
Fix that failure. Keep the public API unchanged. Run the smallest relevant check,
then explain the change and any remaining failures.
```

If the check passes, choose a small change instead: “Add one example for the parser in the README. Do not change code.”

Put lasting project rules in `AGENTS.md`. Base Context reads global instructions from `~/.base-context/AGENTS.md` and project instructions from parent/current directories. Restart or use `/reload` after changing them.

For a longer session, `/compact` summarizes the working conversation. A small **TaskFrame** carries selected earlier user instructions and goal state that are no longer literal in the request. The agent can use `prime_context` to recover an original passage when the summary lacks a detail. Selection is bounded; it does not guarantee that every old instruction is always visible.

## 4. Delegate only independent work

```text
Ask one worker to review the changed API. While it works, finish the documentation.
Wait for its reply before you give me the final result.
```

Workers have their own context. They report through messages or files; their entire transcripts do not enter the parent's prompt. `/agents` shows the capacity limit, and `/agents 4` sets it. The default is four across the root family, including pending, running, and idle workers. Reducing the cap does not stop existing workers.

Use `/btw Why did you choose this approach?` for a tool-free side question that does not steer the main task. Esc closes the side pane.

## 5. Continue later

First, list resident agents:

```bash
base-context list
```

To reconnect to one, run `base-context attach <agent>` with the name or ID from that list. To continue the latest saved session instead, run `base-context -c`. These are alternative routes, not three setup commands to run in sequence.

`attach` returns to a resident agent; `-c` continues the latest saved session. Closing the terminal can leave interactive work running. Use `base-context stop <agent>` to stop one agent, or `base-context shutdown` to stop all agents and services.

For work that should keep going across turns, explicitly start a goal:

```text
/goal Implement the migration in PLAN.md and run the documented checks
```

Manage it with `/goal status`, `/goal pause`, `/goal resume`, or `/goal clear`. An optional goal token budget counts successful root-main uncached input and output, not cached input, children, auxiliary calls, or total spend. See [persistent goals](long-running-agents.md#persistent-goals).

## What needs extra configuration?

The Python workspace, retained output, instruction frame, compaction, and workers are available in ordinary sessions. **Request-budget selection and stable context epochs need an explicit profile.** They are not active just because you launched the CLI. Use the [offline-tested settings example](request-token-budgets.md) if you want to opt in on a supported route.

Use `/context` and `/usage` to inspect the session. Python and project commands run with your user permissions, not inside a built-in security sandbox. Use an external sandbox for untrusted code.

Next: [usage and CLI options](usage.md) · [providers](providers.md) · [settings](settings.md) · [context design](context-management.md) · [keybindings](keybindings.md).
