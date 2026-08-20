import { describe, expect, it } from 'vitest';

import type { Queryable } from '../db/queryable.js';
import { asRow, firstRow, readId, readInt, readText } from '../db/rows.js';
import { withRollback } from '../testing/database.js';
import { importCatalogue } from './import.js';
import { resolveProductTax } from './product-tax.js';

/**
 * The import end to end, against a real database.
 *
 * The validator is tested on its own without one; what needs a live schema is
 * everything after it - that a loaded product is indistinguishable from one the
 * edit screen would have created, that the tax and price histories are opened
 * the same way, and that a dry run leaves nothing behind.
 */

const HEADER =
  'barcode,name,name_hi,short_name,hsn_code,tax_rate,mrp,sale_price,purchase_price,unit,category,reorder_level';

const RICE =
  '8901000000001,Basmati Rice 5kg,बासमती चावल,RICE 5KG,100630,5,520,495,410,Kg,Grocery,10';
const SOAP = '8901000000002,Bath Soap 100g,,SOAP 100G,340111,18,45,42,35,Pcs,Personal Care,24';

function file(...rows: string[]): string {
  return [HEADER, ...rows].join('\n');
}

async function scalarInt(db: Queryable, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await db.query(sql, params);
  return readInt(firstRow(rows), 'n');
}

async function scalarId(db: Queryable, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await db.query(sql, params);
  return readId(firstRow(rows), 'id');
}

async function productByBarcode(db: Queryable, barcode: string): Promise<Record<string, unknown>> {
  const { rows } = await db.query(
    `SELECT p.*, b.barcode_type, b.is_primary
       FROM products p
       JOIN product_barcodes b ON b.product_id = p.id
      WHERE b.barcode = $1`,
    [barcode],
  );
  return firstRow(rows);
}

