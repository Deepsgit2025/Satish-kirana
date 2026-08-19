-- 001_foundation.sql
--
-- Foundation schema — docs/schema.md sections A and B.
--
--   stores · financial_years · devices · employees
--   roles · permissions · role_permissions · app_settings
--   units · unit_conversions · tax_slabs
--
-- tax_slabs belongs to section D and is created here rather than in
-- 003_catalog.sql because this migration seeds it: the GST 2.0 slabs and the
-- superseded pre-revision slabs have to exist before any catalogue row can
-- reference them. 003 extends it (build-order step 3, "tax slab changes").
--
-- Conventions (docs/schema.md header): snake_case, id BIGSERIAL PK, every table
-- carries created_at / updated_at / created_by. Money NUMERIC(12,2), quantity
-- NUMERIC(12,3), rates NUMERIC(5,2).
--
-- The migration runner wraps this file in a single transaction — no explicit
-- BEGIN/COMMIT here.


-- ---------------------------------------------------------------------------
-- Enumerated types
-- ---------------------------------------------------------------------------

CREATE TYPE business_type AS ENUM ('proprietorship', 'partnership', 'llp', 'pvt_ltd');
CREATE TYPE financial_year_status AS ENUM ('open', 'closed');
CREATE TYPE device_type AS ENUM ('counter', 'office', 'server');
CREATE TYPE pay_type AS ENUM ('daily', 'monthly');
CREATE TYPE employee_status AS ENUM ('active', 'inactive');
CREATE TYPE language_code AS ENUM ('en', 'hi');
CREATE TYPE setting_group AS ENUM ('general', 'transaction', 'item', 'party', 'tax');
CREATE TYPE setting_value_type AS ENUM ('string', 'integer', 'decimal', 'boolean', 'time', 'json');


-- ---------------------------------------------------------------------------
-- updated_at maintenance
--
-- Every table below carries updated_at; a trigger keeps it honest so no caller
-- can forget it.
-- ---------------------------------------------------------------------------

CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;


-- ---------------------------------------------------------------------------
-- roles / permissions / role_permissions
-- ---------------------------------------------------------------------------

CREATE TABLE roles (
  id          BIGSERIAL PRIMARY KEY,
  code        VARCHAR(30) NOT NULL UNIQUE,
  name        VARCHAR(60) NOT NULL,
  description TEXT,
  is_system   BOOLEAN NOT NULL DEFAULT false,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  BIGINT
);

COMMENT ON TABLE roles IS
  'Seeded with three starting roles so the system is usable on first login. They are
   editable configuration, not fixed rules — is_system stays false.';

CREATE TABLE permissions (
  id          BIGSERIAL PRIMARY KEY,
  key         VARCHAR(60) NOT NULL UNIQUE,
  module      VARCHAR(30) NOT NULL,
  description TEXT,
  is_system   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  BIGINT
);

COMMENT ON COLUMN permissions.key IS
  'String key such as bill.create. Never rendered — UI labels live in en.json / hi.json.';

