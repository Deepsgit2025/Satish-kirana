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

## D37 — Open Food Facts is a lookup that pre-fills a form, never an import

A local reference table is seeded from the Open Food Facts India export — barcode, product name, brand, category, and nothing else. When an unknown barcode is scanned during catalogue entry or receiving, the shop is offered a pre-filled name and brand to **accept or override**. That is the whole of it.

**It is not an import and must never be built as one.** Coverage of Indian products is patchy and the data is crowd-sourced, so a name arrives spelled how one contributor felt like spelling it — abbreviated, in the wrong case, with the pack size glued on or missing entirely. Every suggested name is reviewed by the person at the keyboard before it becomes a catalogue row. A bulk load would put thousands of unreviewed names into the master and the review would then never happen, because there would be nothing to prompt it.

**The shop's own numbers never come from it.** MRP, sale price, HSN and tax rate are the shop's, always, without exception. Open Food Facts has no authority over any of them and several are legally the shop's responsibility (D14, D35). The lookup fills in the two fields that are tedious to type and factually stable — what the product is called and who makes it — and stops.

**Worth doing before the client's bulk catalogue entry.** Several thousand SKUs are being keyed in by hand right now (D34). Name and brand are the bulk of the typing on every row, and a scan that fills both removes a large share of the work at exactly the moment the work is happening. After the catalogue is entered, the same lookup keeps earning its place on every new product that arrives.

**The internal barcode decision stands: Code 128 with a configurable prefix, not EAN-13.** Restated here because a catalogue seeded with real EAN-13 barcodes invites the question of whether internal codes should match the format around them. They should not:

- **No check digit maths.** EAN-13's thirteenth digit is computed, and every place that generates, validates or hand-enters a code has to get it right. Code 128 has none of that.
- **Variable length.** Internal codes can carry a prefix and a running number without being padded into a fixed thirteen digits.
- **It avoids the 20–29 in-store range.** EAN-13 reserves that prefix band for in-store use, which is also where **scale-printed embedded-weight barcodes** live — the ones where digits inside the code carry a weight or a price. Minting internal codes there means the day a weighing scale or a supplier's pre-packed label enters the shop, a code that reads as a product on one machine reads as a weight on another. Staying off EAN-13 entirely makes the collision impossible rather than unlikely.

`product_barcodes.barcode_type` already distinguishes `ean13`, `code128_internal` and `manual`, so a scanned Open Food Facts match and a printed internal label are never confused for one another.

---

## D38 — Scan-to-create for unknown barcodes, with the form set by role

An unknown barcode at a scanner is an opportunity, not a dead end. Today the scan fails and the person is left to go and add the product somewhere else — which in practice means a sale rung up under a wrong item, or a delivery received short. So an unknown barcode offers to create the product. **What the form asks for depends on who is scanning and where.**

**GRN entry (R1, office): the full create form.** Name, unit, HSN, tax rate, MRP, sale price, cost — all of it, because the supplier invoice is in the operator's hand at that moment and every one of those figures is on it or derivable from it. This is the natural way the catalogue grows once the initial import (D34) is behind us: goods arrive, the product is created properly at the point where the paperwork exists.

**Billing counter (R2): barcode, name and quantity. No price field.** Cashiers hold `bill.create` and explicitly not `price.edit` (D25), and the till form must reflect that exactly. The product enters a **pending** queue and cannot be billed until someone holding `price.edit` prices it — either a supervisor overriding at the till, or the office machine later.

**A price field at the counter is a leak with a UI.** A cashier who types ₹40 for a ₹60 item has not left a discount, a void or an adjustment behind — there is no record that the figure was ever wrong, because the figure they entered *is* the product's price from that moment on. Nothing downstream can detect it: the bill balances, the stock moves, the margin report shows a thin margin on a product that has always had one. Every other way of getting money out of this system leaves a trace that a report can find. This one would not, which is why the field does not exist rather than being restricted, warned about or logged.

**Pending products need a distinct status of their own.** `products.status` is `active | discontinued` today; unpriced products are neither. They must:

- appear in a **review list** so pricing them is a visible outstanding job, not something discovered when a cashier next scans the item;
- be **excluded from stock valuation** — a product with no price would otherwise value at zero and quietly understate the stock figure;
- be **excluded from reorder reports**, which would otherwise propose reordering something nobody has decided to sell yet.

Marking them inactive would hide them; leaving them active would let them be billed at a price nobody set. Hence a third state.

**D37 and D38 are two halves of the same moment.** The barcode is scanned and does not match: the lookup pre-fills what it knows about the packet, scan-to-create handles everything the lookup cannot know — which is every field that is the shop's own.

---

## D39 — A terminal is a user interface, and the line is who reads it

Invariant 19 says every user-facing string comes from `en.json` / `hi.json`. Step 6 had to settle what counts, because at that point the only text in the system was three command-line tools and it would have been easy to call all of it developer output and exempt the lot.

**`catalogue:import` is not developer output.** The client runs it against his own spreadsheet while he is keying several thousand SKUs, months before there is a screen — that is the entire reason the import core shipped before the product master (D34). Its error report is the first thing this system ever says to the person who bought it. It is translated, and so is everything the other two commands print, because carving out an exception for `db:migrate` would mean a lint exception that every future command inherits by default.

**The test is who reads it, not where it appears.** A cashier or the owner reads "this barcode is already on a product": translated. Whoever is installing the system reads "migration 004 has changed since it was applied": not translated. `MigrationPlanError` names filenames and checksums, is read in the same session as a stack trace, and a Hindi translation of it has no reader. Those messages reach the CLI as detail and are passed through as detail, inside a sentence that *is* translated.

**Four things stay English on purpose**, and the reason differs each time:

- **Command-line flags.** `--dry-run` is typed back character for character. A Hindi build that renamed it would print instructions that do not work.
- **Column names in the import report.** They are the headings in the client's own spreadsheet; a translated `hsn_code` points at a column that is not there.
- **Keys of things in the database** — `stock_on_hand`, `default_language`. A support call goes better when both ends say the same string.
- **Statutory acronyms** — GST, CGST, HSN, MRP.

The consequence for later steps: a new background job, sync error or report inherits this test rather than deciding again. If the shop sees it, it has a key.

---

## D40 — Decision numbers are allocated from the file, not from memory

**Ask for the entry by what it decides. Whoever writes it reads the file and takes the next free number.** Never specify the number in the request.

D35 and D36 were written twice because the request named a number that had already been used. The mechanism is ordinary and will recur: this file grows in sessions that do not see each other, so the highest number in it moves independently of anyone's recollection of where it had got to. Remembering "we were around D34" is accurate right up until a session lands two entries and it is not, and there is no moment where that becomes visible from the outside.

Allocating from the file closes it because the file is the only thing that knows. Read the headings, take the highest, add one — as this entry did.

**Why it matters more here than the tidiness suggests.** D31 makes decision IDs one of the three stable references in this project, alongside migration filenames and the names of things in the database, and that standing is what lets a SQL comment or a code comment cite `D27` and stay true. A duplicate number breaks the property that makes them worth citing: a reader following a reference gets two answers and no way to tell which one was meant. And because the file is append-only, the repair is not a renumber — it is another entry saying which one won, so a collision leaves a permanent scar rather than a corrected line.

The same applies to CLAUDE.md's invariants for the same reason, and D31 already says why they are appended and never inserted.

---

## D41 — The product master is three views over one validation core

There are two ways a shop edits a catalogue and they do not resemble each other.

**One product at a time.** A price is wrong, an HSN is four digits, a short name prints badly on the receipt. Somebody finds that product and fixes that field.

**Many products at once.** A supplier revises a price list, a rate change moves a category between slabs, an aisle's reorder levels were all set too low. Somebody wants a grid, a selection, one value, and an apply.

