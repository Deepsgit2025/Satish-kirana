import { describe, expect, it } from 'vitest';

import {
  assignSlab,
  cachedSlabId,
  seedProduct,
  seededSlabId,
} from '../testing/catalog-fixtures.js';
import { withRollback } from '../testing/database.js';
import type { Queryable } from '../db/queryable.js';

/**
 * `products.tax_slab_id` is a cache of `product_tax_assignments`, and this is
 * what holds it to that - docs/DECISIONS.md D28.
 *
 * A comment saying CACHE ONLY does not survive a bulk edit screen. Two sources
 * of truth with nothing reconciling them is how a product ends up billing at 5%
 * while every report says 18%, and nobody finds out from the software.
 *
 * Three mechanisms, tested here, because no one of them covers the ground:
 *
 *   the trigger  - the assignment in force right now changed, so the cache
 *                  moves with it, immediately.
 *   the refresh  - the clock moved past a future-dated change. Nothing wrote,
 *                  so no trigger fired; the nightly pass advances the cache.
 *   the view     - whatever neither caught, made visible instead of assumed.
 *
 * The timestamps below are deliberately in the past rather than `new Date()` -
 * see the `now()` note in CLAUDE.md, Working practices.
 */

const MINUTE_MS = 60 * 1000;
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

function readInt(rows: readonly unknown[], column: string): number {
  const [row] = rows;
  if (typeof row !== 'object' || row === null) throw new Error('expected one row');

  const value = (row as Record<string, unknown>)[column];
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed)) {
    throw new Error(`expected an integer in ${column}`);
  }
  return parsed;
}

interface DriftRow {
  readonly cachedTaxSlabId: number;
  readonly inForceTaxSlabId: number | null;
}

function toDriftRow(value: unknown): DriftRow {
  if (typeof value !== 'object' || value === null) throw new Error('expected a drift row');
  const row = value as Record<string, unknown>;

  const inForce = row.in_force_tax_slab_id;
  return {
    cachedTaxSlabId: readInt([row], 'cached_tax_slab_id'),
    inForceTaxSlabId:
      inForce === null || inForce === undefined ? null : readInt([row], 'in_force_tax_slab_id'),
  };
}

async function driftFor(db: Queryable, productId: number): Promise<DriftRow[]> {
  const { rows } = await db.query(
    `SELECT cached_tax_slab_id, in_force_tax_slab_id
       FROM product_tax_cache_drift
      WHERE product_id = $1`,
    [productId],
  );
  return rows.map(toDriftRow);
}

