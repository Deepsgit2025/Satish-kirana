# Decision Log

Why things are the way they are. `schema.md` says *what*, this says *why* — so a decision isn't relitigated six months from now.

Append new entries at the bottom. Never rewrite history; if a decision is reversed, add a new entry that supersedes it.

---

## D1 — Unified `transactions` table, not one per document type
Sale, purchase, credit note, debit note, payment in/out, expense all share the same shape: party, lines, discount, tax, round-off, payment. One table means one numbering engine, one party ledger, one tax engine, one sync path. Day Book and Party Statement become single queries instead of eight-way UNIONs.

Cost: nullable POS columns on purchase rows. At ~1,000 sales and ~20 purchases a day that's free in Postgres. Revisit only if a second store needs different document types.

## D2 — `parties` merges customers and suppliers
Party statement, balances, payments and credit notes all key off one ledger. Two tables means two payment flows and two balance calculations that eventually disagree.

Walk-in cash customers do **not** create party rows — 1,000 bills/day would create 300,000 junk rows a year. `transactions.party_id` stays nullable; a party is created only when a phone number is entered for loyalty or credit.

## D3 — `units` master with conversions, not a UOM enum
`1 BAG = 50 KG` is what makes the repack flow work, and lets a GRN record "2 bags" while the ledger moves 100 kg.

## D4 — Tax computed on the group, not per line
Verified against a real D-Mart receipt: 106.67 + 41.90 = 148.57, × 2.5% = 3.71. Per-line-then-sum gives 3.72 and the bill stops tying out. One rounding function, one call site.

## D5 — Every line snapshots its own tax, price, name and HSN
A receipt is a tax document. Rates change (22 Sep 2025 revision), employees leave, products get renamed. A reprint must show what was true on the day. No joins to `tax_slabs` or `products` when rendering.

## D6 — Ledgers are append-only
`stock_ledger`, `party_ledger`, `account_ledger`, `employee_advances`, `loyalty_transactions`. Stock is derived; `stock_on_hand` is a rebuildable cache. This is what makes shrinkage investigation possible — a mutable quantity column makes it permanently impossible.

## D7 — Light ledger, no double-entry
**Client decision.** No Balance Sheet or Trial Balance. Delivers Day Book, Cash Flow, Party Statement, item- and bill-wise profit, and an **operating P&L** (Sales − COGS − Expenses), which needs no chart of accounts. Formal books stay with his CA, fed by Tally export. Removes ~25–30% of build cost.

## D8 — Supplier payment is both COD and credit
**Client confirmed.** `parties.payment_terms_days` NULL means COD. Payment allocation, due dates, ageing and reminders are all P1, not optional.

## D9 — Batch tracking selective, FEFO automatic
`products.track_batches` defaults false; enabled for perishables and repacked goods. When a tracked product is scanned the system silently picks the nearest-expiry batch. **Never prompt the cashier for a batch** — a dialog on every scan would stop the queue at 1,000 bills/day.

## D10 — Repack instead of a weighing scale
**Client decision.** Loose goods are packed in advance into fixed weights and labelled, so every item scans like any other at the counter. Removes scale integration, PLU sync and embedded-barcode parsing. Adds the repack module, labels and internal SKUs. Net saving.

## D11 — UPI terminal standalone first
**Client decision.** Cashier runs the card machine, keys amount and RRN last-4 into the bill. Integrated ECR needs bank paperwork outside your control — built behind a payment-provider interface so it can be swapped later without touching billing.

## D12 — Unconstrained greedy change suggestion
**Client decision.** No per-transaction drawer denomination tracking — that would need data entry on every cash bill and cashiers would skip it under rush. Denominations captured at day-open float and day-close count only.

## D13 — B2C only, no e-invoicing
**Client confirmed.** `transactions.buyer_gstin` exists but stays NULL. If populated the sale is B2B and above ₹5 crore turnover legally needs an IRN — so the system **flags it for the office rather than issuing silently**. IRP integration is phase 2 with its own price.

