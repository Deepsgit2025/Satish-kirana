import { describe, expect, it } from 'vitest';

import type { Queryable } from '../db/queryable.js';
import { asRow, readNumeric, readTimestamp } from '../db/rows.js';
import { seedProduct, seededSlabId } from '../testing/catalog-fixtures.js';
import { seedLocation } from '../testing/stock-fixtures.js';
import { withRollback } from '../testing/database.js';
import { postStockMovement } from './stock-ledger.js';

/**
 * The stock ledger's own guarantees: append-only, enforced by the database, and
 * two timestamps that mean different things.
 *
 * Append-only is a CLAUDE.md invariant, and an invariant enforced by convention
 * is a convention. Every one of these mutations is refused by a trigger rather
 * than by a code review.
 */

const MINUTE_MS = 60 * 1000;

interface Fixture {
  readonly productId: number;
  readonly locationId: number;
}

async function seedOne(db: Queryable, itemCode: string): Promise<Fixture> {
  const slabId = await seededSlabId(db, 'GST 5%');
  return {
    productId: await seedProduct(db, { itemCode, taxSlabId: slabId }),
    locationId: await seedLocation(db, `${itemCode}-RACK`),
  };
}

async function cachedQty(
  db: Queryable,
  productId: number,
  locationId: number | null,
): Promise<number> {
  const { rows } = await db.query(
    `SELECT qty FROM stock_on_hand
      WHERE product_id = $1 AND location_id IS NOT DISTINCT FROM $2`,
    [productId, locationId],
  );
  const [row] = rows;
  if (row === undefined) throw new Error('no stock_on_hand row');
  return readNumeric(asRow(row), 'qty');
}

