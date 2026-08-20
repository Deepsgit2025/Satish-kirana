import {
  type BulkChange,
  type BulkField,
  type CatalogueValues,
  type EditResult,
  type MrpPolicy,
  restateInclusivePrice,
  type ProductDetail,
  type RowIssue,
  type SaveResult,
  type TaxRateSnapshot,
} from '@ssbazar/shared';

import { databaseNow } from '../db/clock.js';
import type { Queryable } from '../db/queryable.js';
import { asRow, readNullableText, readText } from '../db/rows.js';
import { loadCatalogueLookups } from './import.js';
import {
  CATALOGUE_COLUMNS,
  catalogueRow,
  type CatalogueLookups,
  type SourceRow,
  type ValidCatalogueRow,
  validateSourceRows,
} from './import-validation.js';
import { resolveProductTax } from './product-tax.js';
import {
  CategoryCache,
  type HsnState,
  insertValidatedProduct,
  newHsnState,
  type ProductBefore,
  toProductBefore,
  updateValidatedProduct,
} from './product-write.js';

/**
 * The product master's three views, as one core.
 *
 * `createProduct` and `updateProduct` are the single-product form.
 * `applyBulkEdit` is the grid: select rows, set one field, apply to all. The
 * list view is `product-search.ts`. All of them, and the CSV import beside
 * them, check rows with `validateSourceRows` and write them with
 * `insertValidatedProduct` / `updateValidatedProduct` - which is the condition
 * D41 attaches to building three views instead of one. A fourth route that
 * validated for itself would be a second copy of "sale price may not exceed
 * MRP" (D35), and the copy nobody hits the bug in is the copy that stays wrong.
 *
 * **A bulk change is validated as a whole row.** The grid sets one field, but
 * the row it produces is the product's current values with that field replaced,
 * and the whole thing goes through the validator. That is what makes a bulk
 * price rise get checked against each product's own MRP rather than sailing
 * past the one rule a file would have caught.
 *
 * **A bulk apply behaves like a file.** 200 selected and 8 bad means 192
 * applied and 8 reported, against their rows - the same bargain the importer
 * offers a 2,000-row spreadsheet, for the same reason. The rows that apply
 * commit together: no transaction handling here, so the caller wraps the call
 * and a test can roll it back.
 *
 * Nothing here writes `products.tax_slab_id`, `sale_price` or `mrp`. See
 * `product-write.ts` for why a shortcut there is a change that does not stick.
 */

/**
 * `MrpPolicy`, `BulkField`, `BulkChange`, `EditResult` and `SaveResult` are
 * defined in `@ssbazar/shared` and re-exported here. The grid builds a
 * `BulkChange` in the renderer and reads an `EditResult` back there, so both
 * shapes cross the IPC boundary and belong where both sides can see one
 * declaration of them (docs/DECISIONS.md D42).
 *
 * `EditOptions` stays here: `effectiveFrom` is a `Date`, which is not something
 * that travels. The contract carries an ISO string and `api.ts` parses it once.
 */
export type { BulkChange, BulkField, EditResult, MrpPolicy, SaveResult };

export interface EditOptions {
  /**
   * Onto `product_prices.reason` and `product_tax_assignments.reason` - the one
   * field that distinguishes this from the same change arriving in a file.
   */
  readonly reason: string;
  readonly changedBy?: number | null;
  /**
   * When the change takes effect. Omitted means now, from the database clock.
   *
   * A date in the future is the pending change itself (D27): the history row is
   * written today, no cache moves, and the nightly refresh advances both caches
   * on the day. A slab moved this way must carry its price with it on the same
   * date, which `applyBulkEdit` does - otherwise the new price would be charged
   * for a month under the old rate.
   */
  readonly effectiveFrom?: Date;
}

/** A product's current values, plus what is needed to tell what moved. */
interface ProductCurrent {
  readonly before: ProductBefore;
  readonly itemCode: string;
  readonly status: string;
  readonly values: CatalogueValues;
}

/**
 * Everything the validator needs about a product as it stands, keyed by the
 * catalogue column names.
 *
 * `tax_rate` comes from the slab the cache points at, which is the slab in
 * force now. Round-tripping it through the validator is an identity for any
 * product on a live slab, because `loadCatalogueLookups` refuses to build a
 * lookup where two slabs share a rate. A product sitting on an abolished slab
 * does not round-trip and reports `rate_no_slab_in_force` on any edit, which is
 * the honest answer: its rate is one the shop may not charge.
 */
