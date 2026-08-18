# Retail POS & Inventory — Database Schema v2

**Engine:** PostgreSQL 15+ on the store server
**Edge cache:** SQLite on each counter (subset + outbox)
**Conventions:** `snake_case`, `id BIGSERIAL` PK, every table has `created_at`, `updated_at`, `created_by`. Money `NUMERIC(12,2)`. Quantity `NUMERIC(12,3)`. Rates `NUMERIC(5,2)`.

Tagged **[P1]** build now, **[P2]** phase two.

> **What changed from v1:** customers and suppliers merged into `parties`; `uom` ENUM replaced by a `units` master with conversions; all financial documents unified into `transactions`; added parked bills, additional charges, expenses, bank/cash accounts, payment allocation, financial years, print profiles, and label templates.

---

## The one big architectural decision

The reference app runs every document — Sale, Purchase, Credit Note, Debit Note, Payment-In, Payment-Out, Expense, Sale Order — through the same shape: party, lines, discount, tax, round-off, payment type, totals. The list screens, Day Book, All Transactions and Party Statement are all one query over that shape.

**So `transactions` is a single table with a `txn_type` discriminator**, not eight separate tables.

*What this buys:* one numbering engine, one party ledger, one tax engine, one sync path, one audit trail. Day Book and Party Statement become trivial instead of eight-way UNIONs.

*What it costs:* a wide table with POS-only columns sitting NULL on purchase rows. At ~1,000 sales + maybe 20 purchases a day that's a non-issue — the nullable columns cost nothing in Postgres, and a partial index on `txn_type='sale'` keeps the counter's hot path fast.

*Where I'd draw the line:* if you ever add a second store with different document types, split then. Not now.

---

## A. Foundation

### `stores` [P1] — the Business Profile

One row today. This is the "Business Profile" screen: everything that prints on a document or identifies the business to a regulator.

| Column | Type | Notes |
|---|---|---|
| id | BIGSERIAL PK | |
| code | VARCHAR(8) UNIQUE | `4521` — embedded in bill numbers |
| business_name | TEXT | trade name, large on the receipt |
| legal_name | TEXT | registered entity name |
| business_type | ENUM | proprietorship, partnership, LLP, pvt ltd |
| business_category | VARCHAR(40) | retail / grocery / supermarket |
| phone / alt_phone | VARCHAR(15) | |
| email | TEXT | |
| address_lines | TEXT | |
| city / state / state_code / pincode | VARCHAR | `23` MP — decides CGST+SGST vs IGST |
| logo_path | TEXT | receipt and A4 header |
| signature_path | TEXT | "Authorized Signatory" block on A4 |
| books_beginning_date | DATE | opening balances date; blocks backdated entries before it |
| **gstin** | VARCHAR(15) | |
| **fssai_no** | VARCHAR(14) | **must print on every bill** — see below |
| **legal_metrology_reg_no** | VARCHAR(30) | packer registration — see Compliance |
| packer_name | TEXT | as registered; prints on repack labels |
| packer_address | TEXT | as registered |
| consumer_care_details | TEXT | phone/email for label complaints |
| cin_no | VARCHAR(21) NULL | companies only |

> **`fssai_no` is not optional.** Every food business must declare its 14-digit FSSAI number on cash receipts, invoices and cash memos. Print it on the bill header by default and don't expose a toggle to turn it off for sale bills.

> **`books_beginning_date`** is worth enforcing. It's the line before which no transaction may be dated — otherwise someone backdates an entry into a closed period and your opening balances stop reconciling.

### Compliance — what the repack module obliges [P1]

Packing bulk goods into retail packets makes the shop a **packer**, not just a retailer, and two separate laws apply. This is the client's obligation, not yours, but your software has to produce compliant output.

**Legal Metrology (Packaged Commodities) Rules, 2011** — registration with the Controller of Legal Metrology is required, applied for within 90 days of commencing pre-packing. Rule 6 mandates specific declarations on every retail package.

**FSSAI** — repacking bulk food into retail packs is treated as deemed manufacturing, requiring the repacker Kind of Business licence rather than a trading registration. At this turnover that's a State licence.

**Raise both with the client before the repack module goes live.** If he isn't registered, software that prints non-compliant labels at scale creates exposure for him and an awkward conversation for you. Get his registration numbers into the Business Profile as a go-live prerequisite.

### `financial_years` [P1]
The reference app's Close Books screen resets invoice prefixes each FY. Numbering is scoped to the year, so this must exist before you write a single bill.

`id`, `code` (`2026-27`), `start_date`, `end_date`, `status ENUM(open, closed)`, `closed_at`, `closed_by`.

### `devices` [P1]
| Column | Type | Notes |
|---|---|---|
| id | BIGSERIAL PK | |
| store_id | FK → stores | |
| device_code | VARCHAR(8) UNIQUE | `C1`, `C2`, `OFFICE` |
| device_type | ENUM | `counter`, `office`, `server` |
| bill_prefix | VARCHAR(20) | `452104015`; NULL for non-billing |
| print_profile_id | FK → print_profiles | |
| last_seen_at | TIMESTAMPTZ | health monitoring |
| is_active | BOOLEAN | |

### `employees` [P1]
| Column | Type | Notes |
|---|---|---|
| id | BIGSERIAL PK | |
| emp_code | VARCHAR(20) UNIQUE | prints as `BAL/086430` |
| name | VARCHAR(60) | single name field |
| phone | VARCHAR(15) | |
| role_id | FK → roles | |
| biometric_user_id | VARCHAR(20) | the ID **inside** the attendance device — not `id` |
| pin_hash | TEXT | counter login |
| password_hash | TEXT | office login |
| date_of_joining | DATE | |
| pay_type | ENUM | `daily`, `monthly` |
| pay_rate | NUMERIC(12,2) | per day, or per month — current; history in `employee_pay_rates` |
| overtime_rate_per_hour | NUMERIC(12,2) NULL | |
| half_day_pay_pct | NUMERIC(5,2) | usually 50 — some shops pay 60 |
| opening_advance | NUMERIC(12,2) | advance already owed before the system started |
| advance_balance | NUMERIC(12,2) | **cache** — truth is `employee_advances` |
| status | ENUM | `active`, `inactive` |

### `roles` / `permissions` / `role_permissions` [P1]
String permission keys: `bill.create`, `bill.void`, `price.edit`, `stock.adjust`, `purchase.create`, `expense.create`, `report.view_all`, `daybook.view`.

The reference app's "All Users" filter on every report implies user attribution everywhere — which the unified `transactions.created_by` gives you for free.

### `app_settings` [P1]
Key-value, typed. Grouped by the reference app's settings tabs so nothing gets lost:

**General** — `decimal_places`, `enable_passcode`, `stop_sale_on_negative_stock`, `block_new_items_from_txn`, `block_new_parties_from_txn`, `audit_trail_enabled`, `auto_backup_enabled`, `backup_time`, `godown_transfer_enabled`

**Transaction** — `round_off_enabled`, `round_off_mode` (nearest/up/down), `round_off_to`, `add_time_on_transactions`, `cash_sale_by_default`, `billing_name_of_parties`, `customer_po_details`, `show_last_5_sale_prices`, `show_last_5_purchase_prices`, `free_item_quantity`, `eway_bill_enabled`, `quick_entry`, `skip_invoice_preview`, `passcode_for_txn_edit_delete`, `discount_during_payments`, `show_profit_while_billing`, `billing_type` (lite/full)

