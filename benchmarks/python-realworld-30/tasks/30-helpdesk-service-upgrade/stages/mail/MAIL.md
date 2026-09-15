# Mail archive import

Run:

```bash
cd service
python -m helpdesk import-mail ../workspace/helpdesk.db ../inputs/archive.mbox
```

Also accept any other mbox path supplied in the same position. Parse messages with the standard-library `mailbox` and `email` modules. Decode the text/plain body and RFC headers. A final line ending added by MIME serialization may be omitted from the stored body; preserve its other text. A message whose To or Cc address is `support+<ticket-id>@example.test` becomes a comment on that ticket. Treat a sender whose normalized address exists in `agents` as an agent; all other senders are customers. A customer comment reopens a resolved or closed ticket. Every newly inserted mail comment also sets the parent ticket’s `updated_at` to the normalized message Date, even when the ticket was already open or the message Date is earlier than its previous `updated_at`. Process these assignments in archive order; do not take the maximum timestamp. Skipped duplicates do not change ticket timestamps.

An unmatched message starts a ticket with its decoded Subject and body, normal priority, open status, sender as requester, and the message Date as both timestamps. Messages with `In-Reply-To` or `References` matching an earlier imported message stay on that earlier ticket. Preserve every external `Message-ID` in the database. It is globally unique across all imports and all mbox files. Reimports are idempotent. Print `{"imported": N, "skipped": N, "created_tickets": N, "created_comments": N}` with integer values.

Process archive order deterministically. Missing or malformed required headers are skipped rather than partially imported.

The edge rule is global across invocations: importing two separate mbox paths that contain the same `Message-ID` imports the first once and counts the second as skipped.
