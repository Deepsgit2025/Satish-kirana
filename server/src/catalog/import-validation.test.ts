import { describe, expect, it } from 'vitest';

import { readCsvTable } from './csv.js';
import {
  type CatalogueLookups,
  CatalogueFileError,
  rateKey,
  validateCatalogueRows,
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
  existingBarcodes: new Set(['8909999999999']),
};

function validate(...rows: string[]) {
  return validateCatalogueRows(readCsvTable([HEADER, ...rows].join('\n')), lookups);
}

/** All the reasons a given line was rejected. */
function reasons(result: ReturnType<typeof validate>, line: number): string[] {
  return result.issues.filter((issue) => issue.line === line).map((issue) => issue.reason);
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
        'required, but blank',
        'must be exactly 6 digits',
        'no GST slab in force at this rate',
        'must be greater than zero',
        'not a unit in the units master',
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
        reason: 'already used on line 2 of this file',
      });
    });

    it('points a third repeat back at the first appearance, not the second', () => {
      const { issues } = validate(GOOD_ROW, GOOD_ROW, GOOD_ROW);
      expect(reasons({ valid: [], issues }, 4)).toEqual(['already used on line 2 of this file']);
    });

    it('rejects one already on a product in the system', () => {
      const { issues } = validate('8909999999999,Dup,,DUP,100630,5,100,90,80,Kg,,');
      expect(reasons({ valid: [], issues }, 2)).toEqual(['already on a product in the system']);
    });
  });

  describe('prices', () => {
    it('rejects a sale price above MRP', () => {
      // Selling above the printed maximum is an offence, not a pricing choice.
      const { issues } = validate('890,X,,X,100630,5,100,120,80,Kg,,');
      expect(reasons({ valid: [], issues }, 2)).toEqual([
        'higher than mrp (100) — MRP is a legal maximum',
      ]);
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

      expect(reasons({ valid: [], issues }, 2)).toEqual(['must be greater than zero']);
      expect(reasons({ valid: [], issues }, 3)).toEqual([
        'not a money amount (digits, optionally with up to 2 decimal places)',
      ]);
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
      expect(reasons({ valid: [], issues }, 2)).toEqual(['no GST slab in force at this rate']);
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

      expect(issues.at(0)?.reason).toMatch(/needs the value wrapped in double quotes/);
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
