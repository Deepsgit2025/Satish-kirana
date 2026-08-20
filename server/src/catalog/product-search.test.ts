import { describe, expect, it } from 'vitest';

import type { Queryable } from '../db/queryable.js';
import { asRow, readId, readText } from '../db/rows.js';
import { seededSlabId } from '../testing/catalog-fixtures.js';
import { withRollback } from '../testing/database.js';
import { importCatalogue } from './import.js';
import { searchProducts, searchProductIds } from './product-search.js';

/**
 * The list view.
 *
 * It reads and never writes, so what is worth testing is that the filters mean
 * what the grid assumes they mean - the selection the operator hands to a bulk
 * edit comes from here, and a filter that quietly matches one product too many
 * becomes a price change on a product nobody chose.
 *
 * **Every assertion here is about the four products this file seeds**, by id,
 * or about a count measured before and after seeding them. Never about the size
 * of `products`. This database is a developer's own, and the first time anybody
 * imports a real catalogue into it a test that expected four products fails for
 * a reason that has nothing to do with searching (CLAUDE.md, Working
 * practices). The fixture's category is named for this file for the same
 * reason: `Grocery` is what a real catalogue would call an aisle.
 */

const HEADER =
  'barcode,name,name_hi,short_name,hsn_code,tax_rate,mrp,sale_price,purchase_price,unit,category,reorder_level';

/** Barcodes nothing else uses, so a seeded product can always be found again. */
const RICE = 'SEARCHTEST-RICE';
const SOAP = 'SEARCHTEST-SOAP';
const OIL = 'SEARCHTEST-OIL';
const ATTA = 'SEARCHTEST-ATTA';

const AISLE = 'Search Test Aisle';
const OTHER_AISLE = 'Search Test Toiletries';

const CATALOGUE = [
  `${RICE},Basmati Rice 5kg,बासमती चावल,SRCH RICE,100630,5,520,495,410,Kg,${AISLE},10`,
  `${SOAP},Bath Soap 100g,,SRCH SOAP,340111,18,45,42,35,Pcs,${OTHER_AISLE},24`,
  `${OIL},Sunflower Oil 1L,सूरजमुखी तेल,SRCH OIL,151211,5,180,175,150,Ltr,${AISLE},12`,
  `${ATTA},100% Atta 10kg,,SRCH ATTA,110100,5,450,430,400,Kg,${AISLE},5`,
];

/** The seeded products, by barcode, so assertions can name one exactly. */
async function seedCatalogue(db: Queryable): Promise<Map<string, number>> {
  const report = await importCatalogue(db, [HEADER, ...CATALOGUE].join('\n'));
  expect(report.imported).toBe(4);

  const { rows } = await db.query(
    `SELECT barcode, product_id FROM product_barcodes WHERE barcode = ANY($1::text[])`,
    [[RICE, SOAP, OIL, ATTA]],
  );
  return new Map(
    rows.map((value) => {
      const row = asRow(value);
      return [readText(row, 'barcode'), readId(row, 'product_id')];
    }),
  );
}

/** Ids the seeded fixture occupies, for "is mine in here" assertions. */
function idsOf(seeded: Map<string, number>, ...barcodes: string[]): number[] {
  return barcodes.map((barcode) => {
    const id = seeded.get(barcode);
    if (id === undefined) throw new Error(`fixture is missing ${barcode}`);
    return id;
  });
}

