import type { Queryable } from '../db/queryable.js';
import { asRow, firstRow, readInt, readId, readNullableId, readNumeric } from '../db/rows.js';

/**
 * The derived side of the stock ledger: reading the cache, and checking it.
 *
 * `stock_on_hand` is maintained by a trigger and is never written by
 * application code (CLAUDE.md invariant 6). What lives here is the pair of
 * operations that keep it honest:
 *
 *   `readStockOnHandDrift` compares the cache against a full sum of the ledger,
 *   in SQL. It is the nightly check, and the assertion the rebuild test makes.
 *
 *   `rebuildStockOnHand` throws the cache away and derives it again from the
 *   beginning. It is the safety net, run deliberately after investigating - not
 *   on a schedule, because a nightly rebuild would quietly repair the evidence
 *   that the trigger is wrong (docs/DECISIONS.md D32).
 *
 * Both compare in the database rather than in JavaScript. Quantities are
 * NUMERIC(12,3) and a difference of 0.001 across ten thousand ledger rows is a
 * real discrepancy that summing doubles could easily hide or invent.
 */

export interface StockDriftRow {
  readonly productId: number;
  readonly locationId: number | null;
  /** NULL when the cache has no row at all for a product the ledger has moved. */
  readonly cachedQty: number | null;
  /** NULL when the cache carries a row the ledger knows nothing about. */
  readonly ledgerQty: number | null;
  readonly difference: number;
}

const DRIFT_SQL = `
  SELECT product_id, location_id, cached_qty, ledger_qty, difference
    FROM stock_on_hand_drift
   ORDER BY product_id, location_id`;

const DRIFT_COUNT_SQL = `SELECT count(*)::int AS n FROM stock_on_hand_drift`;

function toDriftRow(value: unknown): StockDriftRow {
  const row = asRow(value);
  const cached = row.cached_qty;
  const ledger = row.ledger_qty;

  return {
    productId: readId(row, 'product_id'),
    locationId: readNullableId(row, 'location_id'),
    cachedQty: cached === null || cached === undefined ? null : readNumeric(row, 'cached_qty'),
    ledgerQty: ledger === null || ledger === undefined ? null : readNumeric(row, 'ledger_qty'),
    difference: readNumeric(row, 'difference'),
  };
}

/**
 * Every product and location where the cache and the ledger disagree. Expected
 * to be empty at every moment, in a way `product_tax_cache_drift` is not - there
 * is no legitimate reason for a row to appear here.
 */
export async function readStockOnHandDrift(db: Queryable): Promise<StockDriftRow[]> {
  const { rows } = await db.query(DRIFT_SQL);
  return rows.map(toDriftRow);
}

export async function countStockOnHandDrift(db: Queryable): Promise<number> {
  const { rows } = await db.query(DRIFT_COUNT_SQL);
  return readInt(firstRow(rows), 'n');
}

/**
 * Rebuilds `stock_on_hand` from `stock_ledger` and returns the number of rows
 * written. Deliberate use only - see the note above.
 */
export async function rebuildStockOnHand(db: Queryable): Promise<number> {
  const { rows } = await db.query(`SELECT rebuild_stock_on_hand() AS n`);
  return readInt(firstRow(rows), 'n');
}