const CURRENT_SQL = `
  SELECT p.id,
         p.item_code,
         p.status,
         p.name,
         p.name_hi,
         p.short_name,
         p.hsn_code,
         p.tax_slab_id,
         p.mrp,
         p.sale_price,
         p.purchase_price,
         p.reorder_level,
         b.barcode,
         u.short_name AS unit,
         c.name       AS category,
         s.igst_rate  AS tax_rate
    FROM products p
    LEFT JOIN product_barcodes b ON b.product_id = p.id AND b.is_primary
    LEFT JOIN categories c ON c.id = p.category_id
    JOIN units u ON u.id = p.base_unit_id
    JOIN tax_slabs s ON s.id = p.tax_slab_id
   WHERE p.id = ANY($1::bigint[])`;

export class ProductEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProductEditError';
  }
}

function toCurrent(value: unknown): ProductCurrent {
  const row = asRow(value);
  return {
    before: toProductBefore(row),
    itemCode: readText(row, 'item_code'),
    status: readText(row, 'status'),
    values: {
      barcode: readNullableText(row, 'barcode') ?? '',
      name: readText(row, 'name'),
      name_hi: readNullableText(row, 'name_hi') ?? '',
      short_name: readText(row, 'short_name'),
      hsn_code: readText(row, 'hsn_code'),
      tax_rate: readText(row, 'tax_rate'),
      mrp: readText(row, 'mrp'),
      sale_price: readText(row, 'sale_price'),
      purchase_price: readText(row, 'purchase_price'),
      unit: readText(row, 'unit'),
      category: readNullableText(row, 'category') ?? '',
      reorder_level: readText(row, 'reorder_level'),
    },
  };
}

/**
 * Loads the named products, in the order asked for.
 *
 * Order matters because `RowIssue.line` is a position in the request: the grid
 * has to be able to put a complaint back on the row that caused it, and the
 * database returns rows in whatever order suits it.
 */
async function loadCurrent(
  db: Queryable,
  productIds: readonly number[],
): Promise<ProductCurrent[]> {
  const { rows } = await db.query(CURRENT_SQL, [productIds]);

  const byId = new Map<number, ProductCurrent>();
  for (const value of rows) {
    const current = toCurrent(value);
    byId.set(current.before.productId, current);
  }

  return productIds.map((productId) => {
    const current = byId.get(productId);
    if (current === undefined) {
      // Not a row-level issue: the caller named a product that is not there, so
      // there is nothing to report against and nothing sensible to skip to.
      throw new ProductEditError(`No product with id ${String(productId)}.`);
    }
    return current;
  });
}

/**
 * The total GST a slab carries.
 *
 * **Not the sum of all four rates.** A `tax_slabs` row holds the same figure
 * twice - `igst_rate` for an inter-state supply and `cgst_rate + sgst_rate` for
 * an intra-state one, kept equal by `tax_slabs_split_matches_igst` in
 * `001_foundation.sql`. Adding them up doubles the rate: a 5% slab reads as
 * 10%, and a price restated through it comes out at ₹112.64 where the packet
 * says ₹118.
 *
 * `prepareLine` in the tax engine does sum all four, correctly, because a bill
 * line's rates are a snapshot where the caller has already chosen intra or
 * inter and zeroed the other (invariant 2). A slab row has made no such choice
 * yet. `loadCatalogueLookups` reads `igst_rate` as the slab's rate for the same
 * reason.
 */
function totalRateOf(rates: TaxRateSnapshot): number {
  return rates.igstRate + rates.cessRate;
}

/**
 * Applies one field change to a product's current values, and returns the row
 * that results.
 *
 * The tax case is the one with work in it. `keep` changes nothing but the rate;
 * `recompute` restates both printed figures through the single formula in
 * `@ssbazar/shared` so the shop's ex-GST realisation is unchanged. Both are then
 * validated like any other row, so a recomputed price that would cross the
 * product's MRP is reported rather than written (D35).
 */
