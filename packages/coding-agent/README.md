# Synerise base-context

**Keep the work. Focus the context.**

An MIT-licensed coding and research agent for tasks that outgrow a chat window. Base Context combines a persistent Python workspace, recursive agents, and source-backed context management. It is developed by [Synerise](https://synerise.com) as a fork of [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent).

[Repository](https://github.com/BaseModelAI/base-context) · [Quickstart](docs/quickstart.md) · [Documentation](docs/index.md) · [Why this fork](docs/fork-philosophy.md)

[![One historical SDK study: Base Context achieved 89/90 runtime-clean strict finishes versus Prime Agent 64/90, with 2 versus 26 additional attempts and 24.16% less cumulative attempt time.](https://raw.githubusercontent.com/BaseModelAI/base-context/v1.0.1/packages/coding-agent/docs/images/benchmarks/benchmark-overview.png)](https://github.com/BaseModelAI/base-context/blob/v1.0.1/benchmarks/python-realworld-30/REPORT.md)

*One study, not a universal ranking: historical SDK/shared-Bash results, not a fresh measurement of this release. “Clean” adds runtime requirements to task correctness. [Methodology and full results](https://github.com/BaseModelAI/base-context/blob/v1.0.1/benchmarks/python-realworld-30/REPORT.md).*

## Install (recommended)

On **macOS or Linux**, run the interactive installer:

```bash
curl -fsSL https://github.com/BaseModelAI/base-context/releases/latest/download/install.sh | bash
```

**Use this instead of the npm route below. You do not install Python or `uv` first.** The installer checks Node.js/npm and offers to install a compatible version if needed. It installs `uv` when needed, prepares the agent's Python environment, and installs the bundled runtime **before activating the CLI**.

Follow the final PATH/activation command printed by the installer, then start work:

```bash
cd /path/to/your/project
base-context
```

In the terminal UI, select and authenticate with a supported provider using `/login`, then choose a model with `/model`. Both choices are explicit. The installer prepares the application; you use only the selected provider's account and authentication. See [provider setup](docs/providers.md).

### npm alternative: for users who already manage Node.js

Use Node.js **22.12+ on the 22.x line, or 23.3+**, and npm. These must already be installed **before** this route:

```bash
npm install -g @ponythewhite/base-context
cd /path/to/your/project
BASE_CONTEXT_INSTALL_UV=1 base-context
```

`npm install` installs the CLI; it does not prepare Python at that step. Starting a normal CLI session begins preparing the managed Python environment in the background. `BASE_CONTEXT_INSTALL_UV=1` lets that bootstrap install `uv` if it is missing. **No manual Python installation is needed.** Initial setup needs network access and can take a little longer; later launches reuse the environment.

The environment-variable syntax above is for Bash/Zsh. See [installation](docs/installation.md) for PowerShell, manual Python environments, updates, and rollback.

## Why Base Context?

**A capable agent is a great start. Keeping a long job coherent is the next challenge.** A task can span dozens of files, tool outputs, decisions, and interruptions. The useful question is not just “how much can the model read?” It is “can it find the right evidence and keep working?”

Base Context is built to help you:

- **Keep the thread of a long task.** Carry selected goals, constraints, and open work explicitly, rather than leave them buried in a transcript.
- **Check the evidence, not just a recollection.** Recover selected original public text from retained history when a summary is not enough.
- **Use context for the work at hand.** Bring a focused working set to the model while keeping required related messages together.
- **Keep moving after a temporary failure.** Recover recognized transient provider errors within the same invocation, without replaying completed tools, when the remaining limits allow it.

That is the bet: **less repeated detective work, more continuity, and a clearer link between what the agent says and the evidence it can recover.** The benchmark below measures one harness-level outcome; it does not prove that each mechanism independently caused the gain.

## Prime Agent was already awesome. Why fork it?

**Prime Agent gave us an excellent foundation:** a persistent Python workspace, recursive agents, executable skills, and the machinery for long-running work. We keep that programming model. This fork is not an attempt to claim those ideas as ours.

Our different bet is **how to manage the context around that work**. A longer transcript costs space and can bury the important parts. A shorter summary saves space but can lose the detail you need next. We wanted an explicit way to retain evidence, select a useful working view, and recover earlier details on demand.

Think of retained history as a **project notebook**, and the model's context as your **desk**. You do not need every notebook page on the desk at once. You do need the current task, the relevant evidence, and a way to fetch an earlier page. That is a design analogy—not a promise that all information is retained forever or that summaries are lossless.

![Base Context architecture: retain source history, select and recover a task-aware working set, then send the supported model request. Stable epochs preserve accepted context choices.](https://raw.githubusercontent.com/BaseModelAI/base-context/v1.0.1/packages/coding-agent/docs/images/benchmarks/context-working-set.png)

### How the design delivers

| The problem | Our design choice | The practical reason |
| --- | --- | --- |
| Important details compete with old output for context. | Separate retained history from the model's working view; add indexed retrieval. | Focus the prompt, then fetch retained public evidence when it is needed. |
| Goals and constraints get buried in conversation. | Carry selected task state in a **TaskFrame**. | Keep the task explicit instead of relying only on a narrative recap. |
| A tool's answer can be separated from the call that explains it. | Keep required exchanges together with dependency-aware **ViewUnits**. | Preserve the relationships needed to interpret the evidence. |
| Context choices can shift as a long run continues. | Commit stable **context epochs**. | Keep accepted choices steady across requests and restoration. |
| A prompt-size limit can miss the provider's full request. | Offer **opt-in model/provider-aware SDK admission**. | Check supported requests, including output allowances, under explicit profiles; refuse when the required contract cannot fit. |
| A temporary provider error interrupts useful work. | Use bounded recovery inside the same invocation. | Retry recognized transient failures without replaying completed tools. |

Task state is selected recorded evidence, not automatically current truth. Budget estimates are conservative, not exact tokenizer counts; unsupported profiles do not gain a budget guarantee. Stable epochs do not guarantee provider cache hits.

These choices favor **recoverable evidence and controlled working sets**, even when that requires more structure or refusing a request that cannot meet its configured contract. They describe this fork's emphasis—not a claim that every capability is absent from every upstream version.

The fork also owns its package, `base-context` command, `~/.base-context` state, and Python runtime distribution. SSE is the default transport; other supported transports are opt-in. Diagnostics stay local; there is no telemetry upload feature.

There is no promise of unlimited context, universal provider support, guaranteed savings, or lossless summaries. Read [context management](docs/context-management.md) and [fork philosophy](docs/fork-philosophy.md) for the contracts and limits.

## Use it

Start with a concrete request:

```text
Find the cause of the failing parser test, make the smallest fix, and explain what changed.
```

For independent work, ask the agent to delegate:

```text
Delegate the API review to a subagent. Update the documentation while it runs, then read its reply before integrating the findings.
```

The agent works through a persistent Python REPL. `await rlm(...)` returns a **child admission handle**, not the child's answer. Child results arrive through explicit messages or files. See [RLM programming](docs/rlm.md).

Add an `AGENTS.md` file for project instructions. Use `/settings` for common options or `.base-context/settings.json` for project configuration. Global state lives in `~/.base-context`; `BASE_CONTEXT_HOME` selects a separate absolute root.

```bash
base-context agents
base-context attach <agent>
base-context --resume
base-context status
base-context doctor
base-context shutdown
```

See [usage and CLI](docs/usage.md), [settings](docs/settings.md), and [long-running agents](docs/long-running-agents.md) for complete instructions.

## Benchmark evidence

![Runtime-clean strict finishes for all three models: Sol 30/30 versus 18/30; Astra 30/30 versus 19/30; DeepSeek 29/30 versus 27/30. Base Context is first in each pair; all chart scales run from zero to thirty.](https://raw.githubusercontent.com/BaseModelAI/base-context/v1.0.1/packages/coding-agent/docs/images/benchmarks/benchmark-models.png)

One frozen SDK-level study covered 30 Python tasks, three model selections, and two agents: 180 cells and 208 attempts. Base Context reached **90/90 terminal strict passes**, versus **87/90** for stock Prime Agent, with **2 versus 26 additional task attempts** and **24.16% less cumulative attempt lifecycle time**.

The harness used a shared Bash tool, not the native Python/RLM workflow. This is cumulative attempt time, not campaign wall time, CPU time, or user-perceived latency. The study used logical `medium` effort, a fixed single-deferred-retry policy, and historical package `0.1.0` at mixed source revisions (`84a7e6f` for Sol/Astra; `077f463` for DeepSeek). Current releases build on the latter source line; they have not been newly measured in this study. Sixteen attempts have unknown cost; full fees and a whole-campaign cost advantage are unknown. Reported prices are API-equivalent estimates, not cash charges.

Read the [full report and methodology](https://github.com/BaseModelAI/base-context/blob/main/benchmarks/python-realworld-30/REPORT.md) and [reproduction guide](https://github.com/BaseModelAI/base-context/blob/main/benchmarks/python-realworld-30/REPRODUCE.md).

## Integrate and extend

- [SDK](docs/sdk.md), [JSON mode](docs/json.md), [RPC](docs/rpc.md), and [ACP](docs/acp.md)
- [Python and markdown skills](docs/skills.md), [MCP](docs/mcp-integrations.md), and [extensions](docs/extensions.md)
- [Custom models](docs/models.md), [custom providers](docs/custom-provider.md), and [packages](docs/packages.md)
- [Sessions](docs/sessions.md), [compaction](docs/compaction.md), and [architecture](docs/architecture.md)

## Trust and data

The agent executes generated Python and project commands with your user permissions. Worker and kernel processes are **not a security sandbox**. Use an external sandbox for untrusted work and review skills and extensions before loading them.

Retained history and artifacts can contain sensitive information. Compaction is not deletion or secret removal. Do not copy upstream credential stores. Diagnostics stay local; there is no telemetry upload feature. SSE is the default provider transport.

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for copyright and license terms.
