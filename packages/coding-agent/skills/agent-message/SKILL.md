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

- `await agent_message.send_result(summary, findings, receiver_role="parent", receiver_name=None)` — sends
  a result capsule instead of putting a full report in the recipient's context.
  `summary` and `findings` must be strings. The same family selectors as `send`
  apply; the default receiver is the parent. There is no result broadcast.
  Read a report file locally and pass its useful public text as `findings`, not
  just its path. The recipient archives that text through its existing session
  manager before notification. The capsule and receipt contain only the summary
  and an exact native recovery reference (`resultRef`: `sourceSessionId`, `ref`,
  `field: "/data/findings"`), never the full findings. Recover needed reports with
  the existing `prime_context` read/search actions and the supplied reference.
  Native staging rejects summaries over 2,000 characters and encoded archives
  over the existing 1 MiB source budget. It does not truncate either value.

## Result capsules

Use `send()` for short coordination. Use `send_result()` for a full public report:

```python
from pathlib import Path

findings = Path("report.md").read_text()
receipt = await agent_message.send_result(
    "The routing fix is ready. Focused checks remain blocked on integration.",
    findings,
)
```

State conclusions, caveats, and decisions in the capsule. If it revises or
replaces earlier reports, name their exact report refs in the summary. With
several updates, skim the capsules first, then retrieve the last relevant
report or reports. Older reports remain readable. Do not treat unrelated
findings or unresolved blockers as replaced merely because a newer report
arrived. There is no automatic latest-wins, dropping, or coalescing.

## Safety

- Do not delete a child immediately after `send`: delivered follow-ups may still
  be running and queued receipts have not run yet. Wait until observation shows
  the child is idle and its context is no longer needed before calling
  `await rlm.delete_subagent(child)`.
- Reach is limited to parent, siblings, and direct children; relay through an
  intermediate child instead of messaging grandchildren or cousins directly.
- Sender identity is daemon-derived and cannot be spoofed from Python.
- The daemon enforces message size, rate, and pending-queue limits before
  accepting delivery.
