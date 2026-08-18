# Module Breakdown & Phasing

**Scope confirmed:** light ledger (no double-entry, no Balance Sheet), Tally export for the CA. Supplier payment is **both** COD and credit terms, so payables and due-date tracking are core, not optional.

**Sizing key:** S = a few days · M = 1–2 weeks · L = 3+ weeks. These are *relative*, so you can apply your own day rate. Sizes assume one developer and include testing, not deployment or training.

---

## Deployment map

| Device | Modules |
|---|---|
| **Server** (mini PC, always on) | Postgres, sync service, nightly jobs, backups |
| **Counter 1 & 2** | Billing, Quick Stock-In, Day Session, Customer Lookup |
| **Office laptop** | Everything else |

Counters run a deliberately thin app. Every screen you add there is a screen a cashier can get lost in during a rush.

---

## Phase 1 — go-live

Everything needed to open the shop and never touch a paper register.

### Foundation

| Module | Size | Notes |
|---|---|---|
| **Business profile & compliance setup** | S | Logo, signature, GSTIN, FSSAI, Legal Metrology packer registration, books-beginning date |
| Users, roles, permissions | M | PIN login on counters, password on office |
| Master data: units, categories, HSN, tax slabs | S | Seed GST 2.0 slabs (0/5/18/40) with history |
| Settings screens | M | ~60 toggles across General, Transaction, Item, Party, Tax |
| Backup & restore | M | Nightly auto + manual; **test the restore, not just the backup** |

### Catalog

| Module | Size | Notes |
|---|---|---|
| Product master | L | Prices, tax type, units, barcodes, rack mapping, **6-digit HSN** |
| Bulk import (CSV/Excel) | M | You'll onboard thousands of SKUs; manual entry is not viable |
| Bulk edit (price / stock / info) | M | Price revisions hit dozens of SKUs at once |
| **Compliance label design & print** | **M–L** | Legal Metrology Rule 6 + FSSAI declarations, computed unit sale price, blocks printing on missing data |
| Price history & change audit | S | |

### Counter — billing

| Module | Size | Notes |
|---|---|---|
| **Billing screen** | L | The hardest screen in the project. Keyboard-first, scan-driven |
| Parked / multi-tab bills | M | Non-negotiable at 1,000 bills/day |
| Payments: cash, UPI, card, split | M | Change calculation, manual RRN entry |
| Loyalty at counter | M | Phone lookup, earn, redeem, points on bill |
| Sale return / credit note | M | |
| Receipt printing (ESC/POS) | M | 48-col layout, drawer kick, auto-cut |
| Offline mode + sync | **L** | See risk note below |
| Day open / day close | M | Float, denomination count, variance |

### Stock

| Module | Size | Notes |
|---|---|---|
| Stock ledger engine | L | The spine — every module writes through it |
| GRN / goods receipt | L | Batches, expiry, cost, put-away |
| Repack (bulk → packets) | M | Yield tracking, creates batches with expiry |
| Stock adjustments + approval | M | Damage, expiry, theft, correction |
| Cycle counting & variance | M | Per-rack, this is the accountability mechanism |
| Rack assignment | S | |
| Daily stock snapshot | S | Nightly job |
| Expiry / near-expiry report | S | Falls out of batches for free |

### Purchase & money

| Module | Size | Notes |
|---|---|---|
| Suppliers / parties | M | Merged customer+supplier ledger |
| Purchase entry | M | |
| Purchase return / debit note | M | Grocery returns damaged stock constantly |
| Payment In / Payment Out | M | |
| **Payment allocation against invoices** | M | Required — he buys on credit |
| Payment due reminders | S | |
| Expenses + categories | M | |
| Cash & bank accounts | M | Cash-in-hand as a running ledger |

### Employees

| Module | Size | Notes |
|---|---|---|
| Employee master | S | Pay type, day rate, overtime rate, opening advance |
| **Manual attendance marking** | M | Present / Half day / Absent calendar, overtime per day |
| Shifts & rosters | M | |
| **Advance ledger** | M | Give advance, running outstanding, posts to cash account |
| **Salary calculation & payment** | M | Day counts × rate, overtime at 2×, cash/advance split |
| **Salary slips** | M | PDF, print, share |
| Attendance & payroll reports | M | Salary register, advances, staff cost vs sales, **Form N register** |

### Reports