async function changedValues(
  db: Queryable,
  current: ProductCurrent,
  change: BulkChange,
  effectiveFrom: Date,
  line: number,
): Promise<{ values: CatalogueValues; issues: RowIssue[] }> {
  const values: CatalogueValues = { ...current.values };
  values[change.field] = change.value;

  if (change.field !== 'tax_rate' || (change.mrpPolicy ?? 'keep') === 'keep') {
    return { values, issues: [] };
  }

  // The rate the printed price was set under, read at the date the change takes
  // effect rather than today - a reassignment dated next month has to restate
  // from whatever is in force then, not from whatever happens to be in force
  // while the operator is typing.
  const resolved = await resolveProductTax(db, current.before.productId, effectiveFrom);
  if (resolved === null) {
    return {
      values,
      issues: [
        {
          line,
          column: 'tax_rate',
          value: change.value,
          reasonKey: 'catalogue.issue.no_tax_in_force',
          reasonParams: { date: effectiveFrom.toISOString() },
        },
      ],
    };
  }

  const fromRate = totalRateOf(resolved.rates);
  const toRate = Number.parseFloat(change.value);
  if (!Number.isFinite(toRate)) return { values, issues: [] };

  // NUMERIC(12,2) both sides: two places out of the formula, two places into
  // the column, no float ever stored.
  values.sale_price = restateInclusivePrice(
    Number.parseFloat(current.values.sale_price),
    fromRate,
    toRate,
  ).toFixed(2);
  values.mrp = restateInclusivePrice(
    Number.parseFloat(current.values.mrp),
    fromRate,
    toRate,
  ).toFixed(2);

  return { values, issues: [] };
}

interface PreparedEdit {
  readonly rows: SourceRow[];
  readonly befores: ProductBefore[];
  readonly preIssues: RowIssue[];
}

/**
 * Validates the prepared rows and writes the ones that passed.
 *
 * `preIssues` are complaints raised while assembling a row - only the missing
 * tax history so far - and they land in the same report, because a row the
 * operator cannot see the problem with is a row they will try again.
 */
async function applyRows(
  db: Queryable,
  prepared: PreparedEdit,
  lookups: CatalogueLookups,
  options: EditOptions,
): Promise<{ result: EditResult; created: readonly number[] }> {
  const effectiveFrom = options.effectiveFrom ?? (await databaseNow(db));
  const changedBy = options.changedBy ?? null;

  const blocked = new Set(prepared.preIssues.map((issue) => issue.line));
  const checkable = prepared.rows.filter((row) => !blocked.has(row.line));
  const { valid, issues } = validateSourceRows(checkable, CATALOGUE_COLUMNS.length, lookups);

  const categories = new CategoryCache(db);
  const hsn: HsnState = newHsnState();
  const context = { categories, hsn, effectiveFrom, changedBy, reason: options.reason };

  const beforeById = new Map(prepared.befores.map((before) => [before.productId, before]));
  const created: number[] = [];

  for (const row of valid) {
    if (row.productId === null) {
      created.push(await insertValidatedProduct(db, row, context));
      continue;
    }
    const before = beforeById.get(row.productId);
    if (before === undefined) throw new ProductEditError('A validated row lost its product.');
    await updateValidatedProduct(db, row, before, context);
  }

  const allIssues = [...prepared.preIssues, ...issues].sort((a, b) => a.line - b.line);
  const rejectedLines = new Set(allIssues.map((issue) => issue.line));
  const rejectedProductIds = prepared.rows.flatMap((row) =>
    rejectedLines.has(row.line) && row.productId !== null && row.productId !== undefined
      ? [row.productId]
      : [],
  );

  return {
    result: {
      applied: valid.length,
      rejected: rejectedLines.size,
      issues: allIssues,
      rejectedProductIds,
      categoriesCreated: categories.created,
      hsnCodesCreated: [...hsn.created],
    },
    created,
  };
}

/**
 * Creates one product from the single-product form.
 *
 * The same code path as a row of a CSV, which is the point: a product typed in
 * by hand and one loaded from the client's spreadsheet are indistinguishable
 * afterwards, down to the generated item code and the two opened history rows.
 */