describe('searchProducts', () => {
  it('returns everything with no filter, with a total to match', async () => {
    await withRollback(async (db) => {
      const before = (await searchProducts(db)).total;
      const seeded = await seedCatalogue(db);

      const page = await searchProducts(db, { limit: 1000 });

      // Four more than there were, and all four are mine.
      expect(page.total).toBe(before + 4);
      const found = page.rows.map((row) => row.productId);
      for (const id of idsOf(seeded, RICE, SOAP, OIL, ATTA)) expect(found).toContain(id);
    });
  });

  it('carries the joined columns the grid shows', async () => {
    await withRollback(async (db) => {
      const seeded = await seedCatalogue(db);
      const [riceId] = idsOf(seeded, RICE);

      const page = await searchProducts(db, { text: RICE });

      expect(page.rows).toHaveLength(1);
      expect(page.rows[0]).toMatchObject({
        productId: riceId,
        name: 'Basmati Rice 5kg',
        nameHi: 'बासमती चावल',
        barcode: RICE,
        categoryName: AISLE,
        slabName: 'GST 5%',
        unit: 'Kg',
        salePrice: '495.00',
        mrp: '520.00',
        status: 'active',
      });
    });
  });

  it('searches the Hindi name as well as the English one', async () => {
    await withRollback(async (db) => {
      const seeded = await seedCatalogue(db);

      // Invariant 20: the screen shows COALESCE(name_hi, name), so a Hindi
      // reader searches for what is in front of them.
      const page = await searchProducts(db, { text: 'सूरजमुखी' });

      const [oilId] = idsOf(seeded, OIL);
      expect(page.rows.map((row) => row.productId)).toContain(oilId);
    });
  });

  it('searches short name, item code and barcode too', async () => {
    await withRollback(async (db) => {
      const seeded = await seedCatalogue(db);
      const [soapId] = idsOf(seeded, SOAP);

      await expect(searchProducts(db, { text: 'SRCH SOAP' })).resolves.toMatchObject({ total: 1 });
      await expect(searchProducts(db, { text: OIL })).resolves.toMatchObject({ total: 1 });

      // The generated item code is searchable too - the code on the shelf label
      // is what somebody holding one will type.
      const byBarcode = await searchProducts(db, { text: SOAP });
      const itemCode = byBarcode.rows[0]?.itemCode ?? '';
      const byCode = await searchProducts(db, { text: itemCode });
      expect(byCode.rows.map((row) => row.productId)).toEqual([soapId]);
    });
  });

  it('treats a percent sign in the search as a character, not a wildcard', async () => {
    await withRollback(async (db) => {
      const seeded = await seedCatalogue(db);
      const [attaId, riceId, soapId] = idsOf(seeded, ATTA, RICE, SOAP);

      // '100%' interpolated into a LIKE would match every row in the
      // catalogue. Escaped, it matches the one product with a % in its name.
      const found = (await searchProducts(db, { text: '100%', limit: 1000 })).rows.map(
        (row) => row.productId,
      );

      expect(found).toContain(attaId);
      expect(found).not.toContain(riceId);
      expect(found).not.toContain(soapId);
    });
  });

  it('filters by category and by slab, which is how a bulk selection is made', async () => {
    await withRollback(async (db) => {
      const seeded = await seedCatalogue(db);
      const gst5 = await seededSlabId(db, 'GST 5%');
      const categoryId = (await searchProducts(db, { text: RICE })).rows[0]?.categoryId ?? null;

      // The fixture's own aisle, so the count is the fixture's.
      await expect(searchProducts(db, { categoryId })).resolves.toMatchObject({ total: 3 });

      // Slabs are shared with the whole catalogue, so this one is scoped by
      // combining the filters rather than counted on its own.
      const both = await searchProducts(db, { categoryId, taxSlabId: gst5, limit: 1000 });
      expect(both.rows.map((row) => row.productId).sort()).toEqual(
        idsOf(seeded, RICE, OIL, ATTA).sort(),
      );
    });
  });

  it('pages without changing the total', async () => {
    await withRollback(async (db) => {
      await seedCatalogue(db);
      const categoryId = (await searchProducts(db, { text: RICE })).rows[0]?.categoryId ?? null;

      const first = await searchProducts(db, { categoryId, limit: 2 });
      const second = await searchProducts(db, { categoryId, limit: 2, offset: 2 });

      // "Showing 2 of 3" has to keep saying 3, or an operator paging through a
      // selection cannot tell how much they are about to change.
      expect(first.total).toBe(3);
      expect(second.total).toBe(3);
      expect(first.rows).toHaveLength(2);
      expect(second.rows).toHaveLength(1);
      expect(first.rows.map((row) => row.productId)).not.toEqual(
        second.rows.map((row) => row.productId),
      );
    });
  });
});

describe('searchProductIds', () => {
  it('returns the whole matching set, not just the visible page', async () => {
    await withRollback(async (db) => {
      const seeded = await seedCatalogue(db);
      const categoryId = (await searchProducts(db, { text: RICE })).rows[0]?.categoryId ?? null;

      const ids = await searchProductIds(db, { categoryId, limit: 1 });

      // "Apply to all 3 matching" has to mean all three, even when one is on
      // screen. The limit belongs to the page, not to the selection.
      expect([...ids].sort()).toEqual(idsOf(seeded, RICE, OIL, ATTA).sort());
    });
  });
});