## D14 — 6-digit HSN throughout
Required above ₹5 crore turnover for GSTR-1 Table 12, and B2C HSN reporting is mandatory at that level. Set as the data-entry standard before catalogue import; lengthening thousands of codes later is miserable.

## D15 — Never delete a tax slab
Set `effective_to`. Deleting orphans every historical bill. Slab resolution is by document datetime. `slab_group` lets a current slab walk back to its superseded predecessor (`GST 18%` → pre-revision `GST 12%`).

Bulk slab reassignment takes an `effective_from` date and applies via a nightly job — not immediately. Offers keep-MRP (absorb) or recompute-MRP (pass on), because retail prices are GST-inclusive.

## D16 — Labels are regulated output
Repacking makes the shop a *packer*. Legal Metrology Rule 6 and FSSAI labelling both apply: packer name and address, generic name, net quantity, packing month/year, MRP, computed unit sale price, FSSAI number, batch, expiry, veg/non-veg mark, allergens, storage, consumer care.

Unit sale price: per gram under 1 kg, per kilogram at or above. Computed, never typed.

**The label engine refuses to print when a mandatory declaration is missing** — a partial label is the violation. Reprints may only *lower* MRP; stickers cannot raise it or cover the original declaration.

50×25 mm will not fit a compliant food label. Use 100×50 mm for repacked goods.

## D17 — Manual attendance in P1, biometric in phase 2
**Client decision.** Removes the largest schedule unknown from the critical path. `attendance_punches` and `attendance_days` stay separate tables so phase 2 adds a device integration and a nightly job, not a payroll rewrite.

Overtime is always entered manually, never derived from punch-out — staff linger after closing and the owner would pay for loitering. Defaults to 2× the ordinary rate per the MP Shops and Establishments Act.

## D18 — Salary posts to a locked expense category
Salary appears both as payroll output and as an expense category. If both write, every salary is counted twice and expenses inflate with no visible cause. Payroll posts automatically to a reserved category nobody can key into. Same for advances, which are already recorded in `employee_advances`.

## D19 — Advances post to `account_ledger` too
Cash handed to an employee left the drawer. If it only lands in `employee_advances`, day-close never reconciles.

## D20 — Bilingual, with raster printing only when needed
**Client decision: Hindi receipts are a must, item names specifically.**

ESC/POS has no Devanagari code page, so Hindi requires rendering the receipt to a bitmap. Raster costs ~3–4 extra seconds per bill versus text mode — an hour of queue time a day at this volume.

Mitigation: **render raster only when a line carries a Hindi name.** English-only bills stay fast.

Hindi columns are nullable with English fallback (`COALESCE(name_hi, name)`) so he fills the few hundred items that matter rather than doubling catalogue data entry.

Labels stay English — Legal Metrology permits either script.

## D21 — Cloud is a write-only vault
**Client approved AWS Mumbai (ap-south-1).** The application never reads from cloud at runtime. No latency, no dependency, billing continues through an internet outage.

**Two separate jobs.** Database: nightly full dump, tiered retention 7 daily / 12 monthly / 7 yearly. Files: sync-once, versioned, never re-uploaded. Files are ~95% of volume; splitting them is what keeps ten-year cost at roughly ₹7,600.

Account in the client's name, his card, his GSTIN — so he deducts it and claims the input credit, and so you're not holding his data hostage. Write-only IAM user, object lock on, client-side encryption with the passphrase stored off-server.

Photos never go in Postgres — path in the database, file on disk, resized to ~1 MB on capture.

## D22 — Monthly automated restore verification
A backup nobody has restored is not a backup. Monthly job downloads from cloud, decrypts, restores to scratch, and asserts bill counts, sales totals and `stock_on_hand` against `stock_ledger`. Failures surface as a red banner on the dashboard. Annual manual drill on a different machine with the person who'd actually do it.

## D23 — Put-away splits a received line across locations
100 units arrive, 40 to a rack, 60 to the godown. `grn_line_putaway` allocations must sum exactly to the line quantity, keeping the GRN line matched to the supplier invoice. Pre-filled from the product's primary rack so the common case is one keystroke.