**Both get built, because choosing between them is a bet we do not have to take.** The client is keying several thousand SKUs into a spreadsheet right now (D34), which says he thinks in grids; the two years after opening are mostly one product at a time. Pick either and the other workflow is done by hand — a price revision keyed two hundred times, or a single wrong MRP hunted through a grid built for bulk. That is not something a demo surfaces. It surfaces a year in, as a habit somebody has already built around the gap.

So step 7 ships **list**, **single product** and **bulk grid**: find, fix one, fix many. The shape is the reference app's, the same one `schema.md` reads against throughout, and `modules.md` has carried bulk edit as its own module since the first pass — "price revisions hit dozens of SKUs at once". It is also the argument that file's report appendix already makes about reports: build the frame once, and everything after it is a column definition. Built as separate screens instead, they eat the budget and drift apart.

**The condition attached to building all three is the actual decision.** A third view is worth having when it is a selection model and a column. It is not worth having when it is a third rule set — that is three implementations of "sale price may not exceed MRP" (D35), and two of them will be wrong inside a year, because a rule only ever gets fixed in the copy whose bug somebody hit. So every path validates through `validateCatalogueRows` and reports `RowIssue`, and every path writes through `assignProductSlab` and `assignProductPrice`. A row a screen assembled is checked by the code that checks a row the CSV parser assembled.

**Bulk is where the shortcut is tempting and where it is worst.** One UPDATE across two hundred products is a line of SQL and it skips the history entirely. That does not just lose the audit trail. `products.tax_slab_id` is a cache (D27, D28), so those two hundred products land in `product_tax_cache_drift` the same night, and `refresh_product_tax_slab_cache()` sets every one of them back to the slab its untouched assignment still names. The bulk change reports success at 11am and is gone by morning, with nothing on screen having lied at the time. A shortcut here is not a trade against tidiness; it is a change that does not stick.

**The audit trail is that same point from the other end.** Six months on the question is "why is this product at 18%?", and nobody asking it knows or cares whether the rate arrived in a file or a grid. If the two paths write different shapes, the answer depends on which screen someone happened to use — the one thing a history exists to make irrelevant. So a bulk change of two hundred leaves what importing two hundred leaves: one row per product per table, close-then-open, same `changed_by`, same `effective_from`. `reason` is the only field that differs, because saying why is the whole of its job.

**What this settles for later steps.** Any screen that changes many rows at once — bulk reorder levels, a supplier price list, bulk category moves — is another view over this core, not another way into the tables. And when a bulk action does not fit the validator, the validator is the thing that changes.

---

## D42 — The IPC boundary is designed before the UI, not discovered through it

Electron runs two JavaScript contexts. The main process holds the filesystem, the Postgres connection and the app's privileges; the renderer holds the DOM and nothing else. They share no memory, so **every call a screen makes into the catalogue core crosses a serialisation boundary**. There is no version of this where a component imports `applyBulkEdit` and calls it.

So the boundary is designed first, before there is a screen to shape it. The order for the product master is: define the contract, agree the dependencies, wire an empty shell to the real functions, then build the screens.

**What the alternative looks like, because it does not announce itself.** IPC is friction. Every call wants a channel, a serialisable request, a serialisable reply and a handler on the far side. Somebody with a screen to finish and a boundary nobody designed does not usually build all of that — they reach for whatever removes the friction. `nodeIntegration` switched on. A `pg` client imported in the renderer because the query was right there. A validation check re-run in the component because round-tripping it to ask felt wasteful. Each is locally reasonable, none is written down, and together they are an architecture.

**The end state is D41's failure one layer up.** D41 says three views are worth building *provided* they share one validation core, because the alternative is three copies of "sale price may not exceed MRP" (D35) and only the copy somebody hits the bug in ever gets fixed. A renderer that validates for itself to save an IPC hop is a fourth copy, sitting where it is hardest to test: behind a screen instead of in front of a `Queryable`. Step 7 spent its entire design budget making the grid and the importer inseparable. Letting them come apart at the UI boundary instead would spend it twice for nothing.

**Where the two halves live, and why that split and not another.**

