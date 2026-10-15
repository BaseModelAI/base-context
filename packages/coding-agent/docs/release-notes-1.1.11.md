# Base Context 1.1.11

## Delivery and external-job workflows

- Pass an existing `task_contract.delivery` directly to
  `rlm.workflow.stage_delivery(delivery, destination)`. The explicit destination
  is still required. Dependencies stay caller-declared; staging does not infer
  imports or activate the consumer.
- Delivery-specific delegation guidance now preserves supplied consumer paths,
  exclusions, and execution mode. Unknown transfer constraints remain unknown.
- Set `job_watch.watch(wait_budget=seconds)` for a relative owner-review deadline,
  or use an absolute `deadline`. Detached probe watches default to a 15-minute
  owner wake-up when neither is supplied. This does not cancel or retry the job;
  the owner reviews partial results and decides whether to continue waiting.
- Consumed terminal events print compact ID/state receipts even when the result
  is assigned. Full returned evidence is unchanged. Failed parking due to
  available evidence prints a clear action hint rather than implying a hold.
- Main prompts and task workflow documentation explain result inspection,
  deadline review, and queued/in-flight evidence after a false park result.

## Compatibility and limits

The relative wait budget maps to the existing deadline field. Daemon commands,
events, response shapes, capabilities, and protocol versions are unchanged.
The new default bounds unattended waiting until owner review, not remote job
runtime. Explicit deadlines keep their existing meaning.

Terminal receipts are not task-success claims and do not replace inspection of
full results. Delivery contracts do not broaden transfer rules or authorize a
launch, retry, deployment, integration, or activation.

These changes address observed workflow failures. No new benchmark was run and
no success-rate increase is claimed. Local Harbor adapter improvements are
maintained in the ignored benchmark harness, not included in the npm packages.

## Release preparation

This version is prepared locally. Publication, tagging, pushing, and merging
require separate approval. Focused offline tests, repository checks, and local
package installation checks cover the changed paths; the full offline suite is
not claimed. Existing dependency audit advisories are not addressed by this
feature release.