## D24 — Count sheets freeze `system_qty` at generation
Not at data-entry time. Otherwise sales made while someone is counting appear as shortages and an employee is blamed for stock that was legitimately sold.

## D25 — Roles seeded, not left to a wizard
Cashier (`bill.create` only), Supervisor (+ `bill.void`, `stock.adjust`), Owner (all). Editable configuration, `is_system = false`. Without seeds nobody can log in until someone hand-builds a permission matrix under time pressure — and they'd grant everything to everyone.

`report.view_profit` added in `002_report_view_profit.sql`, granted to Owner only: profit visibility must be a role permission, not only the global `show_profit_while_billing` toggle. It took migration number 002, so the catalog migration planned for that number is now `003_catalog.sql` and stock is `004_stock.sql`.

---

## D26 — Remote support is designed in from R0, not added later
Auto-update, structured logging, a diagnostics bundle and a visible version stamp are built before the shop goes live. Every one of them is painful to retrofit into software already running on a counter, and the moment you need them is the moment you cannot ship a build that adds them.

**Remote access is Tailscale**, on the server and both counters. Free tier, works behind NAT, no port forwarding — a private network rather than an inbound hole in the shop's router. AnyDesk and TeamViewer are not options: their free tiers are licensed for personal use only, and this is a client site.

**The WhatsApp panel degrades, never blocks.** The embedded WhatsApp Web view is feature-flagged. It *will* fail to load — WhatsApp changes their web app on their own schedule, so treat this as certain rather than possible. When it does, the send button falls back to opening `https://wa.me/91XXXXXXXXXX?text=<encoded>` in the default browser. The user loses the PDF attachment and keeps the message.

**No workflow may depend on WhatsApp succeeding.** A salary slip or an invoice generates as a PDF regardless of whether any messaging transport is reachable — sending is a separate, optional step. Send failures are logged, so we find out from a diagnostics bundle rather than from a phone call.

---

## D27 — Tax history belongs to the product, not the slab
**Supersedes the `slab_group` sentence in D15.** Everything else in D15 stands.

D15 said a `slab_group` column would let a current slab walk back to its superseded predecessor — `GST 18%` → the pre-revision `GST 12%`. That mapping does not exist, so the column could only ever have held a guess.

The GST 2.0 rationalisation of 22 Sep 2025 moved **products between slabs**, not slabs into slabs. The 12% band was dismantled item by item: some goods dropped to 5%, others rose to 18%. Two products both sitting on 18% today may have come from 12%, from 28%, or from 18% all along. One predecessor pointer on the slab row would have to be wrong for at least one of them, and no value makes it right for all — the relation is many-to-many and it lives on the product.

So the history is recorded where the change actually happened. **`product_tax_assignments`** (`product_id`, `tax_slab_id`, `effective_from`, `effective_to`, `changed_by`, `reason`) records which slab a product sat on and when, exactly as `product_prices` records what it cost and when. One open row per product, enforced by a partial unique index. Resolution is product + datetime → the assignment in force → its slab → its rates.

Three things follow:

- **`products.tax_slab_id` becomes a cache**, like `employees.advance_balance`. The assignment table is the truth; anything asking a dated question resolves through it rather than reading the column. Never join to either when rendering a document — bill lines still snapshot their own rates (D5).
- **A future-dated assignment *is* the pending change.** Build-order step 5 wants bulk reassignment to take an `effective_from` and apply on that date via a nightly job. An assignment row starting next month already expresses that, so there is no pending-changes table to build; the nightly job only advances the `products.tax_slab_id` cache to whatever is by then in force.
- **The test that matters is the forward one.** The shop opens in 2026 and will never hold a bill dated before September 2025, so proving a pre-revision reprint is proving something nobody will ever run. Proving that a rate change dated next month does not leak into today's bills is a bug the shop can actually hit.

---

## D28 — The tax slab cache is enforced, not asserted

`003_catalog.sql` marked `products.tax_slab_id` CACHE ONLY in a column comment. A comment is not enforcement, and two sources of truth with nothing reconciling them is how a product ends up billing at 5% while every report says 18%.

