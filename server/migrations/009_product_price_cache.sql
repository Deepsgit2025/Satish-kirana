-- 009_product_price_cache.sql
--
-- Makes products.sale_price / products.mrp enforced caches of product_prices,
-- the way 004_product_tax_cache.sql did for products.tax_slab_id — docs/
-- DECISIONS.md D28, applied to the sibling cache it left behind.
--
-- Why now rather than with 004. Until the product master screen there was no way
-- to date a price change in the future: the importer writes every price with
-- effective_from = now(), so the cache and the history could not disagree for
-- longer than the transaction that wrote them. Bulk tax reassignment breaks
-- that. A rate change taking effect next month writes a product_tax_assignments
-- row and, when the operator passes the change on rather than absorbing it, a
-- product_prices row on the same date (build-order step 7). The tax half already
-- advances on the day. The price half had nothing to advance it, so the new
-- price would have been recorded, reported, and never charged — the counters
-- bill from products.sale_price.
--
-- The shape is 004's, for the reason 004 gives: a trigger cannot catch a
-- future-dated row coming due, because at that instant nothing writes; and a
-- nightly job alone would leave a change entered for today wrong until the small
-- hours, which at 1,000 bills a day is a full day of bills at the wrong price.
-- So both, plus a view for whatever neither caught, all reading one definition
-- of what is in force.
--
-- One difference from the tax cache, and it is not an oversight.
-- product_tax_assignments carries one column; product_prices carries three that
-- travel together — sale_price, mrp and tax_type. A product half-advanced would
-- price at the new figure against the old ceiling, so they move as a unit.
--
-- The migration runner wraps this file in a single transaction — no explicit
-- BEGIN/COMMIT here.


-- ---------------------------------------------------------------------------
-- product_price_at
--
-- The price in force for a product at an instant. Zero rows or one; two means
-- the history overlaps, which every caller here treats as a fault rather than a
-- choice to make.
--
-- Periods are half-open, [effective_from, effective_to), matching
-- product_tax_assignment_at exactly. A bill timestamped on the boundary takes
-- the new price and the new rate, or the two halves of one change would land on
-- different sides of the same second.
-- ---------------------------------------------------------------------------

CREATE FUNCTION product_price_at(p_product_id BIGINT, p_at TIMESTAMPTZ)
RETURNS SETOF product_prices
LANGUAGE sql STABLE AS $$
  SELECT *
    FROM product_prices
   WHERE product_id = p_product_id
     AND effective_from <= p_at
     AND (effective_to IS NULL OR effective_to > p_at);
$$;

COMMENT ON FUNCTION product_price_at(BIGINT, TIMESTAMPTZ) IS
  'The one definition of "the price in force at". The cache trigger, the nightly refresh and the '
  'drift view all go through it, so the period rule is written once — as product_tax_assignment_at '
  'does for the slab.';


-- ---------------------------------------------------------------------------
-- apply_product_price_cache
--
-- Points one product's price cache at whatever is in force this instant.
-- Returns TRUE when it actually moved, so a caller can count real changes.
--
-- A product with no price in force leaves the cache alone. sale_price and mrp
-- are NOT NULL with a DEFAULT 0, and writing zero over a real price because the
-- history is incomplete would put free goods on the shelf. A missing history is
-- a different fault from a stale cache; product_price_cache_drift reports it
-- either way.
-- ---------------------------------------------------------------------------

CREATE FUNCTION apply_product_price_cache(p_product_id BIGINT) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  in_force product_prices[];
BEGIN
  SELECT array_agg(pp)
    INTO in_force
    FROM product_price_at(p_product_id, now()) pp;

  IF in_force IS NULL THEN
    RETURN false;
  END IF;

  IF array_length(in_force, 1) > 1 THEN
    RAISE EXCEPTION
      'Product % has % prices in force at once; their periods must not overlap.',
      p_product_id, array_length(in_force, 1)
      USING ERRCODE = 'data_exception';
  END IF;

  UPDATE products
     SET sale_price          = in_force[1].sale_price,
         mrp                 = in_force[1].mrp,
         sale_price_tax_type = in_force[1].tax_type
   WHERE id = p_product_id
     AND (sale_price, mrp, sale_price_tax_type)
         IS DISTINCT FROM (in_force[1].sale_price, in_force[1].mrp, in_force[1].tax_type);

  RETURN FOUND;
END;
$$;


-- ---------------------------------------------------------------------------
-- The trigger — "what is in force now" changed
--
-- Fires on every write to the history, including the UPDATE that closes a row.
-- Recording a change dated next month leaves the cache alone, because the price
-- in force now is still the old one: the trigger recomputes rather than copying
-- whatever row was just written.
-- ---------------------------------------------------------------------------

