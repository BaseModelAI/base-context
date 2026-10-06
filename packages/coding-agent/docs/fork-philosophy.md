# Why we forked Prime Agent

**Synerise base-context is a focused bet on context engineering.**

The model is only one part of a useful agent. Long tasks also depend on what the harness keeps visible, what it can recover, how it handles tool dependencies, and whether a provider interruption forces work to start again.

Prime Agent provides a strong foundation: a persistent Python control environment, recursive agents, executable skills, and long-running sessions. Base Context keeps that programming model and develops a different context and recovery architecture around it.

## The motivation

A transcript mixes instructions, decisions, intermediate outputs, failed approaches, and stale observations. Appending all of it consumes context. Summarizing all of it can lose exact details. Keeping a file on disk is not enough unless the agent can recover the relevant evidence and understand its status.

Our design separates these concerns:

1. **Retain source records.** History is evidence, not an obligation to replay every byte.
2. **Compile a working view.** Select context under explicit dependency and resource rules.
3. **Carry instructions and goals.** Keep selected original user text and goal state alongside summaries. The task-state schema is broader than the currently produced TaskFrame content; it is not automatic extraction of decisions, questions, or artifact facts.
4. **Recover on demand.** Bring selected public evidence back through an indexed, bounded interface.
5. **Continue through transient failures.** Keep completed work and pending operations within the same invocation when recovery is allowed.

The aim is practical continuity for coding, research, and other multi-step work. It is not unlimited memory or a claim that selection always beats a larger prompt.

## What comes from upstream

The RLM model treats the Python REPL as a persistent control environment. The agent can inspect data, run commands, call skills, and admit recursive child agents from code. The TypeScript host owns inference and session lifecycles.

Base Context retains that core approach, along with agent messaging, goals, schedules, daemon-backed sessions, and a continual harness. The continual harness stores supplemental prompts, memories, skill descriptions, and reusable delegation specifications. Refinement updates that state; it does not rewrite the immutable base system prompt or automatically publish new executable skills.

`await rlm(...)` returns an admission handle. Children deliver results through messages or files. This distinction matters: a parent should continue independent work and read results when they arrive, not assume the spawn call contains the answer.

We selectively adapt upstream fixes rather than merging every release. The [0.9.5 selection](upstream-0.9.5.md) and [later selection for Base Context 1.0.15](upstream-1.0.15.md) explain that approach and its exclusions.

## What Base Context changes

| Area | Base Context approach | Important limit |
| --- | --- | --- |
| History | Canonical framed records plus indexed public retrieval | Retained history is not always in the prompt |
| Active context | Source-backed working views rather than an arbitrary last-N transcript | Required context must fit or the request can refuse |
| Task state | Structured TaskFrame with source, authority, and state | Selected recorded evidence, not a complete or live world model |
| Message dependencies | ViewUnit closure keeps required replay groups together | Provider adapters decide which layouts support selection |
| Budgeting | Explicit model/provider request profiles in settings or the SDK | Opt-in on supported routes; estimates are not exact provider token counts |
| Context stability | Saved context choices stay stable until an accepted change | Budget-driven epochs need a profile; cache hits and hidden-state continuity are not guaranteed |
| Provider recovery | Retry recognized transient failures inside the same invocation | Authorization, cancellation, permanent errors, and budgets still apply |
| Runtime identity | Own package, binary, state root, and runtime distribution | Upstream installers and credential stores are not interchangeable |
| Transport | SSE by default; other supported transports are opt-in | Transport choice does not imply free caching or universal support |

This table describes the fork's implementation, not a claim that every capability is absent from every upstream revision. See [context management](context-management.md) for behavior and the [request-budget guide](request-token-budgets.md) for a complete CLI/settings profile and supported routes.

## How we evaluate the difference

The published comparison covers Base Context **1.1.1** and Codex **0.160.0** on 30 Python tasks with two model/effort profiles: **GPT-6.1 Sol high** and **GPT-6 Astra medium**. Each harness uses its native execution path, with the same tasks and task checks. Best-of-two selection yields 60 matched task/profile pairs.

Both tools pass **60/60** selected tasks. Base Context has **30.99% shorter mean selected-run duration** and **18.73% lower selected captured API-cost estimates**. These are results for the published scope, not universal savings. Cost estimates are not invoices; task-run durations are not campaign wall time. Native execution conditions differ, and the comparison does not isolate the effect of individual features. **Request-budget selection was disabled.** The tasks did not evaluate long-session recall, post-compaction instruction recovery, or delegation quality. The results do not measure the current source changes. Those questions need separate evaluations; relabeling this historical comparison does not answer them.

Read the [benchmark results and methodology](../../../benchmarks/python-realworld-30/README.md) for the exact selection rules, execution settings, per-profile results, and per-task pairs.

## Fork philosophy

- **Preserve the useful foundation.** Keep the RLM programming model and credit its authors.
- **Own the changed behavior.** Use distinct packages, configuration, state, and release channels.
- **Make limits visible.** Distinguish unavailable evidence, partial retrieval, unknown estimates, and actual refusals.
- **Keep comparisons honest.** Separate design goals from measured outcomes and benchmark revisions from release versions.
- **Stay open.** Retain MIT licensing and upstream notices. Source and documentation should make the implementation understandable without a hosted service.

## Project and license

Base Context is developed by [Synerise](https://synerise.com) and distributed through [BaseModelAI/base-context](https://github.com/BaseModelAI/base-context).

Base Context is [MIT licensed](../../../LICENSE). Required copyright notices are in [NOTICE](../../../NOTICE).
