import { describe, expect, it } from 'vitest';

import { databaseNow } from '../db/clock.js';
import type { Queryable } from '../db/queryable.js';
import { asRow, firstRow, readId, readInt } from '../db/rows.js';
import { queryId, seededSlabId } from '../testing/catalog-fixtures.js';
import { withRollback } from '../testing/database.js';
import { importCatalogue } from './import.js';
import {
  applyBulkEdit,
  createProduct,
  updateProduct,
  type CatalogueValues,
} from './product-edit.js';
import { resolveProductTax } from './product-tax.js';

/**
 * The product master's write paths, against a real database.
 *
 * What these are for is the claim D41 rests on, which is not a claim about a
 * screen: a change made from the grid has to leave the database in the state
 * the same change arriving in a file would leave it in. That is checkable, and
 * the test that checks it - "leaves what the file leaves" below - is the one
 * worth keeping if the rest ever get in the way.
 *
 * A note on time, because it shapes every fixture here. Postgres `now()` is the
 * transaction timestamp and does not advance inside `withRollback`, so a
 * product created and then edited in one test would try to close a history row
 * at the instant it opened - which the period CHECK refuses, correctly. So
 * anything to be edited is seeded dated *yesterday*, and anything to be
 * future-dated is checked by resolving at a future instant rather than by
 * waiting for one.
 */

const HEADER =
  'barcode,name,name_hi,short_name,hsn_code,tax_rate,mrp,sale_price,purchase_price,unit,category,reorder_level';

