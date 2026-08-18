# Project Plan — SS Super Bazar Retail System

**Master document.** Supersedes the earlier delivery plan. Covers confirmed decisions, schema changes still to be written, and the release schedule.

**Context:** the shop has not opened and holds no stock. The plan follows the order things actually happen in a new shop — catalogue, then goods inward, then selling.

**Total: 15.8–26 months** solo full-time, AI-assisted. **Shop can open after R2: 5.7–9.3 months.**

---

## Part 1 — Answers to the two things you asked about

### 1.1 Rack stock report for physical counting — supported, but pulled forward

This is his main theft-control mechanism, so it cannot sit at the end of the project. Moved into **R1**, alongside locations, which are being built anyway for put-away.

**How it works:**

1. Owner assigns a rack to an employee (`rack_assignments`, with date ranges so responsibility is provable over time)
2. Every 7 or 15 days he generates a **count sheet** — a printed list of every SKU the system believes is on that rack, with a blank column
3. The assigned person walks the rack and writes actual quantities
4. Counted figures are keyed in; the system produces a **variance report** — expected vs counted, by item and by value

**One rule that must be enforced:** `cycle_count_lines.system_qty` is **frozen when the count sheet is generated**, not read at data-entry time. Otherwise sales made during the count show up as shortages, and the employee is blamed for stock that was legitimately sold while they were counting.

Advanced pieces — tolerance percentages for loose goods, approval workflow, FEFO — stay in R6. The basic loop ships in R1.

### 1.2 Split receipt between rack and godown — **this was a gap**

The schema had one location per GRN line. Real receiving doesn't work that way: 100 Parle-G arrives, 40 go to the rack, 60 to the godown. Sometimes all to the rack, sometimes all to the godown.

**Fix: a put-away allocation table under each GRN line.**

```
grn_line          Parle-G  ·  qty 100  ·  rate 4.50   (matches the supplier invoice)
  └ putaway 1     40 → rack A-01-3
  └ putaway 2     60 → godown G-01
```

New table `grn_line_putaway`: `id`, `grn_line_id`, `location_id`, `qty`, `batch_id`.
**Constraint:** allocations must sum exactly to the line quantity.

This keeps the GRN line matching the supplier invoice — one line, 100 units — while stock lands in the right physical places. All three of his cases fall out of it: all-rack is one allocation, all-godown is one allocation, split is two.

**Default behaviour:** pre-fill the allocation from `product_locations.is_primary_face`, so the common case is one keystroke and only genuine splits need attention.

Godown → rack movement afterwards is `stock_transfers`, already planned for R6.

---

## Part 2 — Language

**Confirmed: Hindi and English, on screen and on printed receipts.**

### Screen
All UI strings externalised to `en.json` / `hi.json` from R0. Toggle per user (`users.preferred_language`, `app_settings.default_language`). Retrofitting this later means touching every screen twice, so it is a day-one decision.

### Data — Hindi columns
`products.name_hi`, `products.short_name_hi`, `categories.name_hi`, `units.name_hi`, `units.short_name_hi`.

**All nullable, all fall back to English when blank.** He fills Hindi names for the few hundred items that matter and leaves the rest. This is important: a mandatory Hindi name would double his catalogue data-entry work, which is already the longest pole in the project.

### Printed receipt — the technical constraint

**Item names print in Hindi. Everything else stays as it is** — headers, GST breakup, numbers, totals in English.

ESC/POS thermal printers have no Devanagari code page. Hindi cannot be sent as text. The receipt must be rendered by us to a bitmap (576 dots wide at 203 dpi) with a Devanagari font and correct text shaping for conjuncts and matras, then sent in raster mode.

| | Text mode | Raster mode |
|---|---|---|
| Data per bill | ~1 KB | ~30–60 KB |
| Print time | ~1.5 s | **~4–6 s** |
| Layout | printer handles it | we compute every pixel |

