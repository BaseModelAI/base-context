# Volunteer Shift Rescheduling

Build a deterministic volunteer scheduler using only the Python standard library:

```bash
python -m solution.volunteer_schedule inputs --output output
```

The initial inputs are:

- `volunteers.csv`: `volunteer_id,skills,preferred_locations,max_shifts`. Skills and locations are semicolon-separated sets.
- `availability.csv`: `volunteer_id,start,end`. A volunteer is available only when one row fully contains the shift's half-open interval.
- `shifts.csv`: `shift_id,start,end,location,required_skill,seats`.
- `travel_times.csv`: `from_location,to_location,minutes`. Travel times are directional. An omitted same-location trip takes zero minutes.

Times are naive ISO 8601 local coordinator times. Assign only qualified volunteers. One volunteer cannot fill two seats of a shift, exceed `max_shifts`, overlap half-open shift intervals, or take consecutive shifts when the time between them is less than the listed travel time. In addition, assignments at different locations always require at least a 30-minute gap, even when the listed travel time is smaller.

Optimize the complete schedule lexicographically:

1. maximize filled required seats;
2. maximize filled seats whose assigned volunteer has the required skill (never use an unqualified volunteer merely to fill a seat);
3. maximize preference score, one point when the shift location is preferred;
4. minimize the spread between the largest and smallest assignment counts across all volunteers;
5. break remaining ties by the lexical sequence of volunteer IDs for seats ordered by `(shift_id, seat)`, treating an unfilled seat as sorting after every volunteer ID.

Write `output/schedule.csv` with header `shift_id,seat,volunteer_id`, sorted by shift ID then numeric seat.
Use 1-based seat numbers. Include each assigned seat once. An unfilled seat
may be omitted from this file or included once with an empty `volunteer_id`;
in either case it must appear exactly once in `unfilled.csv`. Do not include
unknown seats, duplicate seats, or a seat that is both assigned and unfilled. Write `output/unfilled.csv` with header `shift_id,seat,required_skill,reason` in the same order. Use reason `no_qualified_volunteer` when nobody qualified is available and `capacity_or_conflict` otherwise.

Write `output/summary.json` with integer fields `required_seats`, `filled_seats`, `required_skill_coverage`, `preference_score`, `assignment_count_spread`, and `changed_assignments`, plus an array `fairness_exceptions`. Use sorted JSON keys and a final LF newline. CSV files use UTF-8 and LF endings.

Before later-stage inputs exist, set `changed_assignments` to `0` and `fairness_exceptions` to `[]`.

The fixed change-count baseline is the initial optimized schedule produced before `inputs/callout.json` exists. Preserve that schedule separately, or recompute it from the original inputs without the later-stage rules. Do not replace this baseline with a callout-adjusted or fairness-adjusted schedule. During every later stage and every repeated invocation, minimize changed assignments and report `changed_assignments` relative to this same original baseline. Count each `(shift_id, seat)` whose assigned volunteer differs, including a change between assigned and unfilled. If the fairness stage leaves the callout-adjusted schedule unchanged, the changes already made for the callout must still be counted; do not reset the count to zero.

All task material is inside the current workspace, so do not inspect parent paths such as `..`.

The held-out edge has a shift requiring a skill that no available volunteer has. Leave the seat unfilled and never assign an unqualified volunteer.

JSON counts must be numeric whole values, not booleans. Equivalent integral
numbers such as `1` and `1.0` are accepted; fractional counts are not.

## Execution environment and grading lifecycle

Python 3.12 and Bash are available. Extra shell utilities are not guaranteed.
Do not rely on background processes or `/tmp` files surviving between tool
calls. Use workspace files for scratch data needed by later calls.

Grading copies only `solution/` into fresh main and edge workspaces. In each
workspace it runs the initial command, adds the callout and runs again, then
adds fairness and runs again. Files produced within that fixture workspace
survive between these stage invocations; files from your development output
directory are not copied. The original baseline must remain fixed.
