-- 004_product_tax_cache.sql
--
-- Makes products.tax_slab_id an enforced cache of product_tax_assignments
-- rather than a documented one — docs/DECISIONS.md D28.
--
-- 003_catalog.sql marked the column CACHE ONLY in a comment. A comment does not
-- survive contact with a bulk edit screen, and two sources of truth with nothing
-- reconciling them is how a product ends up billing at 5% while every report
-- says 18%. This migration is separate rather than folded into 003 because 003
-- has been applied, which freezes it (CLAUDE.md).
--
-- Neither mechanism below is sufficient alone.
--
--   A trigger cannot do it. The case that matters most is a reassignment dated
--   in the future, and at the instant it comes due *nothing writes* — the clock
--   passes midnight and no INSERT, UPDATE or DELETE fires anywhere. There is
--   nothing to hook.
--
--   The nightly job cannot do it either. A change entered to take effect
--   immediately would sit wrong until the small hours, and at 1,000 bills a day
--   that is a full day of bills at the wrong rate.
--
-- So the trigger handles "in force now changed", the job handles "the clock
-- moved on", and the view reports whatever neither caught. All three read
-- product_tax_assignment_at(), which is the single definition of what is in
-- force at an instant; the TypeScript resolver calls it too, so the half-open
-- period rule cannot drift between the trigger, the job and the till.
--
-- Numbering: this took 004, so stock is 005_stock.sql. Three comments in
-- 003_catalog.sql still point at 004_stock.sql and cannot be corrected there.
-- The one that support reads through psql is restated at the end of this file.
--
-- The migration runner wraps this file in a single transaction — no explicit
-- BEGIN/COMMIT here.


-- ---------------------------------------------------------------------------
-- product_tax_assignment_at
--
-- The assignment in force for a product at an instant. Zero rows or one; two
-- means the history overlaps, which every caller here treats as a fault rather
-- than a choice to make.
--
-- Periods are half-open, [effective_from, effective_to): the row that ends hands
-- over at the exact instant the next begins, so a bill timestamped on the
-- boundary belongs to the new assignment and to nothing else.
-- ---------------------------------------------------------------------------

CREATE FUNCTION product_tax_assignment_at(p_product_id BIGINT, p_at TIMESTAMPTZ)
RETURNS SETOF product_tax_assignments
LANGUAGE sql STABLE AS $$
  SELECT *
    FROM product_tax_assignments
   WHERE product_id = p_product_id
     AND effective_from <= p_at
     AND (effective_to IS NULL OR effective_to > p_at);
$$;

COMMENT ON FUNCTION product_tax_assignment_at(BIGINT, TIMESTAMPTZ) IS
  'The one definition of "in force at". The cache trigger, the nightly refresh, the drift view '
  'and the TypeScript resolver all go through it, so the period rule is written once.';


-- ---------------------------------------------------------------------------
-- apply_product_tax_slab_cache
--
-- Points one product's cache at whatever is in force this instant. Returns TRUE
-- when the cache actually moved, so a caller can count real changes.
--
-- A product with no assignment in force leaves the cache alone: the column is
-- NOT NULL and has to hold something, and a missing history is a different
-- fault from a stale cache. product_tax_cache_drift reports it either way.
-- ---------------------------------------------------------------------------

CREATE FUNCTION apply_product_tax_slab_cache(p_product_id BIGINT) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  in_force BIGINT[];
BEGIN
  SELECT array_agg(a.tax_slab_id)
    INTO in_force
    FROM product_tax_assignment_at(p_product_id, now()) a;

  IF in_force IS NULL THEN
    RETURN false;
  END IF;

  IF array_length(in_force, 1) > 1 THEN
    RAISE EXCEPTION
      'Product % has % tax assignments in force at once; their periods must not overlap.',
      p_product_id, array_length(in_force, 1)
      USING ERRCODE = 'data_exception';
  END IF;

  UPDATE products
     SET tax_slab_id = in_force[1]
   WHERE id = p_product_id
     AND tax_slab_id IS DISTINCT FROM in_force[1];

  RETURN FOUND;
END;
$$;


