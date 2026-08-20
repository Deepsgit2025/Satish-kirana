import { describe, expect, it } from 'vitest';

import type { Queryable } from '../db/queryable.js';
import { seedProduct, seededSlabId, assignSlab } from '../testing/catalog-fixtures.js';
import { inSavepoint, withRollback } from '../testing/database.js';
import { seedLocation } from '../testing/stock-fixtures.js';
import { postStockMovement } from '../stock/stock-ledger.js';
import {
  PRODUCT_PRICE_CACHE_CHECK,
  PRODUCT_TAX_CACHE_CHECK,
  runAllReconciliationChecks,
  runProductTaxCacheCheck,
  runStockOnHandCheck,
  STOCK_ON_HAND_CHECK,
} from './checks.js';
import { readReconciliationHealth, recordReconciliationRun } from './health.js';

/**
 * The reconciliation health surface - docs/DECISIONS.md D30.
 *
 * What is being tested is mostly that the panel cannot lie by omission: a check
 * that has never run and a check that has not run in a fortnight both have to
 * read as wrong, because a check nobody runs looks exactly like a check that
 * always passes.
 */

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

function healthFor(
  rows: Awaited<ReturnType<typeof readReconciliationHealth>>,
  key: string,
): Awaited<ReturnType<typeof readReconciliationHealth>>[number] {
  const row = rows.find((candidate) => candidate.key === key);
  if (row === undefined) throw new Error(`no health row for ${key}`);
  return row;
}

/** A throwaway check, so a test never depends on what the real ones have done. */
async function registerCheck(db: Queryable, key: string): Promise<void> {
  await db.query(
    `INSERT INTO reconciliation_checks (key, description, run_every, corrects)
     VALUES ($1, 'Registered by a test.', INTERVAL '1 day', false)`,
    [key],
  );
}

async function seedStockedProduct(db: Queryable, itemCode: string): Promise<number> {
  const slabId = await seededSlabId(db, 'GST 5%');
  const productId = await seedProduct(db, { itemCode, taxSlabId: slabId });

  await postStockMovement(db, {
    productId,
    locationId: await seedLocation(db, `${itemCode}-RACK`),
    txnType: 'opening',
    qtyDelta: 10,
    refTable: 'test',
    refId: 1,
    occurredAt: new Date(),
  });

  return productId;
}