export async function createProduct(
  db: Queryable,
  fields: Readonly<Partial<CatalogueValues>>,
  options: EditOptions,
): Promise<SaveResult> {
  const lookups = await loadCatalogueLookups(db);
  const prepared: PreparedEdit = {
    rows: [catalogueRow(1, fields)],
    befores: [],
    preIssues: [],
  };

  const { result, created } = await applyRows(db, prepared, lookups, options);
  return { ...result, productId: created[0] ?? null };
}

/**
 * Saves the single-product form over an existing product.
 *
 * `fields` is the whole row as the form holds it, not a patch: the form shows
 * every column, so it submits every column, and the validator sees a complete
 * row exactly as it does for an import.
 */
export async function updateProduct(
  db: Queryable,
  productId: number,
  fields: Readonly<Partial<CatalogueValues>>,
  options: EditOptions,
): Promise<EditResult> {
  const lookups = await loadCatalogueLookups(db);
  const [current] = await loadCurrent(db, [productId]);
  if (current === undefined) throw new ProductEditError('No product to update.');

  const prepared: PreparedEdit = {
    rows: [catalogueRow(1, fields, productId)],
    befores: [current.before],
    preIssues: [],
  };

  const { result } = await applyRows(db, prepared, lookups, options);
  return result;
}

/**
 * What the grid selected and what it is setting.
 *
 * Named a selection rather than a request because the contract owns the word
 * `BulkEditRequest` - that one carries the reason, the operator and an ISO
 * date across the wire, and `api.ts` splits it into this plus `EditOptions`.
 */
export interface BulkSelection {
  /** In the order the grid shows them: `RowIssue.line` is a position in this. */
  readonly productIds: readonly number[];
  readonly change: BulkChange;
}

/**
 * Sets one field across many products.
 *
 * Each product's current row is materialised, the one field is replaced, and
 * the result is validated whole - so this cannot apply a change the equivalent
 * CSV would have rejected. What it writes is what an import of the same values
 * writes: one `product_prices` row and/or one `product_tax_assignments` row per
 * product that actually moved, close-then-open through the shared helpers, same
 * `changed_by`, same `effective_from`. Only `reason` differs, which is the
 * field whose job is to differ.
 */
export async function applyBulkEdit(
  db: Queryable,
  request: BulkSelection,
  options: EditOptions,
): Promise<EditResult> {
  if (request.productIds.length === 0) {
    return {
      applied: 0,
      rejected: 0,
      issues: [],
      rejectedProductIds: [],
      categoriesCreated: [],
      hsnCodesCreated: [],
    };
  }

  const lookups = await loadCatalogueLookups(db);
  const effectiveFrom = options.effectiveFrom ?? (await databaseNow(db));
  const current = await loadCurrent(db, request.productIds);

  const rows: SourceRow[] = [];
  const preIssues: RowIssue[] = [];

  for (const [index, product] of current.entries()) {
    const line = index + 1;
    const { values, issues } = await changedValues(
      db,
      product,
      request.change,
      effectiveFrom,
      line,
    );
    rows.push(catalogueRow(line, values, product.before.productId));
    preIssues.push(...issues);
  }

  const prepared: PreparedEdit = {
    rows,
    befores: current.map((product) => product.before),
    preIssues,
  };

  // effectiveFrom is resolved once above and passed on, so every product in one
  // bulk run carries the identical instant. Resolving it per row would spread
  // one change across a range of timestamps and make "what changed at 14:02"
  // unanswerable.
  const { result } = await applyRows(db, prepared, lookups, { ...options, effectiveFrom });
  return result;
}

/** Re-exported so a caller does not need to know which file assembles a row. */
export { catalogueRow, type CatalogueValues, type RowIssue, type ValidCatalogueRow };

/**
 * One product as the single-product form holds it: its current values in the
 * catalogue vocabulary, ready to be shown, changed and handed back to
 * `updateProduct`.
 *
 * The form is populated from the same shape it submits, so a save that changes
 * nothing writes nothing - there is no round trip through a different
 * representation for a value to be reformatted in and look edited.
 */
export async function readProductDetail(db: Queryable, productId: number): Promise<ProductDetail> {
  const [current] = await loadCurrent(db, [productId]);
  if (current === undefined) throw new ProductEditError('No product to read.');

  return {
    productId: current.before.productId,
    itemCode: current.itemCode,
    status: current.status,
    values: current.values,
  };
}
