# Context management

**Retain the source. Select what the model needs now.**

Base Context separates session history from the model's active working set. A session can retain evidence that is not in the next prompt. The agent can retrieve selected public text later instead of loading the whole transcript again.

This is a source-backed context system, not unlimited model memory. Summaries can omit details. Retrieval is bounded. A retained file is not proof that its contents are in the model's current prompt.

## The four layers

| Layer | What it does | What it does not promise |
| --- | --- | --- |
| Canonical history and index | Keep session records and support targeted reads | Every past record is always sent to the model |
| Working view | Assemble selected source-backed context and required message groups | Arbitrary clipping of required instructions or tool dependencies |
| TaskFrame | Carry selected recorded task state with source references | New instructions, complete task knowledge, or live resource status |
| Python workspace | Hold variables, parsed data, files, and background-work handles | Unlimited RAM or guaranteed restoration of every object |

Native journals retain a `.jsonl` filename extension but use a **framed format**, not ordinary line-oriented JSON. Use the native readers and exports. The index is derived data, not a substitute for the journal. See [sessions](sessions.md) and [session format](session-format.md).

## Indexed retrieval

The built-in `prime_context` tool reads, searches, or recovers selected public text from the current owned session branch. The historical name is intentional. It is not a general filesystem reader or an unrestricted cross-session search.

From the agent's Python kernel, the same operation is available through `rlm.prime_context`:

```python
selected = await rlm.prime_context({
    "action": "search",
    "query": "parser failure",
    "maxBytes": 8192,
})
```

Searches are case-sensitive literal text. For a known result, use the returned reference, revision, and field to request a bounded range:

```python
selected = await rlm.prime_context({
    "action": "read",
    "ref": result_ref,
    "revision": result_revision,
    "field": result_field,
    "startLine": 1,
    "endLine": 40,
    "maxBytes": 8192,
})
```

Here `result_ref`, `result_revision`, and `result_field` stand for values returned by the previous recovery result. References are entry identities, not paths. Lines are one-based within a selected field. The bridge attaches selected data to the finalized tool result; unrelated Python values are not automatically model-visible.

Results report coverage and a status such as `found`, `complete-miss`, `partial`, `unavailable`, `not_authorized`, or `budget_refused`. A partial search is not proof of absence. Recovered text is tool data with unknown freshness, not fresh instructions. Hidden thinking is outside this public projection.

## TaskFrame: carry the task, not just a summary

The TaskFrame renders selected structured task records near the active context. These can include recorded instructions, goal revisions, open questions, observations, and artifact state. Entries keep their source identities, authority, and state.

A TaskFrame is selective evidence. It does not infer that a file is unchanged, a kernel is alive, or a tool result remains current. Long clauses can remain referenced rather than being silently cut to fit. There are separate byte and reference limits.

