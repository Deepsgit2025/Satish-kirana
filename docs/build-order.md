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

> Build the product master and the import UI in apps/office on top of the step 5 core. **Three views over one catalogue**, not one screen with modes:
>
> - **List** — browse, search and filter: name, barcode, category, slab, status. How anybody finds a product.
> - **Single product** — create and edit one product across every field. How a new line is added and a wrong figure is fixed.
> - **Bulk grid** — select rows, set one field, apply to all. Price, tax slab and category. How a price revision or a rate change actually arrives: dozens of SKUs at once (`docs/modules.md`, Catalog).
>
> Plus the import UI: run a file and read its error report on screen.
>
> **All four paths validate through the step 5 core and write through the same history helpers.** `validateCatalogueRows` and the `RowIssue` it returns; `assignProductSlab` and `assignProductPrice`. A screen assembles the same row shape the CSV parser assembles and hands it to the same checks — `RowIssue.line` identifies a grid row or the form instead of a file line, and the reason is still a `catalogue.issue.*` key resolved in the reader's language (`docs/DECISIONS.md` D39). **No view owns a rule of its own** (D41).
>
> Two places the shared core has to stretch, named here so nobody writes a second one instead:
>
> - **An edit is not a create.** `existingBarcodes` rejects a barcode already on a product, which is every product being edited. The row's own product is excluded from that check — one lookup set built differently, not a second barcode rule.
> - **A bulk change is a whole row.** The grid materialises the product's current values, applies the one changed field on top, and validates the result. That is what makes a bulk price rise get checked against MRP (D35) instead of sailing past a rule the file would have caught.
>
> **A bulk apply behaves like a file.** 200 selected, 8 fail: 192 apply and 8 report, against their rows, with every problem in a row listed rather than the first. The selection is no more abandoned over one product than a 2,000-row file is over one line. The rows that apply commit in one transaction.
>
> **And it leaves what the file leaves.** One `product_prices` and/or `product_tax_assignments` row per product, close-then-open through the helpers, same `changed_by`, `effective_from` from `databaseNow()` and never `new Date()` (CLAUDE.md, Working practices). The single field that differs is `reason`, which exists to differ. Six months on, nothing else about the two histories should say which screen the change came from.
>
> Bulk tax reassignment takes an `effective_from` date and does not apply immediately — a future-dated `product_tax_assignments` row is the pending change, and the nightly job advances the cache on the day (D27). When reassigning, offer keep-MRP (absorb the tax change) or recompute-MRP (pass it on). **The grid offers that same choice, not a simpler one.** A recomputed price is checked against MRP like any other, and a row that would cross the printed maximum reports as an issue and does not apply (D35). Future-dating the slab future-dates the price with it, on the same `effective_from` — otherwise the new price is charged for a month under the old rate.

**Done when:** a product can be created and edited from the single-product view; a bulk reassignment of 200 products leaves the same history rows, in the same shape, as importing those 200 as a file — asserted by a test that does both and compares, not by inspection; a bulk apply containing bad rows applies the good ones and reports the rest by row; every string comes from `en.json` / `hi.json`; and a future-dated slab change applies on the right date and not before.

### Remaining scope, in order

The headless core, the IPC contract (`docs/DECISIONS.md` D42) and a shell wired to it are done. Two things are settled about what is left, and the order matters.

**Sign-in comes before the real screens, not after.** Every `product_prices` and `product_tax_assignments` row carries `changed_by`, and that column is the whole of the answer to "who changed this price". A placeholder — a hardcoded id, a nullable field the UI fills in later — would make every history row written before sign-in exists quietly wrong, in exactly the way the tax cache work was careful not to be. So the single-product and bulk-edit screens are built against a real signed-in employee from their first commit rather than against a value that has to be swapped underneath them.

Minimal is enough for R0: look up the employee, establish who they are, and let the writes take `changed_by` from that. **The renderer never supplies it.** A screen that could name whoever it liked as the author of a change is not an audit trail, it is a text field.

**Language stays on the English fallback until sign-in exists.** The renderer resolves through `createLanguageSession({})` today. The real answer is `employees.preferred_language`, then `app_settings.default_language` — and neither is reachable without knowing who is signed in. Adding a contract method for it now would mean a method with nothing real behind it, which is the speculative surface D42 argues against. It arrives with sign-in, which is the point at which there is something to ask.

Then the three real screens on top: list with search and filter, single-product create and edit, and the bulk grid.

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

**Upgrading Electron is on a clock, and this step is what answers it.** The installed major leaves Electron's supported window roughly six months after it goes in — `docs/DECISIONS.md` D43 carries the date and the checking interval. Without auto-update working, every security upgrade after that is a visit to the shop with a build on a USB stick.

### Installing on the shop's own hardware

**`npm ci` needs the internet, or it needs `ELECTRON_CACHE`.** Electron does not ship its binary in the npm package; a postinstall step downloads a platform-specific one (~225 MB on Windows x64). On a machine that is offline, behind a proxy, or on the shop's own connection on a bad day, the install fails at that step and the error names a download rather than a missing setting.

Either point `ELECTRON_CACHE` at a directory holding a pre-fetched binary, copied from a machine that has already installed it, or set `ELECTRON_MIRROR` at a local one. Worth doing before travelling to the shop rather than while standing in it: this is a five-minute problem with a laptop and a working connection, and an afternoon without.

**Launching the app once is part of the install, not a check afterwards.** The binary is fetched lazily — it did not arrive during `npm install` on the development machine, it arrived on the first `require('electron')`. So a machine can complete its install cleanly, report success, and still have no Electron on it. The failure then surfaces the first time somebody starts the app, which may be the following morning, with the technician already gone and a shop expecting to open.

So the install procedure for each counter and the office machine ends with **starting the application and seeing it render**, on a machine with the same network profile it will have in service — offline if the store server will be offline at install time, behind the shop's connection if that is what it will use. An installer that ran without errors is not evidence the app will start. Only starting it is.

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
