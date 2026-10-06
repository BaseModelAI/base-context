# Privacy retention migration through compact and resume

Use the installed native tools and any supplied runtime. You may keep notes or scripts in notes/, delegate independent work, save command output, and repeat reads or commands. These choices earn no points by themselves. Inputs remain available after later stages, compaction, and process restart. Do not contact external services. Work only in this workspace. All numeric criteria are in the task and stage messages. The judge runs outside your workspace. It scores artifacts and behavior, not your wording or tool choice.

The customer operations team needs an idempotent SQLite migration during a staged
privacy rollout. SQL is the deliverable language because it will run in an existing SQLite
maintenance job. Author solution/migrate.sql. The judge copies inputs/customers.sqlite and
executes your script twice on that copy; do not include a hard-coded database filename.

Input schema: customers(customer_key TEXT PRIMARY KEY,name TEXT,email TEXT,last_contact_day TEXT);
holds(customer_key TEXT,expires_day TEXT); tickets(ticket_id TEXT PRIMARY KEY,customer_key TEXT,
state TEXT,subject TEXT); opt_outs(customer_key TEXT PRIMARY KEY). All dates are ISO calendar
UTC dates. Empty tables are normal. Reference date is 2026-10-01 throughout. Every original
customer remains; never renumber, normalize, or replace a customer_key. Never delete source
rows. Human display names must remain unchanged. No opt-out means no opt_outs row.

Create/refresh retention_decisions(customer_key TEXT PRIMARY KEY,action TEXT,reason TEXT,
open_ticket_count INTEGER), with exactly one row per customer. Initial default: keep/active.
Stale unprotected customers: redact/stale. Redaction means customers.email becomes SQL NULL,
not an empty string or fake address. Never redact a non-target email. Later messages add
protection and precedence rules. Re-execution must leave the same data and work without errors.

Create customer_export view with exactly customer_key,state,open_ticket_count columns, where
state equals retention_decisions.action. No name/email in this view, even for kept customers.
Preserve empty/NULL original emails for customers who should be kept. Sort only at query time.
Five checks: original keys/names/rows; exact email changes; exact decision precedence; open
counts and untouched tickets/holds/opt_outs; export view schema and rows. One edge check:
small main-equivalent fixture at the 90-day and active-hold boundary, including an opt-out hold.
All checks run after BOTH script executions and check data stability between those executions.
