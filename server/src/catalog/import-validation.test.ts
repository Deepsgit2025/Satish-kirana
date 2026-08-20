import { describe, expect, it } from 'vitest';

import { readCsvTable } from './csv.js';
import {
  type CatalogueLookups,
  CatalogueFileError,
  catalogueRow,
  rateKey,
  validateCatalogueRows,
  validateSourceRows,
} from './import-validation.js';

/**
 * The rule set, tested without a database.
 *
 * Every lookup the validator needs is injected, so a case costs nothing to add
 * and the file can cover the awkward rows a real catalogue contains rather than
 * the three someone would click through in a screen.
 */

const HEADER =
  'barcode,name,name_hi,short_name,hsn_code,tax_rate,mrp,sale_price,purchase_price,unit,category,reorder_level';

const GOOD_ROW = '8901234567890,Basmati Rice 5kg,चावल,RICE 5KG,100630,5,520,495,410,Kg,Grocery,10';

const lookups: CatalogueLookups = {
  unitIdByName: new Map([
    ['kg', 2],
    ['kilograms', 2],
    ['pcs', 1],
    ['pieces', 1],
  ]),
  slabIdByRate: new Map([
    [rateKey(0), 10],
    [rateKey(5), 11],
    [rateKey(18), 12],
  ]),
  /** Already worn by product 77. */
  barcodeOwners: new Map([['8909999999999', 77]]),
};

function validate(...rows: string[]) {
  return validateCatalogueRows(readCsvTable([HEADER, ...rows].join('\n')), lookups);
}

/**
 * All the reasons a given line was rejected, as catalogue keys.
 *
 * Keys rather than sentences on purpose. The rule being tested is "a rate with
 * no slab in force is rejected", not "the message reads *no GST slab in force
 * at this rate*", and asserting the second means every improvement to the
 * wording breaks a test that has nothing to do with wording. That the key
 * resolves to a real sentence in both languages is checked once, in
 * packages/shared/src/i18n/catalogue.test.ts, rather than in every case here.
 */
function reasons(result: ReturnType<typeof validate>, line: number): string[] {
  return result.issues.filter((issue) => issue.line === line).map((issue) => issue.reasonKey);
}

