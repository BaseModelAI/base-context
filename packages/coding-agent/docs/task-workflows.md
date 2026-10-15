# Task workflows

Use these optional tools when a task has important constraints, objective order,
or delivery boundaries. A simple edit or lookup does not need a contract or a
multi-stage checklist. Use only relevant fields.

## Keep the task meaning explicit

`await rlm(prompt, task_contract={...})` accepts a structured parent-authored
brief. It validates the shape before child admission and returns the usual child
handle, not a completed result. The contract does not create user authority,
authorize a launch, prove correctness, or automatically complete a task or goal.

Preserve the user's rules, priorities, reference meanings, units, and required
consumer paths. Keep hard bounds separate from desired targets, and keep your
assumptions separate from supplied rules. Do not substitute a convenient output
meaning for the requested one. If an earlier decision changes a later decision's
inputs, reconsider the later decision in the stated order.

All top-level fields are optional. Unknown fields are rejected. Within an
included section, fields are required unless marked optional below.

| Field | Value |
| --- | --- |
| `rules`, `hard_bounds`, `targets`, `references`, `assumptions` | Lists of strings |
| `output_meanings` | Map of output names to string meanings, including units and rounding when relevant |
| `objective` | `components`: ordered list of strings; `direction`: `maximize` or `minimize`; optional `target`: string; `work_limit`: positive safe integer |
| `delivery` | `workspace`: string; optional `consumer_root` and `mode`: strings; `files`: list of `{path, dependencies?}` with string paths and optional lists of string dependencies |
| `integration_owner`, `activation_owner` | Strings naming responsible agents or people, not granting permission |
| `boundary_case` | `description`: string; optional `command`: string |

For example, a file task might need only delivery and boundary information:

```python
child = await rlm(
    "Prepare the requested CLI in the assigned workspace. Do not deploy it.",
    name="cli-worker",
    task_contract={
        "delivery": {
            "workspace": "/work/cli-worker",
            "consumer_root": "/srv/consumer",
            "mode": "python-script",
            "files": [{"path": "cli.py", "dependencies": ["helpers.py"]},
                      {"path": "helpers.py"}],
        },
        "integration_owner": "parent",
        "boundary_case": {"description": "Run the CLI with empty input from the consumer root."},
    },
)
```

`boundary_case.command` is descriptive. It does not execute a command or grant
permission to run one. If testing is warranted, select one relevant
public-interface or state-boundary edge within the task's existing test budget.
Do not add an indiscriminate test suite.

## Separate observations from conclusions

A child can send a compact structured report:

```python
receipt = await agent_message.send_result(
    "Prepared CLI files; not yet integrated into the consumer.",
    findings,
    outcome={
        "facts": [{"source": "cli-check.txt", "field": "exit_code", "value": "0"}],
        "interpretations": ["The workspace CLI accepted empty input."],
        "readiness": {"stage": "prepared", "target": "/srv/consumer",
                      "owner": "parent", "unmet": ["consumer integration"]},
    },
)
```