**This is a real operational cost, not a footnote.** At 1,000 bills a day, 3–4 extra seconds per bill is roughly an hour of additional queue time, concentrated in the evening rush.

**Mitigation to build:** render in raster **only when the bill contains at least one Hindi item name**. English-only bills stay in fast text mode. In practice most bills will be fast, and the shop only pays the time cost where Hindi is actually used.

Sized as **M–L** inside R2 and it is the main reason R2 grew.

### Not translated
Labels stay English — Legal Metrology permits either script. A4 documents and salary slips can be bilingual cheaply later (no ESC/POS constraint), and a Hindi salary slip is genuinely more useful to staff than a Hindi receipt is to a customer.

---

## Part 3 — Everything held in memory, now confirmed in the plan

### 3.1 Schema changes still to be written into `schema.md`

| Item | Why |
|---|---|
| `transactions.godown_id` | Header-level location on purchases. Without it, receiving 40 items means setting location 40 times — so nobody will, and stock lands nowhere |
| `grn_line_putaway` | The rack/godown split above |
| `expense_categories.expense_nature` | `direct` / `indirect`. Needed for a real operating P&L — gross profit vs operating profit |
| `expense_items` + `transaction_lines.expense_item_id` | Petrol and Rent are not products. Putting them in `products` pollutes stock valuation, low-stock alerts and every item report |
| `transaction_attachments` | Multiple files per document. "Upload Bill" is several pages, not one image |
| `products.name_hi`, `short_name_hi` | Hindi, nullable |
| `categories.name_hi`, `units.name_hi`, `units.short_name_hi` | Hindi, nullable |
| `users.preferred_language`, `app_settings.default_language` | Language toggle |
| `backups`, `backup_verifications` | Promoted to P1 — see 3.3 |
| `print_profiles.render_mode` | `text` / `raster` / `auto` |

### 3.2 The salary double-count trap

Salary appears both as an expense category and as payroll output. **If both write to the ledger, every salary is counted twice** and the owner's expenses inflate with no obvious cause.

**Rule:** salary payments post automatically from `salary_runs` into a **reserved, locked expense category**. The category exists so the P&L is complete; nobody can key into it by hand. Same for advances — cash out is already recorded in `employee_advances`, so it must not also be entered as an expense.

This is the class of bug that surfaces in month eight when he says "my expenses look too high", and it is very hard to unpick retrospectively.

### 3.3 Cloud backup — AWS, client approved

- **AWS Mumbai (ap-south-1)**, INR billing, his GSTIN on the invoice from signup
- Account in **SS Super Bazar's name, his card** — not yours
- **Two separate jobs:** database (nightly full dump, tiered retention 7 daily / 12 monthly / 7 yearly) and files (sync-once, versioned, never re-uploaded)
- Files are ~95% of backup volume, so this split is what keeps the cost at roughly ₹10–150/month over ten years
- Write-only IAM user, no delete permission, one bucket
- Object Lock or versioning on — ransomware protection
- Client-side encryption; passphrase stored off-server, paper copy to the owner
- Lifecycle rules at bucket level, not in code
- **Resize supplier bill photos to ~1 MB on capture** — halves file volume
- **Never store photos in Postgres** — path in the DB, file on disk
- Monthly automated restore verification with assertions; health indicator on the dashboard
- Two USB drives, weekly rotation, owner takes one home

### 3.4 Report catalogue
The full ~50-report list is already in the appendix of `schema.md`, including the ones from his reference app that were missing: category-wise profit, item-wise discount, party report by item, expense item report, and the returns registers.

**Correction carried forward:** an *operating* P&L (Sales − COGS − Expenses) needs no double-entry and is in scope. Only Balance Sheet and Trial Balance require a chart of accounts, and those remain out of scope.

---

## Part 4 — Do this week, before any code