**Item** — `barcode_scan`, `direct_barcode_scan`, `show_low_stock_dialog`, `default_unit_id`, `item_wise_tax`, `item_wise_discount`, `update_sale_price_from_txn`, `internal_barcode_prefix`, `low_stock_alert`

**Party** — `party_grouping`, `shipping_address`, `manage_party_status`, `payment_reminder_enabled`, `payment_reminder_days`, `loyalty_enabled`, `points_earn_rate`, `points_redeem_value`

**Tax** — `gst_enabled`, `hsn_enabled`, `cess_on_item`, `reverse_charge_enabled`, `place_of_supply_enabled`

> `stop_sale_on_negative_stock` — set this **off** for your store. Grocery stock counts drift, and a hard block means the counter refuses to sell an item that's physically in the customer's hand. Warn instead.

> `show_profit_while_billing` — set this **off** on counter devices and on for the office. A cashier seeing margin on every line is a leak waiting to happen. Make it a role permission, not just a global toggle.

### `document_type_labels` [P2]
The reference app's "Change Transaction Names" — some shops call it Bill, others Cash Memo or Estimate.

`id`, `txn_type`, `display_label`, `print_label`.

---

## B. Units

### `units` [P1]
Replaces v1's `uom` ENUM. Needed because your repack flow buys in bags and sells in packets.

`id`, `name` (`KILOGRAMS`), `short_name` (`Kg`, prints on bill), `is_system`, `is_active`.

Seed: Pcs, Kg, Gm, Ltr, Ml, Box, Bag, Packet, Dozen, Bundle, Carton, Quintal.

### `unit_conversions` [P1]
`id`, `base_unit_id`, `secondary_unit_id`, `factor NUMERIC(12,4)`.

`1 BAG = 50 KG` → base=KG, secondary=BAG, factor=50.

Lets a GRN record "2 bags" while the ledger moves 100 kg. Without this, every purchase entry needs mental arithmetic and someone will get it wrong.

---

## C. Parties (customers + suppliers)

### `party_groups` [P2]
`id`, `name`, `description`. For "Sale Purchase By Party Group" reporting.

### `parties` [P1]
**Merged from v1's separate `customers` and `suppliers`.** The reference app proves why: Party Statement, party balance, Payment-In/Out and credit notes all key off one ledger. Two tables means two of everything.

| Column | Type | Notes |
|---|---|---|
| id | BIGSERIAL PK | |
| party_type | ENUM | `customer`, `supplier`, `both` |
| name | VARCHAR(80) | |
| phone | VARCHAR(15) | **indexed** — the counter's loyalty lookup key |
| email | TEXT | |
| gstin | VARCHAR(15) NULL | |
| gst_type | ENUM | `unregistered`, `registered`, `composition`, `consumer`, `overseas` |
| state_code | VARCHAR(2) | place of supply → CGST/SGST vs IGST |
| party_group_id | FK NULL | |
| billing_address | TEXT | |
| shipping_address | TEXT NULL | |
| opening_balance | NUMERIC(12,2) | |
| opening_balance_type | ENUM | `receivable`, `payable` |
| current_balance | NUMERIC(12,2) | **cache** — truth is `party_ledger` |
| credit_limit | NUMERIC(12,2) NULL | |
| payment_terms_days | INT NULL | |
| points_balance | INT | **cache** — truth is `loyalty_transactions` |
| total_spend / visit_count | NUMERIC / INT | |
| dob / anniversary | DATE NULL | |
| first_seen_at / last_visit_at | TIMESTAMPTZ | |
| reminder_enabled | BOOLEAN | payment-due reminder |
| reminder_days | INT | days before due to nudge |
| custom_fields | JSONB | user-defined extras |
| status | ENUM | `active`, `inactive` |

### `custom_field_definitions` [P2]
The reference app offers four fixed extra fields per entity, each with a "Show In Print" toggle. A definitions table plus a JSONB value column is the same feature without a schema migration every time the owner wants another field.

`id`, `entity ENUM(party, product, transaction)`, `field_key`, `label`, `data_type ENUM(text, number, date)`, `show_in_print`, `sort_order`, `is_active`.

### `payment_reminders` [P1]
`id`, `party_id`, `txn_id`, `due_date`, `remind_on`, `channel ENUM(whatsapp, sms, none)`, `message_template`, `sent_at`, `status`.

Only meaningful because the owner buys on credit terms. Confirmed in scope.

> Walk-in cash customers should **not** create party rows. 1,000 bills/day would give you 300,000 junk parties a year. Only create a party when a phone number is entered for loyalty or credit. `transactions.party_id` stays nullable.

### `party_ledger` [P1] — append-only
Every event that moves a party's balance. Same discipline as `stock_ledger`: derive the balance, never mutate it.

`id`, `party_id`, `txn_id FK → transactions NULL`, `entry_type ENUM(sale, purchase, payment_in, payment_out, credit_note, debit_note, opening, adjustment)`, `debit`, `credit`, `balance_after`, `entry_date`, `notes`, `created_by`.

---

## D. Catalog

### `tax_slabs` [P1]
`id`, `name` (`GST 5%`), `cgst_rate`, `sgst_rate`, `igst_rate`, `cess_rate`, `effective_from`, `effective_to`, `is_active`.

**Seed these, effective 22 Sep 2025:** 0% · 5% (2.5 + 2.5) · 18% (9 + 9) · 40% (20 + 20). The 12% and 28% slabs were abolished in the GST 2.0 rationalisation, and compensation cess was scrapped on everything except tobacco — keep `cess_rate` but expect zero on nearly every SKU.

Seed the **old** slabs as well with `effective_to = 2025-09-21`. A bill reprinted from before that date must show the rate that applied then, which is the entire point of effective-dating.

Never put rates on the product. The receipt itself references the 22/09/2025 revision — reprints must use the old rate.

### `hsn_codes` [P1]
`hsn_code VARCHAR(8) PK`, `description`, `default_tax_slab_id`.

> **Use 6-digit HSN codes throughout, not 4.** Above ₹5 crore aggregate turnover the GSTR-1 Table 12 summary requires 6 digits, and this shop's volume clears that easily. HSN reporting for B2C is also mandatory at that turnover. Set 6 digits as the data-entry standard *before* you import the product master — going back to lengthen thousands of codes later is miserable work.

### Scope decision — B2C only [P1]

Confirmed: the shop sells to consumers, so **no e-invoicing and no IRN generation**. That removes an entire integration from scope.

`transactions.buyer_gstin` still exists and stays NULL on every normal bill. It costs nothing and covers the case that will eventually happen — a nearby restaurant or office asks for a proper GST invoice. When that field is populated, the sale is B2B, and above ₹5 crore turnover a B2B invoice legally requires an IRN from the Invoice Registration Portal.

**Handle it by refusing, not by half-building it.** If a cashier enters a buyer GSTIN, the system should flag the bill for the office rather than issue it silently. IRP integration is a phase-2 item with its own price; issuing an uncredited B2B invoice is a compliance problem for the owner.

### `categories` [P1]
Self-referencing: `id`, `parent_id`, `name`, `path`.