Neither available mechanism is sufficient alone, so there are both.

**A trigger cannot do it by itself.** The case that matters most is a reassignment dated in the future, and at the moment it comes due *nothing writes*. The clock passes midnight; no INSERT, UPDATE or DELETE fires anywhere. There is nothing for a trigger to hook.

**The nightly job cannot do it by itself either.** A reassignment entered to take effect immediately would sit wrong until the small hours. At 1,000 bills a day that is a full day of bills at the wrong rate.

So a trigger on `product_tax_assignments` syncs the cache whenever the assignment in force *right now* changes, and `refresh_product_tax_slab_cache()` advances every product whose in-force assignment has moved on — the future-dated rows coming due. Both read `product_tax_assignment_at(product_id, at)`, which is the single definition of "in force" in the system. The TypeScript resolver calls it too, so the half-open period rule is written once and cannot drift between the trigger, the job and the till.

Disagreement is made visible rather than assumed away. `product_tax_cache_drift` lists every product where the cache and the in-force assignment differ. That view is what the nightly job corrects and what a test asserts is empty — the same shape as the `stock_on_hand` rebuild check (CLAUDE.md invariant 22), for the same reason: a cache nobody reconciles is a cache that is quietly wrong, and nobody finds out from the software.

This took migration number 004, so stock becomes `005_stock.sql`. Three comments inside `003_catalog.sql` point at `004_stock.sql` and cannot be corrected — that file is applied, therefore frozen. `004` restates the affected column comment in the database, where support actually reads it.

---

## D29 — The seeded slab dates are right about rates and wrong about history

`001_foundation.sql` seeds 0%, 5%, 18% and 40% with `effective_from = 2025-09-22`, and closes 12% and 28% the day before. The rates are correct. The dating is not, for three of them.

Only 12% and 28% were abolished in the GST 2.0 rationalisation. 0%, 5% and 18% existed at those same rates before it and simply carried on, so their true `effective_from` is 2017-07-01 — the same date the two superseded rows already carry. As seeded, resolving any of those three against a date before 22 Sep 2025 returns nothing, when it should return the identical rate.

**Left as it is, deliberately.** The shop opens in 2026 and cannot hold a document dated before the revision, so nothing resolves into the gap; and `001_foundation.sql` is applied, therefore frozen. Correcting it for its own sake would mean a migration that changes nothing observable.

**Correct it in passing.** The next migration that touches `tax_slabs` for a real reason should move those three rows back to 2017-07-01 and say why. Until then this entry is the record that the gap is known, so nobody rediscovers it as a bug.

---

## D30 — Reconciliation jobs report to one health surface

Every derived value in this system has a job that checks it against the truth it was derived from: `product_tax_cache_drift` against `product_tax_assignments` (D28), the `stock_on_hand` rebuild against `stock_ledger` (CLAUDE.md invariant 22, build-order step 4), and the monthly restore verification against the backups (D22).

**They all report to one place** — a health panel on the office dashboard, showing per check: when it last ran, and how much outstanding drift it found. Not a log line, not an email, not a red banner that only appears on the day something breaks. A check that has not run for nine days has to look as wrong as a check that found drift, and only a surface showing last-run time makes that visible.

Three jobs each reporting somewhere different is three jobs nobody reads, and the shop finds out from a customer instead. One surface also fixes the ordering problem: after a refresh, anything still listed is by definition the part no job can fix, which is exactly what wants a human.

`product_tax_cache_drift` is the first entry on it. The `stock_on_hand` check is the second, and it lands with step 4 — so the panel gets built once there are two things to put on it, rather than as scaffolding for one.

---

## D31 — Build-order step numbers are a reading sequence, not an identifier

Steps get inserted, split and moved — remote support moved from the end of R1 to step 8 the moment its position stopped matching its claim to be R0 work, and everything after it shifted by one. That is the file working as intended. It is a plan, and plans are reordered.

