import {
  CATALOGUE_COLUMNS,
  type CatalogueValues,
  type IssueKey,
  type MessageParams,
  OPTIONAL_COLUMNS,
  REQUIRED_COLUMNS,
  type RowIssue,
  TranslatableError,
  type TranslationKey,
} from '@ssbazar/shared';

import type { CsvRow, CsvTable } from './csv.js';

/**
 * Validating a catalogue file, as a pure function.
 *
 * No database in here. Everything it needs to look up - units, slabs, the
 * barcodes already in the system - arrives as `CatalogueLookups`, which makes
 * the whole rule set testable without a Postgres round trip per case, and makes
 * it obvious what the import actually depends on.
 *
 * Two principles the rest of this file follows:
 *
 *   **A bad row is reported, never fatal.** A 2,000-row file with 30 bad rows
 *   imports 1,970. Abandoning the file over one row means the client fixes one
 *   error, re-runs, and finds the next one - thirty round trips instead of one.
 *
 *   **Every problem in a row is reported, not just the first.** Same reason. If
 *   a row has a short HSN *and* a unit that does not exist, saying so once is
 *   worth two passes through the spreadsheet.
 *
 * A missing column heading *is* fatal, because it is a property of the file
 * rather than of a row, and every row would report the same thing.
 *
 * **No reason is written as a sentence here.** Every one is a key into
 * `catalogue.issue.*` plus the numbers that go in it. The client keying the
 * spreadsheet is the person who reads this report, and `--dry-run` against his
 * own file is the whole reason the import core shipped before any screen
 * (`docs/DECISIONS.md` D34) - a report he cannot read is a report that does not
 * do its job. Rendering happens once, in the CLI, in his language.
 */

/**
 * `RowIssue`, `IssueKey`, `CatalogueValues` and the column lists are defined in
 * `@ssbazar/shared` rather than here, and re-exported so this file stays the
 * one place the validator's callers import from.
 *
 * They are there because they cross the IPC boundary: the product master
 * renders exactly these issues, against exactly these columns, in a different
 * JavaScript context from the one that produced them (docs/DECISIONS.md D42).
 * Declaring them on each side would let the two drift while both still
 * compiled.
 */
export type { CatalogueValues, IssueKey, RowIssue };

/**
 * A row on its way in, from wherever.
 *
 * The CSV parser produces exactly this shape already, which is what lets the
 * product master hand the same checks a row assembled from a form or a grid
 * cell (docs/DECISIONS.md D41). Values are strings on both routes on purpose:
 * a form field and a spreadsheet cell both hold text, and validating the text
 * is what makes "must be exactly 6 digits" mean the same thing in both places.
 */
export interface SourceRow extends CsvRow {
  /**
   * The product this row edits, or null/absent when it creates one. Only the
   * barcode check reads it - a product's own barcode is not "already in the
   * system" as far as editing that product goes.
   */
  readonly productId?: number | null;
}

/** A row that passed every check, with lookups already resolved to ids. */
export interface ValidCatalogueRow {
  readonly line: number;
  /** Null on a create, which is every row of an import. */
  readonly productId: number | null;
  readonly barcode: string;
  readonly name: string;
  readonly nameHi: string | null;
  readonly shortName: string;
  readonly hsnCode: string;
  readonly taxSlabId: number;
  /** Money stays as exact decimal text all the way to NUMERIC. Never a float. */
  readonly mrp: string;
  readonly salePrice: string;
  readonly purchasePrice: string;
  readonly baseUnitId: number;
  readonly categoryName: string | null;
  readonly reorderLevel: string;
}

export interface CatalogueLookups {
  /** Unit name and short name, both lowercased, to unit id. */
  readonly unitIdByName: ReadonlyMap<string, number>;
  /** Total GST rate in hundredths - 5% is 500 - to the id of the slab in force. */
  readonly slabIdByRate: ReadonlyMap<number, number>;
  /**
   * Every barcode in the system, to the product wearing it.
   *
   * A set would answer "is this taken", which is the only question an import
   * asks, and the wrong question everywhere else: on an edit screen every
   * product's own barcode is taken, by itself. Carrying the owner is what lets
   * one rule serve a create, an edit and two hundred rows of a bulk grid
   * without any of them getting a private version of it (D41).
   */
  readonly barcodeOwners: ReadonlyMap<string, number>;
}

export interface ValidationResult {
  readonly valid: ValidCatalogueRow[];
  readonly issues: RowIssue[];
}

type CatalogueErrorKey = Extract<TranslationKey, `error.catalogue.${string}`>;

/** The file itself is unusable. Same reasoning as `CsvError`. */
export class CatalogueFileError extends TranslatableError {
  constructor(messageKey: CatalogueErrorKey, params: MessageParams = {}) {
    super(messageKey, params);
    this.name = 'CatalogueFileError';
  }
}

export { CATALOGUE_COLUMNS, OPTIONAL_COLUMNS, REQUIRED_COLUMNS };

