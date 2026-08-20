import type { ImportReport } from '@ssbazar/shared';

import { databaseNow } from '../db/clock.js';
import type { Queryable } from '../db/queryable.js';
import { asRow, readId, readNumeric, readText } from '../db/rows.js';
import { readCsvTable } from './csv.js';
import {
  type CatalogueLookups,
  CatalogueFileError,
  rateKey,
  validateCatalogueRows,
} from './import-validation.js';
import { CategoryCache, insertValidatedProduct, newHsnState } from './product-write.js';

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
 * What this file is, since the product master arrived, is the *file* half of
 * the catalogue: read a CSV, check it, report it. Checking is
 * `validateCatalogueRows` and writing is `insertValidatedProduct`, both shared
 * with the three views of the product master - so an imported product and one
 * typed into the create form are the same rows written by the same code
 * (docs/DECISIONS.md D41).
 *
 * Prices are taken as the column defaults describe them: sale price and MRP
 * GST-inclusive, purchase price exclusive. That is how Indian retail quotes
 * them, and it is per-price rather than global for the reason in
 * `docs/schema.md` - get it wrong and every margin figure is out by the GST
 * rate.
 */

/** Onto every history row a file writes. The grid writes its own (D41). */
export const IMPORT_REASON = 'Catalogue import';

export interface ImportOptions {
  /** Validate and report without writing anything. */
  readonly dryRun?: boolean;
  readonly changedBy?: number | null;
}

/**
 * `ImportReport` is defined in `@ssbazar/shared` and re-exported here. The
 * import screen renders it in the renderer, so it crosses IPC and is declared
 * once, where both sides can see the same declaration (docs/DECISIONS.md D42).
 */
export type { ImportReport };

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

const BARCODES_SQL = `SELECT barcode, product_id FROM product_barcodes`;

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

  // Barcode -> the product wearing it, not just the set of taken codes. The
  // import only ever asks "is this taken", but the edit screen asks "is this
  // taken by somebody else", and both questions are answered by one map rather
  // than by two barcode rules (docs/DECISIONS.md D41).
  const barcodeOwners = new Map<string, number>();
  const barcodes = await db.query(BARCODES_SQL);
  for (const value of barcodes.rows) {
    const row = asRow(value);
    barcodeOwners.set(readText(row, 'barcode'), readId(row, 'product_id'));
  }

  return { unitIdByName, slabIdByRate, barcodeOwners };
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
  const hsn = newHsnState();

  for (const row of valid) {
    await insertValidatedProduct(db, row, {
      categories,
      hsn,
      effectiveFrom,
      changedBy,
      reason: IMPORT_REASON,
    });
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