/** Drift the nightly pass can actually correct - excludes products with no history. */
async function correctableDriftCount(db: Queryable): Promise<number> {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM product_tax_cache_drift WHERE in_force_tax_slab_id IS NOT NULL`,
  );
  return readInt(rows, 'n');
}

/** The nightly pass. Returns how many products it moved. */
async function refreshCache(db: Queryable): Promise<number> {
  const { rows } = await db.query(`SELECT refresh_product_tax_slab_cache() AS n`);
  return readInt(rows, 'n');
}

describe('products.tax_slab_id cache', () => {
  it('moves with an assignment that takes effect immediately, without waiting for the nightly pass', async () => {
    await withRollback(async (db) => {
      const fivePercent = await seededSlabId(db, 'GST 5%');
      const eighteenPercent = await seededSlabId(db, 'GST 18%');
      const productId = await seedProduct(db, { itemCode: 'T-CACHE-1', taxSlabId: fivePercent });

      await assignSlab(
        db,
        productId,
        fivePercent,
        new Date(Date.now() - NINETY_DAYS_MS),
        'Catalogued',
      );
      await expect(cachedSlabId(db, productId)).resolves.toBe(fivePercent);

      // An HSN correction found in an audit: right slab from a minute ago, not
      // from next month. Waiting until the small hours to reflect it would be a
      // day of bills at the wrong rate.
      await assignSlab(
        db,
        productId,
        eighteenPercent,
        new Date(Date.now() - MINUTE_MS),
        'HSN corrected after audit',
      );

      await expect(cachedSlabId(db, productId)).resolves.toBe(eighteenPercent);
      await expect(driftFor(db, productId)).resolves.toEqual([]);
    });
  });

  it('reports nothing for a product whose history and cache agree', async () => {
    await withRollback(async (db) => {
      const fivePercent = await seededSlabId(db, 'GST 5%');
      const productId = await seedProduct(db, { itemCode: 'T-CACHE-2', taxSlabId: fivePercent });

      await assignSlab(
        db,
        productId,
        fivePercent,
        new Date(Date.now() - NINETY_DAYS_MS),
        'Catalogued',
      );

      await expect(driftFor(db, productId)).resolves.toEqual([]);
    });
  });

  it('reports a stale cache, and the nightly pass corrects it', async () => {
    await withRollback(async (db) => {
      const fivePercent = await seededSlabId(db, 'GST 5%');
      const eighteenPercent = await seededSlabId(db, 'GST 18%');
      const productId = await seedProduct(db, { itemCode: 'T-CACHE-3', taxSlabId: fivePercent });

      await assignSlab(
        db,
        productId,
        fivePercent,
        new Date(Date.now() - NINETY_DAYS_MS),
        'Catalogued',
      );

      // The morning after a changeover, in the state it would be in if only a
      // trigger guarded this: history has moved on, the column has not. Written
      // directly, because nothing legitimate produces it - which is the point.
      await db.query(`UPDATE products SET tax_slab_id = $2 WHERE id = $1`, [
        productId,
        eighteenPercent,
      ]);

      await expect(driftFor(db, productId)).resolves.toEqual([
        { cachedTaxSlabId: eighteenPercent, inForceTaxSlabId: fivePercent },
      ]);

      const correctable = await correctableDriftCount(db);
      const moved = await refreshCache(db);

      expect(moved).toBe(correctable);
      await expect(cachedSlabId(db, productId)).resolves.toBe(fivePercent);
      await expect(driftFor(db, productId)).resolves.toEqual([]);
    });
  });

  it('leaves a product with no assignment in force listed after a refresh', async () => {
    await withRollback(async (db) => {
      const fivePercent = await seededSlabId(db, 'GST 5%');
      const productId = await seedProduct(db, { itemCode: 'T-CACHE-4', taxSlabId: fivePercent });

      // Catalogued with a slab on the row and no history behind it. The refresh
      // cannot invent one, so this has to stay visible rather than be silently
      // counted as reconciled - a sellable product with no tax history wants a
      // human, not a nightly job.
      await refreshCache(db);

      await expect(driftFor(db, productId)).resolves.toEqual([
        { cachedTaxSlabId: fivePercent, inForceTaxSlabId: null },
      ]);
    });
  });

  it('refuses an assignment that overlaps another already in force', async () => {
    await withRollback(async (db) => {
      const fivePercent = await seededSlabId(db, 'GST 5%');
      const eighteenPercent = await seededSlabId(db, 'GST 18%');
      const productId = await seedProduct(db, { itemCode: 'T-CACHE-5', taxSlabId: fivePercent });

      await assignSlab(
        db,
        productId,
        fivePercent,
        new Date(Date.now() - NINETY_DAYS_MS),
        'Catalogued',
      );

      // A closed period laid across the open one. The one-open-row index does
      // not catch this - the new row has an effective_to - so the cache trigger
      // is what refuses it. Two rows in force is not a rate to choose between.
      await expect(
        db.query(
          `INSERT INTO product_tax_assignments (product_id, tax_slab_id, effective_from, effective_to)
           VALUES ($1, $2, $3, $4)`,
          [
            productId,
            eighteenPercent,
            new Date(Date.now() - NINETY_DAYS_MS / 2),
            new Date(Date.now() + NINETY_DAYS_MS),
          ],
        ),
      ).rejects.toThrow(/must not overlap/);
    });
  });
});