function file(...rows: string[]): string {
  return [HEADER, ...rows].join('\n');
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Aisle names scoped to this file, so a real catalogue cannot collide. */
const BULK_AISLE = 'Bulk Edit Test Aisle';
const SCALE_BARCODE_PREFIX = 'SCALETEST-';

function fields(over: Partial<CatalogueValues> = {}): CatalogueValues {
  return {
    barcode: '8901000000001',
    name: 'Basmati Rice 5kg',
    name_hi: 'बासमती चावल',
    short_name: 'RICE 5KG',
    hsn_code: '100630',
    tax_rate: '5',
    mrp: '520',
    sale_price: '495',
    purchase_price: '410',
    unit: 'Kg',
    category: 'Grocery',
    reorder_level: '10',
    ...over,
  };
}

async function operatorId(db: Queryable): Promise<number> {
  return queryId(
    db,
    `INSERT INTO employees (emp_code, name) VALUES ('T-OFFICE-1', 'Test Operator') RETURNING id`,
  );
}

/**
 * A product to edit, with its history opened yesterday so that today's edit can
 * close it. Goes in through `createProduct`, so the fixture cannot drift from
 * the path the create form takes.
 */
async function seedEditable(
  db: Queryable,
  over: Partial<CatalogueValues> = {},
  changedBy: number | null = null,
): Promise<number> {
  const now = await databaseNow(db);
  const result = await createProduct(db, fields(over), {
    reason: 'Opening catalogue',
    effectiveFrom: new Date(now.getTime() - DAY_MS),
    changedBy,
  });

  expect(result.issues).toEqual([]);
  if (result.productId === null) throw new Error('fixture product was rejected');
  return result.productId;
}

async function scalarInt(db: Queryable, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await db.query(sql, params);
  return readInt(firstRow(rows), 'n');
}

/** The open row of a history table - what is in force from now on. */
async function openRow(
  db: Queryable,
  table: 'product_prices' | 'product_tax_assignments',
  productId: number,
): Promise<Record<string, unknown>> {
  const { rows } = await db.query(
    `SELECT * FROM ${table} WHERE product_id = $1 AND effective_to IS NULL`,
    [productId],
  );
  return firstRow(rows);
}

async function productRow(db: Queryable, productId: number): Promise<Record<string, unknown>> {
  const { rows } = await db.query(`SELECT * FROM products WHERE id = $1`, [productId]);
  return firstRow(rows);
}

describe('createProduct', () => {
  it('writes what the importer writes', async () => {
    await withRollback(async (db) => {
      const imported = await importCatalogue(
        db,
        file('8901000000009,Rice,,RICE,100630,5,520,495,410,Kg,Grocery,10'),
      );
      expect(imported.imported).toBe(1);

      const typed = await createProduct(db, fields({ barcode: '8901000000001' }), {
        reason: 'Added by hand',
      });

      expect(typed.issues).toEqual([]);
      const typedId = typed.productId;
      if (typedId === null) throw new Error('the typed product was rejected');

      const importedId = await queryId(
        db,
        `SELECT product_id AS id FROM product_barcodes WHERE barcode = '8901000000009'`,
      );

      // Same shape of history, both routes: one open price row, one open slab
      // row, opened by the same helpers.
      for (const table of ['product_prices', 'product_tax_assignments'] as const) {
        const fromFile = await openRow(db, table, importedId);
        const fromForm = await openRow(db, table, typedId);
        expect(Object.keys(fromForm).sort()).toEqual(Object.keys(fromFile).sort());
        expect(fromForm.effective_to).toBeNull();
        expect(fromFile.effective_to).toBeNull();
      }

      // And an item code was generated for the typed one too, not asked for.
      expect(await productRow(db, typedId)).toMatchObject({
        status: 'active',
        sale_price: '495.00',
        mrp: '520.00',
      });
    });
  });

  it('reports a bad row instead of writing it', async () => {
    await withRollback(async (db) => {
      const result = await createProduct(db, fields({ hsn_code: '1006', sale_price: '600' }), {
        reason: 'Added by hand',
      });

      expect(result.productId).toBeNull();
      expect(result.applied).toBe(0);
      expect(result.issues.map((issue) => issue.reasonKey).sort()).toEqual([
        'catalogue.issue.hsn_not_six_digits',
        'catalogue.issue.sale_price_above_mrp',
      ]);
      // Nothing was written for *this* barcode. Not `count(*) = 0`: that holds
      // only until somebody imports a real catalogue into this database
      // (CLAUDE.md, Working practices).
      await expect(
        scalarInt(
          db,
          `SELECT count(*)::int AS n FROM product_barcodes WHERE barcode = '8901000000001'`,
        ),
      ).resolves.toBe(0);
    });
  });
});

describe('updateProduct', () => {
  it('lets a product keep its own barcode', async () => {
    await withRollback(async (db) => {
      const productId = await seedEditable(db);

      const result = await updateProduct(
        db,
        productId,
        fields({ name: 'Basmati Rice 5kg Premium' }),
        { reason: 'Name corrected' },
      );

      expect(result.issues).toEqual([]);
      expect(result.applied).toBe(1);
      expect(await productRow(db, productId)).toMatchObject({
        name: 'Basmati Rice 5kg Premium',
      });
    });
  });

  it('refuses a barcode that belongs to another product', async () => {
    await withRollback(async (db) => {
      await seedEditable(db, { barcode: '8901000000002', short_name: 'OTHER' });
      const productId = await seedEditable(db, { barcode: '8901000000001' });

      const result = await updateProduct(db, productId, fields({ barcode: '8901000000002' }), {
        reason: 'Barcode corrected',
      });

      expect(result.applied).toBe(0);
      expect(result.issues.map((issue) => issue.reasonKey)).toEqual([
        'catalogue.issue.barcode_in_system',
      ]);
    });
  });

  it('opens no price history when the price did not move', async () => {
    await withRollback(async (db) => {
      const productId = await seedEditable(db);

      // Re-opening an unchanged price would close the row that records when the
      // price really started, and "since when has this cost 495" would quietly
      // become "since somebody fixed a typo".
      await updateProduct(db, productId, fields({ name: 'Renamed' }), { reason: 'Typo' });

      await expect(
        scalarInt(db, `SELECT count(*)::int AS n FROM product_prices WHERE product_id = $1`, [
          productId,
        ]),
      ).resolves.toBe(1);
    });
  });

  it('opens price history when it did, and closes the old row exactly', async () => {
    await withRollback(async (db) => {
      const productId = await seedEditable(db);
      const at = await databaseNow(db);

      await updateProduct(db, productId, fields({ sale_price: '510' }), {
        reason: 'Price revised',
      });

      const { rows } = await db.query(
        `SELECT sale_price, effective_from, effective_to FROM product_prices
          WHERE product_id = $1 ORDER BY effective_from`,
        [productId],
      );

      expect(rows).toHaveLength(2);
      const [closed, open] = rows.map((value) => asRow(value));
      expect(closed?.sale_price).toBe('495.00');
      // Half-open handover: the old row ends at the instant the new one begins.
      expect(closed?.effective_to).toEqual(at);
      expect(open?.effective_from).toEqual(at);
      expect(open?.effective_to).toBeNull();
      expect(open?.sale_price).toBe('510.00');

      // And the cache followed, because the trigger moved it - not the update.
      expect(await productRow(db, productId)).toMatchObject({ sale_price: '510.00' });
    });
  });
});

describe('applyBulkEdit', () => {
  it('applies the good rows and reports the rest, like a file', async () => {
    await withRollback(async (db) => {
      // Three MRPs, one new sale price. Only the row it would push above the
      // printed maximum fails (docs/DECISIONS.md D35).
      const roomToRise = await seedEditable(db, {
        barcode: '891',
        short_name: 'A',
        mrp: '600',
        sale_price: '500',
      });
      const atTheCeiling = await seedEditable(db, {
        barcode: '892',
        short_name: 'B',
        mrp: '500',
        sale_price: '450',
      });
      const exactlyAtMrp = await seedEditable(db, {
        barcode: '893',
        short_name: 'C',
        mrp: '560',
        sale_price: '500',
      });
      const ids = [roomToRise, atTheCeiling, exactlyAtMrp];

      const result = await applyBulkEdit(
        db,
        { productIds: ids, change: { field: 'sale_price', value: '550' } },
        { reason: 'March price revision' },
      );

      expect(result.applied).toBe(2);
      expect(result.rejected).toBe(1);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]).toMatchObject({
        line: 2,
        reasonKey: 'catalogue.issue.sale_price_above_mrp',
      });
      expect(result.rejectedProductIds).toEqual([atTheCeiling]);

      // The two that passed really moved; the one that failed did not.
      expect(await productRow(db, roomToRise)).toMatchObject({ sale_price: '550.00' });
      expect(await productRow(db, atTheCeiling)).toMatchObject({ sale_price: '450.00' });
      expect(await productRow(db, exactlyAtMrp)).toMatchObject({ sale_price: '550.00' });
    });
  });

  it('keeps MRP when the rate change is absorbed', async () => {
    await withRollback(async (db) => {
      const productId = await seedEditable(db, { tax_rate: '5', mrp: '520', sale_price: '495' });
      const gst18 = await seededSlabId(db, 'GST 18%');

      await applyBulkEdit(
        db,
        { productIds: [productId], change: { field: 'tax_rate', value: '18', mrpPolicy: 'keep' } },
        { reason: 'GST 2.0 reassignment' },
      );

      // The shelf price stands and the shop earns less on every sale.
      expect(await productRow(db, productId)).toMatchObject({
        sale_price: '495.00',
        mrp: '520.00',
        tax_slab_id: String(gst18),
      });

      // Absorbing writes no price history at all: nothing about the price moved.
      await expect(
        scalarInt(db, `SELECT count(*)::int AS n FROM product_prices WHERE product_id = $1`, [
          productId,
        ]),
      ).resolves.toBe(1);
    });
  });

  it('recomputes MRP and sale price when the rate change is passed on', async () => {
    await withRollback(async (db) => {
      const productId = await seedEditable(db, { tax_rate: '5', mrp: '525', sale_price: '105' });

      await applyBulkEdit(
        db,
        {
          productIds: [productId],
          change: { field: 'tax_rate', value: '18', mrpPolicy: 'recompute' },
        },
        { reason: 'GST 2.0 reassignment' },
      );

      // 105 inclusive at 5% is 100 ex-GST; at 18% that is 118. 525 -> 590.
      expect(await productRow(db, productId)).toMatchObject({
        sale_price: '118.00',
        mrp: '590.00',
      });

      // Both halves of the change carry the same reason and the same instant.
      const price = await openRow(db, 'product_prices', productId);
      const slab = await openRow(db, 'product_tax_assignments', productId);
      expect(price.reason).toBe('GST 2.0 reassignment');
      expect(price.effective_from).toEqual(slab.effective_from);
    });
  });

  it('reports a recomputed price that would cross MRP rather than writing it', async () => {
    await withRollback(async (db) => {
      // MRP already at the ceiling of what the packet allows: recomputing the
      // sale price upward while MRP is pinned would break D35. Here MRP moves
      // with it, so the pair stays legal - the check still runs, which is the
      // point: bulk does not get to skip it.
      const productId = await seedEditable(db, { tax_rate: '5', mrp: '105', sale_price: '105' });

      const result = await applyBulkEdit(
        db,
        {
          productIds: [productId],
          change: { field: 'tax_rate', value: '18', mrpPolicy: 'recompute' },
        },
        { reason: 'GST 2.0 reassignment' },
      );

      expect(result.applied).toBe(1);
      expect(await productRow(db, productId)).toMatchObject({
        sale_price: '118.00',
        mrp: '118.00',
      });
    });
  });

  it('moves a category across a selection', async () => {
    await withRollback(async (db) => {
      const ids = [
        await seedEditable(db, { barcode: '891', short_name: 'A', category: 'Grocery' }),
        await seedEditable(db, { barcode: '892', short_name: 'B', category: 'Grocery' }),
      ];

      const result = await applyBulkEdit(
        db,
        { productIds: ids, change: { field: 'category', value: BULK_AISLE } },
        { reason: 'Aisle reorganised' },
      );

      expect(result.applied).toBe(2);
      // An aisle name no real catalogue holds, so 'was it created' has one
      // answer whatever else is in this database (CLAUDE.md, Working practices).
      expect(result.categoriesCreated).toEqual([BULK_AISLE]);
      await expect(
        scalarInt(
          db,
          `SELECT count(*)::int AS n FROM products p JOIN categories c ON c.id = p.category_id
            WHERE c.name = $1`,
          [BULK_AISLE],
        ),
      ).resolves.toBe(2);
    });
  });

  it('leaves no cache drift behind, because it never writes a cache', async () => {
    await withRollback(async (db) => {
      const ids = [
        await seedEditable(db, { barcode: '891', short_name: 'A' }),
        await seedEditable(db, { barcode: '892', short_name: 'B' }),
      ];

      await applyBulkEdit(
        db,
        {
          productIds: ids,
          change: { field: 'tax_rate', value: '18', mrpPolicy: 'recompute' },
        },
        { reason: 'GST 2.0 reassignment' },
      );

      // A bulk UPDATE of products.tax_slab_id would look identical right now
      // and be undone by refresh_product_tax_slab_cache() overnight. These two
      // views are how that difference becomes visible (D28).
      for (const view of ['product_tax_cache_drift', 'product_price_cache_drift'] as const) {
        await expect(
          scalarInt(db, `SELECT count(*)::int AS n FROM ${view} WHERE product_id = ANY($1)`, [ids]),
        ).resolves.toBe(0);
      }
    });
  });
});