| Module | Size | Notes |
|---|---|---|
| **Report framework** | **L** | Date range, filters, sorting, print, Excel export — **build this first** |
| Dashboard | M | Sales trend, stock value, low stock, receivable/payable |
| Sales reports (12) | M | Register, by item/category/counter/cashier, hourly, discounts, profit |
| Stock reports (12) | M | Summary, detail, valuation, low stock, batch & expiry, rack variance |
| Purchase & party reports (12) | M | Registers, statements, payables ageing, party-wise profit |
| Money reports (10) | M | Day book, cash flow, expenses, day close, **operating P&L** |
| Staff reports (7) | S | Attendance, salary register, advances, sales per cashier |
| GSTR-1 + HSN summary | **M–L** | Get this reviewed by his CA before go-live |
| Tally export | M | |

---

## Phase 2 — after the shop is running

| Module | Size | Why it waits |
|---|---|---|
| **Biometric attendance device** | M | ZKTeco Push protocol — device pushes to your server, no port forwarding. Confirm model first |
| Purchase orders | M | He orders informally today |
| Integrated UPI terminal (ECR) | M | Blocked on bank paperwork, not on you |
| WhatsApp messaging | M | Needs Business API account + template approval |
| E-invoicing / IRN | M | **Only if he ever sells B2B.** Not needed for B2C retail |
| Custom fields | S | Only when he asks |
| Label print job history | S | |
| Leaves & holiday calendar | M | Paid leave policy needs deciding first |
| Statutory payroll (PF, ESI, TDS) | L | Only if he has enough staff to be liable |
| Multi-store | L | Only if a second branch opens |

---

## The three things that will hurt

**1. Offline sync (L).** Two counters writing bills and stock movements during a LAN or server outage, then reconciling. Bill-number collisions, stock going negative, the same bill arriving twice. It is the single most likely source of a data-integrity bug that surfaces three months in, and it cannot be bolted on later — the UUID keys and outbox have to be there from the first bill.

Budget more time here than feels reasonable, and test by **actually unplugging the switch mid-transaction**, repeatedly.

**2. Label compliance (M–L, and it's a client obligation too).** Repacking makes the shop a *packer*, not a retailer. Legal Metrology Rule 6 and FSSAI labelling both apply: packer name and address, generic name, net quantity, packing month/year, MRP, computed unit sale price, FSSAI number, batch, expiry, veg/non-veg mark, allergens, storage, consumer care.

Two things follow. First, the label engine must **refuse to print** when a mandatory declaration is missing — a partial label is the violation. Second, **raise the licences with the client before this module goes live**: Legal Metrology packer registration and the FSSAI repacker Kind of Business licence. That's his obligation, not yours, but you don't want to be the one printing thousands of non-compliant labels.

Put his registration numbers in the Business Profile as a documented go-live prerequisite.

**3. GSTR-1 (M–L).** Filing correctness is not something you can verify yourself. Have his CA review your output against a real month before go-live. Note the HSN digit standard: above ₹5 crore turnover Table 12 needs **6-digit** codes and B2C HSN reporting is mandatory — so set 6 digits as the import standard, because lengthening thousands of codes afterwards is miserable.

**Deferred risk — the biometric device.** Now phase 2, which removes it from your critical path. When you get there, the ZKTeco Push protocol is HTTP-based and device-initiated, so it works behind the shop firewall with no port forwarding, and open-source libraries exist. Specify **Green Label series with Attendance PUSH protocol v2.0+** and confirm before he buys.

---

## Suggested build order

1. **Foundation + product master + stock ledger** — everything else sits on these
2. **Billing screen + receipt printing** — the highest-risk UI, prove it early on real hardware
3. **Offline sync** — while the data model is still young enough to change
4. **GRN + purchase + parties**
5. **Repack + labels + cycle counts**
6. **Day close + cash/bank + expenses**
7. **Attendance**
8. **Reports + GST + Tally export**

> Get a **single counter billing and printing on the real printer in week 2**, even against a half-built product master. Thermal printing, barcode scanners and cash drawers always surprise you, and finding out in week 2 is cheap. Finding out in week 10 is not.

---

## Things to write into the contract

- **Hardware** is the owner's cost, to your spec. Don't absorb it, and don't let him substitute a cheaper printer without your sign-off. **Biometric device is now phase 2 — tell him not to buy it yet.**
- **Compliance prerequisites before repack go-live** — his Legal Metrology packer registration number and FSSAI repacker licence number, entered into the Business Profile. Put this in writing: you build to the declared standard, he holds the licences.
- **Data migration** — if he has existing stock or supplier data, scope it separately. Cleaning someone else's spreadsheet is real work.
- **Training** — 2 sessions minimum: cashiers on billing only, owner on everything else. Separate them.
- **Support window** — define what's covered post-go-live and for how long. The first two weeks will generate more calls than the whole build.
- **GSTR-1 sign-off** — his CA validates the output. You build to spec; correctness of filing is not your liability.
- **Phase 2 items are quoted separately**, not "we'll see."
