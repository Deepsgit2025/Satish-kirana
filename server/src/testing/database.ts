import { fileURLToPath } from 'node:url';

import pg from 'pg';

import type { Queryable } from '../db/queryable.js';
import { describeError } from '../describe-error.js';

/**
 * Support for tests that need a real Postgres.
 *
 * Most of this workspace is tested against fakes, and should be. Effective
 * dating is not: the whole question is which row Postgres returns for a given
 * instant, and a fake that answers it is a fake that has reimplemented the
 * thing under test. So these tests run against the database in `.env` - the
 * developer's own - and every one of them runs inside a transaction that is
 * rolled back, so nothing survives the run.
 *
 * They need the schema migrated. When Postgres is unreachable or a migration is
 * missing the failure says which, and what to run; the tests are never skipped
 * quietly. A skipped test is a green build with no coverage behind it, and a
 * tax resolution nobody checked surfaces as a wrong rate on a customer's bill
 * months later.
 *
 * The stock ledger rebuild test (build-order step 4, CLAUDE.md invariant 22)
 * runs on this same harness, and has the strongest claim to it: what it checks
 * is a trigger, so a fake that answers the question has reimplemented the
 * trigger and then proved the reimplementation right.
 */

const ENV_FILE = fileURLToPath(new URL('../../../.env', import.meta.url));

/** Present once every migration through `004_product_tax_cache.sql` has been applied. */
const REQUIRED_RELATION = 'public.product_tax_cache_drift';

let envLoaded = false;

function loadEnvOnce(): void {
  if (envLoaded) return;
  envLoaded = true;
  try {
    process.loadEnvFile(ENV_FILE);
  } catch {
    // No .env file. PG* may be set in the environment instead; if they are not,
    // connecting fails next with a message that says as much.
  }
}

function describeTarget(): string {
  const database = process.env.PGDATABASE ?? '(default database)';
  const host = process.env.PGHOST ?? 'localhost';
  const port = process.env.PGPORT ?? '5432';
  return `${database} at ${host}:${port}`;
}

function readPresence(rows: readonly unknown[]): boolean {
  const [row] = rows;
  if (typeof row !== 'object' || row === null) return false;
  return (row as { present?: unknown }).present === true;
}

async function assertSchemaPresent(db: Queryable): Promise<void> {
  const result = await db.query('SELECT to_regclass($1) IS NOT NULL AS present', [
    REQUIRED_RELATION,
  ]);
  if (readPresence(result.rows)) return;

  throw new Error(
    `${describeTarget()} has no ${REQUIRED_RELATION}, so it is behind on migrations. ` +
      'Run: npm run db:migrate',
  );
}

async function connect(): Promise<pg.Client> {
  loadEnvOnce();
  const client = new pg.Client();

  try {
    await client.connect();
  } catch (error) {
    throw new Error(
      `Postgres is not reachable at ${describeTarget()} (${describeError(error)}). ` +
        'These tests run against a real database: start Postgres, check the PG* settings in ' +
        '.env, then run npm run db:migrate.',
      { cause: error },
    );
  }

  return client;
}

/**
 * Runs `work` against a live session inside a transaction, and rolls it back
 * however `work` ends. Fixtures, sequence values and any slab a test invents
 * leave nothing behind, so the same test can run twice in a row against a
 * developer database that has real data in it.
 */
export async function withRollback<T>(work: (db: Queryable) => Promise<T>): Promise<T> {
  const client = await connect();
  const db: Queryable = client;

  try {
    await assertSchemaPresent(db);
    await db.query('BEGIN');
    try {
      return await work(db);
    } finally {
      await db.query('ROLLBACK');
    }
  } finally {
    await client.end();
  }
}
