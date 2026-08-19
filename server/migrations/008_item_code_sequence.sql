-- 008_item_code_sequence.sql
--
-- Generates products.item_code — the reference app's "Assign Code".
--
-- The column is NOT NULL UNIQUE and nothing was producing values for it. The
-- catalogue CSV does not carry one (the client's spreadsheet has barcodes and
-- names, not internal codes), and the product master screen will not ask for
-- one either, so it has to be generated.
--
-- In the database rather than in the importer, because two callers need it and
-- they must not invent separate schemes: the CSV import now, the product master
-- screen later. A sequence also survives concurrency, where "select max and add
-- one" hands the same code to two sessions.
--
-- Format is SKU-000001. The prefix is arbitrary — nothing parses it, and
-- item_code is an internal handle, not a barcode. Widening past six digits
-- happens on its own when the sequence gets there; the column is VARCHAR(30).
--
-- The migration runner wraps this file in a single transaction — no explicit
-- BEGIN/COMMIT here.


CREATE SEQUENCE product_item_code_seq AS BIGINT START 1;

COMMENT ON SEQUENCE product_item_code_seq IS
  'Feeds next_item_code(). Never reset: a reused item_code would attach a new product to an old '
  'one''s history in every report that groups by it.';

CREATE FUNCTION next_item_code() RETURNS VARCHAR(30)
LANGUAGE sql VOLATILE AS $$
  SELECT 'SKU-' || lpad(nextval('product_item_code_seq')::text, 6, '0');
$$;

COMMENT ON FUNCTION next_item_code() IS
  'The one generator for products.item_code. Both the catalogue import and the product master '
  'screen call it, so neither can invent a competing scheme.';
