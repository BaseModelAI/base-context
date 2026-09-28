---
name: bounded-inspect
description: Inspect selected text windows and JSON fields from project files under shared source and serialized-output byte budgets. Emit one source-linked bundle; continue within oversized lines without repeating full reads.
---

# Bounded Inspect

Use for repeated, selective file inspection. Keep tiny one-off reads inline.
Historical conversation evidence belongs to `prime_context`, not this skill.
Filesystem paths and byte cursors are **not native recovery refs**.

```python
bounded_inspect.emit(
    bounded_inspect.text("runs/example/train.log", tail_lines=25),
    bounded_inspect.json_fields("runs/example/metrics.json",
        pointers=["/run", "/config", "/seed", "/eligible", "/failures",
                  "/units", "/updates", "/skips", "/wall"]),
    max_bytes=4096, max_source_bytes=65536,
)
```

Selectors are lazy; only `emit` reads. It prints one JSON object and returns
`None`, so a final cell expression does not duplicate the result. Stateless
extraction works in ordinary, goal, and AUTONOMOUS sessions. It does not park,
finish, or change autonomous limits. Consume the supplied evidence; do not
rerun its generating command merely to get a smaller answer.

## API and coverage

- `text(path)` selects the first 25 lines. Choose one of `head_lines=N`,
  `tail_lines=N`, `start_line=N, end_line=M`, or `cursor=item["next"]`.
  Line ranges are 1-based and inclusive; omitted `end_line` means through EOF.
- `json_fields(path, pointers=[...], max_source_bytes=65536)` uses exact JSON
  pointers, including `~0` and `~1` escapes. An empty pointer selects the root.
  Null stays null. Missing fields, invalid JSON, unavailable files, and oversized
  values have distinct statuses. Selected values are never string-sliced. Numeric
  tokens stay exact, including exponents and nested values; no float conversion.
- `emit(*selectors, max_bytes=4096, max_source_bytes=65536)` shares both budgets
  across all selectors, in order. `max_bytes` must be at least 128 for refusal
  metadata. Raise explicit limits when necessary, not by an unbounded retry.

`output_bytes` counts the complete UTF-8 JSON serialization, escaping, metadata,
paths, warnings, and final newline. `source_bytes` counts bytes actually read,
not file size or OS device traffic. The enclosing tool/protocol envelope is
outside this budget; normal `ipython` retention still applies. `omitted` identifies
unreturned selector indices in the original call; `omitted_fields` counts the
unreturned suffix of requested pointers. Order important metadata first.

Text includes a stat version, half-open byte range, starting line (or null),
and next byte cursor. Partial Unicode lines advance at UTF-8 boundaries.
A continuation advances, finishes, or explicitly refuses. Source-limited line
seeking can return an empty window with an advancing cursor. Reuse the same
path and returned cursor; modification or replacement returns `changed_source`.
Stat tokens are practical guards, not immutable captures.

Tail reads only a bounded suffix. If it cannot establish the requested start,
`tail_prefix_unread` marks missing prefix coverage; terminal `tail_window_limit`
means that coverage is incomplete. Absolute line numbers may be unknown. JSON parsing refuses files above the explicit source ceiling before
reading. Large histories need a project-native summary producer, not larger
unbounded `json.load` calls. Select scientific units, run/config/seed identifiers,
eligibility, and failures together. Extraction does not infer quality crossings,
repair failed controls, or turn unavailable measurements into zero.

## Run where the data lives

Use `python -m bounded_inspect`, or stage `src/bounded_inspect/__init__.py` once
and execute that file with standard-library Python through existing authorized
remote execution. Pass a JSON list on stdin:

```json
[{"kind":"text","path":"train.log","tail_lines":25},
 {"kind":"json","path":"metrics.json","pointers":["/run","/units","/wall"]}]
```

CLI flags: `--max-bytes` and `--max-source-bytes`. No SSH setup is provided.
Save a small parameterized project parser after demonstrated reuse. Log full
execution evidence to explicit files when needed: this skill cannot recover
bytes that Bash or another capture already discarded.