CREATE FUNCTION sync_product_price_cache() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM apply_product_price_cache(OLD.product_id);
  END IF;

  -- Only re-run for NEW when it is a different product; on the ordinary UPDATE
  -- the OLD pass above has already covered it.
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.product_id IS DISTINCT FROM OLD.product_id) THEN
    PERFORM apply_product_price_cache(NEW.product_id);
  END IF;

  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_product_prices_sync_cache
AFTER INSERT OR UPDATE OR DELETE ON product_prices
FOR EACH ROW EXECUTE FUNCTION sync_product_price_cache();


-- ---------------------------------------------------------------------------
-- product_price_cache_drift
--
-- Every product whose price cache does not agree with its history. Two shapes
-- end up here and they are not the same fault:
--
--   in_force_price_id IS NOT NULL — a stale cache. The nightly refresh fixes
--     it. This is the normal overnight case: a future-dated price came due.
--
--   in_force_price_id IS NULL — the product has no price in force at all, so
--     there is nothing to reconcile against and the refresh leaves it. Rows
--     still listed after a refresh are that, and want a human.
--
-- Modelled on product_tax_cache_drift, for the reason given there: a cache
-- nobody reconciles is a cache that is quietly wrong, and nobody finds out from
-- the software.
-- ---------------------------------------------------------------------------

CREATE VIEW product_price_cache_drift AS
SELECT p.id              AS product_id,
       p.item_code,
       p.sale_price      AS cached_sale_price,
       p.mrp             AS cached_mrp,
       pp.id             AS in_force_price_id,
       pp.sale_price     AS in_force_sale_price,
       pp.mrp            AS in_force_mrp,
       pp.effective_from AS in_force_since
  FROM products p
  LEFT JOIN LATERAL product_price_at(p.id, now()) pp ON true
 WHERE (pp.sale_price, pp.mrp, pp.tax_type)
       IS DISTINCT FROM (p.sale_price, p.mrp, p.sale_price_tax_type);

COMMENT ON VIEW product_price_cache_drift IS
  'Products where products.sale_price / mrp and product_prices disagree. Expected to be empty. '
  'What the nightly job corrects, and what a test asserts on.';


-- ---------------------------------------------------------------------------
-- refresh_product_price_cache
--
-- The nightly pass. Advances every cache whose in-force price has moved on —
-- the future-dated changes coming due — and returns how many products moved, so
-- the job can log a figure rather than "done".
--
-- It deliberately does not touch products with no price in force. Those stay in
-- the drift view afterwards, which is how the job knows to escalate instead of
-- reporting a clean night.
-- ---------------------------------------------------------------------------

CREATE FUNCTION refresh_product_price_cache() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  moved integer;
BEGIN
  UPDATE products p
     SET sale_price          = pp.sale_price,
         mrp                 = pp.mrp,
         sale_price_tax_type = pp.tax_type
    FROM product_price_cache_drift d
    JOIN product_prices pp ON pp.id = d.in_force_price_id
   WHERE p.id = d.product_id;

  GET DIAGNOSTICS moved = ROW_COUNT;
  RETURN moved;
END;
$$;

COMMENT ON FUNCTION refresh_product_price_cache() IS
  'Nightly. Returns the number of products whose price moved. Anything left in '
  'product_price_cache_drift afterwards has no price in force and needs a human.';


-- ---------------------------------------------------------------------------
-- The check joins the health surface (docs/DECISIONS.md D30)
--
-- Third entry on the panel, and the second that corrects. It corrects for the
-- same reason product_tax_cache does: drift here is the expected overnight case
-- rather than evidence of a broken trigger, so fixing it destroys no evidence.
-- ---------------------------------------------------------------------------

INSERT INTO reconciliation_checks (key, description, run_every, corrects) VALUES
  ('product_price_cache',
   'products.sale_price / mrp against the price in force in product_prices. Corrects stale '
   'caches, which is the ordinary overnight case when a future-dated price change comes due — '
   'the price half of a bulk tax reassignment that was passed on rather than absorbed. Anything '
   'outstanding afterwards is a product with no price history at all.',
   INTERVAL '1 day', true);


-- Reconcile whatever is already here, so the cache is true from this migration
-- onwards rather than from the first write after it.
SELECT refresh_product_price_cache();


-- ---------------------------------------------------------------------------
-- Corrections to a frozen migration
--
-- 003_catalog.sql is applied, so its text cannot change (CLAUDE.md). The column
-- comments it left in the database can, and those are what a support session
-- reads through psql. Both said "Current price. History is product_prices",
-- which was true and did not say that writing the column directly is a bug.
-- ---------------------------------------------------------------------------

COMMENT ON COLUMN products.sale_price IS
  'CACHE of the product_prices row in force now, maintained by trg_product_prices_sync_cache and '
  'refresh_product_price_cache(). History is product_prices — never write this column directly.';
COMMENT ON COLUMN products.mrp IS
  'CACHE of the product_prices row in force now, maintained with sale_price. History is '
  'product_prices — never write this column directly. MRP per lot is product_batches.mrp.';
