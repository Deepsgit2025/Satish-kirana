-- 005_stock_ledger.sql
--
-- The stock ledger and its derived cache — docs/schema.md section G.
--
--   stock_ledger   append-only, the truth about every movement
--   stock_on_hand  derived, trigger-maintained, rebuildable at any moment
--
-- Only those two. The rest of section G — transfers, adjustments, repacks,
-- cycle counts — are documents that post *into* this ledger, and each arrives
-- with the screen that creates it.
--
-- CLAUDE.md invariants 5, 6 and 8 all live here, and none of them is left to
-- convention:
--
--   Append-only is enforced by triggers that refuse UPDATE, DELETE and
--   TRUNCATE outright. A voided document posts a reversing row; it does not
--   edit the row it regrets.
--
--   stock_on_hand is never written by application code. The only things that
--   touch it are the ledger trigger and rebuild_stock_on_hand(), and the second
--   must always reproduce the first exactly — that equality is the only guard
--   against silent stock drift, which cannot be debugged after the fact.
--
-- location_id is a bare BIGINT. The locations table does not exist yet; the
-- foreign key lands with it, in 007_locations_receiving.sql. Same as
-- product_locations.location_id in 003_catalog.sql.
--
-- The migration runner wraps this file in a single transaction — no explicit
-- BEGIN/COMMIT here.


-- ---------------------------------------------------------------------------
-- Enumerated types
-- ---------------------------------------------------------------------------

CREATE TYPE stock_txn_type AS ENUM (
  'sale', 'sale_return',
  'purchase', 'purchase_return',
  'repack_out', 'repack_in',
  'adjustment',
  'transfer_out', 'transfer_in',
  'opening'
);


-- ---------------------------------------------------------------------------
-- Append-only enforcement
--
-- Statement-level, so a DELETE matching no rows still raises rather than
-- appearing to succeed, and so TRUNCATE — which row triggers never see — is
-- caught too. Reused by every append-only table: party_ledger, account_ledger,
-- employee_advances and loyalty_transactions all get these when they land.
-- ---------------------------------------------------------------------------

CREATE FUNCTION refuse_append_only_write() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    '% is append-only: % is not permitted. Post a reversing row instead.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

COMMENT ON FUNCTION refuse_append_only_write() IS
  'CLAUDE.md invariant 5. Attach as BEFORE UPDATE / DELETE / TRUNCATE, FOR EACH STATEMENT.';


-- ---------------------------------------------------------------------------
-- stock_ledger
--
-- One row per movement, signed. Everything about current stock is a sum over
-- this table; nothing else is authoritative.
-- ---------------------------------------------------------------------------

