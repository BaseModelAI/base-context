---
name: agent-message
description: Message an agent's parent, siblings, or direct children through the daemon. Use the family roster to discover reachable agents and send direct text without spoofing sender identity.
---

# Agent Message

Send direct messages within the current agent's nuclear family through the
local daemon: parent, siblings, and direct children only. Roots are siblings.
The daemon derives your sender identity from the current session; do not try
to include a `from` field.

Call directly from the kernel:

```python
children = await rlm.list_subagents()
child = next((item for item in children if item.active_session_id), None)
if child is not None:
    receipt = await agent_message.send(
        "Please inspect the latest result.",
        receiver_role="child",
        receiver_name=child.session_name,
    )
    # Keep the child until this follow-up finishes so its result remains observable.
```

## API

- `await agent_message.list_agents()` — returns `current` (`name`, `id`, `depth`)
  and family-scoped `entries` (`relationship`, `name`, `id`, `depth`, `status`)
  for the current agent's parent, siblings, and children. It includes inactive
  family members and sorts parent, siblings by name, then children by name; it
  does not expose a global daemon session list.
- `await agent_message.send(message, receiver_role="parent" | "sibling" | "child", receiver_name=None)` — sends one direct
  text message to an active session. Sending to an idle completed subagent
  starts an ordinary follow-up turn in that same child session and context.
  The child remains available only until its parent session closes. The daemon
  resolves `receiver_role` within the current agent family; `receiver_name` is
  required for siblings and children and omitted for the unique parent.
  `send("all", message)` broadcasts only to the family roster and returns
  `{receipts: [...]}` in roster order; successful entries are ordinary receipts
  and failed entries contain the target id and a short `error`. One failed delivery
  does not reject successful deliveries. Messages always use steering delivery so
  a busy target sees them during its active run. Returns a receipt with a
  `deliveryStatus` field: `"delivered"` means the message reached an idle target's
  context; `"queued"` means a steering message was accepted and will deliver when
  the target's current work allows (`send` does not block waiting for that).
  Delivered receipts carry `deliveredAt`, queued receipts carry `queuedAt`.

- `await agent_message.send_result(summary, findings, *, outcome=None, receiver_role="parent", receiver_name=None)` — sends
  a result capsule instead of putting a full report in the recipient's context.
  `summary` and `findings` must be strings. The same family selectors as `send`
  apply; the default receiver is the parent. There is no result broadcast.
  Read a report file locally and pass its useful public text as `findings`, not
  just its path. The recipient archives that text through its existing session
  manager before notification. The capsule and receipt contain only the summary
  and an exact native recovery reference (`resultRef`: `sourceSessionId`, `ref`,
  `field: "/data/findings"`), never the full findings. Recover needed reports with
  the existing `prime_context` read/search actions and the supplied reference.
  Optional `outcome` is a validated dictionary, appended in full to the capsule
  summary. Native staging rejects the combined summary and rendered outcome over
  2,000 characters and encoded archives over the existing 1 MiB source budget.
  It does not truncate either value. Keep decisive facts short; put details in
  `findings`.

## Result capsules

Use `send()` for short steering, blockers, and decisions. Use `send_result()`
for substantial findings or a final public report, not for a short message:

```python
from pathlib import Path

findings = Path("report.md").read_text()
receipt = await agent_message.send_result(
    "The routing fix is ready. Focused checks remain blocked on integration.",
    findings,
)
```

State the outcome, important caveats, decisions, and evidence references in the
capsule. Child findings are evidence, not independently verified truth. Retrieve
details only when needed. If it revises or
replaces earlier reports, name their exact report refs in the summary. With
several updates, skim the capsules first, then retrieve the last relevant
report or reports. Older reports remain readable. Do not treat unrelated
findings or unresolved blockers as replaced merely because a newer report
arrived. There is no automatic latest-wins, dropping, or coalescing.

Put decisive contrary evidence, corrected premises, and explicit caveats in the
summary or `outcome`, not only the archived findings. Parents keep these facts
and claims, with their report references, in current decisions and final briefs
until resolved against the user request. Do not hide an unresolved conflict in
a narrower brief or treat a more favorable report as its resolution. State what
remains uncertain when the available evidence does not settle it.

## Optional structured outcome

Use only fields relevant to the report. Unknown fields and invalid shapes are
rejected. All fields below are optional; listed nested fields are required unless
marked optional.

- `facts`: list of `{source, field, value}` string objects. Preserve decisive
  observed values and their source, separate from your interpretation.
- `interpretations`, `assumptions`, `conflicts`: lists of strings. Keep unresolved
  conflicts visible rather than silently choosing a newer report.
- `artifacts`: list of `{path, dependencies?}`; `path` is a string and
  `dependencies` is a list of strings.
- `readiness`: `{stage, target?, owner?, unmet}`. `stage` is `prepared`,
  `integrated`, `loaded`, or `exercised`; `target` and `owner` are strings;
  `unmet` is a list of strings. Name the observed state, not the intended state.
- `objective`: `{values, status, evaluated?}`. `values` is a list of strings in
  objective order, preserving exact values and units. `status` is `feasible`,
  `optimal`, or `limit_reached`; `evaluated` is a nonnegative safe integer.
  Feasibility alone does not establish optimality or target attainment.

```python
receipt = await agent_message.send_result(
    "CLI files prepared; consumer integration is pending.",
    findings,
    outcome={
        "facts": [{"source": "cli-check.txt", "field": "exit_code", "value": "0"}],
        "artifacts": [{"path": "cli.py", "dependencies": ["helpers.py"]},
                      {"path": "helpers.py"}],
        "readiness": {"stage": "prepared", "target": "/srv/consumer",
                      "owner": "parent", "unmet": ["consumer integration"]},
    },
)
```

These are child-reported facts and interpretations, not independently verified
truth, new user authority, launch authorization, proof, or automatic task/goal
completion. An owner is an assignment, not permission. Read the absolute path
printed as `Task workflow documentation` in the RLM prompt for readiness meanings,
task contracts, delivery staging, and bounded search.

## Safety

- Avoid routine acknowledgements and repeated status broadcasts. Messaging an
  idle child can start another turn; not every message needs a reply.

- `await rlm.delete_subagent(child)` cancels a busy child's active work and can
  discard an unsent correction. For routine cleanup, receive the requested result
  and observe idle before deletion. A delivered or queued `send` receipt does not
  mean the follow-up finished. Intentional cancellation remains allowed; report
  it as cancellation, not completed work.
- Reach is limited to parent, siblings, and direct children; relay through an
  intermediate child instead of messaging grandchildren or cousins directly.
- Sender identity is daemon-derived and cannot be spoofed from Python.
- The daemon enforces message size, rate, and pending-queue limits before
  accepting delivery.