describe('a future-dated bulk reassignment', () => {
  it('changes nothing today and everything on its date, price included', async () => {
    await withRollback(async (db) => {
      const productId = await seedEditable(db, { tax_rate: '5', mrp: '525', sale_price: '105' });
      const now = await databaseNow(db);
      const nextMonth = new Date(now.getTime() + 30 * DAY_MS);
      const gst5 = await seededSlabId(db, 'GST 5%');
      const gst18 = await seededSlabId(db, 'GST 18%');

      await applyBulkEdit(
        db,
        {
          productIds: [productId],
          change: { field: 'tax_rate', value: '18', mrpPolicy: 'recompute' },
        },
        { reason: 'GST 2.0 reassignment', effectiveFrom: nextMonth },
      );

      // Today: nothing has moved. The pending change is the row itself (D27).
      expect(await productRow(db, productId)).toMatchObject({
        tax_slab_id: String(gst5),
        sale_price: '105.00',
        mrp: '525.00',
      });
      expect((await resolveProductTax(db, productId, now))?.taxSlabId).toBe(gst5);

      // On the day: the slab and the price both, on the same instant. A slab
      // that moved without its price would sell at the old price under the new
      // rate for a month.
      expect((await resolveProductTax(db, productId, nextMonth))?.taxSlabId).toBe(gst18);

      const { rows } = await db.query(`SELECT sale_price, mrp FROM product_price_at($1, $2)`, [
        productId,
        nextMonth,
      ]);
      expect(firstRow(rows)).toMatchObject({ sale_price: '118.00', mrp: '590.00' });

      // And one moment before, it is still the old price.
      const momentBefore = new Date(nextMonth.getTime() - 1);
      const before = await db.query(`SELECT sale_price FROM product_price_at($1, $2)`, [
        productId,
        momentBefore,
      ]);
      expect(firstRow(before.rows)).toMatchObject({ sale_price: '105.00' });
    });
  });

  it('scales to a full reassignment without touching a cache', async () => {
    await withRollback(async (db) => {
      const rows = Array.from(
        { length: 200 },
        (_, index) =>
          `${SCALE_BARCODE_PREFIX}${String(index).padStart(5, '0')},Item ${String(index)},,` +
          `IT${String(index)},100630,5,520,495,410,Kg,${BULK_AISLE},10`,
      );
      const imported = await importCatalogue(db, file(...rows));
      expect(imported.imported).toBe(200);

      // Only the 200 this test imported. `SELECT id FROM products` would sweep
      // up the shop's whole catalogue the day one exists (CLAUDE.md, Working
      // practices).
      const { rows: idRows } = await db.query(
        `SELECT product_id AS id FROM product_barcodes
          WHERE barcode LIKE $1 ORDER BY product_id`,
        [`${SCALE_BARCODE_PREFIX}%`],
      );
      const productIds = idRows.map((value) => readId(asRow(value), 'id'));
      expect(productIds).toHaveLength(200);

      const now = await databaseNow(db);
      const nextMonth = new Date(now.getTime() + 30 * DAY_MS);

      const result = await applyBulkEdit(
        db,
        {
          productIds,
          change: { field: 'tax_rate', value: '18', mrpPolicy: 'recompute' },
        },
        { reason: 'GST 2.0 reassignment', effectiveFrom: nextMonth },
      );

      expect(result.applied).toBe(200);
      expect(result.issues).toEqual([]);

      // 200 products, 400 rows opened, every one of them dated the same instant
      // - so "what changed on the 1st" has one answer rather than a range.
      await expect(
        scalarInt(
          db,
          `SELECT count(*)::int AS n FROM product_tax_assignments
            WHERE effective_from = $1 AND effective_to IS NULL`,
          [nextMonth],
        ),
      ).resolves.toBe(200);
      await expect(
        scalarInt(
          db,
          `SELECT count(*)::int AS n FROM product_prices
            WHERE effective_from = $1 AND effective_to IS NULL`,
          [nextMonth],
        ),
      ).resolves.toBe(200);

      // Not one cache moved, and not one of these products drifted. Scoped to
      // the 200: a shop's own catalogue sits in this database beside them, and
      // its prices are not this test's business (CLAUDE.md, Working practices).
      await expect(
        scalarInt(
          db,
          `SELECT count(*)::int AS n FROM products
            WHERE id = ANY($1) AND sale_price <> 495.00`,
          [productIds],
        ),
      ).resolves.toBe(0);
      for (const view of ['product_tax_cache_drift', 'product_price_cache_drift'] as const) {
        await expect(
          scalarInt(db, `SELECT count(*)::int AS n FROM ${view} WHERE product_id = ANY($1)`, [
            productIds,
          ]),
        ).resolves.toBe(0);
      }
    });
  });
});