/** NUMERIC(12,2): ten digits before the point, two after. */
const MONEY = /^\d{1,10}(\.\d{1,2})?$/;
/** NUMERIC(12,3). */
const QUANTITY = /^\d{1,9}(\.\d{1,3})?$/;
const RATE = /^\d{1,3}(\.\d{1,2})?$/;
const HSN = /^\d{6}$/;

const MAX_BARCODE = 48;
const MAX_SHORT_NAME = 30;
const MAX_CATEGORY = 60;

/** Rates compare as integer hundredths so 5, 5.0 and 5.00 are one key. */
export function rateKey(rate: number): number {
  return Math.round(rate * 100);
}

function isPositive(decimal: string): boolean {
  return Number.parseFloat(decimal) > 0;
}

class RowChecker {
  readonly issues: RowIssue[] = [];

  private readonly row: SourceRow;

  constructor(row: SourceRow) {
    this.row = row;
  }

  get line(): number {
    return this.row.line;
  }

  /** The product being edited, or null when this row creates one. */
  get productId(): number | null {
    return this.row.productId ?? null;
  }

  get ok(): boolean {
    return this.issues.length === 0;
  }

  value(column: string): string {
    return this.row.values.get(column) ?? '';
  }

  fail(column: string, reasonKey: IssueKey, reasonParams: MessageParams = {}): void {
    this.issues.push({
      line: this.row.line,
      column,
      value: this.value(column),
      reasonKey,
      reasonParams,
    });
  }

  /** Present and non-empty, or an issue. */
  required(column: string): string | null {
    const value = this.value(column);
    if (value.length === 0) {
      this.fail(column, 'catalogue.issue.required');
      return null;
    }
    return value;
  }

  maxLength(column: string, value: string, limit: number): boolean {
    if (value.length <= limit) return true;
    this.fail(column, 'catalogue.issue.too_long', { limit, length: value.length });
    return false;
  }
}

function checkHeader(table: CsvTable): void {
  const missing = REQUIRED_COLUMNS.filter((column) => !table.columns.includes(column));
  if (missing.length > 0) {
    throw new CatalogueFileError('error.catalogue.missing_columns', {
      missing: missing.join(', '),
      expected: [...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS].join(', '),
    });
  }
}

function checkBarcode(
  checker: RowChecker,
  lookups: CatalogueLookups,
  firstSeenAt: Map<string, number>,
): string | null {
  const barcode = checker.required('barcode');
  if (barcode === null) return null;
  if (!checker.maxLength('barcode', barcode, MAX_BARCODE)) return null;

  const earlier = firstSeenAt.get(barcode);
  if (earlier !== undefined) {
    checker.fail('barcode', 'catalogue.issue.barcode_duplicate_in_file', { line: earlier });
    return null;
  }
  // Claimed even when the row fails elsewhere, so a barcode repeated three
  // times reports against its first appearance every time rather than
  // chaining line 2 -> line 5 -> line 9.
  firstSeenAt.set(barcode, checker.line);

  // Taken by somebody else. A product keeping its own barcode through an edit
  // is not a collision, and rejecting it would make every edit fail on the one
  // field the operator did not touch.
  const owner = lookups.barcodeOwners.get(barcode);
  if (owner !== undefined && owner !== checker.productId) {
    checker.fail('barcode', 'catalogue.issue.barcode_in_system');
    return null;
  }
  return barcode;
}

function checkMoney(
  checker: RowChecker,
  column: string,
  options: { positive: boolean },
): string | null {
  const raw = checker.value(column);
  if (raw.length === 0) {
    if (options.positive) checker.fail(column, 'catalogue.issue.required');
    return options.positive ? null : '0';
  }
  if (!MONEY.test(raw)) {
    checker.fail(column, 'catalogue.issue.money_invalid');
    return null;
  }
  if (options.positive && !isPositive(raw)) {
    checker.fail(column, 'catalogue.issue.money_not_positive');
    return null;
  }
  return raw;
}

