-- 003_catalog.sql
--
-- Catalog schema — docs/schema.md section D.
--
--   categories · hsn_codes · products · product_barcodes
--   product_prices · product_tax_assignments · product_locations · product_batches
--
-- tax_slabs is NOT touched here. Build-order step 3 originally asked for a
-- slab_group column so a product's current slab could be walked back to its
-- superseded predecessor. There is no such predecessor: the GST 2.0
-- rationalisation moved products between slabs, not slabs into slabs, so the
-- relation is many-to-many and belongs on the product. Tax history is
-- product_tax_assignments below — docs/DECISIONS.md D27.
--
-- Conventions (docs/schema.md header): snake_case, id BIGSERIAL PK, every table
-- carries created_at / updated_at / created_by. Money NUMERIC(12,2), quantity
-- NUMERIC(12,3), rates NUMERIC(5,2).
--
-- Three columns here point at tables that do not exist yet and are left
-- unconstrained until they do: product_locations.location_id (locations, in
-- 004_stock.sql), product_batches.grn_txn_id (transactions) and
-- product_batches.repack_batch_id (repack runs, R7). Each is commented at its
-- column. 001_foundation.sql does the same for devices.print_profile_id.
--
-- The migration runner wraps this file in a single transaction — no explicit
-- BEGIN/COMMIT here.


-- ---------------------------------------------------------------------------
-- Enumerated types
-- ---------------------------------------------------------------------------

CREATE TYPE product_kind AS ENUM ('standard', 'bulk', 'repacked');
CREATE TYPE product_status AS ENUM ('active', 'discontinued');
CREATE TYPE price_tax_type AS ENUM ('inclusive', 'exclusive');
CREATE TYPE barcode_type AS ENUM ('ean13', 'code128_internal', 'manual');
CREATE TYPE batch_status AS ENUM ('active', 'expired', 'exhausted', 'blocked');
CREATE TYPE food_type AS ENUM ('veg', 'non_veg', 'not_applicable');


-- ---------------------------------------------------------------------------
-- categories
--
-- Self-referencing tree. Shallow in practice — Grocery > Flour > Atta.
-- ---------------------------------------------------------------------------

CREATE TABLE categories (
  id         BIGSERIAL PRIMARY KEY,
  parent_id  BIGINT REFERENCES categories (id),
  name       VARCHAR(60) NOT NULL,
  name_hi    VARCHAR(60),
  path       TEXT,
  is_active  BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT REFERENCES employees (id),
  CONSTRAINT categories_not_own_parent CHECK (parent_id IS NULL OR parent_id <> id),
  CONSTRAINT categories_unique_name_per_parent UNIQUE (parent_id, name)
);

COMMENT ON COLUMN categories.name_hi IS 'Nullable — read as COALESCE(name_hi, name).';
COMMENT ON COLUMN categories.path IS
  'Materialised path of ancestor ids, "/3/17/", so "everything under Grocery" is one LIKE '
  'instead of a recursive CTE. Maintained by the office app on create and on move; the tree is '
  'small enough, and edited rarely enough, that a trigger would cost more than it saves.';

-- UNIQUE (parent_id, name) does not constrain roots, because NULL is never
-- equal to NULL. Two top-level "Grocery" categories would be a data-entry slip
-- nobody notices until a report quietly splits in two.
CREATE UNIQUE INDEX uq_categories_root_name ON categories (name) WHERE parent_id IS NULL;

CREATE INDEX idx_categories_parent ON categories (parent_id);


-- ---------------------------------------------------------------------------
-- hsn_codes
-- ---------------------------------------------------------------------------

CREATE TABLE hsn_codes (
  hsn_code            VARCHAR(8) PRIMARY KEY,
  description         TEXT,
  default_tax_slab_id BIGINT REFERENCES tax_slabs (id),
  is_active           BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          BIGINT REFERENCES employees (id),
  CONSTRAINT hsn_codes_six_digits CHECK (hsn_code ~ '^[0-9]{6}$')
);

COMMENT ON COLUMN hsn_codes.hsn_code IS
  'Six digits, enforced (CLAUDE.md invariant 18). Above 5 crore turnover GSTR-1 Table 12 and '
  'B2C HSN reporting both require six, and lengthening thousands of codes afterwards is '
  'miserable work. The column is VARCHAR(8) per docs/schema.md so the few goods carrying an '
  '8-digit code can be admitted by relaxing the CHECK, without a type change.';