### `products` [P1]
| Column | Type | Notes |
|---|---|---|
| id | BIGSERIAL PK | |
| item_code | VARCHAR(30) UNIQUE | the reference app's "Assign Code" — auto-generated internal code |
| name | TEXT | office screens |
| short_name | VARCHAR(30) | **prints on 80mm receipt** — set manually |
| category_id | FK | |
| hsn_code | FK | |
| tax_slab_id | FK | current slab |
| base_unit_id | FK → units | |
| secondary_unit_id | FK → units NULL | |
| product_kind | ENUM | `standard`, `bulk`, `repacked` |
| is_sellable | BOOLEAN | FALSE for `bulk` |
| pack_weight | NUMERIC(10,3) NULL | 0.500 for a 500g packet |
| mrp | NUMERIC(12,2) | |
| sale_price | NUMERIC(12,2) | current — history in `product_prices` |
| sale_price_tax_type | ENUM | `inclusive`, `exclusive` |
| purchase_price | NUMERIC(12,2) | last/standard cost, for margin without joining GRNs |
| purchase_price_tax_type | ENUM | `inclusive`, `exclusive` |
| wholesale_price | NUMERIC(12,2) NULL | [P2] |
| wholesale_min_qty | NUMERIC(12,3) NULL | [P2] |
| default_discount_pct | NUMERIC(5,2) | |
| reorder_level | NUMERIC(12,3) | "Min Stock To Maintain" |
| track_batches | BOOLEAN | default FALSE — see Batch tracking below |
| tax_on_mrp | BOOLEAN | "Calculate Tax based on MRP" — abated valuation |
| shelf_life_days | INT NULL | |
| custom_fields | JSONB | user-defined extras |
| tolerance_pct | NUMERIC(5,2) | cycle-count variance allowance; 0 for packaged |
| image_path | TEXT NULL | |
| status | ENUM | `active`, `discontinued` |

> **`sale_price_tax_type` is the field people forget.** Your retail prices are MRP-inclusive; supplier purchase prices are usually exclusive. The reference app exposes this toggle on both prices independently, and it must be stored per price, not set globally — otherwise every margin figure is wrong by the GST rate.

### `product_barcodes` [P1]
`id`, `product_id`, `barcode VARCHAR(48) UNIQUE` (**hottest index in the system**), `barcode_type ENUM(ean13, code128_internal, manual)`, `is_primary`.

### `product_prices` [P1]
`id`, `product_id`, `sale_price`, `mrp`, `tax_type`, `effective_from TIMESTAMPTZ`, `effective_to`, `changed_by`, `reason`.

Partial unique index: one open row per product.

### `product_locations` [P1]
`id`, `product_id`, `location_id`, `is_primary_face`, `capacity`.

### `product_batches` [P1]
First-class batches, not loose columns on lines. Without this you cannot produce an expiry report or trace a write-off to a specific lot.

| Column | Type | Notes |
|---|---|---|
| id | BIGSERIAL PK | |
| product_id | FK | |
| batch_no | VARCHAR(30) | supplier's, or generated for repacks |
| mfg_date / expiry_date | DATE NULL | |
| repack_batch_id | FK NULL | links a packed lot to its repack run |
| grn_txn_id | FK NULL | which purchase brought it in |
| cost_rate | NUMERIC(12,2) | this lot's landed cost |
| mrp | NUMERIC(12,2) | MRP changes between lots |
| qty_received | NUMERIC(12,3) | |
| qty_remaining | NUMERIC(12,3) | cache, derived from `stock_ledger` |
| status | ENUM | `active`, `expired`, `exhausted`, `blocked` |

Unique on `(product_id, batch_no)`. `transaction_lines.batch_id` and `stock_ledger.batch_id` replace the loose `batch_no` text columns.

**Turn batches on selectively.** `products.track_batches` defaults to FALSE. Enable it for perishables (dairy, bakery, packaged food nearing shelf life) and everything `repacked`. For shampoo and steel scrubbers it's pointless overhead.

**Never prompt the cashier for a batch.** When a tracked product is scanned, the system auto-picks the batch with the nearest expiry that still has stock — FEFO — and writes `batch_id` onto the line silently. At 1,000 bills/day, a batch-selection dialog on every scan would stop the queue dead. Batch choice is only exposed in stock adjustments, cycle counts and the expiry screen.

This gives the owner a "expiring in next N days" report and, when a lot is written off, a traceable link back to which GRN and which supplier it came from.

---

## E. Locations & Accountability

### `locations` [P1]
`id`, `code VARCHAR(20) UNIQUE` (`A-01-3`), `location_type ENUM(rack, godown, cold, counter_display)`, `parent_id`, `name`.

### `rack_assignments` [P1]
`id`, `location_id`, `employee_id`, `valid_from DATE`, `valid_to DATE NULL`, `assigned_by`.

No overlapping open assignments per location. Without the date range you cannot answer "who owned this rack when the shortage happened."

---

## F. Transactions — the unified document table

### `transaction_series` [P1]
Per-type, per-device, per-FY numbering. Replaces v1's `bill_sequences`.

`id`, `txn_type`, `device_id NULL`, `financial_year_id`, `prefix VARCHAR(10)`, `last_number BIGINT`, `updated_at`.

Unique on `(txn_type, device_id, financial_year_id)`. Counter C1 owns its sale series and allocates locally; the server rejects duplicates rather than renumbering.

### `transactions` [P1]

| Column | Type | Notes |
|---|---|---|
| id | BIGSERIAL PK | |
| uuid | UUID UNIQUE | **generated on the counter** — sync idempotency key |
| txn_type | ENUM | `sale`, `purchase`, `credit_note`, `debit_note`, `payment_in`, `payment_out`, `expense`, `sale_order`, `purchase_order`, `estimate`, `delivery_challan` |
| txn_number | VARCHAR(30) | `452104015-001397` |
| voucher_number | VARCHAR(30) NULL | `S080015-0044` |
| financial_year_id | FK | |
| store_id / device_id | FK | |
| party_id | FK → parties NULL | NULL for walk-in cash |
| party_name_snapshot | VARCHAR(80) NULL | |
| ref_txn_id | FK → transactions NULL | credit note → original sale; GRN → PO |
| supplier_invoice_no | TEXT NULL | purchases |
| supplier_invoice_date | DATE NULL | |
| eway_bill_no | VARCHAR(20) NULL | only on large-value goods movement |
| customer_po_no | VARCHAR(40) NULL | "Customers P.O. Details" |
| billing_name | VARCHAR(80) NULL | when the bill-to name differs from the party name |
| buyer_gstin | VARCHAR(15) NULL | **normally NULL** — see the B2C note below |
| cash_discount_amount | NUMERIC(12,2) | early-payment discount — "Discount During Payments" |
| cashier_id | FK → employees | |
| cashier_name | VARCHAR(30) | **snapshot** — prints on receipt |
| cashier_code | VARCHAR(20) | snapshot |
| day_session_id | FK NULL | counter shift |
| attendance_day_id | FK NULL | who was clocked in; backfilled |
| txn_datetime | TIMESTAMPTZ | business time |
| due_date | DATE NULL | credit terms |
| place_of_supply | VARCHAR(2) | drives IGST vs CGST/SGST |
| is_reverse_charge | BOOLEAN | RCM on purchases from unregistered suppliers |
| item_count | INT | the `Items: 2` figure |
| total_qty | NUMERIC(12,3) | the `Qty: 3` figure |
| gross_amount | NUMERIC(12,2) | Σ MRP × qty |
| line_discount_amount | NUMERIC(12,2) | |
| bill_discount_amount | NUMERIC(12,2) | header-level discount |
| bill_discount_pct | NUMERIC(5,2) NULL | |
| additional_charges | NUMERIC(12,2) | packing / delivery |
| taxable_amount | NUMERIC(12,2) | 148.58 |
| cgst_amount / sgst_amount / igst_amount / cess_amount | NUMERIC(12,2) | |
| round_off | NUMERIC(5,2) | **required** — 155.99 → 156.00 |
| net_amount | NUMERIC(12,2) | 156.00 |
| paid_amount | NUMERIC(12,2) | |
| balance_amount | NUMERIC(12,2) | drives the Paid/Unpaid badge |
| payment_status | ENUM | `paid`, `partial`, `unpaid` |
| mrp_savings | NUMERIC(12,2) | the "Saved Rs. 152.00" line |
| points_earned / points_redeemed | INT | |
| remarks | TEXT NULL | the F12 field |
| terms_conditions | TEXT NULL | [P2] |
| image_path | TEXT NULL | photo of supplier bill |
| synced_at | TIMESTAMPTZ NULL | NULL = counter-only |
| status | ENUM | `draft`, `parked`, `completed`, `void` |
| void_reason / voided_by | TEXT / FK | |

