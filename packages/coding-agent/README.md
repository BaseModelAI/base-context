# Base Context

base-context — made in ![Poland](https://raw.githubusercontent.com/BaseModelAI/base-context/main/packages/coding-agent/docs/images/poland-flag.svg) by [Synerise AI](https://synerise.com).

**Keep the work. Focus the context.**

Give your agent a workspace, not just a conversation. Base Context combines **persistent Python, retained outputs, and instruction recovery** to keep coding and research moving across long sessions. Developed by [Synerise](https://synerise.com), built on [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent).

[![Curated benchmark: 27–39% shorter mean attempt times, 150/150 Base native completions, and faster results in 128/141 pairs where both harnesses completed and fully passed.](https://raw.githubusercontent.com/BaseModelAI/base-context/main/packages/coding-agent/docs/images/benchmarks/curated50-overview.svg)](https://github.com/BaseModelAI/base-context/blob/main/benchmarks/context-curated-50/README.md)

**Less waiting. Strong results.** In our curated 50-task benchmark, Base delivered **27–39% shorter mean attempt times** across three matching profiles and **150/150 native completions**. [Explore the benchmark](#benchmarks).

[Install](#install) · [Workflow](#use-it) · [Benchmarks](#benchmarks) · [Design](#how-it-works) · [Documentation](https://github.com/BaseModelAI/base-context/blob/main/packages/coding-agent/docs/index.md)

## Install

On **macOS or Linux**:

```bash
curl -fsSL https://github.com/BaseModelAI/base-context/releases/latest/download/install.sh | bash
```

The installer offers missing prerequisites and prepares Node.js, `uv`, and managed Python. Run the final PATH command it prints, then:

```bash
cd /path/to/project
base-context
```

**Bring your existing provider account.** Choose `/login`, then `/model` and `/effort`. Have ChatGPT with Codex access? Choose **OpenAI Codex** in `/login`—no separate API key needed. Other supported subscriptions and API keys are available through their provider routes. [Provider setup](https://github.com/BaseModelAI/base-context/blob/main/packages/coding-agent/docs/providers.md).

This page describes **1.1.2**; install commands use the latest public release. [What's new](https://github.com/BaseModelAI/base-context/blob/main/packages/coding-agent/docs/release-notes-1.1.2.md).

<details>
<summary>npm, Windows, and source installations</summary>

If you already manage Node.js/npm, use Node.js **22.12+ on 22.x, or 23.3+**. In Bash/Zsh:

```bash
npm install -g @ponythewhite/base-context
BASE_CONTEXT_INSTALL_UV=1 base-context
```

The first normal launch prepares managed Python. The flag permits installing missing `uv`. Use this route instead of the installer above.

[Windows, source builds, updates, rollback, and uninstall](https://github.com/BaseModelAI/base-context/blob/main/packages/coding-agent/docs/installation.md).

</details>

## Built for more than one turn

- **Inspect once. Build on it.** Keep parsed data, variables, and command handles in a persistent Python workspace. Project tools still run in the project's own environment. You do not need to write Python yourself.
- **Keep output, not clutter.** Retain long results and recover the exact failure, passage, or line you need through `prime_context`.
- **Carry the thread.** TaskFrames carry selected earlier user instructions and goal state through compaction. Retained sources support recovery after a saved-session restart.
- **Put independent work in parallel.** Workers have their own contexts and return messages or reports while the parent keeps moving.

## Use it

Start in your repository, put project rules in `AGENTS.md`, and ask for an outcome:

```text
Fix the failing parser test. Keep the public API unchanged.
Delegate the API review to a worker while you finish the documentation.
```

| Command | Purpose |
| --- | --- |
| `/goal <objective>` | Start a persistent goal; manage it with `status`, `pause`, `resume`, or `clear` |
| `/agents [N]` | Show or set the subagent cap, default four |
| `/btw <question>` | Ask a side question without steering the main task; Esc returns |
| `/context`, `/usage` | Inspect context, captured usage, and cost estimates |
| `/compact`, `/refine` | Summarize context or refine saved harness advice |
| `base-context -c` | Continue the latest saved session |
| `base-context agents` | Open the agents view |
| `base-context attach <agent>` | Reattach to a resident agent |
| `base-context shutdown` | Stop all agents and background services |

Normal interactive work can continue after the terminal detaches. Reattach when you're ready. [Ten-minute workflow](https://github.com/BaseModelAI/base-context/blob/main/packages/coding-agent/docs/quickstart.md) · [Full usage](https://github.com/BaseModelAI/base-context/blob/main/packages/coding-agent/docs/usage.md) · [Goals and background work](https://github.com/BaseModelAI/base-context/blob/main/packages/coding-agent/docs/long-running-agents.md).

## Benchmarks

### Long tasks. Less waiting.

Our **curated 50-task comparison** puts Base Context development builds and **Codex 0.160.0** through staged work with forced compaction and scheduled cold restarts.

| Profile · 50 attempts per harness | Mean time, Base / Codex | Full artifact passes, Base / Codex |
| --- | ---: | ---: |
| GPT-6 Astra · medium | **508.4 / 697.2 s** | 49 / 50 |
| GPT-6.1 Sol · high | **606.4 / 967.4 s** | 50 / 49 |
| GPT-6.1 Sol · xhigh | **908.1 / 1,481.3 s** | 49 / 47 |

**Base was faster in 128/141 pairs where both harnesses completed natively and fully passed.** Across all selected attempts, native completions were **150/150 versus 144/150**, and full artifact passes were **148/150 versus 146/150**. Artifact scores include three passing Codex timeouts; completion is scored separately.

[Time chart](https://github.com/BaseModelAI/base-context/blob/main/packages/coding-agent/docs/images/benchmarks/curated50-time.svg) · [Quality chart](https://github.com/BaseModelAI/base-context/blob/main/packages/coding-agent/docs/images/benchmarks/curated50-quality.svg) · [Cost chart](https://github.com/BaseModelAI/base-context/blob/main/packages/coding-agent/docs/images/benchmarks/curated50-cost.svg) · [Benchmark data](https://github.com/BaseModelAI/base-context/blob/main/benchmarks/context-curated-50/summary.json).

### Estimated cost per task

**About 11.3% lower estimated cost overall**, or **$0.213 saved per task**, across 150 selected attempts per product.

| Model / effort | **Base estimate / task** | **Codex estimate / task** | **Base saving / task** | **Base saving** |
| --- | ---: | ---: | ---: | ---: |
| Astra / medium | **$3.325** | **$3.668** | **$0.343** | **9.3%** |
| Sol 6.1 / high | **$0.753** | **$0.836** | **$0.082** | **9.8%** |
| Sol 6.1 / xhigh | **$0.948** | **$1.161** | **$0.213** | **18.3%** |
| All profiles | **$1.675** | **$1.888** | **$0.213** | **11.3%** |

Both products include estimates for missing captured costs: Base's missing usage uses comparable-request means; Codex's missing model identities use requested-profile rates. [Known components, assumptions and sensitivity](https://github.com/BaseModelAI/base-context/blob/main/benchmarks/context-curated-50/README.md#estimated-cost-per-task) support this API-list-rate comparison, not an invoice or complete-family-spend claim.

**Scope:** 50 curated, outcome-informed tasks; three profiles; first provider-clean attempt per cell, including clean failures and timeouts. Request-budget selection was off. [Full methodology](https://github.com/BaseModelAI/base-context/blob/main/benchmarks/context-curated-50/README.md) covers selection, provider exclusions, mixed builds, and cost sensitivity.

Earlier comparisons remain **withdrawn** and available as archives: [Python 30](https://github.com/BaseModelAI/base-context/blob/main/benchmarks/python-realworld-30/README.md) · [Earlier evaluation records](https://github.com/BaseModelAI/base-context/blob/main/packages/coding-agent/docs/release-1.1.2.md).

## How it works

**Keep a notebook. Work from a clear desk.** Retained history holds the source material. The working context carries what the agent is using now. The Python workspace keeps reusable data and command handles, while the TypeScript host runs model calls, sessions, goals, and worker lifecycles.

Base Context builds source-backed context and recovery around Prime Agent's persistent Python programming model. The workspace, retained output, TaskFrame, and recovery are available in ordinary sessions. For tighter per-request control, opt into budget-driven selection with an explicit `enforce`-mode settings profile or SDK option on supported routes. [Working budget profile](https://github.com/BaseModelAI/base-context/blob/main/packages/coding-agent/docs/request-token-budgets.md).

[Architecture](https://github.com/BaseModelAI/base-context#how-it-works) · [Why we forked](https://github.com/BaseModelAI/base-context/blob/main/packages/coding-agent/docs/fork-philosophy.md) · [Context management](https://github.com/BaseModelAI/base-context/blob/main/packages/coding-agent/docs/context-management.md) · [SDK](https://github.com/BaseModelAI/base-context/blob/main/packages/coding-agent/docs/sdk.md) · [All docs](https://github.com/BaseModelAI/base-context/blob/main/packages/coding-agent/docs/index.md).

Save important deliverables in files; Python restoration is best-effort. Commands run with your user permissions, so use an external sandbox for untrusted code.

## License and thanks

[Synerise](https://synerise.com) develops Base Context. [BaseModelAI/base-context](https://github.com/BaseModelAI/base-context) is its GitHub home; `@ponythewhite/base-context` is the npm package; `base-context` is the command.

[MIT](LICENSE), with upstream notices preserved in [NOTICE](NOTICE).

Thank you to [Prime Intellect](https://github.com/PrimeIntellect-ai/prime-agent) for the excellent Python-first agent and recursive runtime, and to [Mario Zechner's Pi](https://github.com/badlogic/pi-mono), on which Prime Agent builds. Base Context is an independent Synerise fork.
