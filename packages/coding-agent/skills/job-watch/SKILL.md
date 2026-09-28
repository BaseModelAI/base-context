---
name: job-watch
description: Watch launched jobs with native completion callbacks or scheduled read-only probes. Park owned continuation, suppress unchanged status, and deliver prepared evidence for failures, completion, changes, or required reports.
---

# Job Watch

Use for repeated checks or jobs that outlive a short tool call. Tiny commands do not need a watch. Launch once with `bash()` or an authorized project helper. This skill never launches a job, retries a run, starts the next stage, or completes a goal.

```python
job = bash(existing_authorized_command)
w = await job_watch.watch(
    job, job_id="run-1", completion_source="handle",
    probe_command=existing_read_only_probe_command,
    interval="5m", notify="terminal", report_every="5m", fields=["updates", "wall_seconds"],
)
await job_watch.park([w["id"]])
```

Continue useful independent work instead of parking when possible. `park` returns immediately. It holds only automatic goal/autonomous continuation until an event from a selected watch. The goal stays active. User messages and unrelated queued work still run. End the turn after parking; do not poll or sleep.

## API

- `await watch(job=None, *, job_id=None, completion_source, probe_command=None, interval="5m", notify="terminal", fields=None, report_every=None, deadline=None, probe_timeout=30)` registers once. Repeating the same active resource registration returns its existing watch. `fields` selects top-level progress keys for cached status, required reports, and `notify="changes"`. Include every metric needed in reports. Observation time never counts as a change. Intervals use existing schedule syntax, with a ten-second minimum. `deadline` is an ISO date; timeout is seconds.
- `await status(id=None)` returns cached snapshots, not a new probe.
- `await park(ids)` registers a wait without blocking the cell.
- `await unregister(id)` stops observation. It is idempotent and never kills the monitored job. It may cancel an in-flight probe.

Set `completion_source="probe"` for detached remote jobs. A successful SSH launcher exit is **not** remote completion. Probe-only registration requires `job_id`. A probe command must be an already authorized, noninteractive, read-only command in the project's native environment. Do not pass notebook closures. The command prints one JSON object of at most 16 KiB:

```json
{"observed_at":"2026-09-28T12:00:00Z","job_id":"run-1","state":"running","progress":{"updates":12,"wall_seconds":45},"attention":[],"evidence":["runs/run-1/metrics.json"]}
```

Use strings for exact identifiers and precision-sensitive values. Unsafe integers, nonfinite numbers, and precision-losing numeric tokens are rejected as unavailable observations.

States are `running`, `succeeded`, `failed`, `cancelled`, and `unknown`. Preserve units, configuration/run identity, unavailable values, and comparison eligibility in selected fields. Put project-specific threshold or quality-gate warnings in `attention`. Missing/partial JSON or transport failure means unavailable evidence, not permission to restart training. New observability problems and terminal failures remain visible; repeated identical problems are suppressed.

Checks do not require reports. Omit `report_every` unless the user requires periodic reports. Required reports include a prepared snapshot even when values did not change. Delayed observations show lateness; they do not pretend to have run on time. Notifications are about 2 KiB. Large fields are explicitly omitted and captured probe output remains in the supplied file locator. Bash may already have discarded output; use explicit project log files when complete execution evidence matters.

Consume delivered evidence; inspect raw sources only for decisions. Compaction does not recreate a watch. Clean shutdown retains undelivered reports with their original IDs. If shutdown interrupts delivery and its acknowledgement, recovery reports delivery as unknown; it does not claim exactly-once crash recovery. After restart, only an authoritative probe can reconcile a job; a lost handle becomes unknown. Never attach by PID or relaunch automatically. Imported/forked declarations do not acquire ownership. Preserve resource exclusivity, authorized run counts, and stop conditions. Unregister at the requested endpoint.

Pending watch state is limited to 64 KiB (less under smaller source limits). If undelivered evidence fills it, prior reports remain; monitoring stops with unknown, a reason, and a retained locator. This is not successful cadence preservation. The job keeps running. Resume delivery, unregister exhausted watches, and explicitly register again. No automatic retry.
