-- 006_reconciliation_health.sql
--
-- One place where every reconciliation job reports — docs/DECISIONS.md D30.
--
--   reconciliation_checks  the registry: what runs, how often, and whether it
--                          corrects what it finds
--   reconciliation_runs    append-only history, one row per execution
--   reconciliation_health  the panel: per check, when it last ran and how much
--                          drift is outstanding
--
-- Built now because there are two checks rather than one. product_tax_cache
-- arrived with 004_product_tax_cache.sql and stock_on_hand with
-- 005_stock_ledger.sql; a third would have been the point at which nobody knew
-- where to look, and the shop finds out from a customer instead.
--
-- The panel exists to answer two questions with equal weight: is anything
-- wrong, and is anything not being checked. A job that has not run in nine days
-- has to look as alarming as a job that found drift, which is why last-run time
-- is a column here and not a log line somewhere.
--
-- The migration runner wraps this file in a single transaction — no explicit
-- BEGIN/COMMIT here.


CREATE TYPE reconciliation_status AS ENUM ('ok', 'drift', 'failed');


-- ---------------------------------------------------------------------------
-- reconciliation_checks
-- ---------------------------------------------------------------------------

CREATE TABLE reconciliation_checks (
  key         VARCHAR(60) PRIMARY KEY,
  description TEXT NOT NULL,
  run_every   INTERVAL NOT NULL,
  corrects    BOOLEAN NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  BIGINT REFERENCES employees (id)
);

COMMENT ON COLUMN reconciliation_checks.run_every IS
  'How often this is meant to run. The health view calls a check overdue at twice this, so one '
  'missed night reads as a hiccup and two reads as a broken job.';
COMMENT ON COLUMN reconciliation_checks.corrects IS
  'TRUE when the job fixes what it finds, so outstanding drift after a run is the part it could '
  'not fix. FALSE when finding drift is the whole job and correcting it would destroy evidence '
  '(docs/DECISIONS.md D32).';

CREATE TRIGGER trg_reconciliation_checks_updated_at
BEFORE UPDATE ON reconciliation_checks
FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ---------------------------------------------------------------------------
-- reconciliation_runs
--
-- Append-only, using the enforcement from 005_stock_ledger.sql. A run log that
-- can be tidied up is a run log that will be, on the day it is inconvenient.
-- ---------------------------------------------------------------------------

CREATE TABLE reconciliation_runs (
  id          BIGSERIAL PRIMARY KEY,
  check_key   VARCHAR(60) NOT NULL REFERENCES reconciliation_checks (key),
  ran_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  duration_ms INTEGER CHECK (duration_ms >= 0),
  status      reconciliation_status NOT NULL,
  outstanding INTEGER NOT NULL DEFAULT 0 CHECK (outstanding >= 0),
  corrected   INTEGER NOT NULL DEFAULT 0 CHECK (corrected >= 0),
  detail      TEXT,
  CONSTRAINT reconciliation_runs_status_matches_counts
    CHECK ((status = 'drift') = (outstanding > 0) OR status = 'failed')
);

COMMENT ON COLUMN reconciliation_runs.outstanding IS
  'Rows still wrong when the run finished. For a correcting check that is what it could not fix.';
COMMENT ON COLUMN reconciliation_runs.corrected IS 'Rows the run put right. Always 0 for a reporting check.';
COMMENT ON COLUMN reconciliation_runs.detail IS
  'Free text for the panel — the first few offending keys, or the error when status is failed.';

CREATE TRIGGER trg_reconciliation_runs_no_update
BEFORE UPDATE ON reconciliation_runs
FOR EACH STATEMENT EXECUTE FUNCTION refuse_append_only_write();

CREATE TRIGGER trg_reconciliation_runs_no_delete
BEFORE DELETE ON reconciliation_runs
FOR EACH STATEMENT EXECUTE FUNCTION refuse_append_only_write();

CREATE TRIGGER trg_reconciliation_runs_no_truncate
BEFORE TRUNCATE ON reconciliation_runs
FOR EACH STATEMENT EXECUTE FUNCTION refuse_append_only_write();

CREATE INDEX idx_reconciliation_runs_latest ON reconciliation_runs (check_key, ran_at DESC, id DESC);


-- ---------------------------------------------------------------------------
-- reconciliation_health
--
-- What the office dashboard renders. One row per active check, newest run
-- attached.
--
-- `health` orders staleness above outcome on purpose: a check that found drift
-- nine days ago and has not run since is first a check that is not running.
-- Whatever the panel does with the summary, every underlying figure is still a
-- column, so nothing is hidden behind the CASE.
-- ---------------------------------------------------------------------------

CREATE VIEW reconciliation_health AS
SELECT c.key,
       c.description,
       c.run_every,
       c.corrects,
       r.ran_at      AS last_run_at,
       r.status      AS last_status,
       r.outstanding AS outstanding,
       r.corrected   AS last_corrected,
       r.duration_ms AS last_duration_ms,
       r.detail      AS last_detail,
       CASE
         WHEN r.ran_at IS NULL                          THEN 'never_run'
         WHEN r.ran_at < now() - c.run_every * 2        THEN 'overdue'
         WHEN r.status = 'failed'                       THEN 'failed'
         WHEN r.outstanding > 0                         THEN 'drift'
         ELSE 'ok'
       END AS health
  FROM reconciliation_checks c
  LEFT JOIN LATERAL (
         SELECT ran_at, status, outstanding, corrected, duration_ms, detail
           FROM reconciliation_runs
          WHERE check_key = c.key
          ORDER BY ran_at DESC, id DESC
          LIMIT 1
       ) r ON true
 WHERE c.is_active;

COMMENT ON VIEW reconciliation_health IS
  'The office health panel. never_run and overdue are failures too — a check nobody is running '
  'is indistinguishable from a check that always passes, right up until it matters.';


-- ===========================================================================
-- SEED DATA — the two checks that exist today
-- ===========================================================================

INSERT INTO reconciliation_checks (key, description, run_every, corrects) VALUES
  ('product_tax_cache',
   'products.tax_slab_id against the assignment in force in product_tax_assignments. Corrects '
   'stale caches, which is the ordinary overnight case when a future-dated rate change comes '
   'due. Anything outstanding afterwards is a product with no tax history at all.',
   INTERVAL '1 day', true),

  ('stock_on_hand',
   'stock_on_hand against the sum of stock_ledger. Reports only: drift here is never expected, '
   'and rebuilding on a schedule would erase the evidence that the trigger is wrong.',
   INTERVAL '1 day', false);