COMMENT ON COLUMN hsn_codes.default_tax_slab_id IS
  'Suggested slab when a product is created against this code. products.tax_slab_id and the '
  'product_tax_assignments row are what actually apply — this only pre-fills the form.';


-- ---------------------------------------------------------------------------
-- products
--
-- The catalogue row. Price and tax carry a "current" column here for the
-- screens that only ever ask about now, with the dated truth in product_prices
-- and product_tax_assignments.
-- ---------------------------------------------------------------------------

CREATE TABLE products (
  id                      BIGSERIAL PRIMARY KEY,
  item_code               VARCHAR(30) NOT NULL UNIQUE,
  name                    TEXT NOT NULL,
  short_name              VARCHAR(30) NOT NULL,
  name_hi                 TEXT,
  short_name_hi           VARCHAR(30),
  category_id             BIGINT REFERENCES categories (id),
  hsn_code                VARCHAR(8) NOT NULL REFERENCES hsn_codes (hsn_code),
  tax_slab_id             BIGINT NOT NULL REFERENCES tax_slabs (id),
  base_unit_id            BIGINT NOT NULL REFERENCES units (id),
  secondary_unit_id       BIGINT REFERENCES units (id),
  product_kind            product_kind NOT NULL DEFAULT 'standard',
  is_sellable             BOOLEAN NOT NULL DEFAULT true,
  pack_weight             NUMERIC(10,3) CHECK (pack_weight > 0),
  mrp                     NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (mrp >= 0),
  sale_price              NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (sale_price >= 0),
  sale_price_tax_type     price_tax_type NOT NULL DEFAULT 'inclusive',
  purchase_price          NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (purchase_price >= 0),
  purchase_price_tax_type price_tax_type NOT NULL DEFAULT 'exclusive',
  wholesale_price         NUMERIC(12,2) CHECK (wholesale_price >= 0),
  wholesale_min_qty       NUMERIC(12,3) CHECK (wholesale_min_qty > 0),
  default_discount_pct    NUMERIC(5,2) NOT NULL DEFAULT 0
                            CHECK (default_discount_pct >= 0 AND default_discount_pct <= 100),
  reorder_level           NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
  track_batches           BOOLEAN NOT NULL DEFAULT false,
  tax_on_mrp              BOOLEAN NOT NULL DEFAULT false,
  shelf_life_days         INT CHECK (shelf_life_days > 0),
  custom_fields           JSONB NOT NULL DEFAULT '{}'::jsonb,
  tolerance_pct           NUMERIC(5,2) NOT NULL DEFAULT 0
                            CHECK (tolerance_pct >= 0 AND tolerance_pct <= 100),
  image_path              TEXT,
  generic_name            VARCHAR(60),
  food_type               food_type NOT NULL DEFAULT 'not_applicable',
  allergens               TEXT,
  storage_instructions    TEXT,
  is_prepacked            BOOLEAN NOT NULL DEFAULT false,
  status                  product_status NOT NULL DEFAULT 'active',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by              BIGINT REFERENCES employees (id),
  -- CLAUDE.md invariant 14: a bulk product is a purchasing and repacking unit,
  -- never something a cashier can ring up. The matching block on sale lines
  -- lands with transaction_lines; this is the half that can be stated now.
  CONSTRAINT products_bulk_is_not_sellable
    CHECK (product_kind <> 'bulk' OR is_sellable = false),
  CONSTRAINT products_units_distinct
    CHECK (secondary_unit_id IS NULL OR secondary_unit_id <> base_unit_id),
  CONSTRAINT products_wholesale_pair_complete
    CHECK ((wholesale_price IS NULL) = (wholesale_min_qty IS NULL))
);

COMMENT ON COLUMN products.item_code IS
  'Internal code, the reference app "Assign Code". Not a barcode — see product_barcodes.';
COMMENT ON COLUMN products.short_name IS
  'Prints on the 80mm receipt. Set by hand, not truncated from name.';
COMMENT ON COLUMN products.name_hi IS 'Nullable — read as COALESCE(name_hi, name).';
COMMENT ON COLUMN products.short_name_hi IS
  'Nullable — read as COALESCE(short_name_hi, short_name). A line carrying one of these is what '
  'forces the receipt into raster mode (CLAUDE.md invariant 21), so filling it has a cost.';