- **Contract types in `packages/shared`.** It is already the one package both Electron apps and the server import, which makes it the only place a request shape can be written once and be the same shape on both ends of the wire. A channel whose request type is declared on each side separately is a channel that drifts, and it drifts silently — both sides compile.
- **Implementations in `server/`, behind `Queryable`.** They take a database session and return plain data, which is what they already do. `searchProducts` and `applyBulkEdit` need no change at all to serve IPC; they need a handler in front of them. Nothing moves to accommodate the boundary, which is the sign the boundary is in the right place.
- **`packages/shared` must never carry a `pg` dependency.** It has no runtime dependencies today and is bundled into the counter app — a till with a SQLite cache and no Postgres client — and into the renderer. The reason is not bundle size. A `pg` import in shared would put a database driver inside a browser context, which is the exact shortcut this entry exists to close off; the dependency graph is what makes taking it impossible rather than merely discouraged.

**What makes this real rather than aspirational** is that the shell gets wired to the contract while the screens are still empty — real functions, placeholder output. A boundary that carries a list query and a bulk apply before anyone has styled anything is a boundary that was designed. One discovered while a screen is half built is a boundary shaped by whatever was expedient that afternoon, and it will still be there in five years.

---

## D43 — Electron support expires on a schedule, so upgrading it is a standing obligation

**Electron 43.4.1 was installed on 20 August 2026. It leaves Electron's supported window around February 2027.**

Electron ships a major roughly every eight weeks and backports security fixes to the **latest three majors only**. Forty-four stable majors have been published; when 43 went in, the supported set was 41, 42 and 43. Three majors at eight weeks is about six months, so the version this shop runs today stops receiving security fixes around February 2027, whatever anybody does. That is not a defect and it is not avoidable by choosing a different version — a newer one buys weeks, not years.

**Which makes this the one dependency whose upgrade cannot wait for a reason to upgrade.** Everything else in this project is replaced when something needs fixing. Electron is replaced because the calendar says so, and the calendar is the only thing that will say so — an unsupported Electron looks and behaves exactly like a supported one. It runs a full Chromium, which is the largest attack surface in the building and the one most likely to have a published exploit against a version six months old.

**The obligation, stated so it can be met:**

- **Check the supported window every three months**, or whenever `electron` is touched for any other reason. `npm view electron versions` tells you the current major; three below it is the edge.
- **Upgrade before the installed major falls out of the set**, not after. An upgrade done early is a routine version bump; done late it is a version bump plus an incident.
- **Record the new date here**, as an entry that supersedes this one. This entry is dated deliberately: an undated "keep Electron up to date" is a note nobody can tell is overdue, which is the same failure D30 built the reconciliation health panel to prevent — a check that has not run must look as wrong as a check that failed.

**This is what makes step 9 load-bearing rather than convenient.** Auto-update is described there as one of four things that make supporting this system from another city possible, and it is the only mechanism by which a security upgrade reaches the shop at all. Without it an Electron upgrade is a physical visit to the shop with a build on a USB stick — for two counters and an office machine, on a schedule set by a release calendar nobody in the shop reads. That is not a support model that survives a year.

Step 9 already argues that the *first* build installed has to know how to update itself, because otherwise there is no remote path to the second. This entry is why that has a deadline attached: the second build is not hypothetical and it is not driven by a feature request. It is due in roughly six months, and it will be due again six months after that.

**A consequence worth stating plainly.** If the shop goes live before step 9's auto-update works, the clock in the first paragraph is still running and there is no way to answer it remotely. Auto-update is therefore not the last thing in R0 that can slip; it is the thing whose slipping quietly converts every future security fix into a site visit.

---

## D44 — Sign-in identifies, it does not authenticate — and what makes that stop being enough

**Signing in to the office app is choosing your name from a list.** No password, no PIN. `employees.pin_hash` exists in `001_foundation.sql` and nothing writes it.

So `changed_by` on a `product_prices` or `product_tax_assignments` row records **who said they were at the machine**, not a verified identity. Anyone with physical access to the office desk can select any active employee and make changes under their name.