CREATE TABLE stock_ledger (
  id          BIGSERIAL PRIMARY KEY,
  product_id  BIGINT NOT NULL REFERENCES products (id),
  location_id BIGINT,
  txn_type    stock_txn_type NOT NULL,
  qty_delta   NUMERIC(12,3) NOT NULL CHECK (qty_delta <> 0),
  ref_table   VARCHAR(40) NOT NULL,
  ref_id      BIGINT NOT NULL,
  ref_line_id BIGINT,
  batch_id    BIGINT REFERENCES product_batches (id),
  cost_rate   NUMERIC(12,2) CHECK (cost_rate >= 0),
  device_id   BIGINT REFERENCES devices (id),
  employee_id BIGINT REFERENCES employees (id),
  occurred_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE stock_ledger IS
  'Append-only, enforced below. Never UPDATE, never DELETE (CLAUDE.md invariant 5). Stock is '
  'derived from this; a mutable quantity column would make shrinkage permanently uninvestigable.';
COMMENT ON COLUMN stock_ledger.location_id IS
  'NULL until locations are configured — opening stock in a shop with no racks yet still has to '
  'be tracked. FK added in 007_locations_receiving.sql.';
COMMENT ON COLUMN stock_ledger.qty_delta IS
  'Signed, in the product base unit. Negative leaves the shop. Zero is refused: it records '
  'nothing and is always a bug in the caller. The sign is not constrained by txn_type, because '
  'an adjustment or a transfer is legitimately either way.';
COMMENT ON COLUMN stock_ledger.ref_table IS
  'Which document caused this, with ref_id and ref_line_id. Both NOT NULL: a movement nobody '
  'can trace back to a document is exactly the movement someone will need to explain.';
COMMENT ON COLUMN stock_ledger.cost_rate IS
  'Landed cost at the moment of the movement, for COGS. Snapshotted, never joined for.';
COMMENT ON COLUMN stock_ledger.occurred_at IS
  'Business time — when it happened in the shop. Supplied by the caller, and the only one of the '
  'two that hourly and daily reports may group by.';
COMMENT ON COLUMN stock_ledger.recorded_at IS
  'Server insert time. Forced by trigger, never supplied, so a counter cannot claim to have '
  'recorded something earlier than it did. A bill rung at 18:02 during an outage and synced at '
  '18:40 carries both (CLAUDE.md invariant 11); the gap between them is what makes offline '
  'behaviour reportable at all. Collapsing these into one column loses that permanently.';

-- recorded_at is the server's own account of when it saw the row. A caller that
-- sets it is either confused or lying, and either way the value stops meaning
-- what every sync report will assume it means.
CREATE FUNCTION stamp_recorded_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.recorded_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_stock_ledger_recorded_at
BEFORE INSERT ON stock_ledger
FOR EACH ROW EXECUTE FUNCTION stamp_recorded_at();

CREATE TRIGGER trg_stock_ledger_no_update
BEFORE UPDATE ON stock_ledger
FOR EACH STATEMENT EXECUTE FUNCTION refuse_append_only_write();

CREATE TRIGGER trg_stock_ledger_no_delete
BEFORE DELETE ON stock_ledger
FOR EACH STATEMENT EXECUTE FUNCTION refuse_append_only_write();

CREATE TRIGGER trg_stock_ledger_no_truncate
BEFORE TRUNCATE ON stock_ledger
FOR EACH STATEMENT EXECUTE FUNCTION refuse_append_only_write();

CREATE INDEX idx_stock_ledger_product ON stock_ledger (product_id, occurred_at);
CREATE INDEX idx_stock_ledger_location ON stock_ledger (location_id, occurred_at);
CREATE INDEX idx_stock_ledger_ref ON stock_ledger (ref_table, ref_id);
CREATE INDEX idx_stock_ledger_batch ON stock_ledger (batch_id) WHERE batch_id IS NOT NULL;


-- ---------------------------------------------------------------------------
-- stock_on_hand
--
-- The cache. One row per product and location, including the unlocated one.
--
-- Keyed by a UNIQUE constraint rather than a primary key because location_id is
-- nullable and a primary key cannot hold NULL. NULLS NOT DISTINCT gives the
-- same guarantee — one row per pair, the unlocated pair included — where a
-- plain unique constraint would let unlocated rows multiply silently.
-- ---------------------------------------------------------------------------

CREATE TABLE stock_on_hand (
  product_id     BIGINT NOT NULL REFERENCES products (id),
  location_id    BIGINT,
  qty            NUMERIC(12,3) NOT NULL DEFAULT 0,
  last_ledger_id BIGINT REFERENCES stock_ledger (id),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT stock_on_hand_key UNIQUE NULLS NOT DISTINCT (product_id, location_id)
);

COMMENT ON TABLE stock_on_hand IS
  'Derived cache. Written only by the stock_ledger trigger and by rebuild_stock_on_hand(); '
  'never by application code (CLAUDE.md invariant 6).';
COMMENT ON COLUMN stock_on_hand.qty IS
  'Signed and deliberately unconstrained. Negative stock is a real state in a grocery — counts '
  'drift, and stop_sale_on_negative_stock is off by design because refusing to sell an item the '
  'customer is already holding is worse than the discrepancy.';
COMMENT ON COLUMN stock_on_hand.last_ledger_id IS
  'Highest ledger row folded into this figure. Lets a support session tell "this cache is '
  'behind" from "this cache is wrong".';

CREATE INDEX idx_stock_on_hand_location ON stock_on_hand (location_id);


-- ---------------------------------------------------------------------------
-- The cache trigger
--
-- One statement, so the ledger insert and the cache update commit together or
-- not at all (CLAUDE.md invariant 8).
-- ---------------------------------------------------------------------------

CREATE FUNCTION apply_stock_ledger_to_on_hand() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO stock_on_hand (product_id, location_id, qty, last_ledger_id)
  VALUES (NEW.product_id, NEW.location_id, NEW.qty_delta, NEW.id)
  ON CONFLICT ON CONSTRAINT stock_on_hand_key DO UPDATE
     SET qty            = stock_on_hand.qty + EXCLUDED.qty,
         -- GREATEST, not EXCLUDED: two counters can insert out of id order
         -- within the same second, and this figure must only ever move forward.
         last_ledger_id = GREATEST(stock_on_hand.last_ledger_id, EXCLUDED.last_ledger_id),
         updated_at     = now();

  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_stock_ledger_to_on_hand
AFTER INSERT ON stock_ledger
FOR EACH ROW EXECUTE FUNCTION apply_stock_ledger_to_on_hand();


-- ---------------------------------------------------------------------------
-- rebuild_stock_on_hand
--
-- Throws the cache away and sums the ledger from the beginning. Returns the
-- number of rows written.
--
-- This is the safety net of the whole system: whatever the trigger has been
-- doing incrementally, this reproduces from first principles, and a test
-- asserts the two agree exactly. Stock drift found six months late cannot be
-- reconstructed, so it has to be impossible to introduce rather than possible
-- to notice.
--
-- GROUP BY treats NULL locations as one group, which is the same rule the
-- NULLS NOT DISTINCT key uses. The two have to agree or a rebuild would split
-- rows the trigger had merged.
-- ---------------------------------------------------------------------------

CREATE FUNCTION rebuild_stock_on_hand() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  rows_written integer;
BEGIN
  DELETE FROM stock_on_hand;

  INSERT INTO stock_on_hand (product_id, location_id, qty, last_ledger_id)
  SELECT product_id, location_id, sum(qty_delta), max(id)
    FROM stock_ledger
   GROUP BY product_id, location_id;

  GET DIAGNOSTICS rows_written = ROW_COUNT;
  RETURN rows_written;
END;
$$;

COMMENT ON FUNCTION rebuild_stock_on_hand() IS
  'Rebuilds the cache from the ledger. Run deliberately, after investigating drift — never on a '
  'schedule, because a nightly rebuild would erase the evidence that the trigger is wrong.';


-- ---------------------------------------------------------------------------
-- stock_on_hand_drift
--
-- Cache against ledger, both directions: a cached figure that disagrees, a
-- cache row with no ledger behind it, and a ledger position the cache never
-- learned about. Expected to be empty at every moment.
--
-- Unlike product_tax_cache_drift, nothing here is ever expected and nothing
-- corrects it automatically — see docs/DECISIONS.md D32.
-- ---------------------------------------------------------------------------

CREATE VIEW stock_on_hand_drift AS
WITH ledger AS (
  SELECT product_id, location_id, sum(qty_delta) AS qty, max(id) AS last_ledger_id
    FROM stock_ledger
   GROUP BY product_id, location_id
)
SELECT COALESCE(c.product_id, l.product_id)   AS product_id,
       COALESCE(c.location_id, l.location_id) AS location_id,
       c.qty                                  AS cached_qty,
       l.qty                                  AS ledger_qty,
       COALESCE(c.qty, 0) - COALESCE(l.qty, 0) AS difference,
       c.last_ledger_id                       AS cached_last_ledger_id,
       l.last_ledger_id                       AS ledger_last_id
  FROM stock_on_hand c
  FULL JOIN ledger l
    ON l.product_id = c.product_id
   AND l.location_id IS NOT DISTINCT FROM c.location_id
 WHERE COALESCE(c.qty, 0) IS DISTINCT FROM COALESCE(l.qty, 0);

COMMENT ON VIEW stock_on_hand_drift IS
  'Expected empty. Anything here means the trigger and the ledger have diverged, which is the '
  'one failure in this system that cannot be reconstructed after the fact.';