See the [agent-message skill](../skills/agent-message/SKILL.md#optional-structured-outcome)
for every field. `facts` retain decisive source, field, and string value;
`interpretations`, `assumptions`, and `conflicts` remain distinct. Artifact entries
name paths and dependencies. Objective values are strings in the declared order,
with `feasible`, `optimal`, or `limit_reached` status and optional `evaluated`
count. Feasibility does not establish optimality or target attainment.

The entire rendered outcome is appended to the short capsule. The combined
summary and outcome must fit 2,000 characters; oversize reports are rejected,
not truncated. Keep full public details in `findings`, which the recipient can
recover from the capsule's reference. Reports remain child claims, not proof or
automatic task/goal completion. New reports do not silently resolve conflicts
with older evidence.

## Deliver the declared files and dependencies

Carry supplied consumer transfer paths, exclusions, service/step distinctions,
and execution mode into delivery-specific child briefs. Preserve transfer rules
in `task_contract.rules` and selected concrete files and dependencies in
`task_contract.delivery`. Unknown transfer metadata stays unknown; do not infer
an allowlist or add a sidecar the consumer cannot receive. A local workspace run
is not evidence that a separately transferred program has its dependencies.

Pass an existing delivery declaration directly to the helper:

```python
stage = rlm.workflow.stage_delivery(task_contract["delivery"], "/work/staged-cli")
```

The destination is explicit. `consumer_root` and `mode` describe the consumer;
they do not select the staging destination or authorize activation. Use the
staged consumer representation for any already-authorized normal invocation,
not the development workspace with undeclared helpers still present.

Inspect `help(rlm.workflow.stage_delivery)` for the full helper contract. Without
an existing delivery declaration, pass explicit files and dependencies:

```python
stage = rlm.workflow.stage_delivery(
    workspace="/work/cli-worker",
    destination="/srv/consumer",
    files=["cli.py", "helpers.py"],
    dependencies={"cli.py": ["helpers.py"]},
)
```

The helper explicitly copies the listed workspace-relative files. Include every
declared dependency, including dependencies of dependencies, in `files`.
It does not scan imports, infer missing dependencies, or invent an export
allowlist. Use the paths and delivery mode required by the actual consumer.

Existing destination leaves are never overwritten, even if identical. Unrelated
destination content remains. Invalid declarations and paths are rejected before
copying, but an I/O failure during copying can leave a partial delivery. The
helper does not roll back changes. It copies files; it does not load or launch
anything.

`DeliveryStage` contains absolute `workspace` and `destination` roots, relative
`files`, and immutable `(path, dependency_tuple)` pairs in `dependencies`. Map
these explicitly to a delivery section; there is no conversion method:

```python
dependencies = dict(stage.dependencies)
delivery = {
    "workspace": stage.workspace,
    "consumer_root": stage.destination,
    "files": [{"path": path, "dependencies": list(dependencies.get(path, ()))}
              for path in stage.files],
}
```

Add `delivery["mode"]` only when the consumer's required execution mode is known.

## Report the state actually observed

Readiness describes the target, not just whether a worker returned successfully:

- `prepared`: artifacts exist in the workspace or staging location.
- `integrated`: artifacts are connected to the intended consumer.
- `loaded`: the intended runtime has loaded the changed artifacts.
- `exercised`: the relevant public interface or state boundary ran in that runtime.

Name the `target`, responsible `owner`, and `unmet` conditions when relevant.
These are report states, not mandatory gates for every task. Integration and
activation owners are assignments, not authorization. A copied file does not
establish that a running service loaded it.

Changing semantic inputs, dependency files, consumer paths, or integration state
invalidates observations that depended on those inputs. Do not reuse that result
as evidence for the changed state. This does not require automatically repeating
all checks; choose only the task-relevant observation if more evidence is needed.

## Preserve launch context

`bash(command, *, cwd=None, mode=None)` accepts an explicit working directory and
an optional caller-declared mode:

```python
handle = bash(".venv/bin/python cli.py", cwd="/srv/consumer", mode="python-script")
launch = handle.context
# After completion, the result's context contains the same launch snapshot.
```

`handle.context` and `result.context` retain immutable `command`, resolved launch
`cwd`, selected `shell`, and `mode`. They do not capture environment values or
infer interpreters in a pipeline. `mode` is metadata; it does not select a runtime.
A command can change its own directory without changing the launch snapshot.
Use the target project's native environment. Start only authorized work, and use
`job_watch` for repeated job checks rather than a polling loop.

## Bound external waits and inspect terminal results

An individual `probe_timeout` limits one probe, not the total wait for a remote
job. Set `wait_budget` in seconds or an absolute ISO `deadline` when registering
an external dependency, not both. For example, for an already-launched job:

```python
watch = await job_watch.watch(
    job_id=remote_job_id,
    completion_source="probe",
    probe_command=read_only_status_command,
    wait_budget=600,
    interval="30s",
)
```

Detached probe watches default to a 15-minute owner review when neither budget
nor deadline is supplied. The deadline wakes the owner once; monitoring and the
external job continue, with no automatic cancellation, retry, or provider switch.
Review partial results and elapsed/queued time, report unresolved work, and decide
whether to stop waiting or explicitly renew observation with a new budget. See
[job-watch](../skills/job-watch/SKILL.md) for the registration and renewal API.

`events = await job_watch.consume(watch["id"])` emits a compact terminal receipt
even when assigned. The full return still contains the evidence. Inspect the
relevant event details before choosing an artifact or reporting completion;
a successful process is not necessarily a successful task outcome.

Check the result of `await job_watch.park([watch["id"]])`. If `parked` is true,
end the turn. If it is false with `reason="event_available"`, no continuation
hold was acquired by this call; an earlier hold may remain. Inspect already-consumed
evidence or call `consume`/`status`,
then act on the actual result. Do not assume another automatic turn. If events
are already queued or in flight, let normal delivery run instead of polling.
When waiting only for a child reply, end the turn without parking.

## Search within an explicit work limit

`rlm.workflow.bounded_search(initial, *, expand, feasible, complete, objective,
max_states, maximize=True)` performs lazy depth-first search. Inspect its help for
full details. Use an iterable of roots, or `[root]` for one root:

```python
result = rlm.workflow.bounded_search(
    [0],
    expand=lambda value: [value + 1],
    feasible=lambda value: value <= 3,
    complete=lambda value: value == 3,
    objective=lambda value: (value,),
    max_states=10,
)
# result.state == 3; result.objective == (3,)
```

This tiny example can run inline. Heavy searches belong in a managed process
using the project's native environment, not on the REPL main thread. From a
project with the runtime installed, `from rlm import workflow` exposes the same
helpers. `max_states` bounds visited candidates, not callback time; callbacks
and iterator steps must terminate.

The feasibility predicate runs before completion or expansion and prunes an
entire subtree when false. Every visited candidate counts, including infeasible
ones. Only complete feasible states receive an objective. Return fixed-length
tuples of `int`, finite `Decimal`, or `Fraction`, not floats or booleans.
Comparison is exact and lexicographic in tuple order. Preserve the declared
objective priority, direction, and target. Exact comparison does not undo
rounding already introduced while computing an objective.

`SearchResult` has `state`, `objective`, `visited`, and `exhausted`. It retains the
best feasible complete incumbent, choosing the first on ties. No incumbent has
`objective=None`. A zero budget performs no iteration. At the budget boundary,
`exhausted=False` is conservative, even if the last candidate was the last
available one. An exhausted search establishes an optimum only within the
caller-defined complete/pruned search space, not that the model of the problem
or its pruning rules were correct. Report the search scope and remaining limits;
do not label a feasible incumbent optimal merely because work stopped.
