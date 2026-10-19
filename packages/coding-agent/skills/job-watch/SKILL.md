---
name: job-watch
description: Watch launched jobs with completion callbacks or read-only probes. Park owned continuation and deliver failures, completion, changes, or periodic snapshots.
---

# Job Watch

Use for jobs that outlive a short tool call. Tiny commands need no watch. Launch once with `bash()` or an authorized helper. Watches never launch, retry, advance stages, or complete goals.

```python
job = bash(existing_authorized_command)
w = await job_watch.watch(
    job, job_id="run-1", completion_source="handle",
    probe_command=existing_read_only_probe_command,
    interval="5m", notify="terminal", report_every="5m", fields=["updates", "wall_seconds"],
)
await job_watch.park([w["id"]])
```

Continue independent work when possible. `park` returns immediately and holds only automatic goal/autonomous continuation. The goal stays active; user messages and unrelated work still run. End the turn when `parked` is true. If it is false, inspect the reason and available evidence before ending the turn. Do not poll or sleep.

## API

- `await watch(job=None, *, job_id=None, completion_source, probe_command=None, interval="5m", notify="terminal", fields=None, report_every=None, deadline=None, wait_budget=None, probe_timeout=30)` registers once. Repeated active-resource registration returns its watch. If a handle result is already ready, registration relays it and returns the updated cached status; its notification remains pending for normal delivery or `consume`. Registration never waits for a running handle or unfinished result capture. `fields` selects top-level progress keys for status, reports, and `notify="changes"`; include every required metric. Timestamps never count as changes. Intervals use existing schedule syntax (ten-second minimum). `deadline` is ISO; `wait_budget` is a positive finite number of seconds from registration, converted to that existing deadline (millisecond host resolution). Booleans and non-numeric values are rejected. Budgets beyond the supported ISO timestamp range (year 9999) raise `ValueError`; they are not clamped. Supply only one. Detached probe watches default to a 900-second owner wake-up unless either is supplied; handle watches have no default. `probe_timeout` bounds one probe, not the total wait. Re-registering an active resource returns the existing watch without renewing its deadline.
- `await status(id=None)` reads cached snapshots, without probing or consuming notifications.
- `await consume(id=None)` transfers retained notification bodies to the Python caller as `events`, each with its `event_id` and `watch_id`. Retain and inspect this result. Consumed terminal events also print a compact receipt, even when the return is assigned. Receipts show at most eight event/watch IDs and states plus an omitted count, not metrics or arbitrary payloads. The full return is unchanged. The transfer removes only those exact unadmitted or still-queued events; it is not acknowledgement that the model read them. Selected/in-flight events remain pending and appear in `deferred_event_ids`. Omit `id` to consume this session's retained events, including unregistered watches. Other sessions' events are unaffected.
- `await park(ids)` registers a nonblocking wait for a nonempty list of IDs returned by `watch`. It does not register watches. If waiting only for a child reply, end the turn without parking. A retained completion for those IDs enters normal delivery even if it finished before this call. If native admission is blocked, `parked: true` keeps the owned hold. `parked: false, reason: "event_available"` means this call acquired **no new hold for the requested watches**; an earlier hold may remain: retained evidence is queued or already in flight, or the completion was already consumed or acknowledged. Parking does not return or consume event bodies; use `consume` for an explicit transfer instead. Consumed or acknowledged events are not redelivered. The Python call prints an action hint even if assigned. Inspect already-consumed events or call `consume`/`status`, then act or report the actual outcome; do not assume a later automatic turn. If events are deferred/in flight, let normal delivery run instead of polling. `parked: false, reason: "monitoring_unavailable"` also prints a refusal hint: inspect status and retained partial evidence, then report the unresolved outcome; do not relaunch or assume completion. An earlier hold may remain in this case too.
- `await unregister(id)` stops observation, never the job. It may cancel a probe and revoke queued routine progress snapshots. Terminal/failure/attention/monitoring-loss evidence and requested reports remain deliverable or consumable, even after the watch leaves the status roster. Selected/in-flight input is unchanged. Unregister is idempotent.