describe('importCatalogue', () => {
  it('loads a product with everything the edit screen would have written', async () => {
    await withRollback(async (db) => {
      const report = await importCatalogue(db, file(RICE));

      expect(report).toMatchObject({ totalRows: 1, imported: 1, rejected: 0, issues: [] });

      const product = await productByBarcode(db, '8901000000001');
      expect(product).toMatchObject({
        name: 'Basmati Rice 5kg',
        name_hi: 'बासमती चावल',
        short_name: 'RICE 5KG',
        hsn_code: '100630',
        mrp: '520.00',
        sale_price: '495.00',
        purchase_price: '410.00',
        reorder_level: '10.000',
        barcode_type: 'ean13',
        is_primary: true,
        status: 'active',
      });

      // item_code is generated, because the client's spreadsheet has barcodes
      // and names but no internal codes.
      expect(readText(asRow(product), 'item_code')).toMatch(/^SKU-\d{6}$/);
    });
  });

  it('opens the tax and price histories, resolvable immediately', async () => {
    await withRollback(async (db) => {
      await importCatalogue(db, file(RICE));

      const productId = await scalarId(
        db,
        `SELECT p.id FROM products p
           JOIN product_barcodes b ON b.product_id = p.id
          WHERE b.barcode = '8901000000001'`,
      );

      // Dated from the database clock, not from the importer's. A row a few
      // milliseconds in the future would be in force nowhere, and every
      // imported product would show up as tax cache drift until the clock
      // caught up.
      const resolved = await resolveProductTax(db, productId, new Date());
      expect(resolved?.slabName).toBe('GST 5%');
      expect(resolved?.reason).toBe('Catalogue import');

      await expect(
        scalarInt(
          db,
          `SELECT count(*)::int AS n FROM product_tax_cache_drift WHERE product_id = $1`,
          [productId],
        ),
      ).resolves.toBe(0);

      const price = firstRow(
        (
          await db.query(
            `SELECT sale_price, mrp, tax_type, effective_to FROM product_prices
              WHERE product_id = $1`,
            [productId],
          )
        ).rows,
      );
      expect(price).toMatchObject({
        sale_price: '495.00',
        mrp: '520.00',
        tax_type: 'inclusive',
        effective_to: null,
      });
    });
  });

  it('imports the good rows and reports the bad ones without abandoning the file', async () => {
    await withRollback(async (db) => {
      const report = await importCatalogue(
        db,
        file(
          RICE,
          '8901000000003,Short HSN,,SHORT,1006,5,100,90,80,Kg,Grocery,',
          SOAP,
          '8901000000004,No such unit,,NOUNIT,100630,5,100,90,80,Furlong,Grocery,',
          '8901000000001,Duplicate barcode,,DUP,100630,5,100,90,80,Kg,Grocery,',
        ),
      );

      expect(report).toMatchObject({ totalRows: 5, imported: 2, rejected: 3 });
      expect(report.issues.map((issue) => issue.line)).toEqual([3, 5, 6]);

      // The two good rows are really there - the bad ones did not take them
      // down. Counted by barcode rather than by `count(*)`: this database has
      // the shop's own catalogue in it the moment anybody imports one
      // (CLAUDE.md, Working practices).
      await expect(
        scalarInt(
          db,
          `SELECT count(*)::int AS n FROM product_barcodes
            WHERE barcode IN ('8901000000001', '8901000000002')`,
        ),
      ).resolves.toBe(2);
    });
  });

  it('creates unknown categories rather than rejecting the row', async () => {
    await withRollback(async (db) => {
      // An aisle name no real catalogue would hold, so "was it created" has one
      // answer whatever else is in this database. `Grocery` is exactly what the
      // shop's own catalogue calls an aisle, and asserting on it would make
      // this test pass only until somebody imports one.
      const aisle = 'Import Test Aisle';
      const row = `8901000000021,Aisle probe,,PROBE,100630,5,100,90,80,Kg,${aisle},`;

      const report = await importCatalogue(db, file(row));

      expect(report.categoriesCreated).toEqual([aisle]);

      const probe = await productByBarcode(db, '8901000000021');
      expect(probe.category_id).not.toBeNull();

      // Materialised path maintained, same shape the office screen uses.
      const path = firstRow(
        (await db.query(`SELECT path FROM categories WHERE name = $1`, [aisle])).rows,
      );
      expect(readText(path, 'path')).toMatch(/^\/\d+\/$/);
    });
  });

  it('reuses a category that already exists, whatever its case', async () => {
    await withRollback(async (db) => {
      const aisle = 'Import Test Aisle';
      await db.query(`INSERT INTO categories (name) VALUES ($1)`, [aisle.toUpperCase()]);

      const row = `8901000000022,Aisle probe,,PROBE,100630,5,100,90,80,Kg,${aisle},`;
      const report = await importCatalogue(db, file(row));

      expect(report.categoriesCreated).toEqual([]);
      // One of it, not two differing only in case.
      await expect(
        scalarInt(db, `SELECT count(*)::int AS n FROM categories WHERE lower(name) = lower($1)`, [
          aisle,
        ]),
      ).resolves.toBe(1);
    });
  });

  it('creates the HSN codes the file uses, once each', async () => {
    await withRollback(async (db) => {
      const report = await importCatalogue(
        db,
        file(RICE, SOAP, '8901000000005,More rice,,RICE2,100630,5,300,290,250,Kg,Grocery,'),
      );

      // Three rows, two distinct codes, and 100630 appears on two of them.
      // Whichever were not already in the system were added once each - the
      // report never repeats a code.
      expect(new Set(report.hsnCodesCreated).size).toBe(report.hsnCodesCreated.length);

      // And both are there afterwards, however they got there. Asserted by
      // code rather than by counting the table: the moment anybody imports a
      // real catalogue into this database, `count(*)` stops being 2 and the
      // test fails for a reason that has nothing to do with the importer
      // (CLAUDE.md, Working practices).
      await expect(
        scalarInt(
          db,
          `SELECT count(*)::int AS n FROM hsn_codes WHERE hsn_code IN ('100630', '340111')`,
        ),
      ).resolves.toBe(2);
    });
  });

  it('rejects a rate that is no longer in force', async () => {
    await withRollback(async (db) => {
      // 12% was abolished on 22 Sep 2025. A spreadsheet carried over from
      // before then will be full of these, and importing them silently would
      // put the shop on a rate it may not legally charge.
      const report = await importCatalogue(
        db,
        file('8901000000006,Old rate,,OLD,100630,12,100,90,80,Kg,Grocery,'),
      );

      expect(report.imported).toBe(0);
      expect(report.issues.at(0)?.reasonKey).toBe('catalogue.issue.rate_no_slab_in_force');
    });
  });

  it('rejects a barcode already on a product in the system', async () => {
    await withRollback(async (db) => {
      await importCatalogue(db, file(RICE));

      const second = await importCatalogue(db, file(RICE));

      expect(second.imported).toBe(0);
      expect(second.issues.at(0)?.reasonKey).toBe('catalogue.issue.barcode_in_system');
    });
  });

  it('writes nothing on a dry run', async () => {
    await withRollback(async (db) => {
      // Counted before and after rather than asserted to be zero. This is the
      // one command in the system pointed deliberately at the *live* database
      // (D34), so the table it writes nothing to is a table with the shop's
      // real catalogue in it - and a test that expects it empty passes only
      // until the client uses the feature (CLAUDE.md, Working practices).
      const counts = async (): Promise<Record<string, number>> => ({
        products: await scalarInt(db, `SELECT count(*)::int AS n FROM products`),
        categories: await scalarInt(db, `SELECT count(*)::int AS n FROM categories`),
        hsnCodes: await scalarInt(db, `SELECT count(*)::int AS n FROM hsn_codes`),
        prices: await scalarInt(db, `SELECT count(*)::int AS n FROM product_prices`),
        assignments: await scalarInt(db, `SELECT count(*)::int AS n FROM product_tax_assignments`),
      });

      const before = await counts();
      const report = await importCatalogue(db, file(RICE, SOAP), { dryRun: true });

      expect(report).toMatchObject({ dryRun: true, totalRows: 2, imported: 0, rejected: 0 });
      expect(await counts()).toEqual(before);
    });
  });

  it('reports the same problems on a dry run as on a real one', async () => {
    await withRollback(async (db) => {
      const bad = file(RICE, '8901000000007,Bad,,BAD,1006,5,100,90,80,Kg,,');

      const dry = await importCatalogue(db, bad, { dryRun: true });
      const real = await importCatalogue(db, bad);

      expect(dry.issues).toEqual(real.issues);
      expect(dry.rejected).toBe(real.rejected);
    });
  });
});