Indexes: `(txn_type, txn_datetime)`, `(party_id, txn_datetime)`, partial index `WHERE txn_type='sale' AND status='completed'`, `uuid`.

> **`status='parked'` is the multi-tab POS feature.** The reference billing screen keeps several bills open at once (Ctrl+T new, Ctrl+W close). A customer forgets the coriander, the cashier parks the bill and serves the next person. At 1,000 bills/day this is not a nice-to-have — without it the queue stops dead. Parked bills hold **no stock** and get no number until completed; auto-void them at day close.

### `transaction_lines` [P1]
Every tax field is a **snapshot**, never a live join.

| Column | Type | Notes |
|---|---|---|
| id | BIGSERIAL PK | |
| txn_id | FK | |
| line_no | INT | |
| product_id | FK NULL | NULL for expense lines |
| barcode_scanned | VARCHAR(48) NULL | audit trail |
| description | VARCHAR(30) | copy of `short_name` at sale time |
| hsn_code | VARCHAR(8) | copied |
| qty | NUMERIC(12,3) | |
| free_qty | NUMERIC(12,3) | supplier 10+1 schemes |
| unit_id | FK → units | |
| conversion_factor | NUMERIC(12,4) | to base unit |
| mrp | NUMERIC(12,2) | |
| rate | NUMERIC(12,2) | |
| rate_tax_type | ENUM | `inclusive`, `exclusive` |
| line_gross | NUMERIC(12,2) | |
| discount_pct / discount_amount | NUMERIC | line-level |
| taxable_amount | NUMERIC(12,2) | rounded **per line** |
| cgst_rate / sgst_rate / igst_rate / cess_rate | NUMERIC(5,2) | frozen |
| cgst_amount / sgst_amount / igst_amount / cess_amount | NUMERIC(12,2) | |
| line_total | NUMERIC(12,2) | |
| tax_group_index | INT | the printed `1)` / `2)` grouping |
| batch_id | FK → product_batches NULL | auto-selected FEFO, never prompted |
| cost_rate | NUMERIC(12,2) NULL | for Bill Wise Profit |
| location_id | FK NULL | which rack it sold from |

### `transaction_tax_summary` [P1]
The GST breakup block, pre-computed. Denormalised on purpose so reprints and GSTR-1 never recompute and never drift.

`id`, `txn_id`, `tax_group_index`, `cgst_rate`, `sgst_rate`, `igst_rate`, `cess_rate`, `taxable_amount`, `cgst_amount`, `sgst_amount`, `igst_amount`, `cess_amount`, `total_amount`.

### `transaction_charges` [P1]
The F8 "Additional Charges" — packing, delivery, handling. Separate rows because each can carry its own GST rate.

`id`, `txn_id`, `charge_name`, `amount`, `tax_slab_id NULL`, `tax_amount`.

### `transaction_payments` [P1]
Split tenders are normal: ₹500 cash + ₹292 UPI.

`id`, `txn_id`, `payment_mode ENUM(cash, upi, card, points, credit, bank_transfer, cheque)`, `account_id FK → accounts NULL`, `amount`, `tendered_amount NULL`, `change_amount NULL`, `reference_no NULL` (**mandatory for upi/card** — RRN last 4, reconciles against the bank file), `terminal_id NULL` (ready for phase-2 ECR).

### `payment_allocations` [P1]
Links a Payment-In/Out to the invoices it settles. The reference app's "Link Payments to Invoices".

`id`, `payment_txn_id`, `against_txn_id`, `amount_allocated`.

Without this, a supplier paying ₹50,000 against six bills leaves you unable to say which are cleared.

---

## G. Stock

### `stock_ledger` [P1] — append-only
**Never update, never delete.** Current stock is derived. This is what makes shrinkage investigation possible.

`id`, `product_id`, `location_id NULL`, `txn_type ENUM(sale, sale_return, purchase, purchase_return, repack_out, repack_in, adjustment, transfer_out, transfer_in, opening)`, `qty_delta NUMERIC(12,3)` **signed**, `ref_table`, `ref_id`, `ref_line_id NULL`, `batch_id FK NULL`, `cost_rate NULL`, `device_id`, `employee_id`, `occurred_at` (business time), `recorded_at` (server insert).

Indexes: `(product_id, occurred_at)`, `(location_id, occurred_at)`, `(ref_table, ref_id)`.

> `occurred_at` vs `recorded_at` matters for offline. A bill made at 6:02pm during a LAN outage and synced at 6:40pm needs both, or your hourly sales report lies.

### `stock_on_hand` [P1] — derived cache
PK `(product_id, location_id)`, plus `qty`, `last_ledger_id`, `updated_at`.

Maintained by trigger. Rebuildable from the ledger at any time — that's the safety net. A nightly job verifies against a full ledger sum and alerts on drift.

### `daily_stock_snapshots` [P1]
The owner's "daily stock in hand", frozen at day close, immutable.

`id`, `snapshot_date`, `product_id`, `location_id`, `qty`, `valuation_rate`, `valuation_amount`. Unique on `(snapshot_date, product_id, location_id)`.

Also makes month-end reports fast — sum one day's snapshot instead of replaying 18 months of ledger.

### `repack_batches` [P1]
`id`, `batch_code UNIQUE`, `source_product_id` (must be `product_kind='bulk'`), `source_qty`, `packed_on`, `expiry_date` (from `shelf_life_days`), `packed_by`, `yield_pct`, `notes`.

### `repack_outputs` [P1]
`id`, `repack_batch_id`, `output_product_id`, `qty_produced`, `unit_weight`, `location_id`, `product_batch_id FK NULL`.

Every repack output should **create a `product_batches` row** carrying the packed date and computed expiry. That's how a 500g atta packet gets an expiry at all — there's no manufacturer date printed on a shop-sealed pouch.

One batch can yield 500g *and* 1kg packets. The transaction writes one `repack_out` row and one `repack_in` row per output, atomically. Yield below ~95% consistently is a conversation with the packer.