What it means is that a step number is only true on the day it is written. A migration that quotes one is frozen and cannot follow, so it leaves a pointer that is quietly wrong: `003_catalog.sql` still says the locations foreign key arrives in "build-order step 8", which is now step 9.

**Stable references are migration filenames, decision IDs, and the names of things in the database.** `005_stock_ledger.sql`, D27, `product_tax_assignments` — none of them move. Decision IDs are stable precisely because this file is append-only: an entry is superseded by a later one, never renumbered or rewritten. CLAUDE.md's invariant numbers are cited the same way throughout the SQL and deserve the same discipline, so invariants are appended too, never inserted.

**Nothing in code or in a SQL comment references a step number.** Cite the migration, the decision or the table. If a comment genuinely needs to point at planned work, name the file that work will land in.

---

## D32 — Stock drift is reported, never corrected on a schedule

Two reconciliation checks now run nightly and they behave differently on purpose.

`product_tax_cache` **corrects**. Drift there is the ordinary overnight case: a rate change dated for the first of the month comes due, nothing writes at that instant, and no trigger can fire. Advancing the cache is the job. What remains afterwards is the part it could not fix — a product with no tax assignment at all — and that is what the panel reports.

`stock_on_hand` **only reports**. Drift there is never expected. Every movement writes the ledger and the trigger updates the cache in the same statement, so the two can only diverge if something is broken: the trigger, a hand-edit, a restore that went wrong. `rebuild_stock_on_hand()` would put the figure right in a second — and that is exactly why it must not run on a schedule.

**A nightly rebuild would repair the symptom and destroy the evidence.** The morning after, the figures agree, the panel is green, and the fault that caused the divergence is gone with no trace of what it was or how many days it had been happening. Stock drift is already the one failure in this system that cannot be reconstructed after the fact — the movements that caused it are months of ordinary trading ago. Silently healing it every night converts a visible bug into a permanent unexplained shortage, which is the exact thing the append-only ledger exists to prevent (D6).

So the rebuild is a decision a person makes, after looking. The check's job is to make sure a person looks.

The same reasoning applies to any future check: **correct on a schedule only where drift is an expected consequence of time passing.** Anywhere drift means something is wrong, correcting it automatically is destroying the report.

---

## D33 — A mutation must be larger than the column's storage precision

Mutation testing here means breaking the code on purpose and confirming a test notices. The result is only meaningful if the break actually reached the data.

While proving the stock rebuild test, the cache trigger was mutated to `qty + EXCLUDED.qty * 1.0001` and one of the two tests carried on passing. That test posts movements of 2.25 and -1.5, and `qty` is NUMERIC(12,3): 2.25 x 1.0001 is 2.2502250, which stores as **2.250**. The mutation was rounded away before it was written. The test did not miss a defect — at that scale, there was no defect to miss.

**So a surviving test after a sub-precision mutation says nothing either way, and must not be read as weak coverage.** It is a badly built experiment, not a finding. Recorded because the opposite reading is the tempting one: a test that survives a mutation looks like a test that is not checking anything, and someone would go and "fix" a test that was fine.

**Size the mutation against the column.** For NUMERIC(12,3) that means changing a figure by at least 0.001 at the magnitudes the test actually uses — flip a sign, drop a term, swap an aggregate. The second mutation in that session, `GREATEST` to `LEAST` on `last_ledger_id`, was the useful one: it left every quantity identical and the row-for-row comparison failed on 30 rows, which is what proved that comparison is load-bearing rather than decorative.

The same trap waits on money at NUMERIC(12,2) and on rates at NUMERIC(5,2), where a mutation under half a paisa disappears the same way.

---

## D34 — i18n before the first screen, and the import core before both

Two reorderings of the build, for two different reasons.

**i18n moves ahead of the product master screen.** Invariant 19 says every user-facing string comes from `en.json` / `hi.json`, and step 6 ends with a lint rule that fails the build on a hardcoded one. Building the first screen before that rule exists means writing several hundred strings the wrong way and then retrofitting them — which is not a mechanical job, because retrofitting is where you discover that a string was assembled from fragments, or interpolated mid-sentence in a way Hindi word order will not take. The rule has to be in place before there is anything for it to catch, or its first run is a wall of failures nobody has time to read properly.

