import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { databaseNow } from '../db/clock.js';
import { readReconciliationHealth } from '../reconciliation/health.js';
import { withRollback } from '../testing/database.js';
import {
  LOCAL_BACKUP_CHECK,
  RESTORE_VERIFY_CHECK,
  runLocalBackupCheck,
  runRestoreVerifyCheck,
  WAL_ARCHIVE_CHECK,
} from './checks.js';
import { readBackupConfig, type BackupConfig } from './config.js';

/**
 * The backup jobs on the reconciliation health surface - docs/DECISIONS.md D30.
 *
 * Two things are being checked, and neither is whether a backup works. That is
 * proved by taking one, which these tests cannot do inside a transaction that
 * rolls back.
 *
 * **The jobs report where everything else reports.** No log file, no email, no
 * banner of their own. If the keys are on `reconciliation_health` and the runs
 * land in `reconciliation_runs`, then a backup that stopped reads as `overdue`
 * in the same column, on the same panel, as a cache that stopped being
 * refreshed - which is the whole of what D30 asks for.
 *
 * **A broken job reports; it does not throw.** This is the one that would
 * actually go wrong in the shop. `pg_dump` missing from a scheduled task's
 * PATH, a full disk, a directory nobody can write to: every one of those is an
 * exception somewhere inside, and every one of them has to come out as a
 * `failed` row with the reason in it. A job that threw would leave the panel
 * showing last week's success and nothing to say otherwise, which is exactly
 * the silence this surface exists to prevent.
 */

let scratchRoot: string;

function configFor(root: string, overrides: NodeJS.ProcessEnv = {}): BackupConfig {
  return readBackupConfig({
    PGDATABASE: process.env.PGDATABASE ?? 'ssbazar',
    BACKUP_LOCAL_DIR: root,
    ...overrides,
  });
}

beforeEach(async () => {
  scratchRoot = await mkdtemp(path.join(tmpdir(), 'ssbazar-backup-test-'));
});

afterEach(async () => {
  await rm(scratchRoot, { recursive: true, force: true });
});

describe('backup checks on the health surface', () => {
  it('registers all three jobs as reporting checks, not correcting ones', async () => {
    await withRollback(async (db) => {
      const health = await readReconciliationHealth(db);
      const byKey = new Map(health.map((row) => [row.key, row]));

      for (const key of [LOCAL_BACKUP_CHECK, WAL_ARCHIVE_CHECK, RESTORE_VERIFY_CHECK]) {
        const row = byKey.get(key);
        expect(row, `${key} is not on the health panel`).toBeDefined();

        // None of them repairs what it finds. Retention pruning is the job
        // running normally, not drift being corrected - 010_backup_health.sql
        // has the argument, and docs/DECISIONS.md D32 the rule behind it.
        expect(row?.corrects).toBe(false);
      }
    });
  });

  it('records a failed run rather than throwing when pg_dump cannot be found', async () => {
    await withRollback(async (db) => {
      // What a Windows scheduled task looks like when nobody set PG_BIN_DIR:
      // the installer's PATH is not the task's, and the failure arrives as
      // ENOENT from deep inside child_process.
      const config = configFor(scratchRoot, {
        PG_BIN_DIR: path.join(scratchRoot, 'no-postgres-here'),
      });

      const outcome = await runLocalBackupCheck(db, config, await databaseNow(db));

      expect(outcome.status).toBe('failed');
      expect(outcome.detail).not.toBeNull();

      // `failed` and `drift` are different states on purpose. This one says the
      // check could not run, so the state of the backups is unknown - not that
      // the backups were examined and found wanting.
      expect(outcome.outstanding).toBe(0);

      const row = (await readReconciliationHealth(db)).find(
        (candidate) => candidate.key === LOCAL_BACKUP_CHECK,
      );
      expect(row?.lastStatus).toBe('failed');
      expect(row?.health).toBe('failed');
      expect(row?.lastRunAt).not.toBeNull();
    });
  });

  it('records a failed run when there is no dump to verify', async () => {
    await withRollback(async (db) => {
      const outcome = await runRestoreVerifyCheck(db, configFor(scratchRoot));

      expect(outcome.status).toBe('failed');
      expect(outcome.detail).toMatch(/no dumps/);

      const row = (await readReconciliationHealth(db)).find(
        (candidate) => candidate.key === RESTORE_VERIFY_CHECK,
      );
      expect(row?.lastStatus).toBe('failed');
      expect(row?.lastDetail).toMatch(/no dumps/);
    });
  });

  it('leaves the failure on the panel where the next reader will find it', async () => {
    await withRollback(async (db) => {
      await runRestoreVerifyCheck(db, configFor(scratchRoot));

      // The run log is append-only, so the failure cannot be tidied away by
      // the next successful run - it is superseded, not erased.
      const { rows } = await db.query(
        `SELECT count(*)::int AS n FROM reconciliation_runs
          WHERE check_key = $1 AND status = 'failed'`,
        [RESTORE_VERIFY_CHECK],
      );
      const [row] = rows as { n: number }[];
      expect(row?.n).toBeGreaterThan(0);
    });
  });
});
