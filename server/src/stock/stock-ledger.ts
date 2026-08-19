import type { Queryable } from '../db/queryable.js';
import { firstRow, readId } from '../db/rows.js';

/**
 * Posting to the stock ledger - the only way stock ever moves.
 *
 * Every movement in the shop ends up here: a sale line, a goods receipt, a
 * repack, an adjustment, a transfer. Nothing writes `stock_on_hand`; the trigger
 * in `005_stock_ledger.sql` derives it, and `rebuild_stock_on_hand()` can
 * reproduce it from these rows alone (CLAUDE.md invariants 5, 6 and 8).
 *
 * The table refuses UPDATE, DELETE and TRUNCATE at the database level, so a
 * mistake is corrected by posting the opposite row, never by editing this one.
 * That is the property the whole shrinkage investigation rests on: the history
 * of a product is what happened, not what someone last decided it should say.
 *
 * `postStockMovement` takes a `Queryable`, so the caller supplies the
 * transaction. A bill saves its lines, its ledger rows and its party ledger
 * rows in one - they commit together or not at all.
 */

export type StockTxnType =
  | 'sale'
  | 'sale_return'
  | 'purchase'
  | 'purchase_return'
  | 'repack_out'
  | 'repack_in'
  | 'adjustment'
  | 'transfer_out'
  | 'transfer_in'
  | 'opening';

export interface StockMovement {
  readonly productId: number;
  /** NULL until locations are configured. */
  readonly locationId?: number | null;
  readonly txnType: StockTxnType;
  /** Signed, in the product base unit. Negative leaves the shop; zero is refused. */
  readonly qtyDelta: number;
  /** The document that caused this, so any row can be traced back to one. */
  readonly refTable: string;
  readonly refId: number;
  readonly refLineId?: number | null;
  readonly batchId?: number | null;
  /** Landed cost at this moment, for COGS. Snapshotted, never looked up later. */
  readonly costRate?: number | null;
  readonly deviceId?: number | null;
  readonly employeeId?: number | null;
  /**
   * Business time - when this happened in the shop, which is not when the
   * server heard about it. `recorded_at` is stamped by the database and is not
   * offered here, because a caller that could set it could lie about it
   * (CLAUDE.md invariant 11).
   */
  readonly occurredAt: Date;
}

const INSERT_SQL = `
  INSERT INTO stock_ledger (product_id, location_id, txn_type, qty_delta, ref_table, ref_id,
                            ref_line_id, batch_id, cost_rate, device_id, employee_id, occurred_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
  RETURNING id`;

/** Posts one movement and returns its ledger id. */
export async function postStockMovement(db: Queryable, movement: StockMovement): Promise<number> {
  const { rows } = await db.query(INSERT_SQL, [
    movement.productId,
    movement.locationId ?? null,
    movement.txnType,
    movement.qtyDelta,
    movement.refTable,
    movement.refId,
    movement.refLineId ?? null,
    movement.batchId ?? null,
    movement.costRate ?? null,
    movement.deviceId ?? null,
    movement.employeeId ?? null,
    movement.occurredAt,
  ]);

  return readId(firstRow(rows), 'id');
}
