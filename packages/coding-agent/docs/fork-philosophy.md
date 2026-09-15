# Why we forked Prime Agent

**Synerise base-context is a focused bet on context engineering.**

The model is only one part of a useful agent. Long tasks also depend on what the harness keeps visible, what it can recover, how it handles tool dependencies, and whether a provider interruption forces work to start again.

Prime Agent provides a strong foundation: a persistent Python control environment, recursive agents, executable skills, and long-running sessions. Base Context keeps that programming model and develops a different context and recovery architecture around it.

## The motivation

A transcript mixes instructions, decisions, intermediate outputs, failed approaches, and stale observations. Appending all of it consumes context. Summarizing all of it can lose exact details. Keeping a file on disk is not enough unless the agent can recover the relevant evidence and understand its status.

Our design separates these concerns:

1. **Retain source records.** History is evidence, not an obligation to replay every byte.
2. **Compile a working view.** Select context under explicit dependency and resource rules.
3. **Carry task state.** Keep recorded goals, constraints, questions, and artifact state distinguishable from free-form summaries.
4. **Recover on demand.** Bring selected public evidence back through an indexed, bounded interface.
5. **Continue through transient failures.** Keep completed work and pending operations within the same invocation when recovery is allowed.

The aim is practical continuity for coding, research, and other multi-step work. It is not unlimited memory or a claim that selection always beats a larger prompt.

## What comes from upstream

The RLM model treats the Python REPL as a persistent control environment. The agent can inspect data, run commands, call skills, and admit recursive child agents from code. The TypeScript host owns inference and session lifecycles.

Base Context retains that core approach, along with agent messaging, goals, schedules, daemon-backed sessions, and a continual harness. The continual harness stores supplemental prompts, memories, skill descriptions, and reusable delegation specifications. Refinement updates that state; it does not rewrite the immutable base system prompt or automatically publish new executable skills.

`await rlm(...)` returns an admission handle. Children deliver results through messages or files. This distinction matters: a parent should continue independent work and read results when they arrive, not assume the spawn call contains the answer.

## What Base Context changes

| Area | Base Context approach | Important limit |
| --- | --- | --- |
| History | Canonical framed records plus indexed public retrieval | Retained history is not always in the prompt |
| Active context | Source-backed working views rather than an arbitrary last-N transcript | Required context must fit or the request can refuse |
| Task state | Structured TaskFrame with source, authority, and state | Selected recorded evidence, not a complete or live world model |
| Message dependencies | ViewUnit closure keeps required replay groups together | Provider adapters decide which layouts support selection |
| Budgeting | Explicit model/provider request profiles in the SDK | Opt-in enforcement; conservative estimation, not an exact tokenizer |
| Context stability | Accepted epochs freeze context choices until a new boundary | Does not guarantee cache hits or hidden-state continuity |
| Provider recovery | Retry recognized transient failures inside the same invocation | Authorization, cancellation, permanent errors, and budgets still apply |
| Runtime identity | Own package, binary, state root, and runtime distribution | Upstream installers and credential stores are not interchangeable |
| Transport | SSE by default; other supported transports are opt-in | Transport choice does not imply free caching or universal support |

This table describes the fork's implementation, not a claim that every capability is absent from every upstream revision. See [context management](context-management.md) for behavior and [SDK configuration](sdk.md) for supported request-budget paths.

## How we evaluate the difference

The published study uses an independent stock Prime Agent control, not Base Context with one setting switched off. It tests one SDK-level Python coding harness across 30 tasks and three model selections, with logical `medium` effort and the same fixed single-deferred-retry policy. Both arms use a shared Bash tool, not the native `ipython` workflow; this is not a test of recursive-agent performance.

We report task correctness, runtime cleanliness, retry attempts, and cumulative lifecycle time separately. A strict test pass can coexist with a compaction failure. Cumulative attempt durations are not campaign wall time or user-perceived latency. Repeated attempts belong in the time denominator rather than disappearing from a clean-success-only comparison.

The frozen measurements used Base Context package `0.1.0` at mixed source revisions: `84a7e6f` for Sol/Astra and `077f463` for DeepSeek. Release `1.0.0` builds on the latter source line. The study is not a fresh measurement of the 1.0.0 release artifact. It has unknown-cost attempts, so it cannot establish complete fees or a whole-campaign cost advantage. API-equivalent prices are not the same as cash charges.

Read the [report](../../../benchmarks/python-realworld-30/REPORT.md), [complete cells](../../../benchmarks/python-realworld-30/results/cells.md), and [reproduction guide](../../../benchmarks/python-realworld-30/REPRODUCE.md). We treat these results as evidence from one study, not a general ranking of agents or providers.

## Fork philosophy

- **Preserve the useful foundation.** Keep the RLM programming model and credit its authors.
- **Own the changed behavior.** Use distinct packages, configuration, state, and release channels.
- **Make limits visible.** Distinguish unavailable evidence, partial retrieval, unknown estimates, and actual refusals.
- **Keep comparisons honest.** Separate design goals from measured outcomes and benchmark revisions from release versions.
- **Stay open.** Retain MIT licensing and upstream notices. Source and documentation should make the implementation understandable without a hosted service.

## Lineage and acknowledgements

Base Context is developed by [Synerise](https://synerise.com) and distributed through [BaseModelAI/base-context](https://github.com/BaseModelAI/base-context).

We thank **[Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent)** and **[Prime Intellect](https://www.primeintellect.ai/)** for the agent foundation, the [RLM programming model](https://www.primeintellect.ai/blog/rlm), and the work that made this fork possible.

We thank **Mario Zechner** for **[Pi / pi-mono](https://github.com/badlogic/pi-mono)**, whose agent and terminal UI work is part of that lineage.

We also acknowledge **[PrimeRL](https://github.com/PrimeIntellect-ai/prime-rl)**, Prime Intellect's separate open reinforcement-learning project. It is not a direct dependency of the Base Context CLI. This credit does not imply that Prime Intellect or the upstream authors endorse this fork or its benchmark conclusions.

Base Context remains [MIT licensed](../../../LICENSE). The repository README retains the upstream research citation.