describe('reconciliation health', () => {
  it('lists every registered check and says which of them correct what they find', async () => {
    await withRollback(async (db) => {
      const health = await readReconciliationHealth(db);

      expect(health.map((row) => row.key)).toContain(PRODUCT_TAX_CACHE_CHECK);
      expect(health.map((row) => row.key)).toContain(STOCK_ON_HAND_CHECK);

      // The two differ in kind, and the panel says which is which: one fixes
      // what it finds, the other only reports it (docs/DECISIONS.md D32).
      expect(healthFor(health, PRODUCT_TAX_CACHE_CHECK).corrects).toBe(true);
      expect(healthFor(health, STOCK_ON_HAND_CHECK).corrects).toBe(false);
    });
  });

  it('reports a check that has never run as never_run, not as passing', async () => {
    await withRollback(async (db) => {
      // Its own key, because the real checks have real history the moment
      // anything runs them, and a test that assumes an empty run log passes
      // only until someone uses the thing being tested.
      await registerCheck(db, 'test_never_run');

      const row = healthFor(await readReconciliationHealth(db), 'test_never_run');

      expect(row.lastRunAt).toBeNull();
      expect(row.health).toBe('never_run');
    });
  });

  it('records a clean run for every check', async () => {
    await withRollback(async (db) => {
      const outcomes = await runAllReconciliationChecks(db);

      expect(outcomes.map((outcome) => outcome.status)).toEqual(['ok', 'ok', 'ok']);

      const health = await readReconciliationHealth(db);
      for (const key of [PRODUCT_TAX_CACHE_CHECK, PRODUCT_PRICE_CACHE_CHECK, STOCK_ON_HAND_CHECK]) {
        const row = healthFor(health, key);
        expect(row.health).toBe('ok');
        expect(row.outstanding).toBe(0);
        expect(row.lastRunAt).not.toBeNull();
      }
    });
  });

  it('reports stock drift without correcting it', async () => {
    await withRollback(async (db) => {
      const productId = await seedStockedProduct(db, 'T-HEALTH-1');

      // Drift can only be produced by writing the cache directly, which is the
      // point: nothing in the application does this, so a row here means the
      // trigger is wrong.
      await db.query(`UPDATE stock_on_hand SET qty = qty + 5 WHERE product_id = $1`, [productId]);

      const outcome = await runStockOnHandCheck(db);

      expect(outcome.status).toBe('drift');
      expect(outcome.outstanding).toBe(1);
      expect(outcome.corrected).toBe(0);
      expect(outcome.detail).toMatch(/cache 15, ledger 10/);

      // Still wrong afterwards, deliberately. Rebuilding on a schedule would
      // repair the symptom and destroy the evidence (docs/DECISIONS.md D32).
      const health = await readReconciliationHealth(db);
      expect(healthFor(health, STOCK_ON_HAND_CHECK).health).toBe('drift');
      await expect(runStockOnHandCheck(db)).resolves.toMatchObject({ outstanding: 1 });
    });
  });

  it('corrects a stale tax cache and reports nothing outstanding', async () => {
    await withRollback(async (db) => {
      const fivePercent = await seededSlabId(db, 'GST 5%');
      const eighteenPercent = await seededSlabId(db, 'GST 18%');
      const productId = await seedProduct(db, { itemCode: 'T-HEALTH-2', taxSlabId: fivePercent });

      await assignSlab(
        db,
        productId,
        fivePercent,
        new Date(Date.now() - NINETY_DAYS_MS),
        'Catalogued',
      );
      await db.query(`UPDATE products SET tax_slab_id = $2 WHERE id = $1`, [
        productId,
        eighteenPercent,
      ]);

      const outcome = await runProductTaxCacheCheck(db);

      expect(outcome.corrected).toBe(1);
      expect(outcome.outstanding).toBe(0);
      expect(outcome.status).toBe('ok');
    });
  });

  it('reports a check that has stopped running as overdue, not as passing', async () => {
    await withRollback(async (db) => {
      // A clean run, a fortnight ago, and nothing since. The last thing this
      // check said was "ok", which is exactly why the panel must not repeat it.
      await registerCheck(db, 'test_overdue');
      await db.query(
        `INSERT INTO reconciliation_runs (check_key, ran_at, status, outstanding, corrected)
         VALUES ($1, now() - INTERVAL '14 days', 'ok', 0, 0)`,
        ['test_overdue'],
      );

      const row = healthFor(await readReconciliationHealth(db), 'test_overdue');

      expect(row.lastStatus).toBe('ok');
      expect(row.health).toBe('overdue');
    });
  });

  it('keeps the run log append-only', async () => {
    await withRollback(async (db) => {
      await recordReconciliationRun(db, {
        checkKey: STOCK_ON_HAND_CHECK,
        status: 'ok',
        outstanding: 0,
        corrected: 0,
      });

      // A run log that can be tidied up is a run log that will be, on the day
      // it is inconvenient.
      await expect(
        inSavepoint(db, () => db.query(`UPDATE reconciliation_runs SET outstanding = 0`)),
      ).rejects.toThrow(/append-only/);
      await expect(
        inSavepoint(db, () => db.query(`DELETE FROM reconciliation_runs`)),
      ).rejects.toThrow(/append-only/);
      await expect(inSavepoint(db, () => db.query(`TRUNCATE reconciliation_runs`))).rejects.toThrow(
        /append-only/,
      );
    });
  });

  it('refuses to record a run that claims to be clean while reporting drift', async () => {
    await withRollback(async (db) => {
      // The status and the count are two ways of saying the same thing, and a
      // panel reading one while the other disagrees is worse than no panel.
      await expect(
        recordReconciliationRun(db, {
          checkKey: STOCK_ON_HAND_CHECK,
          status: 'ok',
          outstanding: 4,
          corrected: 0,
        }),
      ).rejects.toThrow(/status_matches_counts/);
    });
  });
});