COMMENT ON COLUMN products.category_id IS
  'Nullable. A CSV import lands rows before the tree is tidy, and nothing downstream requires a '
  'category; the office screen asks for one. Tighten to NOT NULL if that stops being true.';
COMMENT ON COLUMN products.tax_slab_id IS
  'CACHE ONLY — the slab in force right now. Truth is product_tax_assignments, which is what any '
  'dated question resolves through (docs/DECISIONS.md D27). A future-dated reassignment does not '
  'touch this column until the nightly job moves it on the day it takes effect. And never join '
  'here when rendering a document: bill lines snapshot their own rates (invariant 2).';
COMMENT ON COLUMN products.sale_price IS 'Current price. History is product_prices.';
COMMENT ON COLUMN products.sale_price_tax_type IS
  'The field people forget. Retail prices are MRP-inclusive, supplier prices usually exclusive, '
  'and it is stored per price rather than globally — otherwise every margin figure is out by the '
  'GST rate.';
COMMENT ON COLUMN products.pack_weight IS
  'Net quantity in the base unit: 0.500 for a 500 g packet, and equally for a 500 ml bottle whose '
  'base unit is litres. The unit-sale-price rule on a label reads the base unit to choose g/kg '
  'against ml/L.';
COMMENT ON COLUMN products.purchase_price IS
  'Last or standard cost, so a margin figure needs no join to the GRNs. Lot cost is product_batches.';
COMMENT ON COLUMN products.track_batches IS
  'FALSE by default. On for perishables and everything repacked; pointless overhead for scrubbers.';
COMMENT ON COLUMN products.tax_on_mrp IS 'Abated valuation — "Calculate Tax based on MRP".';
COMMENT ON COLUMN products.tolerance_pct IS
  'Cycle-count variance allowed before a shortage is raised. 0 for packaged goods.';
COMMENT ON COLUMN products.image_path IS
  'Path on disk. Never the image itself (CLAUDE.md invariant 17) — it would inflate every dump.';
COMMENT ON COLUMN products.generic_name IS
  'Legal Metrology Rule 6: the common name, "Wheat Flour", not the brand "Chakki Fresh".';
COMMENT ON COLUMN products.food_type IS 'The green or brown dot on a repacked food label.';
COMMENT ON COLUMN products.is_prepacked IS
  'TRUE once this SKU is packed and labelled in-store, which makes the shop its packer and the '
  'label a regulated declaration (docs/DECISIONS.md D16).';

-- The label engine decides a label is complete, not the schema. These columns
-- stay nullable because a non-prepacked SKU has no use for them and a repacked
-- one is drafted before it is declared. Print refuses when a mandatory
-- declaration is missing — a partial label is the violation, a partial row is not.
COMMENT ON COLUMN products.allergens IS
  'Mandatory on a repacked food label. Absent, the label engine refuses to print.';
COMMENT ON COLUMN products.storage_instructions IS
  'Mandatory on a repacked food label. Absent, the label engine refuses to print.';

CREATE INDEX idx_products_category ON products (category_id);
CREATE INDEX idx_products_hsn ON products (hsn_code);
CREATE INDEX idx_products_tax_slab ON products (tax_slab_id);
CREATE INDEX idx_products_active_name ON products (name) WHERE status = 'active';


-- ---------------------------------------------------------------------------
-- product_barcodes
--
-- One product, many barcodes: the manufacturer EAN-13, plus an internal
-- Code 128 for repacks and for anything that arrives unbarcoded.
-- ---------------------------------------------------------------------------

CREATE TABLE product_barcodes (
  id           BIGSERIAL PRIMARY KEY,
  product_id   BIGINT NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  barcode      VARCHAR(48) NOT NULL UNIQUE,
  barcode_type barcode_type NOT NULL DEFAULT 'ean13',
  is_primary   BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   BIGINT REFERENCES employees (id)
);

COMMENT ON COLUMN product_barcodes.barcode IS
  'The hottest index in the system — every scan at both counters, around 1,000 bills a day, is '
  'one lookup on this column. Unique across all products: the same code on two SKUs makes the '
  'scanner ambiguous, and a cashier has no way to resolve that at the till.';

CREATE UNIQUE INDEX uq_product_barcodes_primary
  ON product_barcodes (product_id) WHERE is_primary;

CREATE INDEX idx_product_barcodes_product ON product_barcodes (product_id);