The runtime also has a bounded view of its owned kernel lifecycle. This records a lifecycle observation, not a variable inventory or a health guarantee. See [SDK task-state and working-view configuration](sdk.md#native-taskframe-and-working-view-metadata).

## ViewUnits and dependency closure

A working view contains units such as literals, task frames, selected recovery, and replay groups. A unit can require other units to remain visible.

Before accepting a selection, Base Context includes the full set of required dependencies. For example, a selected tool result needs its corresponding call. Source order is preserved. Missing or incomplete required groups can refuse the selection rather than produce an invalid partial transcript.

The provider adapter controls what can be selected independently. An adapter that requires complete-context replay keeps the whole required group; Base Context does not assume that every provider supports selective native replay.

## Model-aware budgets

There are several different limits:

- **Canonical reconstruction limits:** message count and source bytes while rebuilding the active context.
- **Recovery limits:** bytes, records, and requests for an explicit history read.
- **Invocation output limits:** the complete result returned by an owned invocation.
- **Model request budgets:** the actual supported provider request representation plus its output allowance.

Do not treat source bytes as model tokens, process memory, or provider charges.

Model-aware request-token admission is configured through the SDK's **`requestTokenBudget`** option. It requires explicit deployment profiles. It is not a universal CLI flag, and the gate is absent when this option is not supplied. `observe` preserves control thresholds; `enforce` enables supported admission behavior. An existing committed epoch still requires its matching explicit profile.

Profiles identify the API, provider, endpoint, final model, context allowance, output ceiling, and estimation/replay configuration. The current counter is a configured conservative UTF-8-based estimate, **not an exact tokenizer or a proven future bound**. A model name alone does not establish a deployment's limits.

In supported native Responses/Codex selection paths, historical assistant literals can become optional at accepted boundaries. Users, the latest assistant, TaskFrames, summaries, recovery, and required dependencies remain mandatory. If that set cannot fit, the request can refuse. Unsupported media, opaque layouts, or missing contracts also remain explicit limits.

See [SDK request-token profiles](sdk.md#explicit-request-token-budget-profiles) for the exact scope and configuration. Ordinary [compaction](compaction.md) and its `reserveTokens`/`keepRecentTokens` settings are separate.

## Stable context epochs

An epoch is a committed context choice: selected source recipes, task-frame text, and the accepted request contract. Within an epoch, unchanged context stays stable. A new selection or relevant resource change requires an accepted boundary rather than an unrecorded rewrite of the prefix.

Restoring a session rebuilds the view from retained sources. Forks and imports rebuild on the destination; they do not inherit unrestricted native replay permission. Some supported transitions can render closed native groups as descriptive public data. This does not preserve hidden reasoning or turn public text into a replacement for provider signatures.

Stable prefixes can make provider caching useful. They do not guarantee cache hits, a particular cache lifetime, or free cached tokens. Server-side continuation is still subject to the provider's accounting and context limits.

## Provider recovery and transport

**SSE is the default transport.** `transport` can opt into `websocket`, `websocket-cached`, or `auto` for providers that support them. `auto` prefers cached WebSocket continuation where supported and permits eligible pre-stream SSE fallback. Transport choice does not grant authorization or create a budget profile.

Native recovery recognizes concrete transient transport, overload, rate-limit, and server-error metadata. It uses capped backoff and has no outage retry-count cutoff. The existing `retry.maxRetries` setting is not that cutoff.

A recovered request continues in the same invocation. Completed tools are not replayed. Owned summaries, refinement, and side questions retain their pending work during recovery. Cancellation, disabled recovery, permanent or unknown failures, provider delay policy, and configured request/output/auxiliary budgets can still stop the operation. Failed output and physical attempts still count.

See [retry settings](settings.md#retry). “Durable recovery” does not mean every error is retryable or that an operation can run beyond its authorization.

## Retention, compaction, and deletion

Compaction changes the working context. It does **not** erase historical records, scrub secrets, or keep every detail in the summary. Indexed recovery can still read supported retained public history within the current branch and its limits.

Python state survives ordinary tool calls. Kernel snapshots provide best-effort restoration; some objects cannot be serialized, and retained state has limits. Do not infer that a process, variable, or background job survived from a summary alone.

Closing or deleting a subagent runtime does not erase its transcript and artifacts. Ephemeral sessions do not gain persistent, revivable session artifacts. Retention depends on the session and artifact lifecycle, not on the model remembering it. Keep sensitive material out of prompts and outputs that you do not want retained.

## User controls

In `~/.base-context/settings.json` or `.base-context/settings.json`:

```json
{
  "context": { "mode": "on" },
  "transport": "sse",
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

`context.mode` is a **creation default**. A saved session's accepted mode takes precedence. The SDK can change an existing session with `await session.setContextMode("off")` or `await session.setContextMode("on")` after accepted work settles.

Off retains native/public context, explicit history recovery, cancellation, and resource/request limits. It does not replay demoted archives. New compaction and refinement require re-enabling optimization. It is not equivalent to running stock Prime Agent, and is not the benchmark's upstream control.

Use `/context` and `/usage` to inspect the current session. Use `/compact` to request a summary and `/refine` to review durable harness lessons while optimization is enabled. For all settings, see [settings](settings.md).
