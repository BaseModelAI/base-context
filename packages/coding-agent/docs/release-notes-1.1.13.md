# v1.1.13

Restored the v1.1.11 prompts and task guidance, with targeted runtime fixes.

- Added `continuation.block()` and `/continuation` controls for explicit external blockers. A hold stops automatic continuation, preserves the unfinished goal and owned work, and remains until explicit user or host resume.
- Added `/autonomous gates set <JSON-array>` to replace gate commands without resetting run budgets. Delayed results from replaced commands cannot restore obsolete failures.
- Fixed reopening sessions with pending tool continuations.
- Fixed a session-catalog race when an index worker exits before its final reply is read.
- Added optional startup progress to session-creation timeout diagnostics. Older clients and daemons continue to work without it.

This release is not the earlier partial-rollback benchmark candidate. No new TerminalBench results or measured accuracy, time or cost parity are claimed.