**The product master splits in two: the import core, then the screen.** They are not one piece of work. The core is pure validation logic over a file — parse, check, report, load — and needs no application. The screen needs an Electron app that does not exist yet, i18n, and a component library. Bundling them means the validation rules cannot be finished until the app is standing up.

**The core ships first because the client is entering the catalogue right now.** Several thousand SKUs are being keyed into a spreadsheet while this is being built. Every day that passes without a validator is another day of rows accumulating a wrong HSN length, a duplicate barcode or a unit that does not exist — and those errors are cheapest to fix while he still remembers the row and most expensive to fix in bulk afterwards. `npm run catalogue:import -- file.csv --dry-run` gives him that feedback with no UI at all, and it is the same code path the screen will call later.

Splitting also means the import is testable as a pure function of a file plus the database, rather than through a screen. That is the difference between a validator with a hundred cases and a validator with the three someone clicked through.

---

## D35 — `sale_price` above `mrp` is a validation failure, not a pricing choice

The catalogue import rejects any row whose sale price exceeds its MRP. This is **not** a policy the shop can decide to relax.

MRP is the *maximum* retail price, printed on the packet under the Legal Metrology (Packaged Commodities) Rules. Selling above it is an offence — not a sharp practice, not a margin decision, an offence with a penalty attached. A system that accepted the row would be a system that helped commit it at 1,000 bills a day, silently, for as long as the row sat in the catalogue.

So it belongs with "HSN must be six digits" rather than with "we do not usually discount below cost". A row that fails it is broken data and is reported like any other broken row, with its line number and reason. **No setting turns it off**, and nothing downstream should be built to override it.

The same rule already governs labels from the other direction: D16 allows a reprinted sticker to *lower* an MRP and never to raise one, and forbids covering the original declaration. Both are the same principle — the printed maximum is a ceiling the software may approach and never cross.

Where a supplier genuinely raises the MRP on a new lot, the fix is to correct the MRP, not to let the sale price float above the old one. `product_batches.mrp` exists because MRP moves between deliveries.

---

## D36 — The CSV parser is ours, and stays that way

The catalogue import reads CSV with about eighty lines of hand-written parser rather than a library. Deliberate, and worth restating because "why not just use csv-parse" is the obvious question and the obvious answer is wrong here.

**The grammar is four rules.** Fields split on commas; a field may be quoted; a quote inside a quoted field is doubled; a quoted field may span lines. That is the whole of RFC 4180 that matters. Everything else the parser does — stripping Excel's byte order mark, tolerating CRLF, skipping blank rows, tracking the physical line each record began on — is either a line of code or the reason the file exists.

**It is tested rather than trusted.** Fifteen cases covering exactly what Excel on Windows produces, including the one that actually matters: a quoted newline advancing the line counter, so an error on the following row reports the line the client sees in the spreadsheet gutter and not one earlier.

**The dependency rule is worth more than the convenience.** This runs unattended in a shop for years, on machines nobody will be maintaining attentively. Every package added is a package that can need a security update on a Tuesday, and the cost of that is paid at a counter in another city. A parser that has not changed since it was written and is covered by its own tests has a maintenance cost of zero.

The trade is real and small: a library would handle delimiters other than the comma, and encodings other than UTF-8. Neither is in scope — the client's file is comma-separated UTF-8 from Excel, and if that ever stops being true it is a change of requirement, not a bug to patch around.

---

## Open items

| Item | Owner | Blocks |
|---|---|---|
| Product CSV — several thousand SKUs, 6-digit HSN, optional `name_hi` | Client | R0 completion |
| Shop opening date | Client | Whether a stopgap billing package is needed |
| Legal Metrology packer registration number | Client | R7 |
| Monthly-salary policy — does an absent day reduce pay? | Client | R8 |
| Hardware purchase to spec | Client | R1 |

FSSAI licence: **held**, number to be entered in the Business Profile.