-- ---------------------------------------------------------------------------
-- The trigger — "what is in force now" changed
--
-- Fires on every write to the history, including the UPDATE that closes a row.
-- Recording a change dated next month leaves the cache alone, because the
-- assignment in force *now* is still the old one: the trigger recomputes rather
-- than copying whatever row was just written.
-- ---------------------------------------------------------------------------

CREATE FUNCTION sync_product_tax_slab_cache() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM apply_product_tax_slab_cache(OLD.product_id);
  END IF;

  -- Only re-run for NEW when it is a different product; on the ordinary UPDATE
  -- the OLD pass above has already covered it.
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.product_id IS DISTINCT FROM OLD.product_id) THEN
    PERFORM apply_product_tax_slab_cache(NEW.product_id);
  END IF;

  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_product_tax_assignments_sync_cache
AFTER INSERT OR UPDATE OR DELETE ON product_tax_assignments
FOR EACH ROW EXECUTE FUNCTION sync_product_tax_slab_cache();


-- ---------------------------------------------------------------------------
-- product_tax_cache_drift
--
-- Every product whose cache does not agree with its history. Two shapes end up
-- here and they are not the same fault:
--
--   in_force_tax_slab_id IS NOT NULL — a stale cache. The nightly refresh fixes
--     it. This is the normal overnight case: a future-dated change came due.
--
--   in_force_tax_slab_id IS NULL — the product has no assignment in force at
--     all, so there is nothing to reconcile against and the refresh leaves it.
--     Rows still listed after a refresh are that, and want a human.
--
-- Modelled on the stock_on_hand rebuild check (CLAUDE.md invariant 22): a cache
-- nobody reconciles is a cache that is quietly wrong, and nobody finds out from
-- the software.
-- ---------------------------------------------------------------------------

CREATE VIEW product_tax_cache_drift AS
SELECT p.id             AS product_id,
       p.item_code,
       p.tax_slab_id    AS cached_tax_slab_id,
       a.tax_slab_id    AS in_force_tax_slab_id,
       a.effective_from AS in_force_since
  FROM products p
  LEFT JOIN LATERAL product_tax_assignment_at(p.id, now()) a ON true
 WHERE a.tax_slab_id IS DISTINCT FROM p.tax_slab_id;

COMMENT ON VIEW product_tax_cache_drift IS
  'Products where products.tax_slab_id and product_tax_assignments disagree. Expected to be '
  'empty. What the nightly job corrects, and what a test asserts on.';


-- ---------------------------------------------------------------------------
-- refresh_product_tax_slab_cache
--
-- The nightly pass. Advances every cache whose in-force assignment has moved on
-- — the future-dated reassignments coming due — and returns how many products
-- moved, so the job can log a figure rather than "done".
--
-- It deliberately does not touch products with no assignment in force. Those
-- stay in the drift view afterwards, which is how the job knows to escalate
-- instead of reporting a clean night.
-- ---------------------------------------------------------------------------

CREATE FUNCTION refresh_product_tax_slab_cache() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  moved integer;
BEGIN
  UPDATE products p
     SET tax_slab_id = d.in_force_tax_slab_id
    FROM product_tax_cache_drift d
   WHERE p.id = d.product_id
     AND d.in_force_tax_slab_id IS NOT NULL;

  GET DIAGNOSTICS moved = ROW_COUNT;
  RETURN moved;
END;
$$;

COMMENT ON FUNCTION refresh_product_tax_slab_cache() IS
  'Nightly. Returns the number of products whose slab moved. Anything left in '
  'product_tax_cache_drift afterwards has no assignment in force and needs a human.';


-- Reconcile whatever is already here, so the cache is true from this migration
-- onwards rather than from the first write after it.
SELECT refresh_product_tax_slab_cache();


-- ---------------------------------------------------------------------------
-- Correction to a frozen migration
--
-- 003_catalog.sql is applied, so its text cannot change (CLAUDE.md). The column
-- comment it left in the database can, and this is the one a support session
-- reads through psql.
-- ---------------------------------------------------------------------------

COMMENT ON COLUMN product_locations.location_id IS
  'FK added in 005_stock.sql together with the locations table (build-order step 8). '
  '003_catalog.sql says 004 — that number went to 004_product_tax_cache.sql.';
