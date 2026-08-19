import { describe, expect, it } from 'vitest';

import type { Queryable } from '../db/queryable.js';
import { firstRow, readInt, readNumeric } from '../db/rows.js';
import { seedProduct, seededSlabId } from '../testing/catalog-fixtures.js';
import { withRollback } from '../testing/database.js';
import { seedLocations } from '../testing/stock-fixtures.js';
import { postStockMovement, type StockTxnType } from './stock-ledger.js';
import { countStockOnHandDrift, rebuildStockOnHand } from './stock-on-hand.js';

/**
 * The stock ledger rebuild test - CLAUDE.md invariant 22.
 *
 * It posts a run of randomised movements, snapshots what the trigger built
 * incrementally, rebuilds `stock_on_hand` from the ledger from scratch, and
 * asserts the two agree exactly, row for row.
 *
 * This is the safety net for the entire project. Stock drift cannot be debugged
 * retroactively: by the time anyone notices a figure is wrong, the movements
 * that made it wrong are months of ordinary trading ago and there is nothing to
 * compare against. So the guard has to be that the incremental path and the
 * from-scratch path can never disagree, checked on every run.
 *
 * Never delete this test. Never mark it skipped.
 *
 * Both sides are compared in SQL, with EXCEPT ALL over exact NUMERIC values.
 * Pulling the rows into JavaScript and comparing doubles would let a real
 * 0.001 difference vanish, and could invent one that is not there.
 */

/** Fixed, so a failure reproduces exactly rather than "sometimes". */
const SEED = 20260819;
const MOVEMENT_COUNT = 100;
const PRODUCT_COUNT = 5;

const TXN_TYPES: readonly StockTxnType[] = [
  'sale',
  'sale_return',
  'purchase',
  'adjustment',
  'transfer_in',
  'transfer_out',
];

/** mulberry32 - small, seedable, and good enough to shuffle test data. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Four instants, so movements collide on `occurred_at` in bulk. Ties are the
 * case a rebuild that ordered by timestamp instead of by id would get wrong.
 */
function occurredAtChoices(now: Date): readonly Date[] {
  const hour = 60 * 60 * 1000;
  return [
    new Date(now.getTime() - 6 * hour),
    new Date(now.getTime() - 4 * hour),
    new Date(now.getTime() - 2 * hour),
    new Date(now.getTime() - hour),
  ];
}

function pick<T>(random: () => number, from: readonly T[]): T {
  const item = from[Math.floor(random() * from.length)];
  if (item === undefined) throw new Error('empty choice list');
  return item;
}

interface Fixture {
  readonly products: number[];
  /** A rack, a godown and a counter display. Real rows - location_id is a FK. */
  readonly locations: number[];
}

async function seedFixture(db: Queryable, prefix: string): Promise<Fixture> {
  const slabId = await seededSlabId(db, 'GST 5%');
  const products: number[] = [];

  for (let i = 0; i < PRODUCT_COUNT; i += 1) {
    products.push(
      await seedProduct(db, {
        itemCode: `${prefix}-${String(i)}`,
        taxSlabId: slabId,
        name: `Test stock product ${String(i)}`,
      }),
    );
  }

  return { products, locations: await seedLocations(db, prefix) };
}

async function scalarInt(db: Queryable, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await db.query(sql, params);
  return readInt(firstRow(rows), 'n');
}

async function scalarNumeric(db: Queryable, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await db.query(sql, params);
  return readNumeric(firstRow(rows), 'n');
}

/**
 * Rows where the snapshot and the rebuilt cache differ, in either direction and
 * in any column. Zero is the only acceptable answer.
 */
const SYMMETRIC_DIFFERENCE_SQL = `
  SELECT count(*)::int AS n FROM (
    (SELECT product_id, location_id, qty, last_ledger_id FROM stock_on_hand_snapshot
     EXCEPT ALL
     SELECT product_id, location_id, qty, last_ledger_id FROM stock_on_hand)
    UNION ALL
    (SELECT product_id, location_id, qty, last_ledger_id FROM stock_on_hand
     EXCEPT ALL
     SELECT product_id, location_id, qty, last_ledger_id FROM stock_on_hand_snapshot)
  ) d`;