**This is correct and sufficient for R0**, and the reason is specific rather than a shrug. There is one office machine, at one desk, in a shop the owner is in. The realistic alternative is not a stronger credential — it is no attribution at all, or a shared login everybody uses, which is the same thing with more steps. Recording a claim is a large improvement on recording nothing: it makes a wrong change traceable to a person who was plausibly there, on a day, and that is enough to have the conversation. A four-digit PIN nobody can be bothered to type is worth less than a name people select honestly.

**What it is not is a control against a determined insider**, and nothing downstream should be built as though it were. In particular: do not add a report, a permission, or a policy whose correctness depends on `changed_by` being unforgeable, without fixing this first.

**The trigger for revisiting, stated so it is recognisable when it arrives.** Real authentication — PIN at minimum — becomes required at whichever of these happens first:

- **A counter allows sign-in.** Cashiers are a different case entirely: more people, higher turnover, cash involved, and D25 already separates `bill.create` from `price.edit` on the assumption that who is signed in is known. A till where anybody can become anybody makes that separation decorative.
- **A second office workstation exists.** One desk in one room is why "whoever is nearest" is a reasonable guess about who is signed in. Two machines in two places is not one room, and the assumption stops holding the day the second one is installed rather than gradually.

Either of those is the point at which this entry is superseded, not the point at which somebody starts thinking about it. The schema is already ready — `pin_hash` is there, unused, waiting for whoever decides the scheme.

**Why the gap is worth writing down rather than just fixing later.** The column is called `changed_by` and reads like proof. Everything else this project records is either enforced or reconciled: the tax cache has a drift view, the stock cache has a rebuild test, the ledgers are append-only in the database rather than by convention. This one field is a claim, and a reader six months from now has no way to tell that from the schema. Now they do.

---

## D45 — Launch it and use it, every stage that touches a database or an IPC boundary

**Step 7 shipped three bugs that a green build could not see. All three were found by starting the app and clicking something.**

- **The preload threw before it exposed anything.** Importing a value from the `@ssbazar/shared` barrel dragged in the font helpers; bundled to CommonJS, `new URL(…, import.meta.url)` became `new URL(…, '' + {}.url)`, which throws. `contextBridge.exposeInMainWorld` never ran, so `window.catalogue` did not exist and every screen would have failed with nothing in the console to explain it. Typecheck: clean. Build: clean, with a warning nobody would read twice.
- **Translation keys were destroyed in transit.** `attempt()` handed back the `TranslatableError` itself as the failure. It satisfies `TranslatableMessage` structurally, so it compiled, and it works perfectly in process — then crosses IPC as `{}`, because structured clone keeps only an Error's name, message and stack. A Hindi screen would have had nothing to say. The JSON round-trip test could not catch it: `JSON.stringify` *does* keep those properties, so JSON does not model structured clone.
- **Tests that only passed against an empty table.** A smoke run left one `hsn_codes` row behind and two step-5 tests went red. Seeding the database to look like a shop that had already imported a catalogue took ten tests down, across four files. Every one of them would have passed forever until the client imported his spreadsheet — which is the day they would all have broken at once, for a reason having nothing to do with the code under test (CLAUDE.md, Working practices).

**What the three have in common is that reading the code was never going to find them.** Each lives in a gap between two things that are each correct: a bundler and a module system, a type and a serialiser, a test and the database it happens to run against. Static checking sees one side. The gap only exists at runtime.

**So the discipline is a rule, not a habit.** Any stage that touches a real database or crosses an IPC boundary ends by **launching the built application and using the thing that changed** — not by running the test suite again, and not by reading the diff once more. Where the change writes, that means writing something real and looking at what landed. Where it reads, it means reading something that is actually there.

Two specific consequences worth stating, because both cost time here:

- **A build that succeeds is not a build that starts.** Electron fetches its binary lazily, an ESM entry can resolve differently from the module it imports, and a bundler will happily externalise `node:path` into a browser context. Build-order step 9 makes *starting* the app part of installing it for exactly this reason.
- **Clean up after a smoke run, and know what it left.** The row that broke the tests was one `hsn_codes` entry nobody thought about. That is a small cost for the finding, but a smoke run against a shared database is a write, and writes want the same care as any other.

