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
 */

export interface RowIssue {
  /** Physical line in the file - what the spreadsheet's row gutter shows. */
  readonly line: number;
  readonly column: string;
  readonly value: string;
  readonly reason: string;
}

/** A row that passed every check, with lookups already resolved to ids. */
export interface ValidCatalogueRow {
  readonly line: number;
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
  readonly existingBarcodes: ReadonlySet<string>;
}

export interface ValidationResult {
  readonly valid: ValidCatalogueRow[];
  readonly issues: RowIssue[];
}

export class CatalogueFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogueFileError';
  }
}

export const REQUIRED_COLUMNS = [
  'barcode',
  'name',
  'short_name',
  'hsn_code',
  'tax_rate',
  'mrp',
  'sale_price',
  'unit',
] as const;

export const OPTIONAL_COLUMNS = ['name_hi', 'purchase_price', 'category', 'reorder_level'] as const;

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

  private readonly row: CsvRow;

  constructor(row: CsvRow) {
    this.row = row;
  }

  get line(): number {
    return this.row.line;
  }

  get ok(): boolean {
    return this.issues.length === 0;
  }

  value(column: string): string {
    return this.row.values.get(column) ?? '';
  }

  fail(column: string, reason: string): void {
    this.issues.push({ line: this.row.line, column, value: this.value(column), reason });
  }

  /** Present and non-empty, or an issue. */
  required(column: string): string | null {
    const value = this.value(column);
    if (value.length === 0) {
      this.fail(column, 'required, but blank');
      return null;
    }
    return value;
  }

  maxLength(column: string, value: string, limit: number): boolean {
    if (value.length <= limit) return true;
    this.fail(column, `longer than ${String(limit)} characters (${String(value.length)})`);
    return false;
  }
}

function checkHeader(table: CsvTable): void {
  const missing = REQUIRED_COLUMNS.filter((column) => !table.columns.includes(column));
  if (missing.length > 0) {
    throw new CatalogueFileError(
      `The file is missing required column(s): ${missing.join(', ')}. ` +
        `Expected headings: ${[...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS].join(', ')}.`,
    );
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
    checker.fail('barcode', `already used on line ${String(earlier)} of this file`);
    return null;
  }
  // Claimed even when the row fails elsewhere, so a barcode repeated three
  // times reports against its first appearance every time rather than
  // chaining line 2 -> line 5 -> line 9.
  firstSeenAt.set(barcode, checker.line);

  if (lookups.existingBarcodes.has(barcode)) {
    checker.fail('barcode', 'already on a product in the system');
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
    if (options.positive) checker.fail(column, 'required, but blank');
    return options.positive ? null : '0';
  }
  if (!MONEY.test(raw)) {
    checker.fail(column, 'not a money amount (digits, optionally with up to 2 decimal places)');
    return null;
  }
  if (options.positive && !isPositive(raw)) {
    checker.fail(column, 'must be greater than zero');
    return null;
  }
  return raw;
}

function checkRow(
  row: CsvRow,
  columnCount: number,
  lookups: CatalogueLookups,
  firstSeenAt: Map<string, number>,
): { valid?: ValidCatalogueRow; issues: RowIssue[] } {
  const checker = new RowChecker(row);

  if (row.fieldCount !== columnCount) {
    // Almost always an unquoted comma inside a name. Naming the likely cause
    // saves the client from counting columns by hand.
    checker.fail(
      '(row)',
      `has ${String(row.fieldCount)} values but the heading has ${String(columnCount)} — ` +
        'a comma inside a name needs the value wrapped in double quotes',
    );
    return { issues: checker.issues };
  }

  const barcode = checkBarcode(checker, lookups, firstSeenAt);
  const name = checker.required('name');
  const shortName = checker.required('short_name');
  if (shortName !== null) checker.maxLength('short_name', shortName, MAX_SHORT_NAME);

  const hsnCode = checker.required('hsn_code');
  if (hsnCode !== null && !HSN.test(hsnCode)) {
    checker.fail('hsn_code', 'must be exactly 6 digits');
  }

  let taxSlabId: number | undefined;
  const rateText = checker.required('tax_rate');
  if (rateText !== null) {
    if (!RATE.test(rateText)) {
      checker.fail('tax_rate', 'not a percentage (for example 5, 12.5, 18)');
    } else {
      taxSlabId = lookups.slabIdByRate.get(rateKey(Number.parseFloat(rateText)));
      if (taxSlabId === undefined) {
        checker.fail('tax_rate', 'no GST slab in force at this rate');
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
    checker.fail('sale_price', `higher than mrp (${mrp}) — MRP is a legal maximum`);
  }

  let baseUnitId: number | undefined;
  const unit = checker.required('unit');
  if (unit !== null) {
    baseUnitId = lookups.unitIdByName.get(unit.toLowerCase());
    if (baseUnitId === undefined) checker.fail('unit', 'not a unit in the units master');
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
      checker.fail('reorder_level', 'not a quantity (digits, optionally up to 3 decimal places)');
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
 * Checks every row. Throws only when the file itself is unusable - a missing
 * column heading - and otherwise returns the good rows and the reasons the
 * others were left out.
 */
export function validateCatalogueRows(
  table: CsvTable,
  lookups: CatalogueLookups,
): ValidationResult {
  checkHeader(table);

  const valid: ValidCatalogueRow[] = [];
  const issues: RowIssue[] = [];
  const firstSeenAt = new Map<string, number>();

  for (const row of table.rows) {
    const result = checkRow(row, table.columns.length, lookups, firstSeenAt);
    if (result.valid === undefined) issues.push(...result.issues);
    else valid.push(result.valid);
  }

  return { valid, issues };
}
