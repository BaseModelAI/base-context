# SQL settlement close with late revisions

Use the installed native tools and any supplied runtime. You may keep notes or scripts in notes/, delegate independent work, save command output, and repeat reads or commands. These choices earn no points by themselves. Inputs remain available after later stages, compaction, and process restart. Do not contact external services. Work only in this workspace. All numeric criteria are in the task and stage messages. The judge runs outside your workspace. It scores artifacts and behavior, not your wording or tool choice.

The finance team closes a marketplace settlement over six incoming batches. Deliver
solution/reconcile.sql: one read-only SQLite SELECT (WITH is allowed), returning exactly
merchant_id,capture_cents,refund_cents,chargeback_cents,net_cents, ordered by merchant_id.
Also export that result as output/reconciliation.csv. All monetary outputs are integer cents.
The five named checks are merchant rows/order and each of the four money columns.
The edge check runs the same SELECT on a small snapshot with revised/over-refunded events.

Schema: merchants(merchant_id TEXT PRIMARY KEY); orders(order_id TEXT PRIMARY KEY,
merchant_id TEXT,currency TEXT,state TEXT); fx(currency TEXT PRIMARY KEY,rate_bps INTEGER);
events(event_id TEXT,revision INTEGER,order_id TEXT,kind TEXT,amount_cents INTEGER,status TEXT,
PRIMARY KEY(event_id,revision)). Kinds: capture,refund,chargeback. Initial data has captures.
Only orders with state='complete' participate. Pending/void captures are not settled.
Every merchant must appear once, including merchants with no participating orders.
Merchant IDs are case-sensitive ASCII identifiers, not numbers. Preserve leading zeroes.
No database writes and no changing input files. Query must not depend on files outside the
supplied database. net_cents is converted capture minus converted refund minus converted
chargeback. Use zero for a missing component, not NULL. Later messages define incoming
component policies. No floating-point arithmetic in monetary outputs.