This supersedes nothing. It is the reason the practice exists, written down before the next stage is tempted to skip it because the tests are green.

---

## D46 — WAL archiving without a base backup is a directory that fills the disk

The build order asks step 8 for "WAL archiving and a nightly compressed `pg_dump`". Built exactly
as written, the first half does nothing.

**A `pg_dump` is a logical backup and archived WAL cannot be replayed onto one.** The dump
describes the data; restoring it produces a new cluster with a new timeline and WAL of its own.
The archived segments belong to the cluster they came from. There is no procedure — none, not a
difficult one — that combines the two.

So a system archiving WAL alongside nothing but logical dumps writes 16 MB per segment, forever,
to a directory that can never be used. That is worse than not archiving: it costs disk
continuously, it looks like protection on every review, and the day somebody reaches for it is
the day they find out. It also cannot be pruned safely, because pruning needs to know what the
oldest recoverable point is and there isn't one.

**WAL becomes recoverable on top of a physical base backup**, `pg_basebackup`, and only then. So
step 8 takes one on a schedule (`BACKUP_BASE_EVERY_DAYS`, default weekly), keeps the newest two,
and prunes the archive against the oldest one still kept rather than against the calendar. With
no base backup present, nothing is pruned at all and `wal_archive` reports it: there is no way to
know what is needed, and the safe answer to not knowing is to keep everything and say so.

**What this buys is the window.** The nightly dump alone loses everything between 23:30 and the
failure — at a thousand bills a day, an evening's trading, which is the part of the day the shop
makes its money in. The pair narrows that to the last few minutes. That is the whole reason the
build order asked for WAL archiving at all, and it is why the answer to "the base backup is extra
scope" is no: without it, the thing asked for is inert.

**The two are kept deliberately separate all the same.** The dump is the verified path — weekly
`backup:verify` restores it and asserts against it, and it is what you use when the answer is
"put yesterday back", on any compatible Postgres, without matching the cluster byte for byte.
Point-in-time recovery is the sharper instrument and the more fragile one: it needs the same
major version, an intact archive, and a person choosing a target time under pressure. Having both
is not redundancy, it is two different bad mornings.

**A base backup is not taken when the archive is broken.** `wal_archive` checks `archive_mode`
and `pg_stat_archiver` first, and skips the base backup if either says archiving is not working.
Taking one anyway would write gigabytes that recover nothing and hide the real fault behind a
fresh timestamp — the same failure mode as D32's nightly rebuild, in a different place: an
automatic action that repairs the appearance and destroys the evidence.

---

## D47 — Restore-verify uses a scratch database, and the privilege it needs lives on its own role

Restore-verify has to put a dump somewhere. Two ways to give it somewhere, and the choice was
raised as a security question: the weekly check currently needs `CREATEDB` on the live cluster,
and a job holding a privilege on production is a surface that did not exist before.

**Scratch database** (chosen). `CREATE DATABASE ssbazar_verify` on the live cluster, restore into
it, assert, drop it.

**Throwaway cluster.** `initdb` a fresh cluster in a temporary directory on a spare port, start it,
restore, assert, stop it, delete it. No privilege on the live cluster at all.

Both were built and run against the real dump before deciding. The throwaway cluster works: 7
seconds to `initdb`, 51 MB on disk, 1.7 seconds to create and restore, and it independently
confirmed the assertion this design cares most about — `max(recorded_at)` in the restored copy
came back as the original 08:55:34, not the restore time, so `stamp_recorded_at` did not fire
during load.

### Why the scratch database wins anyway

**The throwaway cluster does not give the property it appears to give.** The argument for it is
that a real disaster-recovery drill restores onto hardware unrelated to the live server. It does
not do that. It runs on the same machine, the same disk, the same OS and the same Postgres
installation; if that disk is the thing that failed, both options are equally unavailable. What
it actually buys is *cluster* independence, not *hardware* independence, and those are different
claims that look alike from a distance. The second is the one worth having, and this is not it.

