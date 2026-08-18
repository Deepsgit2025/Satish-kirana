# Build Order

Ordered steps for R0 and R1. Each step is one Claude Code session. **Do not skip ahead** — every step depends on the ones before it.

Review what lands before moving on. At high output volume it is easy to accumulate code nobody has read, and this system runs unattended in a shop for years.

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
> Test case from a real receipt — 5% slab, GST-inclusive prices: line 1 is 1 × ₹112.00, line 2 is 2 × ₹22.00. Expected line taxables 106.67 and 41.91, group taxable 148.58, CGST 3.71, SGST 3.71, group total 155.99, round_off 0.01, net 156.00.
>
> Also test: a bill with both a 5% and an 18% group; a ₹50 bill-level discount apportioned pro-rata across those groups before tax; tax-exclusive input prices; and a zero-rated line.

**Done when:** the reference receipt reproduces to the paisa.

---

## Step 3 — Catalog schema + tax slab changes

> Write `002_catalog.sql` from `docs/schema.md` section D: categories, hsn_codes, tax_slabs, products, product_barcodes, product_prices, product_locations, product_batches. Include `name_hi` and `short_name_hi` (nullable). Then implement slab resolution: given a product and a datetime, return the slab in force at that moment. Include a test proving a bill dated before 2025-09-22 resolves to the old rate.

**Done when:** a historical date returns historical rates.

---

## Step 4 — Stock ledger

> Implement the stock ledger per `docs/schema.md` section G. Append-only, no UPDATE or DELETE. `stock_on_hand` maintained by trigger.
>
> Include a test that posts 100 randomised movements across 5 products and 3 locations, then rebuilds `stock_on_hand` from scratch from the ledger and asserts it matches the trigger-maintained values exactly.

**Done when:** the rebuild test passes. This test is the safety net for the entire project — never let it be deleted or skipped.

---

## Step 5 — Product master + CSV import

> Build the product master screen and CSV import in apps/office. Import must: validate 6-digit HSN, reject duplicate barcodes, report row-level errors without aborting the whole file, and support an optional `name_hi` column. Add bulk edit for price, tax slab and category.
>
> Bulk tax reassignment takes an `effective_from` date and does not apply immediately — pending changes are applied by a nightly job. When reassigning a slab, offer two options: keep MRP (absorb the tax change) or recompute MRP (pass it on).

**Done when:** a 2,000-row CSV imports with a clear error report, and a future-dated slab change applies on the right date and not before.

---

## Step 6 — i18n framework

> Set up i18n across all apps: `en.json` / `hi.json`, language toggle per user, Devanagari-capable font bundled. Add a lint rule that fails the build on hardcoded user-facing strings. Product display uses `COALESCE(name_hi, name)` when the language is Hindi.

**Done when:** the whole UI switches language, and a hardcoded string fails CI.

---

## Step 7 — Local backup

> Implement WAL archiving and a nightly compressed `pg_dump` to a local directory, with 7-day retention. Add a `restore-verify` script that restores a dump to a scratch database and asserts row counts and that `stock_on_hand` equals the sum of `stock_ledger`.

**End of R0.** The shop has no software it can use yet, but everything after this sits on it.

---

## Step 8 — Locations and receiving *(start of R1)*

> Write `003_stock.sql`: locations, product_locations, rack_assignments, grns, grn_lines, grn_line_putaway, stock_adjustments, stock_transfers.
>
> `grn_line_putaway` splits one received line across multiple locations — 100 units received, 40 to a rack, 60 to the godown. Allocations must sum exactly to the line quantity; enforce it. Pre-fill from the product's primary rack so the common case is one keystroke.

---

## Step 9 — GRN entry screen

> Build goods receipt entry: supplier, invoice number and date, lines with batch and expiry, cost rate, tax, and the put-away split. Posts to `stock_ledger` and `party_ledger` in a single transaction. Header-level godown selector that defaults every line.

**Done when:** a real supplier invoice can be entered end to end and stock lands in the right locations.

---

## Step 10 — Rack assignment and count sheets

His main theft-control mechanism.

> Build rack assignment (employee to location, with date ranges and no overlapping open assignments) and cycle counting.
>
> Generating a count sheet **freezes `system_qty` at that moment** — see CLAUDE.md invariant 13. Print a sheet listing every SKU expected on the rack with a blank column. Entry screen for counted quantities. Variance report showing expected vs counted by item and by value, attributed to whoever held the rack on the count date.

**Done when:** a count sheet prints, counts are entered, and the variance report is correct even when sales occur between printing and entry.

---

## After R1

R2 is the billing screen and Hindi raster printing. Before starting it, get the printer, scanner and cash drawer working on real hardware — see `docs/plan.md`. Hardware surprises are cheap to find early and expensive to find late.
