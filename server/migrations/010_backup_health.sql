-- 010_backup_health.sql
--
-- The local backup jobs join the reconciliation health surface — docs/
-- DECISIONS.md D30. No new tables: reconciliation_checks, reconciliation_runs
-- and the reconciliation_health view already exist (006_reconciliation_health
-- .sql), and a backup that reported anywhere else would be the third mechanism
-- D30 exists to prevent. All this migration does is register what runs.
--
-- D30 called the restore verification "the third entry". It is the third
-- subject and the fourth, fifth and sixth rows: product_price_cache arrived in
-- between (009_product_price_cache.sql), and backup is three checks rather than
-- one. That is not padding. The panel's whole claim is that a check nobody has
-- run looks as wrong as a check that failed, and it makes that claim through
-- one column — last_run_at. Three jobs on three cadences cannot share it:
--
--   local_backup          nightly   the dump was taken and is readable
--   wal_archive           nightly   the archive is on, keeping up, and anchored
--   backup_restore_verify weekly    the newest dump actually restores
--
-- Folded into one row, a verify that stopped running six weeks ago would be
-- hidden behind last night's successful dump, which is precisely the failure
-- this surface was built to make visible.
--
--
-- corrects is FALSE on all three, and the reasoning is worth stating because
-- these jobs do delete things.
--
-- The column asks what the check does about drift *it found* — refresh the
-- stale cache, or report and stand back (docs/DECISIONS.md D32). Retention
-- pruning is not that. Expired dumps are not a fault the run discovered and
-- repaired; removing them is the job running normally, the way writing the dump
-- is. Nothing here repairs anything it finds, so corrected stays 0 on every run
-- and what was pruned goes in detail, where a person reads it.
--
-- Reading outstanding on these three:
--
--   failed  the check could not complete — pg_dump exited non-zero, the scratch
--           database would not restore, the directory is unwritable. The state
--           of the backups is unknown.
--   drift   the check completed and what it looked at is wrong. outstanding
--           counts the problems: a missing or empty dump, an archiver failure,
--           a failed assertion.
--   ok      clean.
--
-- The difference matters at 6am. "The verify failed" and "the verify says the
-- backup is bad" want different people doing different things.
--
--
-- These do not run from db:reconcile. That command runs the three read-only
-- comparisons, and adding a job that shells out to pg_dump and writes several
-- megabytes to it would change what running it means. backup:run and
-- backup:verify are their own scheduled tasks; they report here, and
-- db:reconcile still names them when they go stale, because it reads the same
-- view.
--
-- The migration runner wraps this file in a single transaction — no explicit
-- BEGIN/COMMIT here.


INSERT INTO reconciliation_checks (key, description, run_every, corrects) VALUES
  ('local_backup',
   'The nightly compressed pg_dump in BACKUP_LOCAL_DIR/dumps. Checks the dump just taken is '
   'present and non-empty, prunes dumps past the retention window, and reports what the '
   'directory holds. Never prunes the last dump remaining, whatever its age: retention removes '
   'what is redundant, never what is all there is.',
   INTERVAL '1 day', false),

  ('wal_archive',
   'WAL archiving, and the base backup that makes it restorable. Checks archive_mode is on, '
   'that pg_stat_archiver has recorded no new failures since the previous run, and that a '
   'pg_basebackup anchors the archive — archived WAL cannot be replayed onto a restored '
   'pg_dump, so without a base backup the archive is a directory that fills the disk and '
   'recovers nothing (docs/DECISIONS.md D46).',
   INTERVAL '1 day', false),

  ('backup_restore_verify',
   'Restores the newest dump into a scratch database and asserts it against the manifest written '
   'beside it: the applied migration set, a row count for every table, sequence positions, and '
   'stock_on_hand against the sum of stock_ledger through the stock_on_hand_drift view. Reports '
   'only — it never touches the live database, and a dump that fails to restore is left where it '
   'is for a person to look at.',
   INTERVAL '7 days', false);
