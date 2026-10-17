# Base Context 1.1.12

This release improves the inputs used for solving, delegation, and integration.
The changes apply across coding and analysis tasks. They add no task-specific
rules or mandatory review workflow.

- **Literal requirements:** Keep hard constraints, targets, assumptions, and
  acceptance metrics distinct throughout implementation and reporting.
- **Contrary evidence:** Keep corrective findings, unresolved conflicts, caveats,
  and report references visible through compaction and integration. Deleting a
  busy child remains an intentional cancellation and can lose unsent corrections.
- **Independent analysis:** Give analytical workers original evidence and neutral
  questions before a preferred answer. Shared premises do not make agreement
  independent support.
- **Stage interfaces:** Optional `task_contract.stages` describes named inputs,
  outputs, and assumptions without introducing an execution pipeline.
- **Consumer checks:** Optional `boundary_case` metadata records expected behavior,
  consumer interface, runtime, and working directory. Use an authorized focused
  check at the actual consumer boundary, not only an internal helper or producer.

Interrupted native-tool sessions also reopen correctly when their accepted context
mode is unchanged, without prematurely validating a new provider request.

Task contracts remain parent-authored context, not new user authority or launch
permission. Descriptive metadata never executes commands. No daemon protocol or
publication behavior changes are included.

Offline tests cover prompt inputs, contract validation, compaction, and runtime
behavior. They do not establish a benchmark accuracy gain; this release preparation
does not include a Terminal-Bench rerun.