1. **Send the product CSV template.** Several thousand SKUs is six to eight weeks of his staff's time and it is the longest pole in the project. Started now, the catalogue is ready the week R0 finishes. Asked for in month two, you lose two months of calendar for nothing.
   - Standard: **6-digit HSN, not 4** — required above ₹5 crore turnover, and miserable to lengthen later
   - Include an optional `name_hi` column so Hindi names are captured during the same pass
2. **Ask when the shop opens.** Everything depends on it — see Part 6.
3. **Tell him to apply for Legal Metrology packer registration and the FSSAI repacker licence now**, alongside his other setup paperwork. Both block R7.
4. **Agree the hardware spec** so the server, first counter and label printer are on site before R1 finishes.

---

## Part 5 — Release schedule

| # | Release | Months | Cumulative | What it unlocks |
|---|---|---|---|---|
| R0 | Catalogue & foundation | 1.5–2.4 | 1.5–2.4 | Products exist in a system |
| R1 | Goods inward + rack counts | 1.8–3.1 | 3.3–5.5 | **Receive stock; count racks** |
| R2 | Billing + Hindi receipts | 2.4–3.7 | **5.7–9.3** | **Shop can open** |
| R3 | Second counter + day close | 1.3–2.0 | 6.9–11.3 | Both tills, offline-safe |
| R4 | Money & suppliers | 1.9–3.2 | 8.8–14.4 | Payables, expenses, bank |
| R5 | Reports & GST | 2.1–3.3 | 10.9–17.7 | File GST from the system |
| R6 | Advanced stock control | 1.2–1.9 | 12.0–19.7 | Transfers, FEFO, tolerances |
| R7 | Repack & labels | 1.1–1.8 | 13.1–21.5 | Own-packed goods, legally |
| R8 | Payroll | 1.4–2.4 | 14.5–23.9 | Attendance, advances, slips |
| R9 | Loyalty & polish | 1.3–2.2 | 15.8–26.1 | Points, messaging, tuning |

### R0 — Catalogue & foundation
Business profile (GSTIN, FSSAI, Legal Metrology reg, logo, books-beginning date) · users, roles, PIN login · units + conversions, categories, 6-digit HSN, GST 2.0 slabs with history · **stock ledger engine** · **product master + CSV import + bulk edit** · barcode master, internal Code 128 · **i18n framework and Hindi data columns** · local backup (WAL + nightly dump).

**Exit test:** his full product list imports cleanly; an opening stock entry rebuilds correctly from the ledger.

### R1 — Goods inward + rack counts ← *his stated priority*
Suppliers/parties · **GRN with batch, expiry, cost** · **put-away split across rack and godown** · locations (godown, aisle, rack, shelf) · opening stock · stock adjustments with approval · barcode label printing for unbarcoded items · **rack assignment** · **count sheet + variance report** · stock reports (on hand, by location, valuation, low stock).

**Exit test:** a real delivery received and split between rack and godown; a count sheet printed, counted, and a variance report produced.

> From here he never has an inventory backlog. Every delivery is entered as it arrives — the main advantage of building for a shop that hasn't opened.

### R2 — Billing + Hindi receipts ← *the shop opens*
Billing screen (scan, keyboard-first, parked bills) · payments cash/UPI/card/split with change · **ESC/POS printing, text mode English + raster mode Hindi item names** · GST tax invoice with FSSAI number · sale return / credit note · single-counter day close.

> **Get printer, scanner and drawer working in week 2 of this release.** Hardware always surprises you. Early it costs a day; late it costs an opening date.

**Exit test:** 200 test bills rung by an actual cashier, including Hindi item names, printed, GST tying to a manual calculation.

### R3 — Second counter + day close
Second counter · **offline mode + sync** (local SQLite, outbox, UUID idempotency) · denomination count, cash variance, session reports · S3 backup + monthly restore verification · backup health on dashboard.

> Test by **physically unplugging the switch mid-transaction**, repeatedly.

**Exit test:** both counters bill through a 30-minute outage and reconcile cleanly.

