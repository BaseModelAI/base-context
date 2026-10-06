# Large-output checkout incident and narrow rollback

Use the installed native tools and any supplied runtime. You may keep notes or scripts in notes/, delegate independent work, save command output, and repeat reads or commands. These choices earn no points by themselves. Inputs remain available after later stages, compaction, and process restart. Do not contact external services. Work only in this workspace. All numeric criteria are in the task and stage messages. The judge runs outside your workspace. It scores artifacts and behavior, not your wording or tool choice.

Find the regression in the eu-west checkout rollout. Files accumulate over six
stages. The exporter is a repeatable, read-only convenience command; the files themselves
are equally available to both products. It can produce several megabytes. You may avoid
large terminal output by searching or redirecting it. There is no score for dumping logs.

At the end, output/incident.json must contain exactly these fields: release_id, region,
route, cause_event_id, first_error_event_id, first_customer_event_id, first_customer_utc_ms,
failed_request_ids (distinct IDs sorted), rollback_timeout_ms, excluded_reused_request_count.
Use service-error events with code=UPSTREAM_TIMEOUT, linked to gateway status=504, on the
implicated release. The first event means lowest corrected UTC then event_id. No user-facing
failure is inferred from an application error alone. Later team traces resolve ambiguity.
Count only requests on the incident UTC day 2026-09-28 within [10:00,10:10) UTC. Final config
must change only regions.eu-west.checkout.timeout_ms to the previous release's value.
Preserve the shape, all unrelated settings, and non-ASCII human labels. Never disable TLS,
raise global limits, or change us-east as a workaround. Those constraints remain throughout.

Five checks: implicated cause/release/scope; corrected first failure chain; affected IDs;
approved timeout rollback; unchanged unrelated config. One edge: exclude the next-day reused
request and the unrelated regional request. All six criteria apply to the final artifacts.
