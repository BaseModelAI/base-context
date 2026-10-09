# Synerise Base Context

base-context — made in ![Poland](packages/coding-agent/docs/images/poland-flag.svg) by [Synerise AI](https://synerise.com).

**Keep the work. Focus the context.**

Give your agent a workspace, not just a conversation. Base Context combines **persistent Python, retained outputs, and instruction recovery** to keep coding and research moving across long sessions. Built by [Synerise](https://synerise.com), on [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent).

[![Curated R1: 27–39% shorter mean attempt times for Base Context across three matching profiles, with 150/150 native completions.](packages/coding-agent/docs/images/benchmarks/curated50-overview.svg)](benchmarks/context-curated-50/README.md)

**27–39% shorter mean attempt times. 150/150 native completions.** In our curated 50-task R1 benchmark, Base was also faster in **128 of 141 pairs** where both agents completed and fully passed. [Explore the results](#benchmarks).

[Install](#install) · [Workflow](#work-with-it) · [Benchmarks](#benchmarks) · [Design](#how-it-works) · [Documentation](#documentation) · [Attribution](#license-and-thanks)

## Install

On **macOS or Linux**:

```bash
curl -fsSL https://github.com/BaseModelAI/base-context/releases/latest/download/install.sh | bash
```

The installer offers missing prerequisites and prepares Node.js, `uv`, and managed Python. Run the final PATH command it prints, then:

```bash
cd /path/to/your/project
base-context
```

**Bring your existing provider account.** Choose **`/login`**, then **`/model`** and **`/effort`**. Have ChatGPT with Codex access? Choose **OpenAI Codex** in `/login`—no separate API key needed. Other supported subscriptions and API keys are available through their provider routes. [Provider setup](packages/coding-agent/docs/providers.md).

This page describes **1.1.2**; install commands use the latest public release. [What's new](packages/coding-agent/docs/release-notes-1.1.2.md).

<details>
<summary>Prefer npm, Windows, or a source build?</summary>

For an existing Node.js/npm installation, use Node.js **22.12+ on 22.x, or 23.3+**. In Bash/Zsh:

```bash
npm install -g @ponythewhite/base-context
BASE_CONTEXT_INSTALL_UV=1 base-context
```

The first normal launch prepares managed Python; the flag permits installing missing `uv`. Use this route instead of the installer above.

[Windows/PowerShell, source builds, updates, rollback, and uninstall](packages/coding-agent/docs/installation.md).

</details>

## Built for work that takes more than one turn

### Inspect once. Build on it.

The persistent Python workspace keeps parsed data, variables, and command handles ready for the next step. Read a dataset, inspect a repository, start a command—then work with the result instead of recreating it. The agent runs project tools in the project's own environment. **You do not need to write Python yourself.**

### Keep the output. Lose the clutter.

A long log belongs in retained history, not in every model request. Base Context keeps the result and lets the agent recover a specific failure, passage, or line with `prime_context`. The useful evidence stays within reach while the conversation moves forward.

### Carry the thread through compaction.

A **TaskFrame** carries selected earlier user instructions and goal state alongside summaries, without repeating user text already visible in the request. Retained sources support recovery after a saved-session restart, too. Compact the conversation and keep working from the original details when they matter.

### Put independent work in parallel.

Give the API review to one worker and the documentation to another. Each gets its own context and reports back through messages or files. The parent can keep working on the main task while those results arrive.

These capabilities are available in ordinary sessions. Start with the [ten-minute workflow](packages/coding-agent/docs/quickstart.md).

## Work with it

**Coming from Codex?** Start in your repository, keep project rules in `AGENTS.md`, and ask for an outcome:

```text
Fix the failing parser test. Keep the public API unchanged and explain the change.
```

For a longer job, give the agent a persistent goal:

```text
/goal Implement the migration in PLAN.md and run the project checks
```

An active goal keeps work moving across turns. Use `/goal status`, `/goal pause`, `/goal resume`, or `/goal clear` to manage it. [Goals and background work](packages/coding-agent/docs/long-running-agents.md).

To split the work:

```text
Delegate the API review and documentation update to separate workers.
Keep working on the parser fix, then integrate their replies.
```

**`/agents 4`** sets the subagent cap; **`/agents`** shows it. The default is four. Open **`base-context agents`** to see your workers.

Want to ask a question without steering the main task? Use **`/btw Why did you choose this parser?`** for a separate, tool-free side conversation. **Esc** returns to the main editor.

| Want to… | Use |
| --- | --- |
| Add a file or run a command | `@path`, `!command`; `!!command` keeps output out of model context |
| Steer running work / queue a later request | Enter / Alt+Enter |
| Inspect context, tokens, and cost estimates | `/context` or `/usage` |
| Summarize context / refine saved harness advice | `/compact` / `/refine` |
| Continue the latest saved session | `base-context -c` |
| Reattach to a resident agent | `base-context attach <agent>` |
| Stop one agent / all agents and services | `base-context stop <agent>` / `base-context shutdown` |

Normal interactive sessions can keep running after the terminal detaches. Reattach when you're ready. [Full usage](packages/coding-agent/docs/usage.md).

## Benchmarks

### Long tasks. Less waiting.

Our **curated 50-task R1 comparison** puts Base Context development builds and **Codex 0.160.0** through staged work with forced compaction and scheduled cold restarts. Across three matching model/effort profiles, Base delivered **27–39% shorter mean attempt times**.

| Profile · 50 attempts per harness | Mean time, Base / Codex | Native completions, Base / Codex | Full artifact passes, Base / Codex |
| --- | ---: | ---: | ---: |
| GPT-6 Astra · medium | **508.4 / 697.2 s** | 50 / 50 | 49 / 50 |
| GPT-6.1 Sol · high | **606.4 / 967.4 s** | 50 / 50 | 50 / 49 |
| GPT-6.1 Sol · xhigh | **908.1 / 1,481.3 s** | 50 / 44 | 49 / 47 |

The speed difference also holds among successful runs: **Base was faster in 128/141 pairs where both harnesses completed natively and fully passed.** Across all selected attempts, Base completed **150/150** versus **144/150**, with **148/150** full artifact passes versus **146/150**. Artifact scores include three passing Codex timeouts; completion is scored separately.

[![Mean attempt time by profile and faster results among pairs where both harnesses completed and fully passed.](packages/coding-agent/docs/images/benchmarks/curated50-time.svg)](benchmarks/context-curated-50/README.md)

[![Curated R1 quality: full artifact passes, main-check accuracy, and mean progress scores by profile.](packages/coding-agent/docs/images/benchmarks/curated50-quality.svg)](benchmarks/context-curated-50/README.md)

### Cost, with the accounting visible

[![Known-usage API-rate cost subtotals, with separate hypothetical Codex same-model additions and model-price sensitivity.](packages/coding-agent/docs/images/benchmarks/curated50-cost.svg)](benchmarks/context-curated-50/README.md)

**Known costs\*** are API-rate subtotals from captured, priced usage—not invoices. Both harnesses have unpriced receipts, so totals are incomplete. Hatched additions show a **hypothetical same-main-model estimate** for Codex receipts with unknown model identities. [Cost breakdown and assumptions](benchmarks/context-curated-50/README.md).

**Scope:** R1, 50 curated and outcome-informed tasks, three profiles, first provider-clean attempt per cell. Clean failures and timeouts are included. Request-budget selection was off. [Full methodology](benchmarks/context-curated-50/README.md) covers task selection, provider exclusions, mixed builds, cost sensitivity, and archival R2. [Download the R1 summary](benchmarks/context-curated-50/summary-replica1.json).

Earlier comparisons remain **withdrawn** and available as archives: [Python 30](benchmarks/python-realworld-30/README.md) · [Earlier evaluation records](packages/coding-agent/docs/release-1.1.2.md).

## How it works

**Keep a notebook. Work from a clear desk.** Retained history is the notebook; the model's working context is the desk. Base Context separates them so the agent can keep its work without carrying every byte into every request.

![Base Context architecture: retained sources feed model context; a persistent Python workspace runs commands and skills and coordinates independent workers.](packages/coding-agent/docs/images/base-context-architecture.svg)

| Layer | What it brings to the workflow |
| --- | --- |
| Python workspace | Reusable variables, parsed data, skills, and command handles |
| Retained history and `prime_context` | Original public records, ready for targeted recovery |
| TaskFrame | Selected earlier user instructions and goal state alongside summaries |
| Optional request-budget profile | Dependency-aware selection and stable context choices on supported routes |
| TypeScript host | Model calls, sessions, goals, scheduling, provider recovery, and child lifecycles |

Workers start with `await rlm(...)` and return results through messages or files. Recognized transient provider errors can recover within the same invocation without replaying completed tools.

**Want tighter request control?** Enable request-budget selection with an explicit `enforce`-mode route/model profile in settings or the SDK. It is opt-in and applies per request, separate from goal budgets. [Working configuration](packages/coding-agent/docs/request-token-budgets.md).

**Built on Prime Agent, focused on context.** Prime Agent gives us the persistent Python REPL, recursive delegation, skills, messaging, goals, and long-running sessions. Base Context develops framed history, indexed recovery, TaskFrames, dependency-aware selection, and stable context epochs around that foundation. [Why we forked](packages/coding-agent/docs/fork-philosophy.md) · [Context design](packages/coding-agent/docs/context-management.md).

Save important deliverables in files; Python restoration is best-effort. Commands run with your user permissions, so use an external sandbox for untrusted code. [Security guidance](SECURITY.md).

## Documentation

[Quickstart](packages/coding-agent/docs/quickstart.md) · [Usage](packages/coding-agent/docs/usage.md) · [Settings](packages/coding-agent/docs/settings.md) · [Providers](packages/coding-agent/docs/providers.md) · [Skills](packages/coding-agent/docs/skills.md) · [RLM](packages/coding-agent/docs/rlm.md) · [SDK](packages/coding-agent/docs/sdk.md) · [All docs](packages/coding-agent/docs/index.md) · [1.1.2 release notes](packages/coding-agent/docs/release-notes-1.1.2.md)

See the [changelog](CHANGELOG.md) for releases. Contributions are welcome: [CONTRIBUTING.md](CONTRIBUTING.md).

## License and thanks

[Synerise](https://synerise.com) develops Base Context. [BaseModelAI/base-context](https://github.com/BaseModelAI/base-context) is its GitHub home; [`@ponythewhite/base-context`](https://www.npmjs.com/package/@ponythewhite/base-context) is its npm package; `base-context` is the command.

[MIT](LICENSE), with upstream notices preserved in [NOTICE](NOTICE).

**Prime Agent is an excellent foundation, and we are grateful to its authors.** Thank you to [Prime Intellect](https://github.com/PrimeIntellect-ai/prime-agent) for the Python-first agent and recursive runtime, and to [Mario Zechner's Pi](https://github.com/badlogic/pi-mono), on which Prime Agent builds. Base Context is an independent Synerise fork.