-- ---------------------------------------------------------------------------
-- product_prices
--
-- Effective-dated price history. products.sale_price / mrp are the cache.
-- ---------------------------------------------------------------------------

CREATE TABLE product_prices (
  id             BIGSERIAL PRIMARY KEY,
  product_id     BIGINT NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  sale_price     NUMERIC(12,2) NOT NULL CHECK (sale_price >= 0),
  mrp            NUMERIC(12,2) NOT NULL CHECK (mrp >= 0),
  tax_type       price_tax_type NOT NULL,
  effective_from TIMESTAMPTZ NOT NULL,
  effective_to   TIMESTAMPTZ,
  reason         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_by     BIGINT REFERENCES employees (id),
  CONSTRAINT product_prices_period_ordered
    CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT product_prices_one_start_per_product UNIQUE (product_id, effective_from)
);

COMMENT ON TABLE product_prices IS
  'Periods are half-open, [effective_from, effective_to): a row hands over at the exact instant '
  'the next begins, so there is no gap and no overlap to arbitrate.';
COMMENT ON COLUMN product_prices.changed_by IS
  'This table created_by, named for what it records — who moved the price. reason says why.';

-- A product has exactly one price in force. Two open rows is the failure that
-- makes two counters quote different prices for the same scan.
CREATE UNIQUE INDEX uq_product_prices_open
  ON product_prices (product_id) WHERE effective_to IS NULL;

CREATE INDEX idx_product_prices_lookup ON product_prices (product_id, effective_from DESC);


-- ---------------------------------------------------------------------------
-- product_tax_assignments
--
-- Which slab a product sits on, and when — docs/DECISIONS.md D27.
--
-- Same shape as product_prices, for the same reason: a rate change is a dated
-- event on a product, not an edit to a column. Resolution is
--
--     product + datetime -> the assignment in force -> its slab -> its rates
--
-- and the assignment is the authority on which slab, not products.tax_slab_id.
--
-- A row starting in the future *is* a pending reassignment. Build-order step 5
-- wants bulk changes to take an effective_from and apply on that date; inserting
-- the future row expresses that completely, so there is no pending-changes table
-- to build. The nightly job only advances the products.tax_slab_id cache.
-- ---------------------------------------------------------------------------

CREATE TABLE product_tax_assignments (
  id             BIGSERIAL PRIMARY KEY,
  product_id     BIGINT NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  tax_slab_id    BIGINT NOT NULL REFERENCES tax_slabs (id),
  effective_from TIMESTAMPTZ NOT NULL,
  effective_to   TIMESTAMPTZ,
  reason         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_by     BIGINT REFERENCES employees (id),
  CONSTRAINT product_tax_assignments_period_ordered
    CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT product_tax_assignments_one_start_per_product UNIQUE (product_id, effective_from)
);

COMMENT ON TABLE product_tax_assignments IS
  'Product-level tax history. Periods are half-open, [effective_from, effective_to). Never joined '
  'when rendering a document — bill lines snapshot their own rates (CLAUDE.md invariant 2).';
COMMENT ON COLUMN product_tax_assignments.effective_from IS
  'TIMESTAMPTZ, not DATE: resolution is by document datetime, and a bill rung at 23:58 the day '
  'before a change must not pick up the new rate. tax_slabs is dated by day because a government '
  'notification is; a change the shop makes to one product is not.';
COMMENT ON COLUMN product_tax_assignments.reason IS
  'Why the slab moved — "GST 2.0 rationalisation", "HSN corrected after audit". Read by whoever '
  'has to explain a rate on an old bill.';

-- One open assignment per product. Two would make the rate on the next scan
-- depend on row order.
CREATE UNIQUE INDEX uq_product_tax_assignments_open
  ON product_tax_assignments (product_id) WHERE effective_to IS NULL;

CREATE INDEX idx_product_tax_assignments_lookup
  ON product_tax_assignments (product_id, effective_from DESC);


-- ---------------------------------------------------------------------------
-- product_locations
--
-- Where a SKU is meant to live. locations arrives in 004_stock.sql.
-- ---------------------------------------------------------------------------

