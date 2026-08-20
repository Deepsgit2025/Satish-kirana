import type { Queryable } from '../db/queryable.js';
import { asRow, firstRow, readId, readNullableText } from '../db/rows.js';
import type { ValidCatalogueRow } from './import-validation.js';
import { assignProductPrice, assignProductSlab } from './product-history.js';

/**
 * Turning a validated row into rows in the database.
 *
 * Every route that creates or changes a product ends up here - the CSV import,
 * the create form, the edit form and the bulk grid (docs/DECISIONS.md D41). The
 * point of the file existing is that there is nowhere else to do it: a bulk
 * path that wrote its own UPDATE would be shorter, would appear to work, and
 * would be undone by `refresh_product_price_cache()` or
 * `refresh_product_tax_slab_cache()` the same night, because
 * `products.tax_slab_id`, `sale_price` and `mrp` are caches of the history
 * tables and the nightly job puts them back (D27, D28).
 *
 * So nothing in here writes those three columns on an update. It writes the
 * history through `assignProductSlab` / `assignProductPrice` and lets the
 * triggers in `004_product_tax_cache.sql` and `009_product_price_cache.sql`
 * move the cache - immediately for a change in force now, on the night for one
 * dated ahead.
 *
 * Two things it creates rather than refusing, on every route:
 *
 *   **Categories.** `products.category_id` is nullable and the client is
 *   building the aisle structure at the same time as the catalogue.
 *
 *   **HSN codes.** `products.hsn_code` is a foreign key, so a code that is not
 *   in `hsn_codes` would fail the write. The row already proved it is six
 *   digits, and the shop is the authority on which codes it trades under.
 */

export interface WriteContext {
  readonly categories: CategoryCache;
  readonly hsn: HsnState;
  /**
   * When the price and slab history this write opens takes effect. From
   * `databaseNow()`, never `new Date()` (CLAUDE.md, Working practices). A date
   * in the future is a pending change and moves no cache today.
   */
  readonly effectiveFrom: Date;
  readonly changedBy: number | null;
  /**
   * Why, onto `product_prices.reason` and `product_tax_assignments.reason`.
   *
   * The one field that differs between a row that arrived in a file and the
   * same row typed into the grid, and the only one that should: it is read by
   * whoever has to explain a rate on an old bill, and "Catalogue import" and
   * "GST 2.0 reassignment" are different answers to that question.
   */
  readonly reason: string;
}

/** EAN-13 off a product; anything else was keyed in or generated in-store. */
export function barcodeTypeFor(barcode: string): 'ean13' | 'manual' {
  return /^\d{13}$/.test(barcode) ? 'ean13' : 'manual';
}

export class CategoryCache {
  private readonly ids = new Map<string, number>();
  readonly created: string[] = [];

  private readonly db: Queryable;

  constructor(db: Queryable) {
    this.db = db;
  }

  async idFor(name: string): Promise<number> {
    const key = name.toLowerCase();
    const known = this.ids.get(key);
    if (known !== undefined) return known;

    const found = await this.db.query(
      `SELECT id FROM categories WHERE parent_id IS NULL AND lower(name) = $1`,
      [key],
    );
    if (found.rows.length > 0) {
      const id = readId(asRow(found.rows[0]), 'id');
      this.ids.set(key, id);
      return id;
    }

    const inserted = await this.db.query(`INSERT INTO categories (name) VALUES ($1) RETURNING id`, [
      name,
    ]);
    const id = readId(firstRow(inserted.rows), 'id');
    // Materialised path, same shape the office screen maintains: a root's path
    // is just itself, so "everything under this" stays one LIKE.
    await this.db.query(`UPDATE categories SET path = '/' || id || '/' WHERE id = $1`, [id]);

    this.ids.set(key, id);
    this.created.push(name);
    return id;
  }
}

export interface HsnState {
  /** Codes this run has already dealt with, present or absent. */
  readonly attempted: Set<string>;
  /** Codes this run actually added, for the report. */
  readonly created: Set<string>;
}

export function newHsnState(): HsnState {
  return { attempted: new Set(), created: new Set() };
}

export async function ensureHsnCode(
  db: Queryable,
  hsnCode: string,
  taxSlabId: number,
  state: HsnState,
): Promise<void> {
  if (state.attempted.has(hsnCode)) return;
  state.attempted.add(hsnCode);

  const result = await db.query(
    `INSERT INTO hsn_codes (hsn_code, default_tax_slab_id) VALUES ($1, $2)
     ON CONFLICT (hsn_code) DO NOTHING
     RETURNING hsn_code`,
    [hsnCode, taxSlabId],
  );
  if (result.rows.length > 0) state.created.add(hsnCode);
}

const INSERT_PRODUCT_SQL = `
  INSERT INTO products (item_code, name, name_hi, short_name, category_id, hsn_code, tax_slab_id,
                        base_unit_id, mrp, sale_price, purchase_price, reorder_level, created_by)
  VALUES (next_item_code(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
  RETURNING id`;

const INSERT_BARCODE_SQL = `
  INSERT INTO product_barcodes (product_id, barcode, barcode_type, is_primary, created_by)
  VALUES ($1, $2, $3, true, $4)`;

/**
 * Creates a product from a row that has already passed the validator, and
 * returns its id.
 *
 * `tax_slab_id`, `mrp` and `sale_price` go onto the INSERT because the columns
 * are NOT NULL and the product has to exist before its history can reference
 * it. The two history rows that follow immediately restate the same figures
 * through the triggers, so the caches are the triggers' answer from the first
 * moment rather than the INSERT's.
 */
