# Build Order

Ordered steps for R0 and R1. Each step is one Claude Code session. **Do not skip ahead** — every step depends on the ones before it.

Review what lands before moving on. At high output volume it is easy to accumulate code nobody has read, and this system runs unattended in a shop for years.

**Step numbers are not stable.** Inserting a step renumbers every step after it, and a migration that quoted one is frozen and cannot follow. Migration filenames are the stable reference; read a step number in SQL as a hint about intent, not a pointer.

---

## Step 0 — Project skeleton

> Set up the monorepo per the layout in README.md. TypeScript throughout, strict mode. Workspaces for server, apps/counter, apps/office, packages/shared. Vitest for tests, ESLint + Prettier. Postgres via `pg`, no ORM — we write SQL. A `db:migrate` script that runs numbered files in `server/migrations` in order and records applied migrations in a `schema_migrations` table. No application logic yet.

**Done when:** `npm install`, `npm test` and `npm run db:migrate` all run clean on an empty database.

---

## Step 1 — Foundation schema

> Read `docs/schema.md` section A and B. Write `server/migrations/001_foundation.sql`: stores, financial_years, devices, employees, roles, permissions, role_permissions, app_settings, units, unit_conversions. Include the Hindi columns listed in `docs/plan.md` Part 2. Seed the standard units and the GST 2.0 tax slabs (0/5/18/40) effective 2025-09-22, plus the pre-revision slabs with effective_to = 2025-09-21. No application code.

**Done when:** migration applies and rolls forward cleanly on a fresh database.

---

## Step 2 — Tax engine, tests first

The highest-value thing to get right early, and independently verifiable.

> Write the tax calculation module in `packages/shared`. Tests first. Rules are CLAUDE.md invariants 1–4.
>
> Test case from a real receipt — 5% slab, GST-inclusive prices: line 1 is 1 × ₹112.00, line 2 is 2 × ₹22.00. Expected line taxables 106.67 and 41.90, group taxable 148.57, CGST 3.71, SGST 3.71, group total 155.99, round_off 0.01, net 156.00.
>
> The line taxables read 41.91 / 148.58 when this step was written, which contradicts the group total below it — 148.58 + 3.71 + 3.71 is 156.00, leaving no round_off. 44.00 ÷ 1.05 = 41.9047…, so the taxable is 41.90 and the group 148.57. Everything else was already right.
>
> Also test: a bill with both a 5% and an 18% group; a ₹50 bill-level discount apportioned pro-rata across those groups before tax; tax-exclusive input prices; and a zero-rated line.

**Done when:** the reference receipt reproduces to the paisa.

---

## Step 3 — Catalog schema + product tax history

> Write `003_catalog.sql` from `docs/schema.md` section D: categories, hsn_codes, products, product_barcodes, product_prices, product_locations, product_batches, product_tax_assignments. Include `products.name_hi`, `products.short_name_hi` and `categories.name_hi`, all nullable, plus the labelling columns from `docs/DECISIONS.md` D16.
>
> `tax_slabs` already exists — created and seeded in `001_foundation.sql` — and is **not** touched here. This step used to ask for a `slab_group` column so a product's current slab could be walked back to its superseded predecessor. It cannot work: the GST 2.0 rationalisation moved products between slabs, not slabs into slabs, so there is no slab-to-slab predecessor to record. See `docs/DECISIONS.md` D27.
>
> Tax history is **per product** instead. `product_tax_assignments` (product_id, tax_slab_id, effective_from, effective_to, changed_by, reason) follows the `product_prices` pattern, with a partial unique index allowing one open row per product. Resolution: product + datetime → the assignment in force → its slab → its rates.
>
> **Test the forward case, not the historical one.** This shop opens in 2026 and will never hold a bill dated before the September 2025 revision, so a pre-revision reprint test asserts something nobody will ever run. What matters is a rate change ahead of us: assign a product to 5%, then add an assignment moving it to a new 8% slab effective next month. Assert it resolves to 5% today, 8% after that date, and that nothing changes until the date arrives.

**Done when:** a future-dated slab change resolves on its date and not one moment before.

---

## Step 4 — Stock ledger

> Write `005_stock_ledger.sql` from `docs/schema.md` section G: `stock_ledger` and `stock_on_hand` only — the rest of section G belongs to receiving, repacking and counting. Append-only enforced by the database, not by convention. `stock_on_hand` maintained by trigger.
>
> Then `006_reconciliation_health.sql`: the health surface from `docs/DECISIONS.md` D30. The `stock_on_hand` drift check is its second entry, which is why it gets built here rather than deferred again.
>
> Include a test that posts 100 randomised movements across 5 products and 3 locations, then rebuilds `stock_on_hand` from scratch from the ledger and asserts it matches the trigger-maintained values exactly.
>
> Use the existing harness — `server/src/testing/database.ts`: a real Postgres, every test inside a transaction that rolls back. Not optional here. The thing under test *is* the trigger, so a fake that answers the question has reimplemented the trigger, and the test then proves the reimplementation right rather than the schema.

**Done when:** the rebuild test passes. This test is the safety net for the entire project — never let it be deleted or skipped.

---

## Step 5 — Catalogue import core (headless)

No UI. The client is keying several thousand SKUs into a spreadsheet now, and needs to know what is wrong with it long before there is a screen to look at (`docs/DECISIONS.md` D34).

