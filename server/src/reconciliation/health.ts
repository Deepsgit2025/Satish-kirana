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

/**
 * The reconciliation health surface - docs/DECISIONS.md D30.
 *
 * Every job that checks a derived value against the truth it came from reports
 * here, and only here. `product_tax_cache` is the first, `stock_on_hand` the
 * second, and the monthly restore verification will be the third. Three jobs
 * each reporting somewhere different is three jobs nobody reads, and then the
 * shop finds out from a customer.
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
