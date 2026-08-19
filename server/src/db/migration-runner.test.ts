import { describe, expect, it } from 'vitest';

import { checksum, collectMigrationFiles } from './migration-plan.js';
import {
  MIGRATION_LOCK_KEY,
  type MigrationSource,
  type Queryable,
  runMigrations,
  runsOutsideTransaction,
} from './migration-runner.js';

/**
 * A Postgres stand-in that records every statement, so the apply loop can be
 * checked without a live server.
 */
class FakeDb implements Queryable {
  readonly statements: string[] = [];
  readonly inserts: unknown[][] = [];
  private readonly appliedRows: readonly Record<string, unknown>[];
  private readonly failOn: string | undefined;

  constructor(appliedRows: readonly Record<string, unknown>[] = [], failOn?: string) {
    this.appliedRows = appliedRows;
    this.failOn = failOn;
  }

  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
    this.statements.push(sql);

    if (this.failOn !== undefined && sql.includes(this.failOn)) {
      return Promise.reject(new Error(`syntax error near "${this.failOn}"`));
    }
    if (sql.startsWith('SELECT version')) {
      return Promise.resolve({ rows: [...this.appliedRows] });
    }
    if (sql.startsWith('INSERT INTO schema_migrations') && params !== undefined) {
      this.inserts.push(params);
    }
    return Promise.resolve({ rows: [] });
  }

  /** Statements with SQL bodies collapsed, for readable assertions. */
  get trace(): string[] {
    return this.statements.map((sql) => sql.split('\n', 1)[0]?.trim() ?? '');
  }
}

function sourceOf(filename: string, sql: string): MigrationSource {
  const [file] = collectMigrationFiles([filename]);
  if (file === undefined) throw new Error(`bad test fixture: ${filename}`);
  return { file, sql, checksum: checksum(sql) };
}

const foundation = sourceOf('001_foundation.sql', 'CREATE TABLE stores();');
const catalog = sourceOf('002_catalog.sql', 'CREATE TABLE products();');

describe('runsOutsideTransaction', () => {
  it('recognises the opt-out directive', () => {
    expect(runsOutsideTransaction('-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY x;')).toBe(
      true,
    );
  });

  it('is false for ordinary migrations', () => {
    expect(runsOutsideTransaction('CREATE TABLE stores();')).toBe(false);
  });

  it('ignores the directive further down the file', () => {
    const sql = `${'-- filler\n'.repeat(25)}-- migrate:no-transaction\n`;

    expect(runsOutsideTransaction(sql)).toBe(false);
  });
});

describe('runMigrations', () => {
  it('creates schema_migrations on an empty database', async () => {
    const db = new FakeDb();

    await runMigrations(db, [foundation]);

    expect(db.trace[0]).toBe('CREATE TABLE IF NOT EXISTS schema_migrations (');
  });

  it('takes and releases the advisory lock', async () => {
    const db = new FakeDb();

    await runMigrations(db, [foundation]);

    expect(db.trace).toContain('SELECT pg_advisory_lock($1)');
    expect(db.trace.at(-1)).toBe('SELECT pg_advisory_unlock($1)');
    expect(MIGRATION_LOCK_KEY).toBeTypeOf('number');
  });

  it('applies each migration in its own transaction, with its bookkeeping row', async () => {
    const db = new FakeDb();

    const result = await runMigrations(db, [foundation, catalog]);

    expect(result.applied.map((file) => file.filename)).toEqual([
      '001_foundation.sql',
      '002_catalog.sql',
    ]);
    expect(db.trace).toEqual([
      'CREATE TABLE IF NOT EXISTS schema_migrations (',
      'SELECT pg_advisory_lock($1)',
      'SELECT version, filename, checksum FROM schema_migrations ORDER BY version',
      'BEGIN',
      'CREATE TABLE stores();',
      'INSERT INTO schema_migrations (version, filename, checksum, execution_ms) VALUES ($1, $2, $3, $4)',
      'COMMIT',
      'BEGIN',
      'CREATE TABLE products();',
      'INSERT INTO schema_migrations (version, filename, checksum, execution_ms) VALUES ($1, $2, $3, $4)',
      'COMMIT',
      'SELECT pg_advisory_unlock($1)',
    ]);
  });

  it('records version, filename and checksum', async () => {
    const db = new FakeDb();

    await runMigrations(db, [foundation]);

    const [insert] = db.inserts;
    expect(insert?.slice(0, 3)).toEqual([1, '001_foundation.sql', foundation.checksum]);
    expect(insert?.[3]).toBeTypeOf('number');
  });

  it('skips migrations already recorded', async () => {
    const db = new FakeDb([
      { version: 1, filename: '001_foundation.sql', checksum: foundation.checksum },
    ]);

    const result = await runMigrations(db, [foundation, catalog]);

    expect(result.alreadyApplied).toBe(1);
    expect(result.applied.map((file) => file.filename)).toEqual(['002_catalog.sql']);
    expect(db.trace).not.toContain('CREATE TABLE stores();');
  });

  it('accepts a version returned as a string, as pg does for bigint columns', async () => {
    const db = new FakeDb([
      { version: '1', filename: '001_foundation.sql', checksum: foundation.checksum },
    ]);

    const result = await runMigrations(db, [foundation]);

    expect(result.applied).toEqual([]);
    expect(result.alreadyApplied).toBe(1);
  });

  it('rolls back the failing migration, stops, and still releases the lock', async () => {
    const db = new FakeDb([], 'CREATE TABLE products();');

    await expect(runMigrations(db, [foundation, catalog])).rejects.toThrow(/syntax error/u);

    expect(db.trace).toContain('ROLLBACK');
    expect(db.trace.at(-1)).toBe('SELECT pg_advisory_unlock($1)');
    // The first migration committed before the second failed.
    expect(db.inserts).toHaveLength(1);
  });

  it('runs a no-transaction migration without BEGIN or COMMIT', async () => {
    const concurrent = sourceOf(
      '003_index.sql',
      '-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY idx ON products (id);',
    );
    const db = new FakeDb();

    await runMigrations(db, [concurrent]);

    expect(db.trace).not.toContain('BEGIN');
    expect(db.inserts).toHaveLength(1);
  });

  it('changes nothing on a dry run', async () => {
    const db = new FakeDb();

    const result = await runMigrations(db, [foundation, catalog], { dryRun: true });

    expect(result.pending.map((file) => file.filename)).toEqual([
      '001_foundation.sql',
      '002_catalog.sql',
    ]);
    expect(result.applied).toEqual([]);
    expect(db.trace).not.toContain('BEGIN');
    expect(db.inserts).toEqual([]);
  });

  it('refuses to run when an applied migration was edited', async () => {
    const db = new FakeDb([
      { version: 1, filename: '001_foundation.sql', checksum: 'a-checksum-from-before' },
    ]);

    await expect(runMigrations(db, [foundation])).rejects.toThrow(/append-only/u);
    expect(db.trace.at(-1)).toBe('SELECT pg_advisory_unlock($1)');
  });
});
