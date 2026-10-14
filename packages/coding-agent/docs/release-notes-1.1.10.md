# Base Context 1.1.10

## Task workflows

This release adds optional tools for tasks that need coordinated delivery or optimization. Simple tasks keep their existing delegation and result paths.

- Pass a `task_contract` to `rlm` to keep rules, hard bounds, targets, output meanings, supplied references, and assumptions distinct. Parent-authored contract context remains descriptive and recoverable after compaction.
- Declare delivered files and their dependencies. `rlm.workflow.stage_delivery` stages only explicitly listed, dependency-complete files under consumer-relative names without overwriting existing outputs.
- Use `rlm.workflow.bounded_search` for caller-defined, bounded construction or search. It prunes infeasible states before expansion and compares exact lexicographic objective tuples. Its result separates a feasible incumbent from observed search exhaustion.
- Return an `outcome` through `agent_message.send_result` to keep decisive facts, interpretations, assumptions, and conflicts distinct in the result capsule and full report.
- Name integration and activation owners. Report prepared, integrated, loaded, or exercised state without treating preparation as a live observation or permission to activate anything.
- Use `bash(command, cwd=..., mode=...)` for an explicit working directory and caller-declared execution mode. Handles and completed results expose the same immutable command, launch directory, shell, and mode context.
- Record the relevant public-interface or current-state boundary case in the task contract. This does not start a test suite or add a mandatory workflow to simple tasks.

See [Task workflows](task-workflows.md) for examples and input contracts.

## Compatibility and limits

These are additive local runtime APIs. Daemon commands, events, response shapes, capabilities, and protocol versions do not change. Contracts and outcomes use existing message and result transport; they do not create a second task database or grant user authority to agent reports.

Delivery dependencies remain caller declarations, not an import scan. Search exhaustion covers only the caller-defined search space and pruning rules. Readiness remains a reported state, not independent verification. The existing combined 2,000-character result-summary limit still rejects oversized capsules rather than truncating them.

The changes are based on failure traces from an interrupted benchmark run. No new paid benchmark was run, and this release makes no measured success-rate claim.

## Release preparation

Preparation is local only. Publication, tagging, pushing, and merging require separate approval. Focused offline tests and the repository checks cover the changed paths; the full offline suite is not claimed here.

The pinned 1.1.9 dependency baseline has known npm audit advisories, including `extract-zip` on the Windows tool-download path and `basic-ftp` in the optional PAC/proxy dependency chain. This feature release does not claim to resolve that inherited dependency risk. The local preparation report records the audit details separately from the feature review.
