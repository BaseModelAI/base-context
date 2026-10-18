---
name: continuation
description: Hold automatic continuation for an explicit external blocker when no independent work remains, or inspect that hold from the Python REPL.
---

# Continuation

Use an explicit external blocker hold only when required input or another
external dependency is unavailable and no independent work remains. The host
does not infer blockers from messages or tool results.

```python
await continuation.block(reason="required input unavailable")
await continuation.status()
```

## API

- `await continuation.block(reason=...)` records an external blocker hold with
  a nonempty reason and returns the current continuation status.
- `await continuation.status()` returns `{"status": "ready"}` or
  `{"status": "blocked_external", "hold": {"kind": "external_blocker", "reason": "..."}}`.

After setting the hold, report the blocker and end the turn. The hold stops
automatic continuation, not user input. Ordinary input does not resume it.
The user can resume with `/continuation resume`. Resume is controlled by the
user or host; this skill has no model resume or gate replacement API.