### `stock_transfers` / `stock_transfer_lines` [P1]
The reference app's "Godown management & Stock transfer". `stock_ledger` already has `transfer_in`/`transfer_out` types, but a transfer needs a **document** — otherwise the two halves float unlinked and nobody can prove what moved.

Header: `id`, `transfer_no`, `from_location_id`, `to_location_id`, `transfer_date`, `transferred_by`, `received_by NULL`, `status ENUM(draft, in_transit, received, cancelled)`, `notes`.

Lines: `id`, `transfer_id`, `product_id`, `batch_id NULL`, `qty_sent`, `qty_received`, `variance_qty`.

> `qty_sent` vs `qty_received` matters. Godown → rack moves are where stock quietly disappears in a big store, and a transfer that records only one number can't show you that.

Your main flow is godown → rack, which is also how a restock request should work: the rack owner requests, the godown sends, the rack owner confirms receipt. That confirmation step is what makes rack accountability defensible — he can't claim stock never arrived.

### `stock_adjustments` [P1]
`id`, `adjustment_no`, `adjustment_type ENUM(damage, expiry, theft, correction, opening)`, `product_id`, `batch_id FK NULL`, `location_id`, `qty_delta`, `reason TEXT`, `approved_by`, `adjusted_at`, `status ENUM(pending, approved, rejected)`.

> Require approval. If a cashier can silently adjust stock down, your shrinkage report is decorative.

### `cycle_counts` / `cycle_count_lines` [P1]
Header: `id`, `count_no`, `location_id`, `counted_by`, `assigned_employee_id` (rack owner at count time), `count_date`, `status`, `approved_by`.

Lines: `id`, `count_id`, `product_id`, `system_qty` (frozen at count start), `counted_qty`, `variance_qty`, `variance_value`, `within_tolerance`, `remarks`.

This is where rack accountability actually gets measured.

---

## H. Money — accounts, cash, expenses

### `accounts` [P1]
Cash-in-hand and each bank account as a ledger. The reference app treats Cash In Hand as a running balance with its own transaction list.

`id`, `account_type ENUM(cash, bank)`, `display_name`, `bank_name NULL`, `account_number NULL`, `ifsc NULL`, `upi_id NULL`, `opening_balance`, `opening_as_of DATE`, `current_balance` (cache), `print_on_invoice BOOLEAN`, `print_upi_qr BOOLEAN`, `is_active`.

### `account_ledger` [P1] — append-only
`id`, `account_id`, `txn_id NULL`, `entry_type`, `debit`, `credit`, `balance_after`, `entry_date`, `notes`.

### `expense_categories` [P1]
`id`, `name`, `parent_id NULL`, `is_active`. Seed: Rent, Electricity, Salary, Packing Material, Transport, Repairs, Tea/Refreshment, Misc.

Expenses themselves are `transactions` rows with `txn_type='expense'` and an `expense_category_id`. Add that nullable column to `transactions`.

### `day_sessions` [P1]
One row per counter per business day.

`id`, `device_id`, `business_date`, `financial_year_id`, `opened_by`, `opened_at`, `opening_float`, `closed_by`, `closed_at`, `expected_cash`, `counted_cash`, `cash_variance`, `expected_upi`, `counted_upi`, `total_bills`, `total_sales`, `status ENUM(open, closed)`.

Unique `(device_id, business_date)`.

### `session_denominations` [P1]
Day-open float and day-close count **only** — not per transaction.

`id`, `session_id`, `phase ENUM(open, close)`, `denomination INT` (500/200/100/50/20/10/5/2/1), `count INT`, `amount`.

### `cash_movements` [P1]
Mid-shift drops and petty cash.

`id`, `session_id`, `movement_type ENUM(drop, petty_expense, float_add)`, `amount`, `reason`, `approved_by`, `created_at`.

---

## I. Loyalty

### `loyalty_config` [P1]
`id`, `earn_rate` (points per ₹100), `redeem_value` (₹ per point), `min_redeem_points`, `points_expiry_days`, `max_redeem_pct_of_bill`, `effective_from`, `effective_to`.

### `loyalty_transactions` [P1]
`id`, `party_id`, `txn_id NULL`, `txn_type ENUM(earn, redeem, expire, manual_adjust)`, `points` (signed), `balance_after`, `expires_on DATE NULL`, `notes`, `created_at`, `created_by`.

Truth lives here; `parties.points_balance` is a cache reconciled nightly.

---

## J. Attendance

### `attendance_devices` [P2]
`id`, `device_name`, `ip_address`, `port`, `serial_number`, `last_sync_at`, `last_punch_id_synced`, `status`.

### `attendance_punches` [P2] — raw, append-only
`id`, `attendance_device_id`, `biometric_user_id`, `employee_id FK NULL`, `punch_time`, `punch_type ENUM(in, out, unknown)`, `verify_mode`, `device_log_id`, `synced_at`.

Unique `(attendance_device_id, device_log_id)` — idempotency when you re-pull logs.

> `employee_id` is nullable and resolved after insert. A new hire punching before you map their biometric ID must not lose the punch.

### `shifts` [P1]
`id`, `name`, `start_time`, `end_time`, `grace_minutes`, `half_day_threshold_minutes`, `full_day_threshold_minutes`, `break_minutes`.

### `employee_shifts` [P1]
`id`, `employee_id`, `shift_id`, `valid_from`, `valid_to`.

### `attendance_days` [P1] — computed nightly
`id`, `employee_id`, `work_date`, `shift_id`, `first_in`, `last_out`, `total_minutes`, `late_minutes`, `early_out_minutes`, `overtime_minutes`, `status ENUM(present, absent, half_day, week_off, holiday, leave)`, `is_manual_override`, `override_by`, `override_reason`.

Unique `(employee_id, work_date)`. The override fields are essential — fingerprints fail and the owner needs to fix days by hand.

### Linking attendance to billing

`transactions.attendance_day_id` gives the owner:

- **Sales per attended hour** per cashier — fair, because a half-day no longer looks like poor performance
- **Ghost-shift detection** — bills rung under an employee code on a day they never punched in. PIN sharing or attendance fraud; both matter.
- **Attendance defence** — 340 bills under a login is strong evidence of presence when the device missed a punch

**Don't hard-block billing on a missing punch.** One failed fingerprint at 7pm and your counters stop. Warn, flag, and let the nightly job backfill once punches sync.

### `leaves` [P2]
`id`, `employee_id`, `leave_type ENUM(paid, unpaid, sick)`, `from_date`, `to_date`, `days`, `reason`, `approved_by`, `status`.

### `holidays` [P2]
`id`, `holiday_date`, `name`, `is_paid`.

---

## J2. Payroll — daily wage and monthly

Built for how shops actually pay: a day rate, a running advance, and a salary slip on WhatsApp.

### `employee_pay_rates` [P1]
Rates change. A slip reprinted for March must use March's rate, so never overwrite.

`id`, `employee_id`, `pay_type`, `pay_rate`, `overtime_rate_per_hour`, `half_day_pay_pct`, `effective_from DATE`, `effective_to DATE NULL`, `changed_by`, `reason`.

Partial unique index: one open row per employee.

### `employee_advances` [P1] — append-only ledger
The reference app's "Advance Outstanding" is a loan balance, not a salary field. Same discipline as `party_ledger`: derive the balance, never mutate it.