> A CSV parser and validator producing a row-level error report, plus a loader that inserts the valid rows. Columns: `barcode`, `name`, `name_hi` (optional), `short_name`, `hsn_code`, `tax_rate`, `mrp`, `sale_price`, `purchase_price`, `unit`, `category`, `reorder_level`.
>
> Validation: HSN exactly 6 digits; barcodes unique within the file and against `product_barcodes`; `sale_price` and `mrp` positive; `unit` resolves against the units master; `tax_rate` resolves to a slab in force. Unknown categories are **created, not rejected** — `category_id` is nullable and blocking an import on an unfinished category tree helps nobody.
>
> **Errors are row-level and never fatal.** A 2,000-row file with 30 bad rows imports 1,970 and reports 30, with line numbers and reasons. The whole file is never abandoned over one row.
>
> Loading a product writes its `product_tax_assignments` row through the same close-then-open helper the edit screen will use, so the two cannot diverge.
>
> `npm run catalogue:import -- <file> [--dry-run]`. Dry run validates and reports without writing, which is what the client runs against his spreadsheet.

**Done when:** a 2,000-row file with deliberate errors imports the good rows and reports the bad ones by line number, and `--dry-run` writes nothing.

---

## Step 6 — i18n framework

> Set up i18n across all apps: `en.json` / `hi.json`, language toggle per user, Devanagari-capable font bundled. Add a lint rule that fails the build on hardcoded user-facing strings. Product display uses `COALESCE(name_hi, name)` when the language is Hindi.

**Done when:** the whole UI switches language, and a hardcoded string fails CI.

---

## Step 7 — Product master screen

The first screen in the system, which is why it comes after i18n rather than before it.

> Build the product master and the import UI in apps/office on top of the step 5 core: browse, search, create and edit a product, and run an import with its error report on screen. Add bulk edit for price, tax slab and category.
>
> Bulk tax reassignment takes an `effective_from` date and does not apply immediately — a future-dated `product_tax_assignments` row is the pending change, and the nightly job advances the cache on the day (`docs/DECISIONS.md` D27). When reassigning, offer keep-MRP (absorb the tax change) or recompute-MRP (pass it on).

**Done when:** a product can be created, edited and bulk-reassigned from the screen, every string comes from `en.json` / `hi.json`, and a future-dated slab change applies on the right date and not before.

---

## Step 8 — Local backup

> Implement WAL archiving and a nightly compressed `pg_dump` to a local directory, with 7-day retention. Add a `restore-verify` script that restores a dump to a scratch database and asserts row counts and that `stock_on_hand` equals the sum of `stock_ledger`.

---

## Step 9 — Remote support foundations

These are R0, built before the shop goes live. Retrofitting them into software already running in a shop is painful — the day you need logs is the day you cannot ship a build that writes them.

Auto-update is the sharpest case. The very first build installed in the shop has to already know how to update itself; if it does not, there is no remote path to the second build, and every fix after it is delivered by hand.

> Build the four things that make supporting this system from another city possible.
>
> **Auto-update.** `electron-updater` against a signed release feed. Counters check for updates **at startup only** and apply them **at day-close — never mid-day**. A billing terminal restarting during the evening rush is worse than the bug being fixed. The office app may update on restart.
>
> **Structured logging.** JSON lines, rotated, on every device. Log level configurable via `app_settings`. **Never log card numbers, full customer phone numbers, or passwords.**
>
> **Diagnostics bundle.** A "Send diagnostics" button that packages recent logs, sync outbox state, app version, device code and last successful backup time into one file the owner can send. This is the alternative to debugging by phone with a shop owner reading error text aloud.
>
> **Version stamp** visible in the UI on every device, so "which version are you on" is answerable.

**Done when:** an update offered mid-day installs at day-close and not before; a diagnostics bundle from a counter is enough to diagnose a sync failure without a phone call, and contains no card numbers, full phone numbers or passwords; and every device shows its version on screen.

**End of R0.** The shop has no software it can use yet, but everything after this sits on it.

---

## Step 10 — Racks and receiving *(start of R1)*

> Write `009_receiving.sql`: rack_assignments, grns, grn_lines, grn_line_putaway, stock_adjustments, stock_transfers.
>
> `locations` is already here — `007_locations.sql` brought it forward with the three foreign keys that were waiting on it, so no location id anywhere is unconstrained. `rack_assignments` was left behind because it needs employees and date ranges and has its own screen.
>
> The migration number for this work has moved three times, and the frozen files still name the old ones. See `docs/DECISIONS.md` D31 on why a planned filename is not a reference to rely on.
>
> `grn_line_putaway` splits one received line across multiple locations — 100 units received, 40 to a rack, 60 to the godown. Allocations must sum exactly to the line quantity; enforce it. Pre-fill from the product's primary rack so the common case is one keystroke.

---

## Step 11 — GRN entry screen

> Build goods receipt entry: supplier, invoice number and date, lines with batch and expiry, cost rate, tax, and the put-away split. Posts to `stock_ledger` and `party_ledger` in a single transaction. Header-level godown selector that defaults every line.

**Done when:** a real supplier invoice can be entered end to end and stock lands in the right locations.

---

## Step 12 — Rack assignment and count sheets

His main theft-control mechanism.

> Build rack assignment (employee to location, with date ranges and no overlapping open assignments) and cycle counting.
>
> Generating a count sheet **freezes `system_qty` at that moment** — see CLAUDE.md invariant 13. Print a sheet listing every SKU expected on the rack with a blank column. Entry screen for counted quantities. Variance report showing expected vs counted by item and by value, attributed to whoever held the rack on the count date.

**Done when:** a count sheet prints, counts are entered, and the variance report is correct even when sales occur between printing and entry.

---

## After R1

R2 is the billing screen and Hindi raster printing. Before starting it, get the printer, scanner and cash drawer working on real hardware — see `docs/plan.md`. Hardware surprises are cheap to find early and expensive to find late.