CREATE TABLE role_permissions (
  role_id       BIGINT NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  permission_id BIGINT NOT NULL REFERENCES permissions (id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    BIGINT,
  PRIMARY KEY (role_id, permission_id)
);

CREATE INDEX idx_role_permissions_permission ON role_permissions (permission_id);


-- ---------------------------------------------------------------------------
-- employees
-- ---------------------------------------------------------------------------

CREATE TABLE employees (
  id                     BIGSERIAL PRIMARY KEY,
  emp_code               VARCHAR(20) NOT NULL UNIQUE,
  name                   VARCHAR(60) NOT NULL,
  phone                  VARCHAR(15),
  role_id                BIGINT REFERENCES roles (id),
  biometric_user_id      VARCHAR(20),
  pin_hash               TEXT,
  password_hash          TEXT,
  date_of_joining        DATE,
  pay_type               pay_type NOT NULL DEFAULT 'monthly',
  pay_rate               NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (pay_rate >= 0),
  overtime_rate_per_hour NUMERIC(12,2) CHECK (overtime_rate_per_hour >= 0),
  half_day_pay_pct       NUMERIC(5,2) NOT NULL DEFAULT 50
                           CHECK (half_day_pay_pct >= 0 AND half_day_pay_pct <= 100),
  opening_advance        NUMERIC(12,2) NOT NULL DEFAULT 0,
  advance_balance        NUMERIC(12,2) NOT NULL DEFAULT 0,
  preferred_language     language_code,
  status                 employee_status NOT NULL DEFAULT 'active',
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by             BIGINT REFERENCES employees (id)
);

COMMENT ON COLUMN employees.emp_code IS 'Prints as BAL/086430.';
COMMENT ON COLUMN employees.biometric_user_id IS
  'The ID stored inside the attendance device — not employees.id.';
COMMENT ON COLUMN employees.pay_rate IS
  'Current rate, per day or per month. History lives in employee_pay_rates.';
COMMENT ON COLUMN employees.advance_balance IS
  'CACHE ONLY. Truth is employee_advances, which is append-only.';
COMMENT ON COLUMN employees.preferred_language IS
  'NULL falls back to the app_settings.default_language value.';

-- One device user ID maps to one employee, or attendance punches cannot be
-- resolved. Employees without a biometric enrolment are exempt.
CREATE UNIQUE INDEX uq_employees_biometric_user_id
  ON employees (biometric_user_id) WHERE biometric_user_id IS NOT NULL;

CREATE INDEX idx_employees_role ON employees (role_id);
CREATE INDEX idx_employees_active ON employees (id) WHERE status = 'active';


-- ---------------------------------------------------------------------------
-- stores — the Business Profile
--
-- One row today. Everything here either prints on a document or identifies the
-- business to a regulator.
-- ---------------------------------------------------------------------------

CREATE TABLE stores (
  id                      BIGSERIAL PRIMARY KEY,
  code                    VARCHAR(8) NOT NULL UNIQUE,
  business_name           TEXT NOT NULL,
  legal_name              TEXT,
  business_type           business_type,
  business_category       VARCHAR(40),
  phone                   VARCHAR(15),
  alt_phone               VARCHAR(15),
  email                   TEXT,
  address_lines           TEXT,
  city                    VARCHAR(60),
  state                   VARCHAR(60),
  state_code              VARCHAR(2) CHECK (state_code ~ '^[0-9]{2}$'),
  pincode                 VARCHAR(6) CHECK (pincode ~ '^[0-9]{6}$'),
  logo_path               TEXT,
  signature_path          TEXT,
  books_beginning_date    DATE,
  gstin                   VARCHAR(15)
                            CHECK (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$'),
  fssai_no                VARCHAR(14) NOT NULL CHECK (fssai_no ~ '^[0-9]{14}$'),
  legal_metrology_reg_no  VARCHAR(30),
  packer_name             TEXT,
  packer_address          TEXT,
  consumer_care_details   TEXT,
  cin_no                  VARCHAR(21),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by              BIGINT
);

COMMENT ON COLUMN stores.code IS 'Embedded in bill numbers, e.g. 4521.';
COMMENT ON COLUMN stores.state_code IS
  'Decides CGST+SGST vs IGST. 23 = Madhya Pradesh.';
COMMENT ON COLUMN stores.fssai_no IS
  'NOT NULL by design. Every food business must declare its 14-digit FSSAI number '
  'on cash receipts, invoices and cash memos — there is no toggle to suppress it.';
COMMENT ON COLUMN stores.books_beginning_date IS
  'No transaction may be dated before this, or opening balances stop reconciling.';
COMMENT ON COLUMN stores.legal_metrology_reg_no IS
  'Packer registration. Nullable, but required before the repack module goes live.';


-- ---------------------------------------------------------------------------
-- financial_years
--
-- Numbering is scoped to the year, so this exists before the first bill.
-- ---------------------------------------------------------------------------

CREATE TABLE financial_years (
  id         BIGSERIAL PRIMARY KEY,
  code       VARCHAR(9) NOT NULL UNIQUE,
  start_date DATE NOT NULL,
  end_date   DATE NOT NULL,
  status     financial_year_status NOT NULL DEFAULT 'open',
  closed_at  TIMESTAMPTZ,
  closed_by  BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT,
  CONSTRAINT financial_years_dates_ordered CHECK (end_date > start_date),
  CONSTRAINT financial_years_closed_consistent
    CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  -- Two years covering the same day would give one bill two numbering scopes.
  CONSTRAINT financial_years_no_overlap
    EXCLUDE USING gist (daterange(start_date, end_date, '[]') WITH &&)
);

COMMENT ON COLUMN financial_years.code IS 'e.g. 2026-27.';


-- ---------------------------------------------------------------------------
-- devices
-- ---------------------------------------------------------------------------

CREATE TABLE devices (
  id               BIGSERIAL PRIMARY KEY,
  store_id         BIGINT NOT NULL REFERENCES stores (id),
  device_code      VARCHAR(8) NOT NULL UNIQUE,
  device_type      device_type NOT NULL,
  bill_prefix      VARCHAR(20),
  print_profile_id BIGINT,
  last_seen_at     TIMESTAMPTZ,
  is_active        BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by       BIGINT
);

COMMENT ON COLUMN devices.device_code IS 'C1, C2, OFFICE.';
COMMENT ON COLUMN devices.bill_prefix IS
  'e.g. 452104015. NULL on non-billing devices.';
COMMENT ON COLUMN devices.print_profile_id IS
  'FK added with print_profiles (docs/schema.md section K).';
COMMENT ON COLUMN devices.last_seen_at IS 'Health monitoring.';

CREATE INDEX idx_devices_store ON devices (store_id);


-- ---------------------------------------------------------------------------
-- B. Units
--
-- Replaces v1's uom ENUM: the repack flow buys in bags and sells in packets.
-- Hindi columns are nullable and fall back to English when blank.
-- ---------------------------------------------------------------------------

CREATE TABLE units (
  id            BIGSERIAL PRIMARY KEY,
  name          VARCHAR(40) NOT NULL UNIQUE,
  short_name    VARCHAR(10) NOT NULL UNIQUE,
  name_hi       VARCHAR(40),
  short_name_hi VARCHAR(10),
  is_system     BOOLEAN NOT NULL DEFAULT false,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    BIGINT
);

COMMENT ON COLUMN units.short_name IS 'Prints on the bill, e.g. Kg.';
COMMENT ON COLUMN units.name_hi IS 'Nullable — read as COALESCE(name_hi, name).';
COMMENT ON COLUMN units.short_name_hi IS
  'Nullable — read as COALESCE(short_name_hi, short_name).';
COMMENT ON COLUMN units.is_system IS
  'Seeded units. The UI must not offer to delete them.';

CREATE TABLE unit_conversions (
  id                BIGSERIAL PRIMARY KEY,
  base_unit_id      BIGINT NOT NULL REFERENCES units (id),
  secondary_unit_id BIGINT NOT NULL REFERENCES units (id),
  factor            NUMERIC(12,4) NOT NULL CHECK (factor > 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        BIGINT,
  CONSTRAINT unit_conversions_distinct_units CHECK (base_unit_id <> secondary_unit_id),
  CONSTRAINT unit_conversions_unique_pair UNIQUE (base_unit_id, secondary_unit_id)
);

COMMENT ON TABLE unit_conversions IS
  '1 BAG = 50 KG is base=KG, secondary=BAG, factor=50. Lets a GRN record "2 bags" '
  'while the ledger moves 100 kg. Conversions are store-specific, so none are seeded.';

CREATE INDEX idx_unit_conversions_secondary ON unit_conversions (secondary_unit_id);


-- ---------------------------------------------------------------------------
-- tax_slabs (docs/schema.md section D — see the file header)
--
-- Effective-dated. Superseded slabs are never deleted: a bill reprinted from
-- before a revision must show the rate that applied on its own date.
-- ---------------------------------------------------------------------------

CREATE TABLE tax_slabs (
  id             BIGSERIAL PRIMARY KEY,
  name           VARCHAR(30) NOT NULL,
  cgst_rate      NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (cgst_rate >= 0),
  sgst_rate      NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (sgst_rate >= 0),
  igst_rate      NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (igst_rate >= 0),
  cess_rate      NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (cess_rate >= 0),
  effective_from DATE NOT NULL,
  effective_to   DATE,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     BIGINT,
  CONSTRAINT tax_slabs_period_ordered
    CHECK (effective_to IS NULL OR effective_to >= effective_from),
  -- Intra-state halves must add up to the inter-state rate.
  CONSTRAINT tax_slabs_split_matches_igst CHECK (cgst_rate + sgst_rate = igst_rate),
  CONSTRAINT tax_slabs_unique_name_period UNIQUE (name, effective_from)
);

COMMENT ON TABLE tax_slabs IS
  'Never put rates on the product, and never join here when rendering a document — '
  'bill lines snapshot their own rates (CLAUDE.md invariant 2).';
COMMENT ON COLUMN tax_slabs.effective_to IS
  'NULL means in force. A closed period marks a superseded slab, which is kept forever.';
COMMENT ON COLUMN tax_slabs.cess_rate IS
  'GST 2.0 scrapped compensation cess on everything except tobacco. Expect zero.';

CREATE INDEX idx_tax_slabs_effective ON tax_slabs (effective_from, effective_to);


-- ---------------------------------------------------------------------------
-- app_settings
--
-- Typed key-value, grouped by the reference app's settings tabs. Seeded with
-- the full key catalogue below so nothing gets lost; values are runtime
-- configuration and are expected to be edited from the office.
-- ---------------------------------------------------------------------------

CREATE TABLE app_settings (
  id             BIGSERIAL PRIMARY KEY,
  key            VARCHAR(60) NOT NULL UNIQUE,
  setting_group  setting_group NOT NULL,
  value_type     setting_value_type NOT NULL,
  value          TEXT,
  default_value  TEXT,
  description    TEXT,
  is_system      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     BIGINT
);

COMMENT ON COLUMN app_settings.value IS
  'NULL means unconfigured — the caller falls back to default_value, then to code.';
COMMENT ON COLUMN app_settings.description IS
  'Developer note. Not user-facing: UI strings live in en.json / hi.json.';

CREATE INDEX idx_app_settings_group ON app_settings (setting_group);


-- ---------------------------------------------------------------------------
-- Deferred foreign keys
--
-- created_by (and financial_years.closed_by) point at employees, which several
-- of these tables precede. Added here now every table exists.
-- ---------------------------------------------------------------------------

ALTER TABLE roles            ADD CONSTRAINT roles_created_by_fkey            FOREIGN KEY (created_by) REFERENCES employees (id);
ALTER TABLE permissions      ADD CONSTRAINT permissions_created_by_fkey      FOREIGN KEY (created_by) REFERENCES employees (id);
ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_created_by_fkey FOREIGN KEY (created_by) REFERENCES employees (id);
ALTER TABLE stores           ADD CONSTRAINT stores_created_by_fkey           FOREIGN KEY (created_by) REFERENCES employees (id);
ALTER TABLE financial_years  ADD CONSTRAINT financial_years_created_by_fkey  FOREIGN KEY (created_by) REFERENCES employees (id);
ALTER TABLE financial_years  ADD CONSTRAINT financial_years_closed_by_fkey   FOREIGN KEY (closed_by)  REFERENCES employees (id);
ALTER TABLE devices          ADD CONSTRAINT devices_created_by_fkey          FOREIGN KEY (created_by) REFERENCES employees (id);
ALTER TABLE units            ADD CONSTRAINT units_created_by_fkey            FOREIGN KEY (created_by) REFERENCES employees (id);
ALTER TABLE unit_conversions ADD CONSTRAINT unit_conversions_created_by_fkey FOREIGN KEY (created_by) REFERENCES employees (id);
ALTER TABLE tax_slabs        ADD CONSTRAINT tax_slabs_created_by_fkey        FOREIGN KEY (created_by) REFERENCES employees (id);
ALTER TABLE app_settings     ADD CONSTRAINT app_settings_created_by_fkey     FOREIGN KEY (created_by) REFERENCES employees (id);


-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------

CREATE TRIGGER trg_roles_updated_at            BEFORE UPDATE ON roles            FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_permissions_updated_at      BEFORE UPDATE ON permissions      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_role_permissions_updated_at BEFORE UPDATE ON role_permissions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_employees_updated_at        BEFORE UPDATE ON employees        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_stores_updated_at           BEFORE UPDATE ON stores           FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_financial_years_updated_at  BEFORE UPDATE ON financial_years  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_devices_updated_at          BEFORE UPDATE ON devices          FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_units_updated_at            BEFORE UPDATE ON units            FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_unit_conversions_updated_at BEFORE UPDATE ON unit_conversions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_tax_slabs_updated_at        BEFORE UPDATE ON tax_slabs        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_app_settings_updated_at     BEFORE UPDATE ON app_settings     FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ===========================================================================
-- SEED DATA
-- ===========================================================================


-- --- units -----------------------------------------------------------------
-- Hindi names are supplied for the system units because they are fixed
-- vocabulary; per-product Hindi names stay optional.

INSERT INTO units (name, short_name, name_hi, short_name_hi, is_system) VALUES
  ('PIECES',      'Pcs',     'नग',        'नग',      true),
  ('KILOGRAMS',   'Kg',      'किलोग्राम',  'किग्रा',   true),
  ('GRAMS',       'Gm',      'ग्राम',      'ग्रा',     true),
  ('LITRES',      'Ltr',     'लीटर',       'ली',      true),
  ('MILLILITRES', 'Ml',      'मिलीलीटर',   'मिली',    true),
  ('BOX',         'Box',     'डिब्बा',     'डिब्बा',   true),
  ('BAG',         'Bag',     'बोरी',       'बोरी',    true),
  ('PACKET',      'Packet',  'पैकेट',      'पैकेट',    true),
  ('DOZEN',       'Dozen',   'दर्जन',      'दर्जन',    true),
  ('BUNDLE',      'Bundle',  'बंडल',       'बंडल',     true),
  ('CARTON',      'Carton',  'कार्टन',     'कार्टन',   true),
  ('QUINTAL',     'Quintal', 'क्विंटल',    'क्विं',    true);


-- --- tax_slabs -------------------------------------------------------------
--
-- Current slabs, from the GST 2.0 rationalisation of 22 Sep 2025.

INSERT INTO tax_slabs (name, cgst_rate, sgst_rate, igst_rate, cess_rate, effective_from, effective_to, is_active) VALUES
  ('GST 0%',   0.00,  0.00,  0.00, 0.00, DATE '2025-09-22', NULL, true),
  ('GST 5%',   2.50,  2.50,  5.00, 0.00, DATE '2025-09-22', NULL, true),
  ('GST 18%',  9.00,  9.00, 18.00, 0.00, DATE '2025-09-22', NULL, true),
  ('GST 40%', 20.00, 20.00, 40.00, 0.00, DATE '2025-09-22', NULL, true);

-- Superseded slabs. The 12% and 28% rates were abolished on 22 Sep 2025; these
-- rows are closed the day before, never deleted. A bill dated inside their
-- period must reprint at the rate that applied then — that is the whole point
-- of effective-dating. effective_from is 1 Jul 2017, GST commencement.

INSERT INTO tax_slabs (name, cgst_rate, sgst_rate, igst_rate, cess_rate, effective_from, effective_to, is_active) VALUES
  ('GST 12%',  6.00,  6.00, 12.00, 0.00, DATE '2017-07-01', DATE '2025-09-21', false),
  ('GST 28%', 14.00, 14.00, 28.00, 0.00, DATE '2017-07-01', DATE '2025-09-21', false);


-- --- permissions -----------------------------------------------------------
-- The key vocabulary. Roles and their grants follow below.

INSERT INTO permissions (key, module, description) VALUES
  ('bill.create',      'bill',     'Ring up and save a sale bill.'),
  ('bill.void',        'bill',     'Void a bill, posting reversing ledger rows.'),
  ('price.edit',       'price',    'Override the price on a line at billing time.'),
  ('stock.adjust',     'stock',    'Post a stock adjustment.'),
  ('purchase.create',  'purchase', 'Record a purchase or GRN.'),
  ('expense.create',   'expense',  'Record an expense.'),
  ('report.view_all',  'report',   'View reports across all users, not just own.'),
  ('daybook.view',     'daybook',  'Open the Day Book.');


-- --- roles and grants ------------------------------------------------------
-- Three starting roles so the system is usable on first login, rather than
-- someone hand-building a permission matrix under time pressure on day one.
-- is_system is false: these are editable configuration, not fixed rules.
--
-- Cashier is deliberately bill.create and nothing else — no price.edit, no
-- bill.void. Profit visibility is not in the permission vocabulary yet; when
-- billing lands it needs its own key rather than relying on the global
-- show_profit_while_billing toggle (docs/schema.md section A).

INSERT INTO roles (code, name, description, is_system) VALUES
  ('cashier',    'Cashier',    'Rings up bills. No price override, no void.',        false),
  ('supervisor', 'Supervisor', 'Cashier, plus voiding bills and stock adjustments.', false),
  ('owner',      'Owner',      'Full access.',                                       false);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p
    ON (r.code = 'cashier'    AND p.key IN ('bill.create'))
    OR (r.code = 'supervisor' AND p.key IN ('bill.create', 'bill.void', 'stock.adjust'))
    OR (r.code = 'owner')
 WHERE r.code IN ('cashier', 'supervisor', 'owner');


-- --- app_settings ----------------------------------------------------------
-- The full key catalogue from docs/schema.md section A, so nothing is lost
-- when the settings screens get built. Values are conservative defaults and
-- are expected to be reviewed with the owner before go-live; keys that are
-- genuinely store-specific are seeded NULL.

INSERT INTO app_settings (key, setting_group, value_type, value, default_value, description) VALUES
  -- General
  ('decimal_places',               'general', 'integer', '2',     '2',     'Decimal places shown for money.'),
  ('default_language',             'general', 'string',  'en',    'en',    'en or hi. Fallback when employees.preferred_language is NULL.'),
  ('enable_passcode',              'general', 'boolean', 'false', 'false', NULL),
  ('stop_sale_on_negative_stock',  'general', 'boolean', 'false', 'false', 'OFF by design: grocery counts drift, and a hard block refuses to sell an item the customer is already holding. Warn instead.'),
  ('block_new_items_from_txn',     'general', 'boolean', 'false', 'false', NULL),
  ('block_new_parties_from_txn',   'general', 'boolean', 'false', 'false', NULL),
  ('audit_trail_enabled',          'general', 'boolean', 'true',  'true',  NULL),
  ('auto_backup_enabled',          'general', 'boolean', 'true',  'true',  NULL),
  ('backup_time',                  'general', 'time',    '23:30', '23:30', 'Nightly dump, after close.'),
  ('godown_transfer_enabled',      'general', 'boolean', 'false', 'false', NULL),

  -- Transaction
  ('round_off_enabled',            'transaction', 'boolean', 'true',    'true',    'round_off is a stored column, never computed at display time.'),
  ('round_off_mode',               'transaction', 'string',  'nearest', 'nearest', 'One of nearest, up, down.'),
  ('round_off_to',                 'transaction', 'decimal', '1.00',    '1.00',    'Rounding increment in rupees.'),
  ('add_time_on_transactions',     'transaction', 'boolean', 'true',    'true',    'Required: occurred_at carries business time.'),
  ('cash_sale_by_default',         'transaction', 'boolean', 'true',    'true',    NULL),
  ('billing_name_of_parties',      'transaction', 'boolean', 'false',   'false',   NULL),
  ('customer_po_details',          'transaction', 'boolean', 'false',   'false',   NULL),
  ('show_last_5_sale_prices',      'transaction', 'boolean', 'true',    'true',    NULL),
  ('show_last_5_purchase_prices',  'transaction', 'boolean', 'true',    'true',    NULL),
  ('free_item_quantity',           'transaction', 'boolean', 'false',   'false',   NULL),
  ('eway_bill_enabled',            'transaction', 'boolean', 'false',   'false',   'B2C shop, out of scope.'),
  ('quick_entry',                  'transaction', 'boolean', 'false',   'false',   NULL),
  ('skip_invoice_preview',         'transaction', 'boolean', 'true',    'true',    'Counter throughput: a preview costs a keystroke on every bill.'),
  ('passcode_for_txn_edit_delete', 'transaction', 'boolean', 'true',    'true',    NULL),
  ('discount_during_payments',     'transaction', 'boolean', 'false',   'false',   NULL),
  ('show_profit_while_billing',    'transaction', 'boolean', 'false',   'false',   'OFF globally. A cashier seeing margin on every line is a leak. Gate it by role permission, not just this toggle.'),
  ('billing_type',                 'transaction', 'string',  'full',    'full',    'One of lite, full.'),

  -- Item
  ('barcode_scan',                 'item', 'boolean', 'true',  'true',  NULL),
  ('direct_barcode_scan',          'item', 'boolean', 'true',  'true',  NULL),
  ('show_low_stock_dialog',        'item', 'boolean', 'true',  'true',  NULL),
  ('default_unit_id',              'item', 'integer', NULL,    NULL,    'Set below from the seeded Pcs unit.'),
  ('item_wise_tax',                'item', 'boolean', 'true',  'true',  NULL),
  ('item_wise_discount',           'item', 'boolean', 'true',  'true',  NULL),
  ('update_sale_price_from_txn',   'item', 'boolean', 'false', 'false', NULL),
  ('internal_barcode_prefix',      'item', 'string',  NULL,    NULL,    'In-store Code 128 prefix. Store-specific, set at go-live.'),
  ('low_stock_alert',              'item', 'boolean', 'true',  'true',  NULL),

  -- Party
  ('party_grouping',               'party', 'boolean', 'false', 'false', NULL),
  ('shipping_address',             'party', 'boolean', 'false', 'false', NULL),
  ('manage_party_status',          'party', 'boolean', 'false', 'false', NULL),
  ('payment_reminder_enabled',     'party', 'boolean', 'false', 'false', NULL),
  ('payment_reminder_days',        'party', 'integer', '7',     '7',     'Days after the due date before a reminder is raised.'),
  ('loyalty_enabled',              'party', 'boolean', 'false', 'false', NULL),
  ('points_earn_rate',             'party', 'decimal', NULL,    NULL,    'Store-specific, set when loyalty is switched on.'),
  ('points_redeem_value',          'party', 'decimal', NULL,    NULL,    'Store-specific, set when loyalty is switched on.'),

  -- Tax
  ('gst_enabled',                  'tax', 'boolean', 'true',  'true',  NULL),
  ('hsn_enabled',                  'tax', 'boolean', 'true',  'true',  'HSN codes are 6 digits throughout.'),
  ('cess_on_item',                 'tax', 'boolean', 'false', 'false', 'GST 2.0 scrapped cess on everything except tobacco.'),
  ('reverse_charge_enabled',       'tax', 'boolean', 'false', 'false', NULL),
  ('place_of_supply_enabled',      'tax', 'boolean', 'false', 'false', 'B2C, single state.');

UPDATE app_settings
   SET value         = (SELECT id::text FROM units WHERE short_name = 'Pcs'),
       default_value = (SELECT id::text FROM units WHERE short_name = 'Pcs')
 WHERE key = 'default_unit_id';
