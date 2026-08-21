import { describe, expect, it } from 'vitest';

import { databaseNow } from '../db/clock.js';
import type { Queryable } from '../db/queryable.js';
import { withRollback } from '../testing/database.js';
import { seedSyntheticStock, SYNTHETIC_MOVEMENTS } from '../testing/synthetic-stock.js';
import { assertRestoredDatabase, describeFailures, failedAssertions } from './assertions.js';
import { captureManifest, type BackupManifest } from './manifest.js';

/**
 * The manifest, and the assertions restore-verify makes against it.
 *
 * A real restore needs a committed dump and a scratch database, which no test
 * inside a rolled-back transaction can have. What can be tested here - and is
 * the part with the logic in it - is whether the comparison itself is
 * load-bearing: a database asserted against a manifest of itself must pass
 * every assertion, and a manifest doctored by one figure must fail the one
 * assertion that covers it and no others.
 *
 * That is the same trick the rebuild test uses. Assert the two paths agree, then
 * prove the assertion notices when they do not, rather than trusting that a
 * green comparison was comparing anything.
 *
 * The fixture is the synthetic catalogue and ledger from
 * `testing/synthetic-stock.ts`: 100 movements over 5 products and 3 locations.
 * The shop has not opened and there is no real catalogue yet, so that is what a
 * backup of this system currently contains.
 *
 * Sizes of the deliberate breakages follow docs/DECISIONS.md D33: quantities
 * are NUMERIC(12,3), so a mutation has to be at least 0.001 at the magnitudes
 * in play or it is rounded away before it reaches the data and the surviving
 * assertion proves nothing either way.
 */

async function manifestOf(db: Queryable, dumpFile: string): Promise<BackupManifest> {
  const takenAt = await databaseNow(db);
  return captureManifest(db, { database: 'ssbazar', dumpFile, takenAt });
}

function assertionNamed(
  assertions: Awaited<ReturnType<typeof assertRestoredDatabase>>,
  name: string,
): (typeof assertions)[number] {
  const found = assertions.find((assertion) => assertion.name === name);
  if (found === undefined) throw new Error(`no assertion named ${name}`);
  return found;
}