| Column | Type | Notes |
|---|---|---|
| id | BIGSERIAL PK | |
| employee_id | FK | |
| entry_type | ENUM | `opening`, `advance_given`, `recovered_from_salary`, `written_off`, `adjustment` |
| amount | NUMERIC(12,2) | **signed** — positive increases what he owes |
| balance_after | NUMERIC(12,2) | |
| salary_run_id | FK NULL | set on `recovered_from_salary` |
| account_id | FK → accounts NULL | which drawer or bank the cash left from |
| entry_date | DATE | |
| notes | TEXT | |
| approved_by | FK → employees | |

> **An advance is cash leaving the drawer.** It must post to `account_ledger` too, or your day-close won't reconcile. This is the most common thing shops get wrong on paper — the money is gone but nothing records it.

`employees.advance_balance` is a cache over this ledger, reconciled nightly.

### `salary_runs` [P1] — one per employee per month, frozen
| Column | Type | Notes |
|---|---|---|
| id | BIGSERIAL PK | |
| employee_id | FK | |
| period_month | DATE | first of month |
| pay_type | ENUM | **snapshot** |
| pay_rate | NUMERIC(12,2) | **snapshot** |
| overtime_rate | NUMERIC(12,2) | **snapshot** |
| full_days / half_days / absent_days | INT | **snapshot** of attendance at run time |
| paid_days | NUMERIC(6,2) | full + (half × half_day_pay_pct) |
| overtime_hours | NUMERIC(8,2) | |
| basic_amount | NUMERIC(12,2) | paid_days × rate |
| overtime_amount | NUMERIC(12,2) | |
| additions / deductions | NUMERIC(12,2) | bonus, fine, other |
| gross_amount | NUMERIC(12,2) | |
| advance_opening | NUMERIC(12,2) | **snapshot** — prints on the slip |
| advance_recovered | NUMERIC(12,2) | credited against salary this month |
| advance_closing | NUMERIC(12,2) | **snapshot** |
| cash_paid | NUMERIC(12,2) | the split |
| remaining_unpaid | NUMERIC(12,2) | |
| status | ENUM | `draft`, `paid`, `cancelled` |
| paid_on | DATE NULL | |
| paid_by / account_id | FK | |
| notes | TEXT | |

Unique on `(employee_id, period_month)`.

> **Freeze on payment.** Once `status='paid'`, the day counts and rates on this row never change again — even if the owner later corrects an attendance day in that month. A slip already sent on WhatsApp is a document, and a document that silently rewrites itself is worse than no document. Corrections go through `additions`/`deductions` on the *next* month's run, which is also how a real accountant would handle it.

### `salary_payments` [P1]
Separate from the run, because partial payments happen — ₹5,000 now, the rest on Friday.

`id`, `salary_run_id`, `payment_mode ENUM(cash, upi, bank_transfer)`, `account_id FK`, `amount`, `paid_on`, `reference_no NULL`, `paid_by`, `notes`.

### `salary_slips` [P1]
`id`, `salary_run_id`, `slip_number`, `generated_at`, `pdf_path`, `sent_via ENUM(whatsapp, print, pdf, none)`, `sent_to_phone`, `sent_at`, `sent_by`.

Keep the row even when sending fails — "did Jayant get his slip" is a question the owner will ask.

### Where attendance meets payroll

**Phase 1 is manual marking.** The biometric device moves to phase 2, so day status is entered by the owner or supervisor: Present / Half day / Absent on a month calendar, with overtime hours added per day. `attendance_days` is written directly, `is_manual_override = true`.

**Phase 2 adds the biometric.** Punches land in `attendance_punches`; a nightly job derives `attendance_days.status` from the shift thresholds in `shifts` (`half_day_threshold_minutes`, `full_day_threshold_minutes`). Manual entries always win over computed ones — the override fields already exist for exactly this.

Because the schema already holds both paths, phase 2 adds a device integration and a nightly job. It does **not** require reworking payroll, which is the reason to keep `attendance_punches` and `attendance_days` as separate tables even while only one is in use.

**Overtime is always entered manually**, in both phases. Don't compute it from punch-out time — staff linger after closing, and paying for loitering costs real money. Overtime should be an authorised decision.

> **Overtime rate defaults to 2× the ordinary rate.** Under the MP Shops and Establishments Act, overtime wages must be twice the ordinary wage rate. Default `overtime_rate_per_hour` to `2 × (daily rate ÷ shift hours)` and warn if the owner sets it lower — he can override, but he should do it knowingly.

### Payroll reports [P1]
Monthly salary register (all employees, one page), advance outstanding by employee, salary paid vs month, and staff cost as a percentage of sales.

**Plus one statutory report: Form N.** Under the MP Shops and Establishments Rules every employer must maintain a register of employees showing attendance, wages, overtime, fines and other deductions. Your tables already hold all of it — this is a print layout, not new data, and it's a genuine selling point. A shop owner who can hand an inspector a printed register instead of a shoebox of paper will value that more than most of the reporting.

---

## K. Printing & Labels

### `print_profiles` [P1]
Per-device, per-paper print config. This grew a lot after reviewing the reference Print settings — there are ~40 individual toggles there, and every one hardcoded is a support call later.

**Structure:** fixed columns for things the print engine branches on, plus a JSONB blob for the pure show/hide toggles. Forty boolean columns would be unmaintainable; forty JSONB keys are fine because nothing queries them — they're only read when rendering a document.

| Column | Type | Notes |
|---|---|---|
| id | BIGSERIAL PK | |
| name | TEXT | "Counter thermal", "Office A4" |
| printer_type | ENUM | `thermal_58`, `thermal_80`, `thermal_112`, `a4`, `a5` |
| is_default | BOOLEAN | per type |
| printer_ip / printer_port | INET / INT | ESC/POS target |
| chars_per_line | INT | 32 (58mm) · 48 (80mm) · or custom |
| theme | VARCHAR(20) | reference app ships 4 thermal layouts — build 2 |
| print_mode | ENUM | `text` (fast ESC/POS) or `graphic` (raster, slower, allows logo) |
| copies | INT | |
| auto_cut | BOOLEAN | |
| open_drawer_after_print | BOOLEAN | |
| extra_feed_lines | INT | tear-off clearance |
| use_bold | BOOLEAN | |
| paper_size / orientation | VARCHAR / ENUM | A4 profiles only |
| company_name_text_size | ENUM | `small`, `medium`, `large` |
| body_text_size | ENUM | |
| print_original_duplicate | BOOLEAN | "Original / Duplicate / Triplicate" marking |
| repeat_header_all_pages | BOOLEAN | A4, multi-page |
| min_rows_in_item_table | INT | keeps the table from collapsing on short bills |
| amount_in_words_format | ENUM | `indian` (lakh/crore) or `international` |
| signature_text | TEXT | "Authorized Signatory" |
| signature_image_path | TEXT NULL | |
| footer_text | TEXT | |
| field_toggles | JSONB | everything below |

**`field_toggles` keys**, grouped as the reference app does:

- *Header* — `logo`, `company_name`, `address`, `email`, `phone`, `gstin`, `fssai`
- *Item table* — `s_no`, `hsn`, `uom`, `mrp`, `description`, `batch_no`, `exp_date`, `mfg_date`, `size`, `model_no`, `serial_no`
- *Totals* — `total_item_qty`, `amount_with_decimal`, `received_amount`, `balance_amount`, `party_current_balance`, `tax_details`, `you_saved`, `amount_grouping`, `amount_in_words`
- *Footer* — `description`, `terms_conditions`, `received_by`, `delivered_by`, `signature`, `payment_mode`, `acknowledgement`, `upi_qr`, `bank_details`, `loyalty_block`