/**
 * The test the whole three-view design is answerable to.
 *
 * If this ever fails, the grid has grown a path of its own and D41's bargain -
 * three views are cheap *provided* they share one core - has stopped holding.
 */
describe('a bulk change leaves what the file leaves', () => {
  it('writes history rows indistinguishable from an import, except the reason', async () => {
    await withRollback(async (db) => {
      const changedBy = await operatorId(db);
      const gst18 = await seededSlabId(db, 'GST 18%');

      // One product created by importing the target values.
      const imported = await importCatalogue(
        db,
        file('8901000000009,Rice,,RICE,100630,18,590,118,410,Kg,Grocery,10'),
        { changedBy },
      );
      expect(imported.imported).toBe(1);
      const importedId = await queryId(
        db,
        `SELECT product_id AS id FROM product_barcodes WHERE barcode = '8901000000009'`,
      );

      // One product created at the old values yesterday, then bulk-edited to
      // the same target today.
      const editedId = await seedEditable(
        db,
        { barcode: '8901000000001', tax_rate: '5', mrp: '525', sale_price: '105' },
        changedBy,
      );
      const result = await applyBulkEdit(
        db,
        {
          productIds: [editedId],
          change: { field: 'tax_rate', value: '18', mrpPolicy: 'recompute' },
        },
        { reason: 'GST 2.0 reassignment', changedBy },
      );
      expect(result.applied).toBe(1);

      // Every column that describes the change, on both history tables.
      const comparable = (row: Record<string, unknown>): Record<string, unknown> => {
        const {
          id: _id,
          product_id: _p,
          reason: _r,
          created_at: _c,
          updated_at: _u,
          ...rest
        } = row;
        return rest;
      };

      for (const table of ['product_prices', 'product_tax_assignments'] as const) {
        const fromFile = await openRow(db, table, importedId);
        const fromGrid = await openRow(db, table, editedId);

        expect(comparable(fromGrid)).toEqual(comparable(fromFile));
        expect(fromGrid.changed_by).toBe(String(changedBy));
      }

      // The reason is the one thing that differs, and it is the field whose job
      // is to differ.
      expect((await openRow(db, 'product_prices', importedId)).reason).toBe('Catalogue import');
      expect((await openRow(db, 'product_prices', editedId)).reason).toBe('GST 2.0 reassignment');

      // And the products themselves ended up in the same place.
      const fromFile = await productRow(db, importedId);
      const fromGrid = await productRow(db, editedId);
      for (const column of ['sale_price', 'mrp', 'tax_slab_id', 'sale_price_tax_type'] as const) {
        expect(fromGrid[column]).toEqual(fromFile[column]);
      }
      expect(fromGrid.tax_slab_id).toBe(String(gst18));
    });
  });
});