describe('backup manifest', () => {
  it('describes the database it was captured from, and that database satisfies it', async () => {
    await withRollback(async (db) => {
      await seedSyntheticStock(db, 'T-BACKUP-1', await databaseNow(db));

      const manifest = await manifestOf(db, 'ssbazar-20260821T183000Z.dump');
      const assertions = await assertRestoredDatabase(db, manifest);

      expect(failedAssertions(assertions)).toEqual([]);

      // The fixture has to be worth asserting about. A manifest of an empty
      // database would pass every check above while proving nothing.
      expect(manifest.stock.ledgerRows).toBeGreaterThanOrEqual(SYNTHETIC_MOVEMENTS);
      expect(manifest.migrations).toContain('005_stock_ledger.sql');
      expect(manifest.migrations).toContain('010_backup_health.sql');
      expect(manifest.tables.map((table) => table.name)).toContain('stock_ledger');
      expect(manifest.stock.driftRows).toBe(0);
    });
  });

  it('covers every table without being told which ones exist', async () => {
    await withRollback(async (db) => {
      const manifest = await manifestOf(db, 'ssbazar-20260821T183000Z.dump');
      const names = manifest.tables.map((table) => table.name);

      // Discovered rather than listed, so a table added by a later migration is
      // covered the day it lands instead of the day someone remembers.
      for (const table of [
        'products',
        'stock_ledger',
        'stock_on_hand',
        'reconciliation_runs',
        'schema_migrations',
      ]) {
        expect(names).toContain(table);
      }
    });
  });

  it('fails the row-count assertion for the one table that is short', async () => {
    await withRollback(async (db) => {
      await seedSyntheticStock(db, 'T-BACKUP-2', await databaseNow(db));
      const manifest = await manifestOf(db, 'ssbazar-20260821T183000Z.dump');

      // A restore that dropped a single ledger row: the count in the manifest
      // says one more than the database holds.
      const doctored: BackupManifest = {
        ...manifest,
        tables: manifest.tables.map((table) =>
          table.name === 'stock_ledger' ? { ...table, rows: table.rows + 1 } : table,
        ),
      };

      const assertions = await assertRestoredDatabase(db, doctored);
      const failures = failedAssertions(assertions);

      expect(failures.map((failure) => failure.name)).toEqual(['rows:public.stock_ledger']);
      expect(describeFailures(assertions)).toMatch(/rows:public\.stock_ledger: expected/);
    });
  });

  it('notices a quantity that came back 0.001 different', async () => {
    await withRollback(async (db) => {
      await seedSyntheticStock(db, 'T-BACKUP-3', await databaseNow(db));
      const manifest = await manifestOf(db, 'ssbazar-20260821T183000Z.dump');

      const total = manifest.stock.totalQty;
      if (total === null) throw new Error('fixture posted no movements');

      // One thousandth, which is exactly the storage precision of
      // NUMERIC(12,3). Anything smaller is rounded away before it reaches the
      // column and the assertion would survive for a reason that says nothing
      // about the assertion (docs/DECISIONS.md D33).
      const shifted = (Number.parseFloat(total) + 0.001).toFixed(3);

      const assertions = await assertRestoredDatabase(db, {
        ...manifest,
        stock: { ...manifest.stock, totalQty: shifted },
      });

      expect(failedAssertions(assertions).map((failure) => failure.name)).toEqual([
        'stock:total_qty',
      ]);
    });
  });

  it('notices a recorded_at that was rewritten in transit', async () => {
    await withRollback(async (db) => {
      await seedSyntheticStock(db, 'T-BACKUP-4', await databaseNow(db));
      const manifest = await manifestOf(db, 'ssbazar-20260821T183000Z.dump');

      // What a data-only restore would do: `stamp_recorded_at` fires on every
      // restored INSERT and stamps today over the history. Row counts still
      // match, nothing errors, and invariant 11's offline gap is gone.
      const assertions = await assertRestoredDatabase(db, {
        ...manifest,
        stock: { ...manifest.stock, maxRecordedAt: '2020-01-01 00:00:00+00' },
      });

      expect(failedAssertions(assertions).map((failure) => failure.name)).toEqual([
        'stock:max_recorded_at',
      ]);
    });
  });

  it('fails when the restore is missing a table entirely', async () => {
    await withRollback(async (db) => {
      const manifest = await manifestOf(db, 'ssbazar-20260821T183000Z.dump');

      const doctored: BackupManifest = {
        ...manifest,
        tables: [...manifest.tables, { schema: 'public', name: 'a_table_that_is_gone', rows: 3 }],
      };

      const failures = failedAssertions(await assertRestoredDatabase(db, doctored));

      expect(failures.map((failure) => failure.name)).toEqual([
        'tables',
        'rows:public.a_table_that_is_gone',
      ]);
      expect(
        assertionNamed(
          await assertRestoredDatabase(db, doctored),
          'rows:public.a_table_that_is_gone',
        ).actual,
      ).toBe('missing');
    });
  });

  it('fails when the dump came from a database at a different migration', async () => {
    await withRollback(async (db) => {
      const manifest = await manifestOf(db, 'ssbazar-20260821T183000Z.dump');

      const failures = failedAssertions(
        await assertRestoredDatabase(db, {
          ...manifest,
          migrations: [...manifest.migrations, '099_from_another_database.sql'],
        }),
      );

      expect(failures.map((failure) => failure.name)).toEqual(['migrations']);
    });
  });

  it('checks every sequence is at or past the highest id its column holds', async () => {
    await withRollback(async (db) => {
      await seedSyntheticStock(db, 'T-BACKUP-5', await databaseNow(db));

      // The sequence wound back below its data is a table this test creates,
      // never a real one.
      //
      // `setval` is not transactional. A ROLLBACK does not undo it, so an
      // earlier version of this test that wound back `stock_ledger_id_seq`
      // left the developer's database issuing ids that already existed - and
      // took the stock ledger rebuild test down with it, on the next run, for a
      // reason that had nothing to do with stock. The table and its sequence
      // are created inside this transaction, so the rollback removes both and
      // there is nothing left to wind back.
      await db.query(`CREATE TABLE sequence_probe (id BIGSERIAL PRIMARY KEY, note TEXT NOT NULL)`);
      await db.query(
        `INSERT INTO sequence_probe (note) SELECT 'row ' || g FROM generate_series(1, 3) g`,
      );

      const manifest = await manifestOf(db, 'ssbazar-20260821T183000Z.dump');
      const assertions = await assertRestoredDatabase(db, manifest);

      expect(failedAssertions(assertions)).toEqual([]);
      expect(assertionNamed(assertions, 'sequence:public.stock_ledger_id_seq').ok).toBe(true);
      expect(assertionNamed(assertions, 'sequence:public.sequence_probe_id_seq').ok).toBe(true);

      // A restored database whose sequence sits below max(id) issues ids that
      // already exist. Wound back deliberately to prove the check would say so.
      await db.query(`SELECT setval('sequence_probe_id_seq', 1, false)`);

      const rewound = await assertRestoredDatabase(db, manifest);
      const failures = failedAssertions(rewound);

      expect(failures.map((failure) => failure.name)).toEqual([
        'sequence:public.sequence_probe_id_seq',
      ]);
      expect(assertionNamed(rewound, 'sequence:public.sequence_probe_id_seq').actual).toBe(
        'unused',
      );
    });
  });
});
