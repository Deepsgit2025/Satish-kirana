import type { TaxRateSnapshot } from '@ssbazar/shared';

import type { Queryable } from '../db/queryable.js';

/**
 * Slab resolution: product + datetime -> the rates in force at that moment.
 *
 *     product_tax_assignments (the assignment in force) -> tax_slabs -> rates
 *
 * The assignment is the authority on which slab a product sits on.
 * `products.tax_slab_id` is only a cache of "right now" - kept in step by a
 * trigger when an assignment takes effect immediately, and advanced by the
 * nightly refresh when a future-dated one comes due, so a slab change entered
 * for next month is already recorded while today's bills carry on at today's
 * rate (docs/DECISIONS.md D27 and D28).
 *
 * There is no slab-to-slab history to walk. The GST 2.0 rationalisation moved
 * products between slabs, not slabs into slabs: a product on 12% became 5% or
 * 18% depending on what it was, so the change is per product and nowhere else.
 *
 * What comes back is a `TaxRateSnapshot`, the shape `computeBillTax` takes. A
 * caller resolves once, snapshots the rates onto the line, and the tax engine
 * never looks anything up (CLAUDE.md invariant 2). Nothing here may be called
 * while rendering or reprinting a document - old bills print from their own
 * stored rates, not from this.
 */

/** The assignment in force at a datetime, with the slab it points at. */
export interface ResolvedProductTax {
  readonly productId: number;
  readonly taxSlabId: number;
  /** `tax_slabs.name`, e.g. `GST 5%`. For display and for the audit trail. */
  readonly slabName: string;
  /** Ready to copy onto a transaction line. */
  readonly rates: TaxRateSnapshot;
  readonly effectiveFrom: Date;
  /** NULL means this assignment is still open. */
  readonly effectiveTo: Date | null;
  readonly reason: string | null;
}

/** Raised when the assignment history cannot yield one answer. */
export class ProductTaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProductTaxError';
  }
}

/**
 * Which row is in force is decided by `product_tax_assignment_at`, defined in
 * `004_product_tax_cache.sql`, not by a predicate written out here. The cache
 * trigger and the nightly refresh call the same function, so the period rule
 * exists once and cannot drift between the till and the job that reconciles it.
 * Periods are half-open, `[effective_from, effective_to)`, so a bill timestamped
 * on a boundary belongs to the new assignment and to nothing else.
 *
 * The slab's own effective dates are deliberately not filtered on. The
 * assignment says which slab applied; a slab whose period does not cover the
 * assignment is a data error to surface, not a row to skip silently into a NULL
 * rate at the till.
 */
const RESOLVE_SQL = `
  SELECT a.product_id,
         a.tax_slab_id,
         a.effective_from,
         a.effective_to,
         a.reason,
         s.name      AS slab_name,
         s.cgst_rate,
         s.sgst_rate,
         s.igst_rate,
         s.cess_rate
    FROM product_tax_assignment_at($1, $2) a
    JOIN tax_slabs s ON s.id = a.tax_slab_id`;

function asRow(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new ProductTaxError('Unreadable row from product_tax_assignments.');
  }
  return value as Record<string, unknown>;
}

/** `id` and `product_id` are BIGINT, which node-postgres hands back as text. */
function readId(row: Record<string, unknown>, column: string): number {
  const value = row[column];
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed)) {
    throw new ProductTaxError(`Column ${column} is not a usable id.`);
  }
  return parsed;
}

/** NUMERIC arrives as text so no precision is lost in transit. Rates are (5,2). */
function readRate(row: Record<string, unknown>, column: string): number {
  const value = row[column];
  const parsed = typeof value === 'string' ? Number.parseFloat(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
    throw new ProductTaxError(`Column ${column} is not a usable rate.`);
  }
  return parsed;
}

function readText(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw new ProductTaxError(`Column ${column} is not text.`);
  return value;
}

function readNullableText(row: Record<string, unknown>, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new ProductTaxError(`Column ${column} is not text.`);
  return value;
}

function readTimestamp(row: Record<string, unknown>, column: string): Date {
  const value = row[column];
  if (!(value instanceof Date)) throw new ProductTaxError(`Column ${column} is not a timestamp.`);
  return value;
}

function readNullableTimestamp(row: Record<string, unknown>, column: string): Date | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  return readTimestamp(row, column);
}

function toResolvedProductTax(value: unknown): ResolvedProductTax {
  const row = asRow(value);
  return {
    productId: readId(row, 'product_id'),
    taxSlabId: readId(row, 'tax_slab_id'),
    slabName: readText(row, 'slab_name'),
    rates: {
      cgstRate: readRate(row, 'cgst_rate'),
      sgstRate: readRate(row, 'sgst_rate'),
      igstRate: readRate(row, 'igst_rate'),
      cessRate: readRate(row, 'cess_rate'),
    },
    effectiveFrom: readTimestamp(row, 'effective_from'),
    effectiveTo: readNullableTimestamp(row, 'effective_to'),
    reason: readNullableText(row, 'reason'),
  };
}

/**
 * The rates in force for `productId` at `at`, or `null` when the product had no
 * assignment then - a product created but never assigned a slab, or a datetime
 * before its first assignment. `null` is not a rate of zero: the caller has to
 * refuse the line rather than sell it tax-free.
 *
 * Two rows in force is a corrupt history rather than a choice to make, so it
 * throws, as the cache trigger does. The partial unique index in
 * `003_catalog.sql` stops the common way in - a second open row - but
 * overlapping closed periods are still writable, and silently taking whichever
 * row sorted first would put a wrong rate on a bill.
 */
export async function resolveProductTax(
  db: Queryable,
  productId: number,
  at: Date,
): Promise<ResolvedProductTax | null> {
  const result = await db.query(RESOLVE_SQL, [productId, at]);

  if (result.rows.length === 0) return null;
  if (result.rows.length > 1) {
    throw new ProductTaxError(
      `Product ${String(productId)} has ${String(result.rows.length)} tax assignments in force at ` +
        `${at.toISOString()}. Periods must not overlap.`,
    );
  }

  return toResolvedProductTax(result.rows[0]);
}