> **Two profiles minimum, not one.** Counters print 80mm thermal; the office prints A4 for supplier-facing documents like purchase returns and GRNs. They share almost no settings, which is why `print_profiles` is a table and not columns on `devices`.

> `party_current_balance` should be **off** on retail bills and **on** for credit customers — printing "you owe ₹4,200" on a walk-in cash customer's receipt is confusing at best.

### `label_templates` [P1]
You print your own labels for repacked goods, which makes these **regulated declarations**, not decoration. Rule 6 of the Legal Metrology (Packaged Commodities) Rules plus FSSAI labelling requirements both apply.

| Column | Type | Notes |
|---|---|---|
| id | BIGSERIAL PK | |
| name | TEXT | |
| width_mm / height_mm | INT | |
| labels_per_row | INT | |
| printer_type | ENUM | `label`, `regular` |
| font_size_body / font_size_mrp | INT | MRP must be conspicuous |
| is_default | BOOLEAN | |
| field_layout | JSONB | position and visibility per field |

**Mandatory fields — cannot be switched off for a repacked food item:**

| Field | Source | Rule |
|---|---|---|
| Packer name & address | `stores.packer_name`, `packer_address` | Legal Metrology Rule 6 |
| Generic/common name | `products.generic_name` | e.g. "Wheat Flour", not "Chakki Fresh" |
| Net quantity | `product_batches` / `products.pack_weight` | standard SI units |
| Month & year of packing | `product_batches.packed_on` | full date if shelf life < 3 months |
| MRP | `products.mrp` | must read "inclusive of all taxes" |
| **Unit sale price** | computed | see rule below |
| FSSAI licence number | `stores.fssai_no` | 14 digits |
| Batch / lot number | `product_batches.batch_no` | traceability |
| Best before / use by | `product_batches.expiry_date` | |
| Veg / non-veg mark | `products.food_type` | green or brown dot symbol |
| Consumer care details | `stores.consumer_care_details` | |
| Storage instructions | `products.storage_instructions` | |
| Allergen declaration | `products.allergens` | |
| Barcode | `product_barcodes` | your internal Code 128 |

**Unit sale price rule** — the one people get wrong:
```
net quantity <  1 kg   →  price per gram
net quantity >= 1 kg   →  price per kilogram
net volume  <  1 L     →  price per millilitre
net volume  >= 1 L     →  price per litre
sold by count          →  price per unit
```
Rounded to two decimals. A 500 g packet at ₹95 prints **₹0.19 per g**; a 2 kg packet at ₹360 prints **₹180.00 per kg**. Compute it, never let anyone type it.

**Two more implementation rules:**

- **Block printing when data is missing.** If a repacked SKU has no generic name, allergen field or expiry, the label print should refuse rather than print a partial label. A missing declaration is the violation.
- **Never allow a sticker to overwrite MRP upward.** Stickers may only carry a *reduced* MRP, and must not cover the original declaration. Build the reprint flow so a corrected label can only lower the price, or you've built a tool for a Legal Metrology offence.

### New `products` columns this requires [P1]
`generic_name VARCHAR(60)`, `food_type ENUM(veg, non_veg, not_applicable)`, `allergens TEXT`, `storage_instructions TEXT`, `is_prepacked BOOLEAN`.

Seed the reference label sizes: 50×25 mm (2-up), 100×50 mm, 38×25 mm (2-up). At 50×25 mm you will **not** fit all mandatory declarations — plan on 100×50 mm for repacked food and keep the small sizes for shelf-edge and internal-SKU labels only.

### `label_print_jobs` [P2]
`id`, `product_id`, `repack_batch_id NULL`, `template_id`, `qty_printed`, `printed_by`, `printed_at`. Useful for reprints and for catching someone printing 500 labels for a 100-packet batch.

---

## K2. Messaging [P2]

The reference app's Transaction Message screen — auto-send a WhatsApp message when a document is saved. Genuinely useful for **supplier documents and credit customers**; pointless for 1,000 walk-in cash bills a day.

### `message_templates` [P2]
`id`, `txn_type`, `channel ENUM(whatsapp, sms)`, `header_text`, `body_template TEXT`, `footer_text`, `include_balance BOOLEAN`, `include_invoice_link BOOLEAN`, `include_payment_link BOOLEAN`, `attach_pdf BOOLEAN`, `auto_send BOOLEAN`, `is_active`.

Body uses placeholders: `{party_name}`, `{txn_number}`, `{net_amount}`, `{paid_amount}`, `{balance_amount}`, `{party_balance}`, `{due_date}`, `{shop_name}`.

### `message_log` [P2]
`id`, `txn_type`, `ref_table`, `ref_id`, `party_id NULL`, `employee_id NULL`, `channel`, `to_phone`, `rendered_body TEXT`, `attachment_path NULL`, `status ENUM(queued, sent, failed, skipped)`, `provider_message_id`, `error_text`, `queued_at`, `sent_at`.

Covers salary slips too — one log for every outbound message, so "did it actually go" is always answerable.

> **Which documents to auto-send:** purchase orders, purchase returns, payment receipts to suppliers, payment reminders, and salary slips. **Not** retail sale bills — the customer is standing there holding the printed receipt, and auto-messaging every walk-in will burn through API credits for nothing.

> WhatsApp needs a Business API account and template pre-approval, which takes time and isn't in your control. Ship SMS or manual share first; treat WhatsApp automation as phase 2 with its own line item.

---

## L. Sync & Audit

### `sync_outbox` [P1] — in each counter's SQLite
`id`, `entity_type`, `entity_uuid`, `payload JSONB`, `operation`, `created_at`, `attempts`, `last_attempt_at`, `last_error`, `status ENUM(pending, sent, failed, conflict)`.

Server dedupes on `entity_uuid` — the same bill pushed three times inserts once.

### `sync_state` [P1] — server-side
`device_id`, `entity_type`, `last_pulled_at`, `last_pushed_id`, `last_success_at`, `pending_count`.

### `audit_log` [P1]
`id`, `table_name`, `record_id`, `action ENUM(insert, update, delete)`, `old_values JSONB`, `new_values JSONB`, `employee_id`, `device_id`, `ip_address`, `created_at`.

Triggered on: `product_prices`, `stock_adjustments`, `transactions` (void/edit), `employees`, `role_permissions`, `parties` (credit limit).

### `backups` [P2]
`id`, `backup_path`, `backup_type ENUM(auto, manual, close_books)`, `size_bytes`, `started_at`, `completed_at`, `status`.

---

## The counter screen, mapped to tables

| POS control | Where it lands |
|---|---|
| Item search (name / code / HSN / MRP / price) | `products`, `product_barcodes` |
| Multiple bill tabs | `transactions.status='parked'` |
| Change Quantity [F2] | `transaction_lines.qty` |
| Item Discount [F3] | `transaction_lines.discount_pct/amount` |
| Change Unit [F6] | `transaction_lines.unit_id` + `conversion_factor` |
| Additional Charges [F8] | `transaction_charges` |
| Bill Discount [F9] | `transactions.bill_discount_amount` |
| Loyalty Points [F10] | `loyalty_transactions`, `parties.points_balance` |
| Customer search [F11] | `parties.phone` |
| Remarks [F12] | `transactions.remarks` |
| Full Breakup [Ctrl+F] | `transaction_tax_summary` |
| Amount Received / Change to Return | `transaction_payments.tendered_amount` / `change_amount` |
| Other/Credit Payments [Ctrl+M] | `transaction_payments` split + `party_ledger` |