export async function insertValidatedProduct(
  db: Queryable,
  row: ValidCatalogueRow,
  context: WriteContext,
): Promise<number> {
  const categoryId =
    row.categoryName === null ? null : await context.categories.idFor(row.categoryName);

  await ensureHsnCode(db, row.hsnCode, row.taxSlabId, context.hsn);

  const inserted = await db.query(INSERT_PRODUCT_SQL, [
    row.name,
    row.nameHi,
    row.shortName,
    categoryId,
    row.hsnCode,
    row.taxSlabId,
    row.baseUnitId,
    row.mrp,
    row.salePrice,
    row.purchasePrice,
    row.reorderLevel,
    context.changedBy,
  ]);
  const productId = readId(firstRow(inserted.rows), 'id');

  await db.query(INSERT_BARCODE_SQL, [
    productId,
    row.barcode,
    barcodeTypeFor(row.barcode),
    context.changedBy,
  ]);

  await assignProductPrice(db, {
    productId,
    salePrice: row.salePrice,
    mrp: row.mrp,
    taxType: 'inclusive',
    effectiveFrom: context.effectiveFrom,
    reason: context.reason,
    changedBy: context.changedBy,
  });

  await assignProductSlab(db, {
    productId,
    taxSlabId: row.taxSlabId,
    effectiveFrom: context.effectiveFrom,
    reason: context.reason,
    changedBy: context.changedBy,
  });

  return productId;
}

/** What the product held before the edit, for deciding what actually moved. */
export interface ProductBefore {
  readonly productId: number;
  readonly taxSlabId: number;
  readonly salePrice: string;
  readonly mrp: string;
  readonly barcode: string | null;
}

const UPDATE_PRODUCT_SQL = `
  UPDATE products
     SET name           = $2,
         name_hi        = $3,
         short_name     = $4,
         category_id    = $5,
         hsn_code       = $6,
         base_unit_id   = $7,
         purchase_price = $8,
         reorder_level  = $9
   WHERE id = $1`;

/**
 * Applies a validated row to a product that already exists.
 *
 * What is deliberately missing from `UPDATE_PRODUCT_SQL` is the whole point of
 * this function: `tax_slab_id`, `sale_price` and `mrp` are not in it. Those
 * move by writing history, and a bulk edit that set them directly would be
 * reverted by the nightly refresh the same night - reporting success at 11am
 * and gone by morning, with nothing on screen having lied at the time.
 *
 * **History is written only for what changed.** Re-opening an unchanged price
 * because somebody fixed a typo in the name would close the row that records
 * when the price really started, and the answer to "since when has this cost
 * ₹495" would quietly become "since the typo".
 */
export async function updateValidatedProduct(
  db: Queryable,
  row: ValidCatalogueRow,
  before: ProductBefore,
  context: WriteContext,
): Promise<void> {
  const categoryId =
    row.categoryName === null ? null : await context.categories.idFor(row.categoryName);

  await ensureHsnCode(db, row.hsnCode, row.taxSlabId, context.hsn);

  await db.query(UPDATE_PRODUCT_SQL, [
    before.productId,
    row.name,
    row.nameHi,
    row.shortName,
    categoryId,
    row.hsnCode,
    row.baseUnitId,
    row.purchasePrice,
    row.reorderLevel,
  ]);

  if (before.barcode !== row.barcode) {
    await writePrimaryBarcode(db, before, row.barcode, context.changedBy);
  }

  // NUMERIC comes back from Postgres as text - '495.00' - and the row carries
  // whatever the operator typed, which may be '495'. Compared as numbers, so
  // re-saving a form without touching it opens no history.
  const priceMoved =
    Number.parseFloat(before.salePrice) !== Number.parseFloat(row.salePrice) ||
    Number.parseFloat(before.mrp) !== Number.parseFloat(row.mrp);

  if (priceMoved) {
    await assignProductPrice(db, {
      productId: before.productId,
      salePrice: row.salePrice,
      mrp: row.mrp,
      taxType: 'inclusive',
      effectiveFrom: context.effectiveFrom,
      reason: context.reason,
      changedBy: context.changedBy,
    });
  }

  if (before.taxSlabId !== row.taxSlabId) {
    await assignProductSlab(db, {
      productId: before.productId,
      taxSlabId: row.taxSlabId,
      effectiveFrom: context.effectiveFrom,
      reason: context.reason,
      changedBy: context.changedBy,
    });
  }
}

/**
 * Moves the primary barcode. A product with none yet - possible only for one
 * created outside these routes - gets one rather than silently keeping nothing.
 */
async function writePrimaryBarcode(
  db: Queryable,
  before: ProductBefore,
  barcode: string,
  changedBy: number | null,
): Promise<void> {
  if (before.barcode === null) {
    await db.query(INSERT_BARCODE_SQL, [
      before.productId,
      barcode,
      barcodeTypeFor(barcode),
      changedBy,
    ]);
    return;
  }

  await db.query(
    `UPDATE product_barcodes
        SET barcode = $2, barcode_type = $3
      WHERE product_id = $1 AND is_primary`,
    [before.productId, barcode, barcodeTypeFor(barcode)],
  );
}

/** Reads back what a product held, for `updateValidatedProduct`. */
export function toProductBefore(value: unknown): ProductBefore {
  const row = asRow(value);
  return {
    productId: readId(row, 'id'),
    taxSlabId: readId(row, 'tax_slab_id'),
    salePrice: readNullableText(row, 'sale_price') ?? '0',
    mrp: readNullableText(row, 'mrp') ?? '0',
    barcode: readNullableText(row, 'barcode'),
  };
}
