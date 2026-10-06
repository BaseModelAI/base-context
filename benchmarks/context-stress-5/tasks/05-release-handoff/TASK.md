# Delegation-friendly regional release handoff

Use the installed native tools and any supplied runtime. You may keep notes or scripts in notes/, delegate independent work, save command output, and repeat reads or commands. These choices earn no points by themselves. Inputs remain available after later stages, compaction, and process restart. Do not contact external services. Work only in this workspace. All numeric criteria are in the task and stage messages. The judge runs outside your workspace. It scores artifacts and behavior, not your wording or tool choice.

Coordinate an operations handoff for a regional release. Inputs arrive from three
teams over six stages, and each team has enough records to need filtering. The task permits
independent native workers, but does not require delegation or reward process theater.
All handoff deliverables are files; parent/child message contents are not judged.
Reference date is 2026-10-01. Use service_id plus region as the key, never owner display names.
Scope and severity must stay exact: a waiver in us-east never covers eu-west; critical findings
cannot be waived. Dependencies never cross regions. Do not modify supplied policies or data.

Final artifacts:
- output/readiness.json: array sorted by (service_id,region), each row with exactly service_id,
  region,recommended_replicas,monthly_cost_cents,direct_blockers,blocked_by,decision.
  direct_blockers is a sorted list drawn from capacity,budget,security:<finding_id>.
  blocked_by is a sorted unique list of transitive dependency service IDs with direct blockers.
  decision is ready iff both lists are empty, otherwise blocked.
- output/owner-actions.csv: header owner,service_id,region,blocker. One row per DIRECT blocker,
  sorted by (owner,service_id,region,blocker). Owners are exact strings; CSV may quote them.
- output/summary.json: object with ready_by_region and blocked_by_region count objects. Include
  every region, even when one count is zero. No all-or-nothing global release veto.

inputs/services.json starts with current replicas and owners. Later files provide capacity,
security, billing and dependencies. Missing findings/dependencies means none; numeric records
exist for each key once that stage is delivered. The dependency graph is acyclic.
Five checks: security blockers; recommended capacity and capacity blockers; costs and budget
blockers; full dependency propagation/decisions/row shape/order; owner actions and regional
counts. One edge criterion checks critical waiver refusal, expiry boundary and region-specific
waivers in the late update. Artifact-analysis scoring checks factual decisions, not prose.