describe('stock_on_hand rebuild', () => {
  it('reproduces the trigger-maintained cache exactly from the ledger', async () => {
    await withRollback(async (db) => {
      const now = new Date();
      const random = makeRandom(SEED);
      const { products, locations } = await seedFixture(db, 'T-STK');
      const instants = occurredAtChoices(now);

      const firstProduct = products[0];
      const firstLocation = locations[0];
      if (firstProduct === undefined || firstLocation === undefined) {
        throw new Error('fixture did not seed');
      }

      for (let i = 0; i < MOVEMENT_COUNT; i += 1) {
        // The first two are pinned to one product and location so that pair is
        // guaranteed to carry movements, and can then be driven to exactly zero
        // below. The rest are free.
        const productId = i < 2 ? firstProduct : pick(random, products);
        const locationId = i < 2 ? firstLocation : pick(random, locations);

        // Signed, three decimals, never zero - the column refuses zero and a
        // movement that records nothing is always a bug in the caller.
        const magnitude = Math.round((random() * 20 + 0.001) * 1000) / 1000;
        const qtyDelta = random() < 0.4 ? -magnitude : magnitude;

        await postStockMovement(db, {
          productId,
          locationId,
          txnType: pick(random, TXN_TYPES),
          qtyDelta,
          refTable: 'rebuild_test',
          refId: i + 1,
          occurredAt: pick(random, instants),
        });
      }

      // One pair driven to exactly zero. The negation is computed in SQL so it
      // is the exact NUMERIC complement rather than a float that nearly is.
      // A product that nets to zero still has a cache row, and a rebuild that
      // dropped it would disagree here.
      await db.query(
        `INSERT INTO stock_ledger (product_id, location_id, txn_type, qty_delta,
                                   ref_table, ref_id, occurred_at)
         SELECT $1, $2, 'adjustment', -sum(qty_delta), 'rebuild_test', 0, $3
           FROM stock_ledger
          WHERE product_id = $1 AND location_id = $2
         HAVING sum(qty_delta) <> 0`,
        [firstProduct, firstLocation, now],
      );

      // The fixture has to be worth testing: several pairs, at least one
      // negative balance, and the zeroed pair actually at zero.
      const pairs = await scalarInt(db, `SELECT count(*)::int AS n FROM stock_on_hand`);
      const negatives = await scalarInt(
        db,
        `SELECT count(*)::int AS n FROM stock_on_hand WHERE qty < 0`,
      );
      const zeroed = await scalarNumeric(
        db,
        `SELECT qty AS n FROM stock_on_hand WHERE product_id = $1 AND location_id = $2`,
        [firstProduct, firstLocation],
      );

      expect(pairs).toBeGreaterThan(5);
      expect(negatives).toBeGreaterThan(0);
      expect(zeroed).toBe(0);

      // Snapshot what the trigger built, then derive it again from nothing.
      await db.query(
        `CREATE TEMP TABLE stock_on_hand_snapshot ON COMMIT DROP AS
           SELECT product_id, location_id, qty, last_ledger_id FROM stock_on_hand`,
      );

      const rebuiltRows = await rebuildStockOnHand(db);

      expect(rebuiltRows).toBe(pairs);
      await expect(scalarInt(db, SYMMETRIC_DIFFERENCE_SQL)).resolves.toBe(0);
      await expect(countStockOnHandDrift(db)).resolves.toBe(0);
    });
  });

  it('agrees with the ledger at every point, not only at the end', async () => {
    await withRollback(async (db) => {
      const now = new Date();
      const random = makeRandom(SEED + 1);
      const { products, locations } = await seedFixture(db, 'T-STEP');

      // Checking after each movement catches an error that a later movement
      // would otherwise cancel out - the sum landing right by luck while the
      // incremental path was wrong twice.
      for (let i = 0; i < 20; i += 1) {
        await postStockMovement(db, {
          productId: pick(random, products),
          locationId: pick(random, locations),
          txnType: pick(random, TXN_TYPES),
          qtyDelta: random() < 0.5 ? -1.5 : 2.25,
          refTable: 'rebuild_test',
          refId: i + 1,
          occurredAt: now,
        });

        await expect(countStockOnHandDrift(db)).resolves.toBe(0);
      }
    });
  });
});
