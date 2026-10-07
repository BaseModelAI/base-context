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

Continue independent work when possible. `park` returns immediately and holds only automatic goal/autonomous continuation. The goal stays active; user messages and unrelated work still run. End the turn after parking. Do not poll or sleep.

## API

- `await watch(job=None, *, job_id=None, completion_source, probe_command=None, interval="5m", notify="terminal", fields=None, report_every=None, deadline=None, probe_timeout=30)` registers once. Repeated active-resource registration returns its watch. `fields` selects top-level progress keys for status, reports, and `notify="changes"`; include every required metric. Timestamps never count as changes. Intervals use existing schedule syntax (ten-second minimum). Deadline is ISO; timeout is seconds.
- `await status(id=None)` reads cached snapshots, without probing.
- `await park(ids)` registers a nonblocking wait for a nonempty list of IDs returned by `watch`. It does not register watches. If waiting only for a child reply, end the turn without parking.
- `await unregister(id)` stops observation, never the job. It may cancel a probe and revoke queued routine snapshots. Already-admitted terminal/failure/attention/monitoring-loss evidence remains. Selected/in-flight input is unchanged. Unregister is idempotent.

Use `completion_source="probe"` and a `job_id` for detached remote jobs. Successful SSH launcher exit is **not** remote completion. The probe must be authorized, noninteractive, read-only, and run in the project's native environment; no notebook closures. It prints one JSON object, at most 16 KiB:

```json
{"observed_at":"2026-09-28T12:00:00Z","job_id":"run-1","state":"running","progress":{"updates":12,"wall_seconds":45},"attention":[],"evidence":["runs/run-1/metrics.json"]}
```

Use strings for exact identifiers and precision-sensitive values. Unsafe integers, nonfinite numbers, and precision-losing tokens are rejected as unavailable observations. States are `running`, `pending`, `succeeded`, `failed`, `cancelled`, and `unknown`. Preserve units, configuration/run identity, unavailable values, and comparison eligibility. Put project-specific gate warnings in `attention`. Partial JSON or transport failure means unavailable evidence, never permission to restart. Identical repeated problems are suppressed.

## Delivery

Omit `report_every` unless periodic reports are required. Check cadence stays unchanged. Unread routine progress/report snapshots keep only the latest within the same watch generation, goal, and source. `superseded_snapshots` counts replaced snapshots. A terminal snapshot can supersede routine snapshots and a report due at that check. Null/missing fields and latest scientific values are preserved, not merged. Critical failure, attention, observability-loss, deadline, and delivery-unknown evidence survives later routine updates. Selected input is frozen before acknowledgement. User/agent messages are not coalesced.

Delayed observations show lateness. Notifications are about 2 KiB; oversized fields are explicitly omitted. Inspect retained evidence for decisions. Bash may discard output, so use project logs when complete evidence matters.

Compaction does not recreate watches. Clean shutdown retains pending IDs. Interrupted delivery recovers as delivery-unknown, not exactly-once. After restart, only authoritative probes reconcile jobs; lost handles become unknown. Never attach by PID or relaunch. Imported/forked declarations gain no ownership. Preserve resource exclusivity, authorized run counts, and stop conditions.

Pending state is capped at 64 KiB, or less under source limits. Exhausted critical-evidence space preserves prior evidence but stops monitoring with unknown and a retained locator. The job keeps running. Resume delivery, unregister exhausted watches, and explicitly register again; no automatic retry.
