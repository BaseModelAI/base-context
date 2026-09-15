# Helpdesk Service Upgrade

Repair and extend the editable `service/helpdesk/` package using only Python 3.12 and the standard library. The runner launches this candidate service from `service/` on `127.0.0.1`, writes its URL to `inputs/helpdesk_url.txt`, and restarts it after each later stage so code changes take effect. There is no fixture service or external agent API. Preserve every supplied SQLite agent, ticket, comment, and numeric ID while migrating the version-1 database in place.

Run initial commands from `service/`:

```bash
python -m helpdesk serve --db ../workspace/helpdesk.db --port 0
python -m helpdesk create-agent ../workspace/helpdesk.db --email agent@example.test
```

`create-agent` inserts a normalized, case-folded email directly in the local database. It is idempotent and prints one JSON agent record. New agents use `1970-01-01T00:00:00Z` so the command never reads wall-clock time.

A server binds only to `127.0.0.1`. With `--port 0`, print exactly one flushed `LISTENING <port>` line when ready, then serve. Bodies and errors use UTF-8 JSON.

## Required API

* `POST /tickets` requires `subject`, `body`, `requester_email`, `priority`, and `created_at`; it creates an `open` ticket with both `created_at` and `updated_at` set to the normalized supplied `created_at`, and returns `201` with the full record. `assignee_id` may be null.
* `GET /tickets/<id>` returns the ticket with `comments` in ascending numeric comment-ID order, or `404`.
* `PATCH /tickets/<id>` may update `subject`, `body`, `status`, `priority`, or `assignee_id`. It also accepts `updated_at`: normalize a supplied value, or retain the prior value when omitted. Return `200` on success. Never use the wall clock.
* `POST /tickets/<id>/comments` requires `author_email`, `author_type` (`customer` or `agent`), `body`, and `created_at`, and returns `201`. A customer comment reopens a `resolved` or `closed` ticket. Every newly inserted comment sets the parent ticket’s `updated_at` to the comment’s normalized `created_at`, regardless of author or whether it reopens the ticket, even when that timestamp is earlier than the previous `updated_at`. This is direct assignment, not a maximum. This includes imported mail comments. Existing historical comments and skipped duplicates do not change this field.
* `GET /tickets` lists by ascending numeric ID. Optional `status` and numeric `assignee` filters use AND.

A full ticket record contains `id`, `subject`, `body`, `status`, `priority`,
`assignee_id`, `requester_email`, `created_at`, and `updated_at`. Additional derived
fields are allowed. An agent record contains `id`, `email`, and `created_at`.
A comment contains `id`, `ticket_id`, `author_email`, `author_type`, `body`, and
`created_at`. IDs are numeric integers, not booleans; integral JSON representations
such as `1` and `1.0` are equivalent. JSON member names must be unique.
`GET /tickets` may return an array or an object with a `tickets` array.
Malformed requests must receive a 4xx response with a JSON body; nonexistent ticket
resources return 404. These failures must leave the database unchanged.

Statuses are `open`, `pending_customer`, `resolved`, and `closed`. Priorities are `urgent`, `normal`, and `low`. Reject invalid JSON, enums, unknown assignees, and missing ticket IDs without partial writes. Server writes must commit so they survive runner-managed restarts.

Later stages add mbox import/deduplication, business-time SLA and reopening, deterministic search/export, and stale maintenance. Keep every prior behavior. In particular, external `Message-ID` is globally unique: if the same value occurs in two different mbox files, import it only once and report the later copy as skipped. Future inputs do not exist before their stage.

Normalize timestamps to RFC 3339 UTC with `Z`, and emails with Unicode NFKC plus case-folding. Do not use wall-clock time, optional SQLite extensions, subprocess tools, public network, or any second API.

## Execution environment and grading lifecycle

Python 3.12 and Bash are available. Extra shell utilities are not guaranteed.
Do not rely on background processes or `/tmp` files surviving between tool
calls. Use workspace files for scratch data needed by later calls.

The runner-managed service is separate from a background process started by a
tool call. Grading copies `service/` into fresh fixtures with their own supplied
version-1 database and all stage inputs. CLI commands and service restarts share
that database within a fixture. Development databases and generated outputs are
not copied. Preserve the supplied records; do not replace the database with an
empty one.