### R4 — Money & suppliers
Party ledger · purchase returns / debit notes · Payment In/Out with invoice allocation · reminders and ageing · **expenses with direct/indirect and expense items** · cash and bank accounts · **locked salary category rule**.

### R5 — Reports & GST
**Report framework first**, then ~30 reports · dashboard · GSTR-1, GSTR-3B summary, HSN summary · operating P&L · Tally export.

**Exit test:** his CA files one real month from your GSTR-1 output without corrections.

### R6 — Advanced stock control
Godown → rack transfers with sent vs received · batch FEFO auto-selection · expiry alerts · tolerance percentages for loose goods · cycle-count approval workflow.

### R7 — Repack & compliance labels
Repack bulk → packets with yield tracking · **compliance label engine**: Legal Metrology Rule 6 + FSSAI declarations, computed unit sale price, refuses to print when data is missing.

> **Blocked on the client.** Packer registration and FSSAI repacker licence numbers must be in the Business Profile before this ships.

### R8 — Payroll
Employee master and shifts · manual attendance calendar · advance ledger posting to cash · salary calculation with cash/advance split, frozen on payment · salary slips · Form N register.

### R9 — Loyalty & polish
Loyalty earn/redeem · WhatsApp/SMS for supplier documents · custom fields · second print profile · performance tuning · remaining ~20 reports.

### Phase 2 — quoted separately
Biometric attendance · purchase orders · integrated UPI terminal (ECR) · e-invoicing/IRN if he ever sells B2B · leaves and holidays · statutory payroll (PF/ESI/TDS) · multi-store.

---

## Part 6 — The conversation you need to have now

**When does the shop open?**

R2 is 5.7–9.3 months away. If he opens before that he cannot bill on your software, and effort will not fix it — the billing screen, raster Hindi printing and payments genuinely take that long.

**A — Open on schedule, bill on something else.** He licenses a cheap billing package (₹3,000–5,000/year) for the first few months and switches at R2. **His inventory is live from R1 regardless**, so stock is correct from day one. Some double-entry of sales during the overlap.

**B — Delay opening to match R2.** Only sensible if the shop isn't ready anyway. Rent burning with no revenue is worse than a billing workaround.

**C — Compress R2.** One counter, English-only receipts at launch with Hindi added in R3, cash and manual UPI only, no parked bills. Perhaps 1.5–2 months. Everything cut returns later, and the cashier's life is harder meanwhile.

**Recommend A.** A billing package is a commodity costing less than a day of your time. Rushing billing against an opening date is where projects break, and it is the one module you cannot afford to get wrong.

---

## Part 7 — Commercial structure

- **Payment on acceptance of each release**, not monthly
- **Written exit test agreed before each release starts** — that defines "accepted"
- **Hardware is his**, to your spec. Server, first counter and label printer before R1; second counter before R3; **biometric not until Phase 2**
- **Cloud is his AWS account**, his card, his GSTIN
- **Licences are his** — packer registration and FSSAI repacker, required before R7
- **Change log.** Every request during a release gets sized and scheduled, never absorbed silently. This is what stops 16 months becoming 26.
- **Pause clause.** Either side can stop at a release boundary. After R3 he has a complete working shop system — a legitimate place to stop.

---

## Part 8 — What will actually go wrong

**Scope creep between releases.** He will see R1 and ask for three things during R2. Each is reasonable; together they add six months. The change log is the only defence.

**R2 running long.** The billing screen is the hardest UI in the project, it lands early when you know the domain least, and Hindi raster printing is new work with no reference implementation. Budget the top of the range.

**Sync bugs surfacing at month 10.** Subtle — a stock count off by three, occasionally. Impossible to debug retroactively. Build the nightly reconciliation job (compare `stock_on_hand` against a full `stock_ledger` sum, alert on drift) in R3, not later.

**Him losing patience around month 8–10.** This is why R3 must leave the shop fully operational. If he can run the business on what you've built, waiting for reports is tolerable. If he is still half on paper, it is not.