function checkRow(
  row: SourceRow,
  columnCount: number,
  lookups: CatalogueLookups,
  firstSeenAt: Map<string, number>,
): { valid?: ValidCatalogueRow; issues: RowIssue[] } {
  const checker = new RowChecker(row);

  if (row.fieldCount !== columnCount) {
    // Almost always an unquoted comma inside a name. Naming the likely cause
    // saves the client from counting columns by hand.
    checker.fail('(row)', 'catalogue.issue.field_count', {
      actual: row.fieldCount,
      expected: columnCount,
    });
    return { issues: checker.issues };
  }

  const barcode = checkBarcode(checker, lookups, firstSeenAt);
  const name = checker.required('name');
  const shortName = checker.required('short_name');
  if (shortName !== null) checker.maxLength('short_name', shortName, MAX_SHORT_NAME);

  const hsnCode = checker.required('hsn_code');
  if (hsnCode !== null && !HSN.test(hsnCode)) {
    checker.fail('hsn_code', 'catalogue.issue.hsn_not_six_digits');
  }

  let taxSlabId: number | undefined;
  const rateText = checker.required('tax_rate');
  if (rateText !== null) {
    if (!RATE.test(rateText)) {
      checker.fail('tax_rate', 'catalogue.issue.rate_not_a_percentage');
    } else {
      taxSlabId = lookups.slabIdByRate.get(rateKey(Number.parseFloat(rateText)));
      if (taxSlabId === undefined) {
        checker.fail('tax_rate', 'catalogue.issue.rate_no_slab_in_force');
      }
    }
  }

  const mrp = checkMoney(checker, 'mrp', { positive: true });
  const salePrice = checkMoney(checker, 'sale_price', { positive: true });
  const purchasePrice = checkMoney(checker, 'purchase_price', { positive: false });

  // Selling above the printed maximum retail price is an offence, not a
  // pricing decision. Catching it here is far cheaper than catching it on a
  // shelf label (docs/DECISIONS.md D16).
  if (mrp !== null && salePrice !== null && Number.parseFloat(salePrice) > Number.parseFloat(mrp)) {
    checker.fail('sale_price', 'catalogue.issue.sale_price_above_mrp', { mrp });
  }

  let baseUnitId: number | undefined;
  const unit = checker.required('unit');
  if (unit !== null) {
    baseUnitId = lookups.unitIdByName.get(unit.toLowerCase());
    if (baseUnitId === undefined) checker.fail('unit', 'catalogue.issue.unit_unknown');
  }

  const categoryRaw = checker.value('category');
  const category = categoryRaw.length === 0 ? null : categoryRaw;
  if (category !== null) checker.maxLength('category', category, MAX_CATEGORY);

  let reorderLevel = '0';
  const reorderRaw = checker.value('reorder_level');
  if (reorderRaw.length > 0) {
    if (QUANTITY.test(reorderRaw)) {
      reorderLevel = reorderRaw;
    } else {
      checker.fail('reorder_level', 'catalogue.issue.quantity_invalid');
    }
  }

  const nameHiRaw = checker.value('name_hi');

  if (
    !checker.ok ||
    barcode === null ||
    name === null ||
    shortName === null ||
    hsnCode === null ||
    mrp === null ||
    salePrice === null ||
    purchasePrice === null ||
    taxSlabId === undefined ||
    baseUnitId === undefined
  ) {
    return { issues: checker.issues };
  }

  return {
    valid: {
      line: row.line,
      productId: row.productId ?? null,
      barcode,
      name,
      nameHi: nameHiRaw.length === 0 ? null : nameHiRaw,
      shortName,
      hsnCode,
      taxSlabId,
      mrp,
      salePrice,
      purchasePrice,
      baseUnitId,
      categoryName: category,
      reorderLevel,
    },
    issues: [],
  };
}

/**
 * Builds a row for the validator out of column values, for the routes that have
 * no file behind them - the create form, the edit form, a line of the bulk
 * grid.
 *
 * `line` is whatever number the person is looking at: the grid row, or 1 for a
 * form. `fieldCount` is set to match, because a form cannot have the wrong
 * number of fields - that check exists for an unquoted comma in a CSV, and a
 * screen row must not be able to trip it.
 */
export function catalogueRow(
  line: number,
  values: Readonly<Partial<CatalogueValues>>,
  productId: number | null = null,
): SourceRow {
  const map = new Map<string, string>();
  const supplied: Readonly<Partial<Record<string, string>>> = values;
  for (const column of CATALOGUE_COLUMNS) map.set(column, supplied[column] ?? '');

  return { line, values: map, fieldCount: CATALOGUE_COLUMNS.length, productId };
}

/**
 * Checks a set of rows, whatever assembled them.
 *
 * This is the core of D41: the import, the create form, the edit form and the
 * bulk grid all arrive here, so there is one implementation of every rule and
 * one shape of complaint about it. A rule fixed here is fixed for all four,
 * which is the property that makes building three views cheaper than building
 * one and bolting the others on.
 */
export function validateSourceRows(
  rows: readonly SourceRow[],
  columnCount: number,
  lookups: CatalogueLookups,
): ValidationResult {
  const valid: ValidCatalogueRow[] = [];
  const issues: RowIssue[] = [];
  const firstSeenAt = new Map<string, number>();

  for (const row of rows) {
    const result = checkRow(row, columnCount, lookups, firstSeenAt);
    if (result.valid === undefined) issues.push(...result.issues);
    else valid.push(result.valid);
  }

  return { valid, issues };
}

/**
 * Checks every row of a parsed file. Throws only when the file itself is
 * unusable - a missing column heading - and otherwise returns the good rows and
 * the reasons the others were left out.
 */
export function validateCatalogueRows(
  table: CsvTable,
  lookups: CatalogueLookups,
): ValidationResult {
  checkHeader(table);
  return validateSourceRows(table.rows, table.columns.length, lookups);
}