**Hardware independence is already covered, and covered better.** D22 puts an annual manual drill
on a different machine with the person who would actually do it. That tests the thing that fails
in a real recovery, which is not the software: it is whether a person can find the passphrase,
reach the files, and follow the procedure at seven in the morning with a shop opening at nine. An
automated weekly job cannot test that and should not pretend to.

**It adds a failure mode to the job that runs when everything else has already failed.**
`pg_ctl start` held its console for the entire life of the server during the trial and only
returned when the cluster was stopped, so the job has to detach it correctly; and a job killed
between start and stop leaves an orphaned postmaster holding a port and 51 MB, which the next
run then collides with. The scratch-database path has none of that — the failure modes are
`CREATE DATABASE` fails or `pg_restore` fails, both of which are already reported.

There is also an unresolved Windows constraint: PostgreSQL refuses to start its server under an
administrative account, and `docs/backup.md` schedules these jobs as `SYSTEM`. The trial ran as an
ordinary user and started fine; running it as `SYSTEM` was **not** tested. Anyone choosing the
throwaway cluster has to settle that first.

### The privilege, measured rather than assumed

`ssbazar` is owned by `postgres`, not by the application role. `DROP DATABASE` requires ownership
or superuser, so `CREATEDB` does **not** confer any ability to drop the shop's database. The
marginal grant is exactly: may create databases, and may drop the ones it created. The realistic
worst case is disk exhaustion, not data loss.

**That is small, but "small" is not "belongs on the application role."** So the privilege moves off
it: a dedicated role holding `CREATEDB` and nothing else, owning nothing but scratch databases,
used by the weekly job and by no other code path. The application role that runs billing keeps no
elevated attribute at all, which is the outcome the original concern was actually asking for —
and it is a one-line role change rather than a rebuilt module. `BACKUP_VERIFY_PGUSER` /
`BACKUP_VERIFY_PGPASSWORD` carry it: they apply to the maintenance, restore and assertion
connections only, never to the connection that records the run on the panel.

`REPLICATION` is a separate matter and is not affected by this decision. `pg_basebackup` needs it
whichever way the verify is built (D46), and it belongs on the same dedicated backup role for the
same reason.

### What choosing this gives up, stated plainly

A dump is restored into a cluster that already has the roles, extensions and settings it expects.
A dump that silently depended on something cluster-level and undumped would pass here and fail on
bare metal. `--no-owner --no-privileges` widens that gap further by design.

The trial restore into a cluster built from nothing did succeed, so the gap is not currently
open — but nothing checks that it stays closed. **The annual drill in D22 is what covers it**, and
that is now the second thing depending on the drill actually happening rather than being intended.

### When to revisit

- **The annual drill lapses.** If a year goes by without one, the weekly check is the only
  restore anybody performs, and it should then be made to prove more.
- **A second machine exists.** The moment there is somewhere else to restore to, the useful
  version of this is a job that restores to *that*, not one that spins a second cluster on the
  same disk.
- **The verify starts needing to test recovery rather than the file.** Point-in-time recovery
  (D46) cannot be rehearsed inside a scratch database — replaying WAL onto a base backup needs a
  cluster of its own. If PITR moves from documented to routinely exercised, the throwaway cluster
  comes back on its own merits, for that job rather than for this one.

---

## D48 — A base backup taken before archiving started can never be rolled forward

D46 says WAL archiving needs a base backup to anchor it. That is necessary and it is not
sufficient, and the gap between the two was found by switching archiving on and watching the
check report `ok` for a system that could not recover anything.

**The sequence, because it is the ordinary one rather than a contrived one.** `archive_mode` needs
a server restart, not a reload, so there is always a window where the setting is configured and
not yet in force. A base backup taken in that window records a start WAL of, say, `0008`. The
restart happens an hour later. The archive begins at `000B`. Segments `0009` and `000A` were
written while nothing was archiving them and do not exist anywhere. The WAL chain has a hole at
its start, so recovery from that base backup stops at the end of the backup's own streamed WAL
and cannot reach the archive at all.

