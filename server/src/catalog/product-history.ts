import type { PriceTaxType } from '@ssbazar/shared';

import type { Queryable } from '../db/queryable.js';
import { firstRow, readId } from '../db/rows.js';

/**
 * Recording a change to a product's price or tax slab.
 *
 * Both tables work the same way and both are written only through here, so
 * every caller - the catalogue import, the product master screen, a bulk
 * reassignment, a test fixture - produces the same shape of history. The moment
 * two of them write it differently, one of them is wrong and the drift will
 * turn up months later as a rate on a bill nobody can explain.
 *
 * The pattern is close-then-open. The row currently open is closed at the exact
 * instant the new one begins, then the new one is inserted there:
 *
 *     ...──────────────┤├──────────────>
 *      old, now closed  │  new, open
 *                effective_from
 *
 * Closing first is what keeps the one-open-row index satisfied, and half-open
 * periods mean the handover is exact - no gap for a bill to fall into, no
 * overlap to arbitrate (docs/DECISIONS.md D27).
 *
 * `effectiveFrom` in the future is a pending change and touches nothing today.
 * Take it from `databaseNow()` rather than `new Date()` when the intent is
 * "now", or the row lands fractionally in the future and nothing is in force.
 */

export interface SlabAssignment {
  readonly productId: number;
  readonly taxSlabId: number;
  readonly effectiveFrom: Date;
  /** Why the slab moved. Read by whoever has to explain a rate on an old bill. */
  readonly reason: string;
  readonly changedBy?: number | null;
}

export interface PriceAssignment {
  readonly productId: number;
  /** Exact decimal text, not a float - NUMERIC(12,2) all the way through. */
  readonly salePrice: string;
  readonly mrp: string;
  readonly taxType: PriceTaxType;
  readonly effectiveFrom: Date;
  readonly reason: string;
  readonly changedBy?: number | null;
}

const CLOSE_SLAB_SQL = `
  UPDATE product_tax_assignments
     SET effective_to = $2
   WHERE product_id = $1 AND effective_to IS NULL`;

const OPEN_SLAB_SQL = `
  INSERT INTO product_tax_assignments (product_id, tax_slab_id, effective_from, reason, changed_by)
  VALUES ($1, $2, $3, $4, $5)
  RETURNING id`;

const CLOSE_PRICE_SQL = `
  UPDATE product_prices
     SET effective_to = $2
   WHERE product_id = $1 AND effective_to IS NULL`;

const OPEN_PRICE_SQL = `
  INSERT INTO product_prices (product_id, sale_price, mrp, tax_type, effective_from, reason,
                              changed_by)
  VALUES ($1, $2, $3, $4, $5, $6, $7)
  RETURNING id`;

/**
 * Moves a product onto a slab from `effectiveFrom`, and returns the new
 * assignment's id. On a product with no history yet - a fresh import - there is
 * nothing to close and this is simply the opening row.
 */
export async function assignProductSlab(db: Queryable, input: SlabAssignment): Promise<number> {
  await db.query(CLOSE_SLAB_SQL, [input.productId, input.effectiveFrom]);

  const { rows } = await db.query(OPEN_SLAB_SQL, [
    input.productId,
    input.taxSlabId,
    input.effectiveFrom,
    input.reason,
    input.changedBy ?? null,
  ]);

  return readId(firstRow(rows), 'id');
}

/** The same, for price and MRP. `products.sale_price` and `mrp` are the cache. */
export async function assignProductPrice(db: Queryable, input: PriceAssignment): Promise<number> {
  await db.query(CLOSE_PRICE_SQL, [input.productId, input.effectiveFrom]);

  const { rows } = await db.query(OPEN_PRICE_SQL, [
    input.productId,
    input.salePrice,
    input.mrp,
    input.taxType,
    input.effectiveFrom,
    input.reason,
    input.changedBy ?? null,
  ]);

  return readId(firstRow(rows), 'id');
}