describe('validateCatalogueRows', () => {
  it('accepts a well-formed row and resolves its lookups to ids', () => {
    const { valid, issues } = validate(GOOD_ROW);

    expect(issues).toEqual([]);
    expect(valid).toHaveLength(1);
    expect(valid[0]).toMatchObject({
      line: 2,
      barcode: '8901234567890',
      name: 'Basmati Rice 5kg',
      nameHi: 'चावल',
      shortName: 'RICE 5KG',
      hsnCode: '100630',
      taxSlabId: 11,
      baseUnitId: 2,
      categoryName: 'Grocery',
    });
  });

  it('keeps money as exact text rather than a float', () => {
    // 0.1 + 0.2 arithmetic has no business anywhere near a price. The value
    // goes to NUMERIC as the characters the client typed.
    const { valid } = validate('890,X,,X,100630,5,1234567.89,1234567.89,0.01,Kg,,');
    expect(valid[0]?.mrp).toBe('1234567.89');
    expect(valid[0]?.purchasePrice).toBe('0.01');
  });

  it('imports the good rows and reports only the bad ones', () => {
    const { valid, issues } = validate(
      GOOD_ROW,
      '8901111111111,Bad HSN,,BAD,1006,5,100,90,80,Kg,Grocery,',
      '8902222222222,Fine,,FINE,100640,18,60,55,50,Pcs,,',
    );

    expect(valid.map((row) => row.line)).toEqual([2, 4]);
    expect(issues.map((issue) => issue.line)).toEqual([3]);
  });

  it('reports every problem in a row, not just the first', () => {
    // One pass through the spreadsheet instead of four.
    const { issues } = validate(',No barcode,,,12345,999,0,abc,,Furlong,,x');

    expect(reasons({ valid: [], issues }, 2)).toEqual(
      expect.arrayContaining([
        'catalogue.issue.required',
        'catalogue.issue.hsn_not_six_digits',
        'catalogue.issue.rate_no_slab_in_force',
        'catalogue.issue.money_not_positive',
        'catalogue.issue.unit_unknown',
      ]),
    );
  });

  describe('barcodes', () => {
    it('rejects one repeated within the file, naming the earlier line', () => {
      const { valid, issues } = validate(GOOD_ROW, GOOD_ROW);

      expect(valid).toHaveLength(1);
      expect(issues.at(0)).toMatchObject({
        line: 3,
        column: 'barcode',
        reasonKey: 'catalogue.issue.barcode_duplicate_in_file',
        reasonParams: { line: 2 },
      });
    });

    it('points a third repeat back at the first appearance, not the second', () => {
      const { issues } = validate(GOOD_ROW, GOOD_ROW, GOOD_ROW);
      expect(reasons({ valid: [], issues }, 4)).toEqual([
        'catalogue.issue.barcode_duplicate_in_file',
      ]);
      expect(issues.at(0)?.reasonParams).toEqual({ line: 2 });
    });

    it('rejects one already on a product in the system', () => {
      const { issues } = validate('8909999999999,Dup,,DUP,100630,5,100,90,80,Kg,,');
      expect(reasons({ valid: [], issues }, 2)).toEqual(['catalogue.issue.barcode_in_system']);
    });
  });

  describe('prices', () => {
    it('rejects a sale price above MRP', () => {
      // Selling above the printed maximum is an offence, not a pricing choice.
      const { issues } = validate('890,X,,X,100630,5,100,120,80,Kg,,');
      expect(issues.at(0)).toMatchObject({
        reasonKey: 'catalogue.issue.sale_price_above_mrp',
        reasonParams: { mrp: '100' },
      });
    });

    it('accepts a sale price equal to MRP', () => {
      const { issues } = validate('890,X,,X,100630,5,100,100,80,Kg,,');
      expect(issues).toEqual([]);
    });

    it('rejects zero and more than two decimal places', () => {
      const { issues } = validate(
        '890,X,,X,100630,5,0,10,,Kg,,',
        '891,Y,,Y,100630,5,10.999,5,,Kg,,',
      );

      expect(reasons({ valid: [], issues }, 2)).toEqual(['catalogue.issue.money_not_positive']);
      expect(reasons({ valid: [], issues }, 3)).toEqual(['catalogue.issue.money_invalid']);
    });

    it('defaults a blank purchase price to zero', () => {
      const { valid } = validate('890,X,,X,100630,5,100,90,,Kg,,');
      expect(valid[0]?.purchasePrice).toBe('0');
    });
  });

  describe('lookups', () => {
    it('matches a unit by short name or full name, either case', () => {
      const { valid } = validate(
        '890,X,,X,100630,5,100,90,,KILOGRAMS,,',
        '891,Y,,Y,100630,5,1,1,,kg,,',
      );
      expect(valid.map((row) => row.baseUnitId)).toEqual([2, 2]);
    });

    it('treats 5, 5.0 and 5.00 as the same rate', () => {
      const { valid } = validate(
        '890,X,,X,100630,5,100,90,,Kg,,',
        '891,Y,,Y,100630,5.0,100,90,,Kg,,',
        '892,Z,,Z,100630,5.00,100,90,,Kg,,',
      );
      expect(valid.map((row) => row.taxSlabId)).toEqual([11, 11, 11]);
    });

    it('rejects a rate with no slab in force', () => {
      // 12% was abolished in the GST 2.0 rationalisation. A spreadsheet
      // carried over from before it will be full of these.
      const { issues } = validate('890,X,,X,100630,12,100,90,,Kg,,');
      expect(reasons({ valid: [], issues }, 2)).toEqual(['catalogue.issue.rate_no_slab_in_force']);
    });
  });

  describe('categories', () => {
    it('accepts an unknown one — it is created on load, not rejected', () => {
      const { valid, issues } = validate('890,X,,X,100630,5,100,90,,Kg,Brand New Aisle,');

      expect(issues).toEqual([]);
      expect(valid[0]?.categoryName).toBe('Brand New Aisle');
    });

    it('accepts a blank one', () => {
      const { valid, issues } = validate('890,X,,X,100630,5,100,90,,Kg,,');

      expect(issues).toEqual([]);
      expect(valid[0]?.categoryName).toBeNull();
    });
  });

  describe('the file itself', () => {
    it('rejects a row with the wrong number of values, naming the likely cause', () => {
      const table = readCsvTable(
        `${HEADER}
8901234567890,Basmati Rice, 5kg,चावल,RICE 5KG,100630,5,520,495,410,Kg,Grocery,10`,
      );
      const { issues } = validateCatalogueRows(table, lookups);

      expect(issues.at(0)).toMatchObject({
        reasonKey: 'catalogue.issue.field_count',
        reasonParams: { actual: 13, expected: 12 },
      });
    });

    it('refuses a file missing a required heading', () => {
      // A property of the file, not of a row: every row would say the same
      // thing, so this one is fatal.
      expect(() => validateCatalogueRows(readCsvTable('barcode,name\n1,x'), lookups)).toThrow(
        CatalogueFileError,
      );
    });

    it('accepts a file without the optional headings', () => {
      const table = readCsvTable(
        'barcode,name,short_name,hsn_code,tax_rate,mrp,sale_price,unit\n890,X,X,100630,5,100,90,Kg',
      );
      const { valid, issues } = validateCatalogueRows(table, lookups);

      expect(issues).toEqual([]);
      expect(valid[0]).toMatchObject({ nameHi: null, categoryName: null, reorderLevel: '0' });
    });
  });
});