CREATE TABLE product_locations (
  id              BIGSERIAL PRIMARY KEY,
  product_id      BIGINT NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  location_id     BIGINT NOT NULL,
  is_primary_face BOOLEAN NOT NULL DEFAULT false,
  capacity        NUMERIC(12,3) CHECK (capacity > 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      BIGINT REFERENCES employees (id),
  CONSTRAINT product_locations_unique_pair UNIQUE (product_id, location_id)
);

COMMENT ON COLUMN product_locations.location_id IS
  'FK added in 004_stock.sql together with the locations table (build-order step 8).';
COMMENT ON COLUMN product_locations.is_primary_face IS
  'The shelf a customer picks it off, and the default a GRN put-away pre-fills so the common case '
  'is one keystroke (docs/DECISIONS.md D23).';
COMMENT ON COLUMN product_locations.capacity IS
  'How much the face holds. Drives replenishment lists.';

CREATE UNIQUE INDEX uq_product_locations_primary_face
  ON product_locations (product_id) WHERE is_primary_face;

CREATE INDEX idx_product_locations_location ON product_locations (location_id);


-- ---------------------------------------------------------------------------
-- product_batches
--
-- First-class lots. Without them there is no expiry report, and no way to trace
-- a write-off back to the GRN and the supplier it came from.
-- ---------------------------------------------------------------------------

CREATE TABLE product_batches (
  id              BIGSERIAL PRIMARY KEY,
  product_id      BIGINT NOT NULL REFERENCES products (id),
  batch_no        VARCHAR(30) NOT NULL,
  mfg_date        DATE,
  packed_on       DATE,
  expiry_date     DATE,
  repack_batch_id BIGINT,
  grn_txn_id      BIGINT,
  cost_rate       NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (cost_rate >= 0),
  mrp             NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (mrp >= 0),
  qty_received    NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (qty_received >= 0),
  qty_remaining   NUMERIC(12,3) NOT NULL DEFAULT 0,
  status          batch_status NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      BIGINT REFERENCES employees (id),
  CONSTRAINT product_batches_unique_no UNIQUE (product_id, batch_no),
  CONSTRAINT product_batches_expiry_after_mfg
    CHECK (mfg_date IS NULL OR expiry_date IS NULL OR expiry_date >= mfg_date)
);

COMMENT ON COLUMN product_batches.packed_on IS
  'Month and year of packing, a Legal Metrology Rule 6 declaration. Held as a full date because '
  'the rule requires one when shelf life is under three months.';
COMMENT ON COLUMN product_batches.mrp IS 'Per lot — MRP moves between deliveries.';
COMMENT ON COLUMN product_batches.qty_remaining IS
  'CACHE ONLY, derived from stock_ledger, which is append-only and is the truth (invariant 6). '
  'The trigger that maintains it lands with the ledger in build-order step 4.';
COMMENT ON COLUMN product_batches.repack_batch_id IS
  'Which repack run packed this lot. FK added with the repack module (R7).';
COMMENT ON COLUMN product_batches.grn_txn_id IS
  'Which purchase brought it in — the trace from a write-off back to a supplier. FK added with '
  'transactions (docs/schema.md section F).';

-- FEFO: when a tracked product is scanned the system silently picks the
-- nearest-expiry lot that still has stock (docs/DECISIONS.md D9). At 1,000
-- bills a day this runs on every scan of a tracked SKU, so it gets its own
-- index. NULLS LAST keeps undated lots behind dated ones.
CREATE INDEX idx_product_batches_fefo
  ON product_batches (product_id, expiry_date NULLS LAST)
  WHERE status = 'active' AND qty_remaining > 0;

CREATE INDEX idx_product_batches_expiring
  ON product_batches (expiry_date) WHERE status = 'active' AND expiry_date IS NOT NULL;

CREATE INDEX idx_product_batches_grn ON product_batches (grn_txn_id);


-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------

CREATE TRIGGER trg_categories_updated_at              BEFORE UPDATE ON categories              FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_hsn_codes_updated_at               BEFORE UPDATE ON hsn_codes               FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_products_updated_at                BEFORE UPDATE ON products                FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_product_barcodes_updated_at        BEFORE UPDATE ON product_barcodes        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_product_prices_updated_at          BEFORE UPDATE ON product_prices          FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_product_tax_assignments_updated_at BEFORE UPDATE ON product_tax_assignments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_product_locations_updated_at       BEFORE UPDATE ON product_locations       FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_product_batches_updated_at         BEFORE UPDATE ON product_batches         FOR EACH ROW EXECUTE FUNCTION set_updated_at();