At most 16 active or unresolved watches can occupy slots. An inactive terminal watch stops occupying a slot only after all its pending events are consumed or acknowledged. Its cached status and evidence remain readable. Pending reports and queued/in-flight events on registered watches still occupy a slot. Cached history remains subject to the declaration and pending-state byte budgets; explicitly `unregister` obsolete watches when their status is no longer needed.

Use `completion_source="probe"` and a `job_id` for detached remote jobs. Successful SSH launcher exit is **not** remote completion. The probe must be authorized, noninteractive, read-only, and run in the project's native environment; no notebook closures. It prints one JSON object, at most 16 KiB:

```json
{"observed_at":"2026-09-28T12:00:00Z","job_id":"run-1","state":"running","progress":{"updates":12,"wall_seconds":45},"attention":[],"evidence":["runs/run-1/metrics.json"]}
```

Use strings for exact identifiers and precision-sensitive values. Unsafe integers, nonfinite numbers, and precision-losing tokens are rejected as unavailable observations. States are `running`, `pending`, `succeeded`, `failed`, `cancelled`, and `unknown`. Preserve units, configuration/run identity, unavailable values, and comparison eligibility. Put project-specific gate warnings in `attention`. Partial JSON or transport failure means unavailable evidence, never permission to restart. Identical repeated problems are suppressed.

## External dependency waits

Before parking on an external research dependency, choose a task-appropriate total `wait_budget` (seconds) or absolute `deadline`. The default 15-minute probe budget is an owner review point, not a job runtime limit. Include queued/elapsed duration, resolved work, and unresolved work in the probe's selected progress fields or retained evidence. Use `report_every` when intermediate owner reports are required.

The deadline schedules a check even when the normal probe interval is longer. Its notification wakes the owner after that check (or an already-running probe) returns or times out; admission and an active owner turn can add delivery delay. A pending job remains pending; observation continues and the job is not cancelled. Inspect partial results, report the blocked dependency and elapsed wait to the parent/user, and choose whether to continue for an explicit reason or return an honest incomplete result. A deadline reports once. If continuing, set the next review point explicitly: unregister observation and register the same running job with a new budget, without relaunching it. Do not automatically retry, resubmit, or change providers. Keep partial work clearly partial.

## Delivery

Omit `report_every` unless periodic reports are required. Check cadence stays unchanged. Routine `notify="changes"` progress updates are retained in watch state and available through `status` and `consume`, without starting model turns. Unread progress snapshots keep only the latest within the same watch generation, goal, and source; `superseded_snapshots` counts replacements. A terminal snapshot can supersede routine progress and includes a report due at that check. Requested periodic report bodies are retained separately and still trigger delivery.

A successful completion wakes a parked watcher, including when `park` explicitly selects an already retained completion. Success for IDs that were not awaited remains available through `consume`, without an extra model turn. Failures, attention, observability loss, deadlines, and requested reports can wake an idle agent or join a batch after the active run finishes. Adjacent job-watch notifications share a model turn without discarding their bodies. Null/missing fields and latest scientific values are preserved, not merged. Critical evidence survives later routine updates. Selected input is frozen. User/agent messages are not coalesced with job-watch batches.

Delayed observations show lateness. Notifications are about 2 KiB; oversized fields are explicitly omitted. Inspect retained evidence for decisions. Bash may discard output, so use project logs when complete evidence matters.

Compaction does not recreate watches. Clean shutdown retains pending IDs. Interrupted delivery recovers as delivery-unknown, not exactly-once. After restart, only authoritative probes reconcile jobs; lost handles become unknown. Never attach by PID or relaunch. Imported/forked declarations gain no ownership. Preserve resource exclusivity, authorized run counts, and stop conditions.

Pending state is capped at 64 KiB, or less under source limits. Exhausted critical-evidence space preserves prior evidence but stops monitoring with unknown and a retained locator. The job keeps running. Deliver or consume retained evidence, unregister exhausted watches, and explicitly register again; no automatic retry.
