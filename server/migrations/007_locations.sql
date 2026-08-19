-- 007_locations.sql
--
-- The locations master — docs/schema.md section E — and the three foreign keys
-- that have been waiting for it.
--
-- Brought forward from the receiving work. locations is five columns and
-- depends on nothing, while product_locations.location_id and
-- stock_ledger.location_id have been unconstrained BIGINTs since
-- 003_catalog.sql and 005_stock_ledger.sql. Carrying that through a release of
-- R1 testing means a wrong location id can land in the ledger — and the ledger
-- is append-only, so it could never be corrected, only annotated by a
-- compensating row that does not remove the wrong one.
--
-- rack_assignments stays with the receiving work: it needs employees and date
-- ranges and has its own screen, none of which is on the critical path here.
--
-- Adding the keys will fail loudly if any existing row points at a location
-- that does not exist. That is the intended behaviour — such a row is exactly
-- what this migration exists to make impossible, and it has to be looked at
-- rather than migrated around.
--
-- The migration runner wraps this file in a single transaction — no explicit
-- BEGIN/COMMIT here.


CREATE TYPE location_type AS ENUM ('rack', 'godown', 'cold', 'counter_display');


-- ---------------------------------------------------------------------------
-- locations
--
-- Self-referencing, so an aisle contains racks and a rack contains shelves.
-- Nothing is seeded: the codes are the physical layout of one shop and are
-- entered from the office before the first goods receipt.
-- ---------------------------------------------------------------------------

CREATE TABLE locations (
  id            BIGSERIAL PRIMARY KEY,
  code          VARCHAR(20) NOT NULL UNIQUE,
  name          VARCHAR(60) NOT NULL,
  location_type location_type NOT NULL,
  parent_id     BIGINT REFERENCES locations (id),
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    BIGINT REFERENCES employees (id),
  CONSTRAINT locations_not_own_parent CHECK (parent_id IS NULL OR parent_id <> id)
);

COMMENT ON COLUMN locations.code IS
  'The label physically on the shelf, e.g. A-01-3. What someone counting stock reads out loud, '
  'so it is the identifier on printed count sheets and put-away lists rather than the id.';
COMMENT ON COLUMN locations.location_type IS
  'counter_display is the impulse rack at the till. It holds sellable stock and is counted like '
  'any other location — otherwise the stock sitting next to the cashier is the stock nobody counts.';
COMMENT ON COLUMN locations.is_active IS
  'A dismantled rack is deactivated, never deleted: stock_ledger rows point at it forever.';

CREATE INDEX idx_locations_parent ON locations (parent_id);
CREATE INDEX idx_locations_type ON locations (location_type) WHERE is_active;

CREATE TRIGGER trg_locations_updated_at
BEFORE UPDATE ON locations
FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ---------------------------------------------------------------------------
-- The deferred foreign keys
--
-- All three columns stay nullable. NULL means "not located" and is a real
-- state: opening stock in a shop whose racks are not yet coded has to be
-- tracked somewhere, and stock_on_hand carries that balance as its own row.
-- What the keys stop is a location id that refers to nothing.
-- ---------------------------------------------------------------------------

ALTER TABLE product_locations
  ADD CONSTRAINT product_locations_location_id_fkey
  FOREIGN KEY (location_id) REFERENCES locations (id);

ALTER TABLE stock_ledger
  ADD CONSTRAINT stock_ledger_location_id_fkey
  FOREIGN KEY (location_id) REFERENCES locations (id);

ALTER TABLE stock_on_hand
  ADD CONSTRAINT stock_on_hand_location_id_fkey
  FOREIGN KEY (location_id) REFERENCES locations (id);


-- ---------------------------------------------------------------------------
-- Corrections to frozen migrations
--
-- 003_catalog.sql, 004_product_tax_cache.sql and 005_stock_ledger.sql are all
-- applied, so their text cannot change (CLAUDE.md). Each promised this foreign
-- key in a file that ended up with a different number — 004_stock.sql, then
-- 005_stock.sql, then 007_locations_receiving.sql. The comments left in the
-- database are the copies support reads through psql, and they are restated
-- here now that the keys actually exist and there is nothing left to promise.
-- ---------------------------------------------------------------------------

COMMENT ON COLUMN product_locations.location_id IS
  'Where this SKU is meant to live. FK added in 007_locations.sql.';

COMMENT ON COLUMN stock_ledger.location_id IS
  'NULL means not located — opening stock in a shop whose racks are not yet coded still has to '
  'be tracked, and stock_on_hand carries that balance as its own row. FK added in '
  '007_locations.sql.';
