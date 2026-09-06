# Travel Itinerary Repair

Build this deterministic itinerary checker using only the Python standard library:

```bash
python -m solution.itinerary_check inputs --output output
```

`itinerary.json` contains trip dates and segments. Segment local timestamps use `YYYY-MM-DDTHH:MM` and name their IANA start and end time zones. Convert them with `zoneinfo.ZoneInfo`; fixtures avoid ambiguous or nonexistent local times. Retain the supplied local text and format UTC as `YYYY-MM-DDTHH:MM:SSZ`. Intervals are half-open: an end exactly equal to another start does not overlap.

Initially, and again after the follow-up, write `timeline.csv` with exact header:

```text
segment_id,type,revision,start_local,end_local,start_timezone,end_timezone,start_utc,end_utc,origin,destination,booking_ref,selected_alternative_id
```

Include active segments only. Sort by UTC start then segment ID. Detect:

- every pair of active segment intervals that overlap;
- duplicate nonempty `booking_ref` values;
- connections between consecutive `flight` or `train` segments in UTC order. A connection is insufficient when the elapsed minutes are below `minimum_connection_minutes["previous_type>next_type"]` from `connection_rules.json`;
- an airport change whenever the previous transport destination differs from the next origin. Add `airport_change_minutes` to that connection's required time;
- nights without lodging. The required dates run from `trip_start_date` inclusive to `trip_end_date` exclusive. A hotel covers the night dated `D` when local midnight at the end of `D` (the start of the next date) lies strictly after check-in and before checkout.

Write `issues.json` as `{"issues": [...]}`. Use these exact `type` strings: `"overlap"`, `"duplicate_booking"`, `"insufficient_connection"`, `"airport_change"`, and `"night_without_lodging"`. An overlap, duplicate-booking, insufficient-connection, or airport-change item has `type` and the two ordered `segment_ids`: lexical ID order for overlap and duplicate
booking, and previous-to-next transport order for connection and airport-change
issues. A missing-lodging item has an empty `segment_ids` list and `night`. Sort items by type, joined segment IDs, then night. Use sorted JSON keys and a final LF newline.

For later rebooking, compare each update revision with the original revision
and keep the highest. Omit a segment whose winning status is `cancelled`.
A replacement keeps the segment ID, type, winning revision, and booking
reference; replace its local times, time zones, origin, and destination with
the chosen alternative and set `selected_alternative_id`. Apply the airport
change allowance when testing an alternative from a different origin.
Sort `rebook.csv` by original segment ID; emit its header even with no rows.

All CSV files use UTF-8, normal CSV quoting, and LF endings. The held-out edge has a hotel checkout at exactly a local train departure. The half-open intervals must not overlap.

## Execution environment and grading lifecycle

Python 3.12 and Bash are available. Extra shell utilities are not guaranteed.
Do not rely on background processes or `/tmp` files surviving between tool
calls. Use workspace files for scratch data needed by later calls.

Grading copies only `solution/` into fresh main and edge workspaces, generates
the original itinerary and all later update inputs, and runs the final command
once. Existing output files are not copied. Reconstruct the final itinerary
from those inputs, without relying on a previously generated timeline.
