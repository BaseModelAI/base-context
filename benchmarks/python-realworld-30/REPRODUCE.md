# Reproduce the charts; run a new experiment

## Regenerate the published charts offline

From the repository root, with Python 3:

```sh
python3 benchmarks/python-realworld-30/scripts/render_readme_graphics.py
```

This reads only `results/summary.json` and `results/task-profile-pairs.csv`.
It writes the three SVGs in `packages/coding-agent/docs/images/benchmarks/`.
It needs no extra packages, credentials, model calls or private report files.

The published numbers are the selected **GPT-6.1 Sol high** and
**GPT-6 Astra medium** results described in the [benchmark README](README.md).
The CSV retains the numeric precision of the saved measurements. Displayed
values are rounded. Compute a reduction as `100 * (1 - Base / Codex)` from the
aggregate cost totals or runtime means, not from a mean of per-pair ratios.

## Run a separately labeled native experiment

The [native harness guide](native/README.md) describes one attempt with an
installed Base Context or Codex product. Keep the task definitions, fixtures and
judges unchanged. Use your own authorized provider access and keep raw outputs
and credentials outside the checkout. Running an attempt can spend money.

The published build was Base Context **1.1.1**, clean source
`22f815fbf324ca4df1a886c8e71c819d765caba1`, against official Codex **0.160.0**.
The exact two profiles are:

| Model | Effort |
| --- | --- |
| `gpt-6.1-sol` | `high` |
| `gpt-6-astra` | `medium` |

Recorded context was 272,000 tokens, 95% usable and a 90% compaction trigger.
Task deadlines were twice the original `scenario.json` limits. The first two
eligible attempts per agent/task/profile were ranked by the selection rule in
the README. External provider/transport errors were replaced; clean quality
failures and timeouts were not discarded.

**This checkout does not provide exact controller reproduction.** The retained
single-attempt runner does not implement the campaign scheduler, strict saved-run
screening, best-of-two selection, or all private controller timing changes. It
does not explicitly apply the published context-capacity overrides. Review and
set native product controls for a new experiment; do not assume matching defaults.
Changing a build, controller, profile, provider behavior or concurrency changes
the experiment. Hosted model outputs and historical timings cannot be replayed
from the public numeric export.

Publish only a curated numeric export with the new experiment's settings.
Native logs, session files and collector outputs may contain private data and
are not suitable for direct publication.
