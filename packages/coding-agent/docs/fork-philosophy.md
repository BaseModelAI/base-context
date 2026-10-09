# Why we forked Prime Agent

**A good agent should build on its work, not keep rediscovering it.**

That is the idea behind Synerise Base Context. Give the agent a persistent workspace. Keep useful outputs within reach. Carry earlier instructions through compaction. Let independent workers move in parallel while the main task keeps going.

Prime Agent gave us an excellent foundation for that workflow. Base Context develops the context and recovery architecture around it.

## The opportunity: continuity

A long task produces more than a conversation. It produces parsed data, command handles, test output, decisions, and instructions that still matter many turns later. A larger prompt is only one way to carry that work forward.

Our approach is to **keep the work and focus the context**:

1. **Reuse the workspace.** Keep Python variables, parsed data, and running-command handles available for the next step.
2. **Retain the source.** Store long outputs and recover the exact passage needed, rather than repeatedly sending or rerunning everything.
3. **Carry the thread.** Keep selected earlier user instructions and goal state alongside summaries.
4. **Keep moving.** Coordinate independent workers and recover recognized transient provider failures without replaying completed tools.
5. **Make context a deliberate choice.** Offer explicit request-budget profiles for dependency-aware selection on supported routes.

This is a practical workflow for multi-step coding, investigation, and research: inspect, retain, recover, and continue.

## What makes the fork worth using

| Capability | What it brings to your work |
| --- | --- |
| Retained outputs and indexed recovery | Find the useful line in an earlier result without rerunning the command |
| TaskFrame | Carry selected user instructions and goal state through compaction, without repeating already-visible user text |
| Source-backed history | Recover original public records when a summary leaves out a detail |
| Native provider recovery | Continue an invocation through recognized transient failures while keeping completed tool work |
| Optional request-budget selection | Keep required replay groups together and choose supported context under an explicit per-request budget |
| Stable context choices | Reuse accepted selections across requests through context epochs |
| An owned runtime | One CLI, its own distribution, and separate `~/.base-context` settings and state |

The workspace, retained output, TaskFrame, and recovery are available in ordinary sessions. Budget-driven selection and epochs are **opt-in**: configure an explicit route/model profile in settings or the SDK. The [request-budget guide](request-token-budgets.md) includes a working example and supported routes. [Context management](context-management.md) explains the layers in detail.

## The foundation we keep

Prime Agent's Python-first model is central to Base Context. The REPL is a persistent control environment: the agent can inspect data, run project tools, call skills, and coordinate recursive child agents from code. The TypeScript host owns model calls and session lifecycles.

We retain that foundation, including agent messaging, goals, schedules, daemon-backed sessions, and the continual harness. The latter stores supplemental prompts, memories, skill descriptions, and reusable delegation specifications so useful working advice can carry forward.

Delegation is asynchronous by design. `await rlm(...)` admits a child and returns its handle. Children deliver results through messages or files, leaving the parent free to continue independent work.

We selectively adapt upstream improvements while developing the fork's context architecture. The [0.9.5 selection](upstream-0.9.5.md) and [later selection for Base Context 1.0.15](upstream-1.0.15.md) document that process.

## Where it shines in the benchmark

Our [curated 50-task comparison](../../../benchmarks/context-curated-50/README.md) puts Base Context development builds and Codex 0.160.0 through staged work with forced compaction and scheduled cold restarts. Across three matching model/effort profiles, Base delivered:

- **27–39% shorter mean attempt times.**
- **Faster results in 128/141 pairs** where both harnesses completed natively and fully passed.
- **150/150 native completions**, versus Codex 144/150.
- **148/150 full artifact passes**, versus Codex 146/150.

These are workflow results on 50 curated, outcome-informed tasks, using the first provider-clean attempt per cell. Request-budget selection was off. The [full methodology and charts](../../../benchmarks/context-curated-50/README.md) include selection, provider exclusions, mixed builds, separate completion and artifact scores, and known-usage costs alongside hypothetical pricing scenarios.

Earlier comparisons remain **withdrawn** and preserved as archives: [Python 30](../../../benchmarks/python-realworld-30/README.md) · [Earlier evaluation records](release-1.1.2.md).

## Our principles

- **Build on a strong foundation.** Preserve the useful programming model and credit its authors.
- **Make retained work useful.** Saving history matters most when the agent can find and use it again.
- **Keep the user in control.** Offer explicit provider, model, worker, and request-budget choices.
- **Make results inspectable.** Publish benchmark scope, data, and accounting alongside the charts.
- **Stay open.** Keep MIT licensing, upstream notices, and an understandable implementation.

## Project and license

[Synerise](https://synerise.com) develops Base Context. [BaseModelAI/base-context](https://github.com/BaseModelAI/base-context) is its GitHub home, `@ponythewhite/base-context` is its npm package, and `base-context` is its command.

Thank you to [Prime Intellect](https://github.com/PrimeIntellect-ai/prime-agent) for Prime Agent and to [Mario Zechner](https://github.com/badlogic/pi-mono) for Pi, on which Prime Agent builds. Base Context is an independent Synerise fork.

Base Context is [MIT licensed](../../../LICENSE), with upstream notices preserved in [NOTICE](../../../NOTICE).
