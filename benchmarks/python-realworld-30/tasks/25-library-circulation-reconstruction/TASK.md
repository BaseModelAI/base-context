# Library Circulation Reconstruction

Implement `solution/library_state.py` so this Python 3.12 standard-library-only command runs:

```bash
python -m solution.library_state inputs --as-of 2025-08-31T23:59:59Z --output output
```

The main `transactions.csv` contains exactly 300,000 interleaved rows. Process it with
reasonable memory use. Use only the standard library, `decimal.Decimal` for money, and
`ROUND_HALF_UP` for two-decimal output. Do not modify `inputs/`.

## Inputs

- `patrons.csv`: `patron_id,name,timezone,email`. Time zones are IANA names.
- `catalog.csv`: `item_id,title,daily_fine,lost_fee,fine_cap`.
- `transactions.csv`:
  `transaction_id,item_id,patron_id,kind,timestamp,due_date,amount`. Timestamps are ISO
  8601 instants. Due dates are patron-local `YYYY-MM-DD` dates. Kinds are `checkout`,
  `renew`, `return`, `mark-lost`, `waive-fine`, and `restore`.

Ignore transactions after `--as-of`. For each item, order its rows by timestamp instant,
then transaction ID; file order is not state order. A checkout starts or replaces the
item's active loan and carries its due date. A renewal changes the due date only when
that item is actively loaned to the row's patron. A return closes only a matching active
loan. Other invalid state transitions have no effect.

A matching `mark-lost` keeps the loan active with status `lost` and adds the catalog lost
fee once. A matching `restore` clears lost status and removes that assessed lost fee from
the patron account, without taking the balance below zero. A return stops fine accrual
but does not itself remove an assessed lost fee.

For an active loan, accrue the catalog daily fine on every patron-local calendar day
after its due date. Accrual is event-driven: before a `checkout`, `renew`, `return`,
`mark-lost`, or `restore` event, accrue the item's existing loan through the day before
that event in the borrowing patron's timezone, even if the requested state transition
is invalid. A `waive-fine` event does not trigger new accrual. At `--as-of`, accrue
each open loan through its patron-local as-of date. A renewal retains
fine already accrued, then replaces the due date for later days. Cap overdue fines for
one loan at that catalog item's `fine_cap`. A waiver applies its nonnegative `amount` to
the named patron's already-accrued balance at that point in the global
`(timestamp,transaction_id)` order and cannot reduce the balance below zero; unused
waiver amount is discarded. Do not accrue other open loans merely because a waiver
arrives. `overdue_fines` reports assessed overdue fines, `lost_fees` reports assessed
lost fees net of restores, and `waived` reports actual applied waivers; clamp the
resulting total balance at zero.

## Outputs

Replace outputs deterministically:

- `active_loans.csv`, exact header
  `item_id,patron_id,due_date,status,accrued_fine,lost_fee`. Include active loans only.
  Status is `on_loan` or `lost`. Sort by item ID. Money uses two decimals.
- `fines.csv`, exact header
  `patron_id,overdue_fines,lost_fees,waived,total_balance`. Include every patron, even a
  zero-balance patron, sorted by patron ID. The `waived` field is the amount actually
  applied. All money uses two decimals.
- One UTF-8 file `notices/<patron_id>.txt` for every patron. Use exactly:

```text
Library account notice
Patron: <patron_id>
Name: <name>
As of: <as-of argument>
Active loans: <count>
Items: <item IDs joined by comma+space, or none>
Overdue fines: <amount>
Lost fees: <amount>
Waived: <amount>
Balance: <amount>
```

End each notice with one LF. Item IDs are sorted. Remove stale notice files.

## Stated edge behavior

A return can occur before its checkout in CSV file order but after it by timestamp. The
timestamp ordering must close the loan and stop its fine correctly.

The judge copies only `solution/__init__.py` and `solution/library_state.py` into fresh fixture workspaces. Keep all candidate implementation code in those declared artifacts.

## Execution environment and grading lifecycle

Python 3.12 and Bash are available. Extra shell utilities are not guaranteed.
Do not rely on background processes or `/tmp` files surviving between tool
calls. Use workspace files for scratch data needed by later calls.

Grading stages the correction file in a fresh workspace and runs the final
command once. Development outputs are not copied. Reconstruct both the
original and corrected states from the supplied transactions to compute
`correction_effects.csv`; do not rely on a previously generated report.
The output directory can contain stale notice files. Remove them as required.
Notice text uses LF line endings and the exact template above. Standard CSV
quoting styles are equivalent; money still uses exactly two fractional digits.
