import { assignProductSlab } from '../catalog/product-history.js';
import type { Queryable } from '../db/queryable.js';

/**
 * Catalogue fixtures for the database-backed tests.
 *
 * Everything here writes through the real schema rather than around it, so a
 * fixture that stops being possible - a constraint tightened, a column made NOT
 * NULL - fails the tests that use it instead of quietly diverging from what the
 * product master will actually do.
 *
 * All of it runs inside `withRollback`, so nothing needs cleaning up.
 */

/** Rice. Any valid 6-digit code would do; a real one reads better in a failure. */
const DEFAULT_HSN = '100630';

export function idOf(rows: readonly unknown[]): number {
  const [row] = rows;
  if (typeof row !== 'object' || row === null) throw new Error('expected one row');

  const { id } = row as { id?: unknown };
  const parsed = typeof id === 'string' ? Number.parseInt(id, 10) : id;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed)) {
    throw new Error('expected an id column');
  }
  return parsed;
}

export async function queryId(
  db: Queryable,
  sql: string,
  params: readonly unknown[] = [],
): Promise<number> {
  const { rows } = await db.query(sql, [...params]);
  return idOf(rows);
}

/** `tax_slabs.effective_from` is a DATE; send one, so no timezone rounds it. */
export function toDateOnly(at: Date): string {
  const month = String(at.getMonth() + 1).padStart(2, '0');
  const day = String(at.getDate()).padStart(2, '0');
  return `${String(at.getFullYear())}-${month}-${day}`;
}

/** An open slab seeded by `001_foundation.sql`, by name - `GST 5%`, `GST 18%`. */
export async function seededSlabId(db: Queryable, name: string): Promise<number> {
  return queryId(db, `SELECT id FROM tax_slabs WHERE name = $1 AND effective_to IS NULL`, [name]);
}

/**
 * A slab the seed does not contain. GST 2.0 left 0/5/18/40, so a rate outside
 * that set is unmistakably a change made after go-live rather than history.
 */
export async function createSlab(
  db: Queryable,
  name: string,
  totalRate: number,
  effectiveFrom: Date,
): Promise<number> {
  const half = totalRate / 2;
  return queryId(
    db,
    `INSERT INTO tax_slabs (name, cgst_rate, sgst_rate, igst_rate, effective_from)
     VALUES ($1, $2, $2, $3, $4)
     RETURNING id`,
    [name, half, totalRate, toDateOnly(effectiveFrom)],
  );
}

export interface SeedProductOptions {
  readonly itemCode: string;
  /** Seeds `products.tax_slab_id`, the cache. History is `assignSlab`. */
  readonly taxSlabId: number;
  readonly name?: string;
}

/** One sellable product, with its HSN code created if this is the first to use it. */
export async function seedProduct(db: Queryable, options: SeedProductOptions): Promise<number> {
  await db.query(
    `INSERT INTO hsn_codes (hsn_code, description) VALUES ($1, 'Rice')
     ON CONFLICT (hsn_code) DO NOTHING`,
    [DEFAULT_HSN],
  );

  const baseUnitId = await queryId(db, `SELECT id FROM units WHERE short_name = 'Kg'`);
  const name = options.name ?? 'Test Basmati Rice 5 kg';

  return queryId(
    db,
    `INSERT INTO products (item_code, name, short_name, name_hi, hsn_code, tax_slab_id,
                           base_unit_id, mrp, sale_price)
     VALUES ($1, $2, 'RICE 5KG', 'चावल 5 किग्रा', $3, $4, $5, 520.00, 495.00)
     RETURNING id`,
    [options.itemCode, name, DEFAULT_HSN, options.taxSlabId, baseUnitId],
  );
}

/**
 * Records a slab change through the same helper production code uses. Kept as a
 * fixture only for the shorter positional signature; the close-then-open logic
 * itself lives in `catalog/product-history.ts`, so a test can never pass against
 * a path the importer and the edit screen do not take.
 */
export async function assignSlab(
  db: Queryable,
  productId: number,
  taxSlabId: number,
  from: Date,
  reason: string,
): Promise<void> {
  await assignProductSlab(db, { productId, taxSlabId, effectiveFrom: from, reason });
}

/** `products.tax_slab_id` - the cache, read directly rather than resolved. */
export async function cachedSlabId(db: Queryable, productId: number): Promise<number> {
  return queryId(db, `SELECT tax_slab_id AS id FROM products WHERE id = $1`, [productId]);
}
