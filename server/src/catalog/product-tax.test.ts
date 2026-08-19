import { describe, expect, it } from 'vitest';

import {
  assignSlab,
  cachedSlabId,
  createSlab,
  seedProduct,
  seededSlabId,
} from '../testing/catalog-fixtures.js';
import { withRollback } from '../testing/database.js';
import type { Queryable } from '../db/queryable.js';
import { resolveProductTax } from './product-tax.js';

/**
 * Slab resolution, tested forwards.
 *
 * The obvious test here is the historical one - a bill dated before the 22 Sep
 * 2025 revision reprints at 12%. It proves nothing this shop will ever run. It
 * opens in 2026 and its first bill is dated after the revision, so there is no
 * pre-revision document to reprint and never will be.
 *
 * The case it will hit is the next rate change, which is always in the future
 * when it is entered. The office records it days or weeks ahead; every bill
 * rung between now and then must carry the old rate, and the first bill after
 * the changeover must carry the new one. Get that wrong by a day and a thousand
 * bills go out at the wrong rate before anyone notices.
 *
 * So: a product on 5%, reassigned to a new 8% slab from the first of next
 * month. It resolves to 5% today, 5% a millisecond before the changeover, 8%
 * from the changeover onwards - and `products.tax_slab_id` does not move.
 */

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** Local midnight on the 1st - a rate change applies from a shop day, not from UTC. */
function firstOfNextMonth(from: Date): Date {
  return new Date(from.getFullYear(), from.getMonth() + 1, 1, 0, 0, 0, 0);
}

interface Fixture {
  readonly productId: number;
  /** `GST 5%`, seeded by 001_foundation.sql. */
  readonly currentSlabId: number;
  /** `GST 8%`, which the seed cannot contain - GST 2.0 left 0/5/18/40. */
  readonly newSlabId: number;
  readonly cataloguedAt: Date;
  readonly changeover: Date;
}

/**
 * One product on 5%, with a move to 8% recorded ahead of time - the shape the
 * office leaves behind when it enters a notified rate change.
 */
async function seedProductWithFutureSlabChange(db: Queryable, now: Date): Promise<Fixture> {
  const cataloguedAt = new Date(now.getTime() - NINETY_DAYS_MS);
  const changeover = firstOfNextMonth(now);

  const currentSlabId = await seededSlabId(db, 'GST 5%');
  const newSlabId = await createSlab(db, 'GST 8%', 8, changeover);
  const productId = await seedProduct(db, { itemCode: 'T-RICE-5', taxSlabId: currentSlabId });

  await assignSlab(db, productId, currentSlabId, cataloguedAt, 'Catalogued');
  await assignSlab(db, productId, newSlabId, changeover, 'Notified rate change');

  return { productId, currentSlabId, newSlabId, cataloguedAt, changeover };
}

describe('resolveProductTax', () => {
  it('holds today at the current rate when a change is already recorded for next month', async () => {
    await withRollback(async (db) => {
      const now = new Date();
      const fixture = await seedProductWithFutureSlabChange(db, now);

      const today = await resolveProductTax(db, fixture.productId, now);

      expect(today).not.toBeNull();
      expect(today?.slabName).toBe('GST 5%');
      expect(today?.taxSlabId).toBe(fixture.currentSlabId);
      expect(today?.rates).toEqual({
        cgstRate: 2.5,
        sgstRate: 2.5,
        igstRate: 5,
        cessRate: 0,
      });
      expect(today?.effectiveTo).toEqual(fixture.changeover);
    });
  });

  it('still returns the old rate one millisecond before the change takes effect', async () => {
    await withRollback(async (db) => {
      const now = new Date();
      const fixture = await seedProductWithFutureSlabChange(db, now);

      const lastMoment = new Date(fixture.changeover.getTime() - 1);
      const resolved = await resolveProductTax(db, fixture.productId, lastMoment);

      expect(resolved?.slabName).toBe('GST 5%');
      expect(resolved?.rates.igstRate).toBe(5);
    });
  });

  it('returns the new rate from the changeover instant onwards', async () => {
    await withRollback(async (db) => {
      const now = new Date();
      const fixture = await seedProductWithFutureSlabChange(db, now);

      const atChangeover = await resolveProductTax(db, fixture.productId, fixture.changeover);
      const aMonthLater = await resolveProductTax(
        db,
        fixture.productId,
        new Date(fixture.changeover.getTime() + THIRTY_DAYS_MS),
      );

      expect(atChangeover?.slabName).toBe('GST 8%');
      expect(atChangeover?.taxSlabId).toBe(fixture.newSlabId);
      expect(atChangeover?.rates).toEqual({
        cgstRate: 4,
        sgstRate: 4,
        igstRate: 8,
        cessRate: 0,
      });
      expect(atChangeover?.effectiveTo).toBeNull();
      expect(aMonthLater?.slabName).toBe('GST 8%');
    });
  });

  it('leaves products.tax_slab_id on the old slab until the change arrives', async () => {
    await withRollback(async (db) => {
      const now = new Date();
      const fixture = await seedProductWithFutureSlabChange(db, now);

      // The cache trigger fired three times seeding this fixture - opening the
      // 5% assignment, closing it, opening the 8% one - and moved nothing,
      // because it recomputes what is in force *now* rather than copying the
      // row that was just written. If it ever starts copying, this fails, and
      // it should: the counter would charge 8% a month early.
      await expect(cachedSlabId(db, fixture.productId)).resolves.toBe(fixture.currentSlabId);
    });
  });

  it('resolves to null before the product had any assignment', async () => {
    await withRollback(async (db) => {
      const now = new Date();
      const fixture = await seedProductWithFutureSlabChange(db, now);

      const before = new Date(fixture.cataloguedAt.getTime() - 1);

      // Not a rate of zero. The caller has to refuse the line rather than sell
      // it tax-free.
      await expect(resolveProductTax(db, fixture.productId, before)).resolves.toBeNull();
    });
  });

  it('refuses a second open assignment for the same product', async () => {
    await withRollback(async (db) => {
      const now = new Date();
      const fixture = await seedProductWithFutureSlabChange(db, now);

      // Two open rows would make the rate on the next scan depend on row order.
      await expect(
        db.query(
          `INSERT INTO product_tax_assignments (product_id, tax_slab_id, effective_from)
           VALUES ($1, $2, $3)`,
          [fixture.productId, fixture.currentSlabId, new Date(now.getTime() + 1000)],
        ),
      ).rejects.toThrow(/uq_product_tax_assignments_open/);
    });
  });
});
