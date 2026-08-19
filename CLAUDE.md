# SS Super Bazar — Retail System

Offline-first supermarket POS. Two billing counters + one office machine + an always-on store server, all on a LAN. ~1,000 bills/day.

Full specs in `docs/`. **Read `docs/plan.md` for scope, `docs/schema.md` for tables.** This file holds the rules that must never be broken.

---

## Stack

<!-- CONFIRM THESE BEFORE FIRST COMMIT -->
- **Server:** Node.js + TypeScript, Postgres 15
- **Counter/office app:** Electron + React + TypeScript, local SQLite cache
- **Printing:** ESC/POS over TCP (raw sockets), raster rendering for Hindi
- **Migrations:** one numbered SQL file per change, never edited after commit

---

## Conventions

- **Join tables use composite primary keys, not surrogate ids.** `role_permissions` is the reference case.

---

## Non-negotiable invariants

Violating any of these is a bug, even if the code works and tests pass.

### Money and tax

1. **One rounding function, one call site.** Never inline tax maths.
   ```
   line_taxable  = round(rate × qty ÷ (1 + total_rate/100), 2)   // per line
   group_taxable = Σ line_taxable                                 // then sum
   group_cgst    = round(group_taxable × cgst_rate/100, 2)        // tax on the GROUP
   ```
   Tax is computed on the **group**, not per line. Per-line-then-sum gives the wrong answer.
   Reference: 106.67 + 41.90 = 148.57, × 2.5% = 3.71 ✓ — per line it would be 2.67 + 1.05 = 3.72 ✗
   (This line read 41.91 / 148.58 until the engine was built. That set cannot hold: 148.58 + 3.71
   + 3.71 is 156.00, not the 155.99 the receipt prints, and it leaves no 0.01 round_off. 44.00 ÷
   1.05 = 41.9047…, which is 41.90. Reproduced to the paisa in `packages/shared`.)

2. **Every bill line snapshots its own tax.** `rate`, `cgst_rate`, `hsn_code`, `description` are copied at sale time. **Never join to `tax_slabs` or `products` when rendering or reprinting a document.** Rates change; old bills must reprint with old rates.

3. **`round_off` is a stored column**, not computed at display time.

4. **Bill-level discount is apportioned pro-rata across tax groups before tax is computed.** A flat ₹50 off a bill with 5% and 18% items splits by taxable value. Getting this wrong makes GSTR-1 wrong.

### Ledgers — append-only, no exceptions

5. **`stock_ledger`, `party_ledger`, `account_ledger`, `employee_advances`, `loyalty_transactions` are INSERT-only.** No UPDATE, no DELETE, ever.

6. **Never `UPDATE products SET qty`.** Stock is derived. `stock_on_hand` is a trigger-maintained cache that must be rebuildable from `stock_ledger` at any time.

7. **Void, don't delete. Reverse, don't edit.** A voided document flips status and posts reversing ledger rows.

8. **Every movement is one transaction.** Ledger insert + cache update commit together or not at all.

### Documents

9. **`transactions.uuid` is generated on the counter**, before insert. It is the sync idempotency key. The server dedupes on it — the same bill pushed three times inserts once.

10. **Numbers are allocated locally, validated centrally.** Each counter owns its series (`transaction_series`). The server rejects duplicates; it never renumbers.

11. **`occurred_at` (business time) and `recorded_at` (server insert) are both stored.** A bill made at 18:02 during an outage and synced at 18:40 needs both, or hourly reports lie.

12. **A paid `salary_run` is immutable.** Day counts, rates and advance figures freeze on payment. Later attendance corrections adjust the *next* month.

13. **`cycle_count_lines.system_qty` freezes when the count sheet is generated**, not at data-entry time. Otherwise sales made during counting appear as shortages.

### Data rules

14. **`product_kind='bulk'` can never appear on a sale line.** Enforce with a CHECK/trigger, not UI.

15. **Advances post to `account_ledger` too.** Cash handed to an employee left the drawer. If it only lands in `employee_advances`, day-close never reconciles.

16. **Salary posts to a reserved, locked expense category** from `salary_runs` only. Nobody keys into it by hand, or every salary is counted twice.

17. **Files live on disk; only paths go in the database.** Never store images in Postgres — it would inflate every nightly dump by gigabytes.

18. **HSN codes are 6 digits.** Required above ₹5 crore turnover.

### Language

19. **All UI strings come from `en.json` / `hi.json`.** No hardcoded user-facing text, ever.

20. **Hindi fields are nullable and fall back to English when blank.** `COALESCE(name_hi, name)`.

21. **Receipts render in raster mode only when a line has a Hindi name.** English-only bills use fast text mode. Raster costs 3–4 extra seconds per bill.

### Tests

22. **Never delete or skip the stock ledger rebuild test.** It posts randomised movements, rebuilds `stock_on_hand` from `stock_ledger`, and asserts an exact match. It is the only guard against silent stock drift, which cannot be debugged retroactively.

---

## Working practices

- **Tests before implementation** for anything touching money, tax, stock or payroll. Everything else can be tested after.
- **One module per session.** Don't let a task sprawl across the codebase.
- **Migrations are append-only.** Never edit a committed migration; add a new one.
- **An applied migration is immutable, comments included.** Once a file has run against any
  database — a developer laptop counts — it is frozen. Not the SQL, not a typo in a comment, not
  a stale doc reference in the header. The runner stores a SHA-256 of every applied file and
  refuses to run when one changes, so an edit does not correct history, it stops the next
  deploy. Corrections go in the next migration, which says what it supersedes.
- **Postgres `now()` is the transaction timestamp, not the wall clock.** It is fixed at BEGIN and
  does not advance while the transaction runs. In a rolled-back test, anything meant to be
  already in force has to be dated *before* the transaction opened — a fresh `new Date()` is in
  the future as far as any trigger reading `now()` is concerned, so the row it should have
  matched does not match. Day-close, salary runs and backup verification all straddle this, and
  all three are places where being an hour out is a real figure on a real document.
- **A test must never assume a shared table is empty.** Anything a real job or CLI writes to —
  the reconciliation run log, the audit log, the sync outbox — has rows in it the moment someone
  uses the feature, and a test that asserted "nothing has run yet" then fails for a reason that
  has nothing to do with the code. Register a throwaway key inside the test's own transaction and
  assert on that. A test that passes only until someone uses the thing it tests is worse than no
  test: it looks like coverage and it breaks on the day the feature starts working.
- **No new dependency without asking.** This runs unattended in a shop for years.
- **When a spec is ambiguous, stop and ask.** Don't invent business rules — most of them have a reason documented in `docs/schema.md`.

## Definition of done

A module is done when: tests pass · it handles the offline case · it writes to the ledger, not to a cached quantity · errors are surfaced to the user in both languages · no hardcoded strings.
