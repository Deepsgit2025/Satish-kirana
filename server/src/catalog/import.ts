import { databaseNow } from '../db/clock.js';
import type { Queryable } from '../db/queryable.js';
import { asRow, firstRow, readId, readNumeric, readText } from '../db/rows.js';
import { readCsvTable } from './csv.js';
import {
  type CatalogueLookups,
  CatalogueFileError,
  rateKey,
  type RowIssue,
  type ValidCatalogueRow,
  validateCatalogueRows,
} from './import-validation.js';
import { assignProductPrice, assignProductSlab } from './product-history.js';

/**
 * The catalogue import: a file in, products out, and a list of the rows that
 * did not make it.
 *
 * No transaction handling here - the caller supplies the session, so the CLI
 * can wrap the whole load in one transaction and a test can roll it back. The
 * valid rows commit together or not at all; the *rejected* rows are not part of
 * that bargain, because they were never going to be written and their report is
 * the point of the exercise.
 *
 * Two things the loader creates rather than refusing:
 *
 *   **Categories.** `products.category_id` is nullable and the client is
 *   building the aisle structure at the same time as the catalogue. Blocking
 *   several thousand rows on a tree that is not finished helps nobody.
 *
 *   **HSN codes.** `products.hsn_code` is a foreign key, so a code that appears
 *   in the file and not in `hsn_codes` would fail the insert. The row already
 *   proved the code is six digits, and the file is the authority on which codes
 *   this shop trades under.
 *
 * Prices are taken as the column defaults describe them: sale price and MRP
 * GST-inclusive, purchase price exclusive. That is how Indian retail quotes
 * them, and it is per-price rather than global for the reason in
 * `docs/schema.md` - get it wrong and every margin figure is out by the GST
 * rate.
 */

export interface ImportOptions {
  /** Validate and report without writing anything. */
  readonly dryRun?: boolean;
  readonly changedBy?: number | null;
}

export interface ImportReport {
  readonly dryRun: boolean;
  /** Data rows in the file, excluding the heading. */
  readonly totalRows: number;
  readonly imported: number;
  readonly rejected: number;
  readonly issues: readonly RowIssue[];
  readonly categoriesCreated: readonly string[];
  readonly hsnCodesCreated: readonly string[];
}

const UNITS_SQL = `
  SELECT id, lower(name) AS name, lower(short_name) AS short_name
    FROM units
   WHERE is_active`;

/**
 * Slabs in force today. A rate that was abolished - 12% and 28% went in the
 * GST 2.0 rationalisation - deliberately does not resolve, so a spreadsheet
 * carried over from before September 2025 reports every such row instead of
 * quietly importing at a rate the shop may not legally charge.
 */
const SLABS_SQL = `
  SELECT id, name, igst_rate
    FROM tax_slabs
   WHERE is_active
     AND effective_from <= current_date
     AND (effective_to IS NULL OR effective_to >= current_date)`;

const BARCODES_SQL = `SELECT barcode FROM product_barcodes`;

export async function loadCatalogueLookups(db: Queryable): Promise<CatalogueLookups> {
  const unitIdByName = new Map<string, number>();
  const units = await db.query(UNITS_SQL);
  for (const value of units.rows) {
    const row = asRow(value);
    const id = readId(row, 'id');
    unitIdByName.set(readText(row, 'name'), id);
    unitIdByName.set(readText(row, 'short_name'), id);
  }

  const slabIdByRate = new Map<number, number>();
  const slabs = await db.query(SLABS_SQL);
  for (const value of slabs.rows) {
    const row = asRow(value);
    const key = rateKey(readNumeric(row, 'igst_rate'));
    const existing = slabIdByRate.get(key);
    if (existing !== undefined) {
      // Two slabs in force at one rate makes "tax_rate 5" ambiguous, and
      // guessing would put a rate on thousands of products by coin toss.
      throw new CatalogueFileError('error.catalogue.ambiguous_slab', {
        slab: readText(row, 'name'),
      });
    }
    slabIdByRate.set(key, readId(row, 'id'));
  }

  const existingBarcodes = new Set<string>();
  const barcodes = await db.query(BARCODES_SQL);
  for (const value of barcodes.rows) existingBarcodes.add(readText(asRow(value), 'barcode'));

  return { unitIdByName, slabIdByRate, existingBarcodes };
}

/** EAN-13 off a product; anything else was keyed in or generated in-store. */
function barcodeTypeFor(barcode: string): 'ean13' | 'manual' {
  return /^\d{13}$/.test(barcode) ? 'ean13' : 'manual';
}

class CategoryCache {
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

interface HsnState {
  /** Codes this run has already dealt with, present or absent. */
  readonly attempted: Set<string>;
  /** Codes this run actually added, for the report. */
  readonly created: Set<string>;
}

async function ensureHsnCode(
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

async function loadRow(
  db: Queryable,
  row: ValidCatalogueRow,
  context: {
    readonly categories: CategoryCache;
    readonly hsn: HsnState;
    readonly effectiveFrom: Date;
    readonly changedBy: number | null;
  },
): Promise<void> {
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

  // Both histories opened through the same helpers the edit screen will use,
  // so an imported product and an edited one are indistinguishable afterwards.
  await assignProductPrice(db, {
    productId,
    salePrice: row.salePrice,
    mrp: row.mrp,
    taxType: 'inclusive',
    effectiveFrom: context.effectiveFrom,
    reason: 'Catalogue import',
    changedBy: context.changedBy,
  });

  await assignProductSlab(db, {
    productId,
    taxSlabId: row.taxSlabId,
    effectiveFrom: context.effectiveFrom,
    reason: 'Catalogue import',
    changedBy: context.changedBy,
  });
}

/**
 * Validates a catalogue file and, unless this is a dry run, writes the rows
 * that passed.
 *
 * Throws only when the file cannot be read at all - unparseable, or missing a
 * required heading. Everything else comes back in the report.
 */
export async function importCatalogue(
  db: Queryable,
  text: string,
  options: ImportOptions = {},
): Promise<ImportReport> {
  const dryRun = options.dryRun ?? false;
  const changedBy = options.changedBy ?? null;

  const table = readCsvTable(text);
  const lookups = await loadCatalogueLookups(db);
  const { valid, issues } = validateCatalogueRows(table, lookups);

  if (dryRun) {
    return {
      dryRun: true,
      totalRows: table.rows.length,
      imported: 0,
      rejected: table.rows.length - valid.length,
      issues,
      categoriesCreated: [],
      hsnCodesCreated: [],
    };
  }

  // From the database, not from `new Date()`. now() is the transaction
  // timestamp, and a row dated a few milliseconds ahead of it is in force
  // nowhere - the tax cache trigger would leave every imported product looking
  // like drift (CLAUDE.md, Working practices).
  const effectiveFrom = await databaseNow(db);
  const categories = new CategoryCache(db);
  const hsn: HsnState = { attempted: new Set(), created: new Set() };

  for (const row of valid) {
    await loadRow(db, row, { categories, hsn, effectiveFrom, changedBy });
  }

  return {
    dryRun: false,
    totalRows: table.rows.length,
    imported: valid.length,
    rejected: table.rows.length - valid.length,
    issues,
    categoriesCreated: categories.created,
    hsnCodesCreated: [...hsn.created],
  };
}
