# Python Real-World 30

Thirty staged Python 3.12 tasks with external deterministic judges. The paired
MEDIUM benchmark compares CURRENT Base Context with Prime Agent 0.9.4 on Sol,
Astra and DeepSeek.

- **[Frozen results and methodology](REPORT.md)** — 180 cells, 208 effective
  attempts, all retries and failures charged.
- **[Detailed 180-row table](results/cells.md)** · [CSV](results/cells.csv) ·
  [208 attempt rows](results/attempts.csv) · [summary JSON](results/summary.json).
- **[Reproduce the method from a clean checkout](REPRODUCE.md)** — preparation
  scripts, local export, qualification and explicit provider admission.

The frozen terminal strict scores are **90/90 CURRENT vs 87/90 vanilla**.
Cumulative lifecycle attempt-hours are **7.2953 vs 9.6188**. These are summed
attempt durations, not campaign wall time. Whole-workload cost is **UNKNOWN**.
Strict grading passes and runtime-clean outcomes are separate.

This historical run uses mixed CURRENT SDK commits, not release 1.0.0. Read the
report's DeepSeek restart and task 15/27 amendment chronology before comparing it
with a fresh run. No raw model output, sessions or provider payloads are published.

## Layout

- `tasks.json`, `tasks/`: unchanged task prompts, staged fixtures and external judges.
- `paired_medium_reference.py`: six independent paired queues and one deferred retry.
- `run.py`, `benchlib.py`, `compare.py`: native RPC execution and metric rules.
- `prepare-hosts.py`: local archive-to-host mapping.
- `stock-accounting/`: offline accounting-only patch for a separate stock host copy.
- `bash-tool.mjs`: shared isolated Bash adapter.
- `api-price-profiles.json`: fixed API-equivalent price snapshot.
- `scripts/reproduce.py`: offline preparation/qualification and explicitly admitted method replication.
- `scripts/export_results.py`: allowlisted numeric/status/profile export.

The legacy `run.py --three-model-campaign` path is not the published paired MEDIUM
scheduler. Use the paired driver through the reproduction instructions. Live work
requires qualification of the chosen clean build and explicit admission. A script
flag is not a substitute for qualification.