describe('stock_ledger', () => {
  it('derives stock_on_hand from movements, including negative deltas', async () => {
    await withRollback(async (db) => {
      const now = new Date();
      const { productId, locationId } = await seedOne(db, 'T-LEDGER-1');

      await postStockMovement(db, {
        productId,
        locationId,
        txnType: 'opening',
        qtyDelta: 12.5,
        refTable: 'test',
        refId: 1,
        occurredAt: now,
      });
      await postStockMovement(db, {
        productId,
        locationId,
        txnType: 'sale',
        qtyDelta: -4.25,
        refTable: 'test',
        refId: 2,
        occurredAt: now,
      });

      await expect(cachedQty(db, productId, locationId)).resolves.toBe(8.25);
    });
  });

  it('keeps an unlocated balance separate from a located one', async () => {
    await withRollback(async (db) => {
      const now = new Date();
      const { productId, locationId } = await seedOne(db, 'T-LEDGER-2');

      // Opening stock in a shop with no racks configured yet. The NULL row is a
      // real balance, not a missing one, and must not merge with the rack.
      await postStockMovement(db, {
        productId,
        txnType: 'opening',
        qtyDelta: 7,
        refTable: 'test',
        refId: 1,
        occurredAt: now,
      });
      await postStockMovement(db, {
        productId,
        locationId,
        txnType: 'purchase',
        qtyDelta: 3,
        refTable: 'test',
        refId: 2,
        occurredAt: now,
      });

      await expect(cachedQty(db, productId, null)).resolves.toBe(7);
      await expect(cachedQty(db, productId, locationId)).resolves.toBe(3);
    });
  });

  it('records business time and server time separately', async () => {
    await withRollback(async (db) => {
      const { productId, locationId } = await seedOne(db, 'T-LEDGER-3');

      // A bill rung at the counter during a LAN outage and synced later. Both
      // times have to survive, or the hourly sales report lies about when the
      // shop was busy (CLAUDE.md invariant 11).
      const occurredAt = new Date(Date.now() - 40 * MINUTE_MS);

      const { rows } = await db.query(
        `INSERT INTO stock_ledger (product_id, location_id, txn_type, qty_delta, ref_table,
                                   ref_id, occurred_at, recorded_at)
         VALUES ($1, $3, 'sale', -1, 'test', 1, $2, TIMESTAMPTZ '2020-01-01 00:00:00+05:30')
         RETURNING occurred_at, recorded_at`,
        [productId, occurredAt, locationId],
      );

      const row = asRow(rows[0]);
      const storedOccurred = readTimestamp(row, 'occurred_at');
      const storedRecorded = readTimestamp(row, 'recorded_at');

      expect(storedOccurred).toEqual(occurredAt);

      // The caller offered 2020 and the database ignored it. recorded_at is the
      // server's own account of when it saw the row; a caller that could set it
      // could lie about it, and every sync report reads it as truth.
      expect(storedRecorded.getFullYear()).toBeGreaterThan(2020);
      expect(storedRecorded.getTime()).toBeGreaterThan(storedOccurred.getTime());
      expect(Math.abs(storedRecorded.getTime() - Date.now())).toBeLessThan(5 * MINUTE_MS);
    });
  });

  it('refuses a movement that records nothing', async () => {
    await withRollback(async (db) => {
      const { productId, locationId } = await seedOne(db, 'T-LEDGER-4');

      await expect(
        postStockMovement(db, {
          productId,
          locationId,
          txnType: 'adjustment',
          qtyDelta: 0,
          refTable: 'test',
          refId: 1,
          occurredAt: new Date(),
        }),
      ).rejects.toThrow(/qty_delta/);
    });
  });

  it('refuses a movement against a location that does not exist', async () => {
    await withRollback(async (db) => {
      const { productId } = await seedOne(db, 'T-LEDGER-7');

      // The reason locations was brought forward into 007 rather than waiting
      // for the receiving work: a wrong location id landing in an append-only
      // table could never be corrected, only annotated by a compensating row
      // that leaves the wrong one in place.
      await expect(
        postStockMovement(db, {
          productId,
          locationId: 999_999_999,
          txnType: 'purchase',
          qtyDelta: 5,
          refTable: 'test',
          refId: 1,
          occurredAt: new Date(),
        }),
      ).rejects.toThrow(/stock_ledger_location_id_fkey/);
    });
  });

  it('refuses UPDATE', async () => {
    await withRollback(async (db) => {
      const { productId, locationId } = await seedOne(db, 'T-LEDGER-5');
      await postStockMovement(db, {
        productId,
        locationId,
        txnType: 'sale',
        qtyDelta: -1,
        refTable: 'test',
        refId: 1,
        occurredAt: new Date(),
      });

      await expect(
        db.query(`UPDATE stock_ledger SET qty_delta = -2 WHERE product_id = $1`, [productId]),
      ).rejects.toThrow(/append-only/);
    });
  });

  it('refuses DELETE, including one that would match nothing', async () => {
    await withRollback(async (db) => {
      const { productId, locationId } = await seedOne(db, 'T-LEDGER-6');
      await postStockMovement(db, {
        productId,
        locationId,
        txnType: 'sale',
        qtyDelta: -1,
        refTable: 'test',
        refId: 1,
        occurredAt: new Date(),
      });

      await expect(
        db.query(`DELETE FROM stock_ledger WHERE product_id = $1`, [productId]),
      ).rejects.toThrow(/append-only/);
    });
  });

  it('refuses a DELETE that matches no rows', async () => {
    await withRollback(async (db) => {
      // A row trigger would let this through, having no rows to fire on, and
      // the statement would report success. Enforcement that only works when
      // it happens to match something is not enforcement.
      await expect(db.query(`DELETE FROM stock_ledger WHERE false`)).rejects.toThrow(/append-only/);
    });
  });

  it('refuses TRUNCATE', async () => {
    await withRollback(async (db) => {
      // TRUNCATE never fires row triggers, so without a statement-level guard
      // it is the one command that empties an append-only table in silence.
      await expect(db.query(`TRUNCATE stock_ledger CASCADE`)).rejects.toThrow(/append-only/);
    });
  });
});