**Every fact the check looked at was true.** `archive_mode` was on. A base backup was present. The
archiver had never failed. `wal_archive` reported `ok`, and point-in-time recovery was impossible.
That is a worse failure than reporting nothing, because it is a specific assurance that recovery
exists — and D30 built this panel so somebody would rely on it.

**So a base backup records the `archive_mode` in force when it was taken**, and a backup that
cannot be rolled forward does not count towards having one. The check reports `rollable=` beside
`base_backups=` for the same reason: the count on its own is the reading that was wrong.

**And it fixes itself rather than waiting for the cadence.** Nothing rollable makes a base backup
due immediately, regardless of `BACKUP_BASE_EVERY_DAYS`. A weekly schedule would otherwise leave
the shop without point-in-time recovery for the rest of the week — and this is a repair the job
can safely make, because taking a base backup is what the job does anyway (D32's rule: correct on
a schedule only where the correction is the normal action, not where it destroys evidence).

**A sidecar that does not record the mode counts as not rollable.** Unknown is not the same as
fine, and treating it as fine is the exact mistake being guarded against. It self-clears the next
time a base backup is taken.

### Why this does not need segment-by-segment continuity checking

The obvious next step — walk the archive and prove there is no gap between the base backup's start
and the newest segment — was considered and is not being built. **Postgres does not create gaps
on its own.** A failing `archive_command` is retried against the same segment indefinitely; it is
never skipped, which is why `failed_count` and `last_failed_wal` catch an outage while it is
happening. The archive command refuses to overwrite for the same reason. And the only thing that
deletes from the archive is the pruning here, which only ever removes segments behind the oldest
base backup being kept.

That leaves exactly one way to punch a hole in the middle of a healthy archive: switching
archiving off and on again. Which is the case above, and is what the recorded mode catches. WAL
segment names are also not as simple to enumerate as they look — the last eight hex digits run
`00` to `FF` before the middle eight increment — and a continuity check that got that arithmetic
wrong would raise false alarms, which is worse than the check not existing.

---

## Open items

| Item | Owner | Blocks | Status |
|---|---|---|---|
| Product CSV — several thousand SKUs, 6-digit HSN, optional `name_hi` | Client | R0 completion | **Not started.** Now the critical path — see below |
| Shop opening date | Client | Whether a stopgap billing package is needed | Still unknown |
| Legal Metrology packer registration number | Client | R7 | Open |
| Monthly-salary policy — does an absent day reduce pay? | Client | R8 | Open |
| Hardware purchase to spec | Client | R1 | Open |

FSSAI licence: **held**, number to be entered in the Business Profile.

### The catalogue is now the critical path, not the code

`plan.md` Part 5 sized the product CSV at six to eight weeks of the client's staff and called it the longest pole in the project, on the assumption it started when the template shipped with step 5. **It has not started.**

Steps 7 and 8 are done, which leaves one step in R0 — remote support. So the arithmetic has inverted: the software reaches the end of R0 with an empty catalogue, and the go-live date is set by data entry rather than by anything in this repository. Every day it does not start is a day on the end, and no amount of build speed recovers it.

Two consequences worth acting on rather than noting:

- **Ask for the file in progress, not the finished file.** The point of shipping the validator before any screen (D34) was that the client finds out about a four-digit HSN while he still remembers the row. That only works if somebody runs it on the first hundred rows. Thirty bad rows found at row 100 is a habit corrected; the same thirty found at row 3,000 is a re-key.
- **He probably cannot run the validator himself.** `npm run catalogue:import -- file.csv --dry-run` needs Node, this repository and a reachable Postgres, and his staff are keying into a spreadsheet on a shop PC. `catalogue-import.md` now says what to do instead, but the practical loop is: he sends the file, it gets checked here, the report goes back.

**The opening date is the other half of the same conversation.** It gates the stopgap billing decision, which has a lead time and is already argued out in `plan.md` Part 6 — option A, a commodity package for the first few months, with inventory live from R1 regardless. That decision is cheap to take early and expensive to take under an opening date.
