import type { Queryable } from '../db/queryable.js';
import {
  asRow,
  firstRow,
  readBoolean,
  readId,
  readInt,
  readNullableText,
  readNullableTimestamp,
  readText,
} from '../db/rows.js';
import { describeError } from '../describe-error.js';

/**
 * The reconciliation health surface - docs/DECISIONS.md D30.
 *
 * Every job that checks a derived value against the truth it came from reports
 * here, and only here. `product_tax_cache` is the first, `stock_on_hand` the
 * second, `product_price_cache` the third, and the local backup jobs -
 * `local_backup`, `wal_archive` and `backup_restore_verify` - the rest
 * (010_backup_health.sql). Jobs each reporting somewhere different are jobs
 * nobody reads, and then the shop finds out from a customer.
 *
 * The backup jobs do not run from `db:reconcile`; they are scheduled
 * separately, because taking a dump is not a read-only comparison. What makes
 * them part of this surface is that they record their runs here, so a backup
 * that stopped a fortnight ago reads as `overdue` on the same panel and in the
 * same column as a cache that stopped being refreshed.
 *
 * The panel weighs two questions equally: is anything wrong, and is anything
 * not being checked. A job that has not run in nine days is reported as loudly
 * as a job that found drift, because a check nobody runs is indistinguishable
 * from a check that always passes until the day it matters.
 */

export type ReconciliationStatus = 'ok' | 'drift' | 'failed';

/** `never_run` and `overdue` are outcomes too. */
export type ReconciliationHealth = ReconciliationStatus | 'never_run' | 'overdue';

export interface ReconciliationRunInput {
  readonly checkKey: string;
  readonly status: ReconciliationStatus;
  /** Rows still wrong when the run finished. For a correcting check, what it could not fix. */
  readonly outstanding: number;
  /** Rows the run put right. Always 0 for a reporting check. */
  readonly corrected: number;
  readonly durationMs?: number;
  /** The first few offending keys, or the error when the status is `failed`. */
  readonly detail?: string;
}

export interface ReconciliationHealthRow {
  readonly key: string;
  readonly description: string;
  readonly corrects: boolean;
  readonly lastRunAt: Date | null;
  readonly lastStatus: ReconciliationStatus | null;
  readonly outstanding: number | null;
  readonly lastDetail: string | null;
  readonly health: ReconciliationHealth;
}

const RECORD_SQL = `
  INSERT INTO reconciliation_runs (check_key, status, outstanding, corrected, duration_ms, detail)
  VALUES ($1, $2, $3, $4, $5, $6)
  RETURNING id`;

const HEALTH_SQL = `
  SELECT key, description, corrects, last_run_at, last_status, outstanding, last_detail, health
    FROM reconciliation_health
   ORDER BY key`;

function toStatus(value: unknown): ReconciliationStatus {
  if (value === 'ok' || value === 'drift' || value === 'failed') return value;
  throw new Error(`Unknown reconciliation status: ${String(value)}`);
}

function toHealth(value: unknown): ReconciliationHealth {
  if (value === 'never_run' || value === 'overdue') return value;
  return toStatus(value);
}

function toHealthRow(value: unknown): ReconciliationHealthRow {
  const row = asRow(value);
  const lastStatus = row.last_status;
  const outstanding = row.outstanding;

  return {
    key: readText(row, 'key'),
    description: readText(row, 'description'),
    corrects: readBoolean(row, 'corrects'),
    lastRunAt: readNullableTimestamp(row, 'last_run_at'),
    lastStatus: lastStatus === null || lastStatus === undefined ? null : toStatus(lastStatus),
    outstanding:
      outstanding === null || outstanding === undefined ? null : readInt(row, 'outstanding'),
    lastDetail: readNullableText(row, 'last_detail'),
    health: toHealth(row.health),
  };
}

/**
 * Records one execution and returns its id. `reconciliation_runs` is
 * append-only, so this is the only thing that ever writes to it - a run log
 * that can be tidied up is a run log that will be, on the day it is
 * inconvenient.
 */
export async function recordReconciliationRun(
  db: Queryable,
  run: ReconciliationRunInput,
): Promise<number> {
  const { rows } = await db.query(RECORD_SQL, [
    run.checkKey,
    run.status,
    run.outstanding,
    run.corrected,
    run.durationMs ?? null,
    run.detail ?? null,
  ]);

  return readId(firstRow(rows), 'id');
}

/** One row per active check, newest run attached. What the office panel renders. */
export async function readReconciliationHealth(db: Queryable): Promise<ReconciliationHealthRow[]> {
  const { rows } = await db.query(HEALTH_SQL);
  return rows.map(toHealthRow);
}

/** What a check's work returns: what it fixed, what is left, and why. */
export interface CheckWork {
  readonly outstanding: number;
  readonly corrected: number;
  readonly detail: string | null;
}

export interface CheckOutcome {
  readonly checkKey: string;
  readonly status: ReconciliationStatus;
  readonly outstanding: number;
  readonly corrected: number;
  readonly durationMs: number;
  readonly detail: string | null;
}

/**
 * Runs `work`, records the outcome as a run, and returns it.
 *
 * One definition, used by the data comparisons in `reconciliation/checks.ts`
 * and by the backup jobs in `backup/checks.ts`. It is shared rather than
 * copied because the part worth getting right is the failure path, and a second
 * copy of that is a second chance to get it wrong: a thrown error becomes a
 * `failed` run rather than an exception, so one broken check never stops the
 * others from reporting and never leaves the panel with a silent gap where a
 * check used to be.
 *
 * The distinction the status carries:
 *
 *   `failed` - the check could not complete. What it was checking is unknown.
 *   `drift`  - the check completed and found the thing it checks to be wrong.
 *
 * Those want different people doing different things at six in the morning,
 * which is why they are not collapsed into "not ok".
 */
export async function runAndRecordCheck(
  db: Queryable,
  checkKey: string,
  work: () => Promise<CheckWork>,
): Promise<CheckOutcome> {
  const startedAt = Date.now();

  try {
    const result = await work();
    const outcome: CheckOutcome = {
      checkKey,
      status: result.outstanding > 0 ? 'drift' : 'ok',
      outstanding: result.outstanding,
      corrected: result.corrected,
      durationMs: Date.now() - startedAt,
      detail: result.detail,
    };

    await recordReconciliationRun(db, {
      checkKey,
      status: outcome.status,
      outstanding: outcome.outstanding,
      corrected: outcome.corrected,
      durationMs: outcome.durationMs,
      ...(outcome.detail === null ? {} : { detail: outcome.detail }),
    });

    return outcome;
  } catch (error) {
    const detail = describeError(error);
    const durationMs = Date.now() - startedAt;

    try {
      await recordReconciliationRun(db, {
        checkKey,
        status: 'failed',
        outstanding: 0,
        corrected: 0,
        durationMs,
        detail,
      });
    } catch {
      // Recording failed too, so the panel will show this check as overdue
      // rather than failed. Nothing here can fix that, and swallowing the
      // original error on top of it would leave no trace at all.
      throw error;
    }

    return { checkKey, status: 'failed', outstanding: 0, corrected: 0, durationMs, detail };
  }
}