/**
 * The same rule set, reached from a screen instead of a file.
 *
 * These cases exist to prove the claim D41 rests on: the product master does
 * not get its own validator. If one of these ever needs a rule the file path
 * does not have, the two have started to drift and the cheap three-view screen
 * has quietly become three screens.
 */
describe('validateSourceRows', () => {
  const FIELDS = {
    barcode: '8901234567890',
    name: 'Basmati Rice 5kg',
    name_hi: 'चावल',
    short_name: 'RICE 5KG',
    hsn_code: '100630',
    tax_rate: '5',
    mrp: '520',
    sale_price: '495',
    purchase_price: '410',
    unit: 'Kg',
    category: 'Grocery',
    reorder_level: '10',
  };

  function check(...rows: ReturnType<typeof catalogueRow>[]) {
    return validateSourceRows(rows, 12, lookups);
  }

  it('applies the file rules to a row assembled from a form', () => {
    const { valid, issues } = check(catalogueRow(1, { ...FIELDS, hsn_code: '1006' }));

    expect(valid).toEqual([]);
    expect(issues.map((issue) => issue.reasonKey)).toEqual(['catalogue.issue.hsn_not_six_digits']);
  });

  it('lets a product keep its own barcode through an edit', () => {
    // 8909999999999 belongs to product 77. Editing product 77 and leaving the
    // barcode alone is not a collision; treating it as one would fail every
    // edit on the one field the operator did not touch.
    const fields = { ...FIELDS, barcode: '8909999999999' };

    expect(check(catalogueRow(1, fields, 77)).issues).toEqual([]);
    expect(check(catalogueRow(1, fields, 78)).issues.map((issue) => issue.reasonKey)).toEqual([
      'catalogue.issue.barcode_in_system',
    ]);
    // And a create still cannot take it.
    expect(check(catalogueRow(1, fields)).issues.map((issue) => issue.reasonKey)).toEqual([
      'catalogue.issue.barcode_in_system',
    ]);
  });

  it('reports a bulk price rise against MRP, row by row', () => {
    // The case the bulk grid exists for and the one a shortcut would miss:
    // one new sale price applied to rows whose MRPs differ. Only the rows it
    // would push above the printed maximum fail (docs/DECISIONS.md D35).
    const { valid, issues } = check(
      catalogueRow(1, { ...FIELDS, barcode: '891', mrp: '600', sale_price: '550' }, 1),
      catalogueRow(2, { ...FIELDS, barcode: '892', mrp: '500', sale_price: '550' }, 2),
      catalogueRow(3, { ...FIELDS, barcode: '893', mrp: '550', sale_price: '550' }, 3),
    );

    expect(valid.map((row) => row.line)).toEqual([1, 3]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ line: 2, reasonKey: 'catalogue.issue.sale_price_above_mrp' });
  });

  it('carries the product id onto the validated row', () => {
    const { valid } = check(
      catalogueRow(1, FIELDS, 42),
      catalogueRow(2, { ...FIELDS, barcode: '9' }),
    );

    expect(valid.map((row) => row.productId)).toEqual([42, null]);
  });

  it('cannot trip the field-count check, which is a CSV fault', () => {
    // A form has no unquoted commas to get wrong. catalogueRow fills every
    // column so this can never fire on a screen row.
    const { issues } = check(catalogueRow(1, { barcode: '890', name: 'X' }));

    expect(issues.map((issue) => issue.reasonKey)).not.toContain('catalogue.issue.field_count');
  });
});
