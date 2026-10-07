# Base Context

**Keep the work. Focus the context.**

An MIT-licensed coding and research agent with a persistent Python workspace, parallel workers, and source-backed context. Developed by [Synerise](https://synerise.com), built on [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent).

Keep parsed data and command handles across turns. Retain long output outside the prompt, recover details by reference, and carry selected earlier instructions through compaction. Delegate independent work while the parent continues.

Request-budget selection is **opt-in**, not default CLI optimization. Start with the [ten-minute workflow](https://github.com/BaseModelAI/base-context/blob/main/packages/coding-agent/docs/quickstart.md), then see the [working budget profile](https://github.com/BaseModelAI/base-context/blob/main/packages/coding-agent/docs/request-token-budgets.md) if you need request-level limits.

[Install](#install) · [Use it](#use-it) · [How it works](#how-it-works) · [Documentation](https://github.com/BaseModelAI/base-context/blob/main/packages/coding-agent/docs/index.md)

## Install

On macOS or Linux, the recommended installer prepares missing prerequisites and managed Python before activating the CLI:

```bash
curl -fsSL https://github.com/BaseModelAI/base-context/releases/latest/download/install.sh | bash
```

Run the final PATH command it prints, then:

```bash
cd /path/to/project
base-context
```

Use `/login` for your provider, `/model` for your model, and `/effort` for its reasoning level. Selection and authentication are explicit; Base Context uses its own settings and credentials.

**npm alternative:** if you already manage Node.js/npm, use Node.js **22.12+ on 22.x, or 23.3+**. In Bash/Zsh:

```bash
npm install -g @ponythewhite/base-context
BASE_CONTEXT_INSTALL_UV=1 base-context
```

The first normal launch prepares managed Python. The flag permits installing missing `uv`; you do not need a manual Python installation. Use npm instead of, not in addition to, the installer above.

[Windows, source builds, updates, rollback, and uninstall](https://github.com/BaseModelAI/base-context/blob/main/packages/coding-agent/docs/installation.md).

## Use it

Start in your repository and ask for an outcome. Put project rules in `AGENTS.md`. You do not need to write Python yourself.

| Command | Purpose |
| --- | --- |
| `/goal <objective>` | Explicitly start a persistent goal; manage it with `status`, `pause`, `resume`, or `clear` |
| `/agents [N]` | Show or save the live-subagent cap, default four; lowering it does not stop workers |
| `/btw <question>` | Ask a tool-free side question without adding the conversation to the main session; Esc returns |
| `/context`, `/usage` | Inspect context, captured usage, cost estimates, and separate goal-budget scope |
| `/compact`, `/refine` | Summarize context or refine saved harness advice |
| `base-context agents` | Open the agents view |
| `base-context attach <agent>` | Reattach to a resident agent |
| `base-context shutdown` | Stop all agents and background services |

For independent work, ask:

```text
Delegate the API review and documentation update to separate workers.
Keep working on the parser fix, then integrate their replies.
```

Normal interactive workers can continue after the terminal detaches. [Quickstart](https://github.com/BaseModelAI/base-context/blob/main/packages/coding-agent/docs/quickstart.md) · [Full usage](https://github.com/BaseModelAI/base-context/blob/main/packages/coding-agent/docs/usage.md).

## How it works

- **Persistent Python:** keep variables, parsed data, commands, and skills available across tool calls.
- **Instructions and recovery:** TaskFrames carry selected earlier user text and goal state without repeating visible user inputs. Indexed recovery retrieves original public text. An explicit budget profile enables supported ViewUnit selection and stable context epochs.
- **Parallel children:** `await rlm(...)` returns an admission handle. Results arrive through messages or files, while independent work can continue.

Base Context inherits the Python-first programming model from Prime Agent. Its focus is the source-backed working-set architecture around that model. Bring that workflow to your next coding or research task.

Summaries are not lossless, retrieval is bounded, and Python restoration is best-effort. Generated code runs with your user permissions; workers are **not a security sandbox**. Use an external sandbox for untrusted work. Retained sessions can contain sensitive data; compaction does not delete it.

[Architecture, comparison charts, and design details](https://github.com/BaseModelAI/base-context#how-it-works) · [Context management](https://github.com/BaseModelAI/base-context/blob/main/packages/coding-agent/docs/context-management.md) · [SDK](https://github.com/BaseModelAI/base-context/blob/main/packages/coding-agent/docs/sdk.md) · [All docs](https://github.com/BaseModelAI/base-context/blob/main/packages/coding-agent/docs/index.md).

## Historical benchmark

> **Archived — comparison withdrawn.** This historical comparison is withdrawn, along with all earlier Base Context comparisons, including released-version comparisons. Its numbers, tables, and charts are preserved as archival records only and must not be used to support performance claims.

Base Context **1.1.1** and Codex **0.160.0** both passed **60/60** selected task/profile pairs on 30 self-authored Python standard-library tasks. Base had **31% shorter mean selected-run time** and a **19% lower captured API-cost estimate** in that sample, using GPT-6.1 Sol high and GPT-6 Astra medium.

These are best-of-two results with a ceiling effect, different dates and concurrency limits, and different native tools/instructions. They are not single-attempt reliability, invoices, complete campaign spend, or measurements of the current changes. Request-budget selection was not enabled, so the comparison cannot establish its effect or long-session quality. [Data, charts, and full method](https://github.com/BaseModelAI/base-context/blob/main/benchmarks/python-realworld-30/README.md).

## License and thanks

[MIT](LICENSE). Upstream notices are preserved in [NOTICE](NOTICE).

Thank you to [Prime Intellect](https://github.com/PrimeIntellect-ai/prime-agent) for the excellent Python-first agent foundation, and to [Mario Zechner's Pi](https://github.com/badlogic/pi-mono), on which Prime Agent builds. Base Context is an independent fork, not an official Prime Intellect release.
