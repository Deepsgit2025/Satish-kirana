import type { Queryable } from '../db/queryable.js';
import { firstRow, readInt } from '../db/rows.js';
import { describeError } from '../describe-error.js';
import { readStockOnHandDrift } from '../stock/stock-on-hand.js';
import { recordReconciliationRun, type ReconciliationStatus } from './health.js';

/**
 * The scheduled reconciliation jobs. Each one compares a derived value against
 * the truth it came from, records what it found, and returns rather than
 * throwing - a failed check has to appear on the health panel, not disappear
 * into an unhandled rejection (docs/DECISIONS.md D30).
 *
 * The two differ in one important way, and it is not an oversight:
 *
 *   `product_tax_cache` corrects. Drift there is the expected overnight case -
 *   a future-dated rate change coming due, which nothing wrote and no trigger
 *   could catch. Outstanding drift after the run is the part it could not fix.
 *
 *   `stock_on_hand` only reports. Drift there is never expected, so rebuilding
 *   on a schedule would repair the symptom and destroy the evidence that the
 *   trigger is wrong. Rebuilding is a decision a person makes after looking
 *   (docs/DECISIONS.md D32).
 */

export const PRODUCT_TAX_CACHE_CHECK = 'product_tax_cache';
export const PRODUCT_PRICE_CACHE_CHECK = 'product_price_cache';
export const STOCK_ON_HAND_CHECK = 'stock_on_hand';

export interface ReconciliationOutcome {
  readonly checkKey: string;
  readonly status: ReconciliationStatus;
  readonly outstanding: number;
  readonly corrected: number;
  readonly durationMs: number;
  readonly detail: string | null;
}

/** How many offending rows a `detail` string names before it says "and N more". */
const DETAIL_SAMPLE = 3;

function statusFor(outstanding: number): ReconciliationStatus {
  return outstanding > 0 ? 'drift' : 'ok';
}

async function scalarInt(db: Queryable, sql: string): Promise<number> {
  const { rows } = await db.query(sql);
  return readInt(firstRow(rows), 'n');
}

/**
 * Runs `work`, records the outcome, and returns it. A thrown error becomes a
 * `failed` run rather than an exception, so one broken check does not stop the
 * others from reporting.
 */
async function runCheck(
  db: Queryable,
  checkKey: string,
  work: () => Promise<{ outstanding: number; corrected: number; detail: string | null }>,
): Promise<ReconciliationOutcome> {
  const startedAt = Date.now();

  try {
    const result = await work();
    const outcome: ReconciliationOutcome = {
      checkKey,
      status: statusFor(result.outstanding),
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

/**
 * `stock_on_hand` against the sum of `stock_ledger`. Reports; never corrects.
 */
export async function runStockOnHandCheck(db: Queryable): Promise<ReconciliationOutcome> {
  return runCheck(db, STOCK_ON_HAND_CHECK, async () => {
    const drift = await readStockOnHandDrift(db);
    if (drift.length === 0) return { outstanding: 0, corrected: 0, detail: null };

    const sample = drift
      .slice(0, DETAIL_SAMPLE)
      .map(
        (row) =>
          `product ${String(row.productId)} at location ${row.locationId === null ? 'none' : String(row.locationId)}: ` +
          `cache ${String(row.cachedQty ?? 'missing')}, ledger ${String(row.ledgerQty ?? 'missing')}`,
      );
    if (drift.length > DETAIL_SAMPLE) {
      sample.push(`and ${String(drift.length - DETAIL_SAMPLE)} more`);
    }

    return { outstanding: drift.length, corrected: 0, detail: sample.join('; ') };
  });
}

/**
 * `products.tax_slab_id` against the assignment in force. Advances caches whose
 * future-dated change has come due, then reports whatever is left - which can
 * only be a product with no tax history at all, and wants a person.
 */
export async function runProductTaxCacheCheck(db: Queryable): Promise<ReconciliationOutcome> {
  return runCheck(db, PRODUCT_TAX_CACHE_CHECK, async () => {
    const corrected = await scalarInt(db, `SELECT refresh_product_tax_slab_cache() AS n`);
    const outstanding = await scalarInt(
      db,
      `SELECT count(*)::int AS n FROM product_tax_cache_drift`,
    );

    return {
      outstanding,
      corrected,
      detail:
        outstanding === 0
          ? null
          : `${String(outstanding)} product(s) with no tax assignment in force`,
    };
  });
}

/**
 * `products.sale_price` / `mrp` against the price in force. Corrects, for the
 * same reason the tax cache check does: drift here is a future-dated price
 * coming due, not evidence that anything is broken.
 *
 * It is the other half of a bulk tax reassignment that was passed on rather
 * than absorbed (build-order step 7). The slab moves on its date through
 * `product_tax_cache`; without this, the price recorded alongside it on the
 * same date would never reach the column the counters bill from.
 */
export async function runProductPriceCacheCheck(db: Queryable): Promise<ReconciliationOutcome> {
  return runCheck(db, PRODUCT_PRICE_CACHE_CHECK, async () => {
    const corrected = await scalarInt(db, `SELECT refresh_product_price_cache() AS n`);
    const outstanding = await scalarInt(
      db,
      `SELECT count(*)::int AS n FROM product_price_cache_drift`,
    );

    return {
      outstanding,
      corrected,
      detail: outstanding === 0 ? null : `${String(outstanding)} product(s) with no price in force`,
    };
  });
}

/**
 * Every check, in order, each recording its own run. Runs them all even when
 * one reports drift or fails: a partial panel is worse than a bad one, because
 * the checks that did not report look like checks that passed.
 *
 * The two cache checks run before `stock_on_hand` and in that order because a
 * price is read against the slab in force; nothing depends on the ordering
 * being exact, but a panel read top to bottom should tell the story that way.
 */
export async function runAllReconciliationChecks(db: Queryable): Promise<ReconciliationOutcome[]> {
  return [
    await runProductTaxCacheCheck(db),
    await runProductPriceCacheCheck(db),
    await runStockOnHandCheck(db),
  ];
}