> **Bill-level discount must be apportioned across tax groups before tax is computed.** A flat ₹50 off a bill containing 5% and 18% items has to be split pro-rata by taxable value, or your GST breakup won't tie out and GSTR-1 will be wrong. Apportion, then round per line, then tax the group.

---

## Design rules enforced in code

**1. One rounding function, one call site.**
```
line_taxable  = round(rate × qty ÷ (1 + total_rate/100), 2)   -- per line
group_taxable = Σ line_taxable                                 -- then sum
group_cgst    = round(group_taxable × cgst_rate/100, 2)        -- tax on the GROUP
```
Verified against the reference receipt: 106.67 + 41.91 = 148.58, × 2.5% = 3.71. ✓ Computing tax per line and summing gives 3.72 and the bill stops tying out.

**2. Stock changes only via `stock_ledger`.** No `UPDATE products SET qty`. Ever.

**3. Balances only via `party_ledger` / `account_ledger`.** Same rule. `current_balance` is a cache.

**4. Tax, price, name and HSN on a line are snapshots.** No joins when reprinting a six-month-old bill.

**5. Everything financial is append-only.** Void, don't delete. Reverse, don't edit.

**6. `product_kind='bulk'` can never appear on a sale line.** CHECK or trigger, not just UI.

**7. Numbers are allocated locally, validated centrally.** Counter C1 owns its series; the server rejects duplicates.

**8. A paid `salary_run` is immutable.** Day counts, rates and advance figures freeze on payment. Later attendance corrections adjust the *next* month, never a slip already issued.

**9. Every advance posts to `account_ledger`.** Cash handed to an employee is cash out of the drawer. If it only lands in `employee_advances`, day-close will never reconcile.

---

## Sizing at 1,000 bills/day

| Table | Rows/day | Rows/year |
|---|---|---|
| transactions | ~1,050 | 385K |
| transaction_lines | ~6,200 | 2.3M |
| transaction_tax_summary | ~2,000 | 730K |
| transaction_payments | ~1,200 | 440K |
| stock_ledger | ~7,000 | 2.6M |
| party_ledger | ~200 | 73K |
| daily_stock_snapshots | ~4,000 | 1.5M |

Comfortable for Postgres on a mini PC. Partition `transaction_lines` and `stock_ledger` by month from year two. BRIN indexes on `occurred_at` / `txn_datetime`.

---

## Counter SQLite subset

**Pulled down (read-only):** products, product_barcodes, product_prices (current), tax_slabs, hsn_codes, units, unit_conversions, parties (phone + name + points + balance), app_settings, print_profiles.

**Written locally:** transactions, transaction_lines, transaction_tax_summary, transaction_charges, transaction_payments, stock_ledger, loyalty_transactions, day_sessions, sync_outbox.

Counters never write to the product master. Price changes flow one way: office → server → counters.

---

## Appendix — Report catalogue

Build **one report framework** first: date range, filters (counter / cashier / party / category / location), sortable columns, print, Excel export. Then each report below is a query plus a column definition — roughly a day each. Built as bespoke screens instead, thirty reports will eat a third of the project.

### Sales
Daily & monthly sales · Sale register · Sale by item · Sale by category · Sale by counter · Sale by cashier · Hourly sales pattern · Item-wise discount · Bill-wise profit · Item-wise profit · Category-wise profit · **Sale return / credit note register**

### Stock
Stock summary · Stock summary by category · Stock detail (item ledger) · Item detail · Low stock to reorder · Stock valuation · **Batch-wise stock with expiry** · **Near-expiry alert list** · **Stock movement per item** · Rack-wise variance · Repack yield · Daily closing stock

### Purchase & parties
Purchase register · **GRN register by supplier** · **Purchase return / debit note register** · Party statement · All parties · Outstanding payables with ageing · Outstanding receivables · Party-wise profit & loss · Party report by item · Item report by party · Sale-purchase by party · Sale-purchase by party group

### Money
Day book · All transactions · Cash flow · Cash in hand · Bank statement · Expense register · Expense by category · Expense by item · Day close & cash variance by counter · **Operating Profit & Loss**

### Staff
Attendance summary · Late & overtime · Salary register · Advances outstanding · Salary paid history · Sales per cashier · Staff cost as % of sales

### GST
GSTR-1 · GSTR-3B summary · Sale summary by HSN · GST rate-wise summary · Tally export

> **One correction to an earlier statement.** I previously grouped Profit & Loss with Balance Sheet as "needs double-entry". That was wrong. An **operating P&L** — Sales − COGS − Expenses — is fully computable here: sales from `transactions`, COGS from `cost_rate` on lines, expenses from expense transactions. Only **Balance Sheet** and **Trial Balance** need a chart of accounts, because they need assets, liabilities and capital rather than trading activity.
>
> Give him the operating P&L. It's the report an owner actually opens, it's nearly free once the framework exists, and it makes the missing accounting module far easier to accept.

### Deliberately not built
Trial Balance · Balance Sheet · GSTR-9 · TDS/TCS returns · Form 27EQ · Loan statements · Fixed asset register

---

## Deliberately excluded from scope

From the reference app, skipped as wrong for a single-location grocery: TDS/TCS, Form 27EQ, GSTR-9, Loan Accounts, Fixed Assets, Multi-Firm, Multi-Currency, SAC reports, Services (as distinct from products), Estimates/Quotations, Composition Scheme, Other Income, Repeat Invoices.

Also skipped from Item Settings:
- **Serial No. / IMEI tracking** — for electronics dealers. No grocery SKU has one.
- **Party Wise Item Rate** — negotiated per-customer pricing. Retail sells at one price to everyone.
- **Manufacturing / BOM** — the repack module already does this job, and does it better for your case.
- **Model No. / Size** — apparel and hardware fields.

**Kept from the settings review, despite looking like enterprise noise:**

- **Reverse Charge** (`transactions.is_reverse_charge`) — buying from unregistered suppliers (loose-goods wholesaler, transport) puts GST liability on the buyer. Cheap now, painful to retrofit.
- **E-way bill number** — a field, not a module. Just store it for large-value inward movements.
- **Godown transfer** — you already have godown and rack locations, so the transfer document is small and it's what makes restocking auditable.
- **Discount during payments** — cash discount for early settlement is normal with credit suppliers.

**Accounting layer — decided: light ledger, no double-entry.** No Balance Sheet or Trial Balance. The schema delivers Day Book, Cash Flow, Party Statement, Item-wise and Bill-wise Profit, cash-in-hand and bank balances — without a chart of accounts or journal entries. Formal books are the CA's job, fed by Tally export. This removes roughly 25–30% of what a full accounting package would cost to build.

**Supplier payment — confirmed: both COD and credit terms.** `parties.payment_terms_days` NULL means pay-on-delivery; a value means credit. So `payment_allocations`, `transactions.due_date`, `payment_status` and the outstanding-payables report are all **P1**, not optional. `payment_reminders` moves to P1 as well — with credit suppliers, due-date tracking is the point of having the ledger at all.
