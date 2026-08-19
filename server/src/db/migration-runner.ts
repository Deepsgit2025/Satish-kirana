import {
  type AppliedMigration,
  type MigrationFile,
  MigrationPlanError,
  planMigrations,
} from './migration-plan.js';
import type { Queryable } from './queryable.js';

/**
 * Applies pending migrations against a single Postgres session.
 *
 * The database is reached through the narrow `Queryable` interface rather than a
 * `pg.Client` directly, so the whole apply loop - transaction boundaries,
 * locking, bookkeeping - is testable without a live server.
 */

export type { Queryable };

/** A migration file plus its contents. */
export interface MigrationSource {
  readonly file: MigrationFile;
  readonly sql: string;
  readonly checksum: string;
}

export interface RunOptions {
  /** Report what would be applied without touching the schema. */
  readonly dryRun?: boolean;
  readonly log?: (message: string) => void;
}

export interface RunResult {
  /** Migrations applied by this run (empty on a dry run). */
  readonly applied: readonly MigrationFile[];
  /** Migrations that still need applying (what a dry run reports). */
  readonly pending: readonly MigrationFile[];
  /** Migrations already recorded before this run. */
  readonly alreadyApplied: number;
}

/**
 * Session-level lock key, so two machines running `db:migrate` at once queue up
 * instead of racing. Any constant works as long as it never changes.
 */
export const MIGRATION_LOCK_KEY = 5_570_532_118;

const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version      INTEGER PRIMARY KEY,
  filename     TEXT NOT NULL,
  checksum     TEXT NOT NULL,
  applied_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  execution_ms INTEGER NOT NULL
)`;

const SELECT_APPLIED_SQL =
  'SELECT version, filename, checksum FROM schema_migrations ORDER BY version';

const INSERT_APPLIED_SQL =
  'INSERT INTO schema_migrations (version, filename, checksum, execution_ms) VALUES ($1, $2, $3, $4)';

/**
 * A migration whose first lines carry this directive runs outside a
 * transaction - for statements Postgres refuses to run inside one, such as
 * CREATE INDEX CONCURRENTLY.
 */
const NO_TRANSACTION_DIRECTIVE = '-- migrate:no-transaction';

/** True when the migration opts out of the surrounding transaction. */
export function runsOutsideTransaction(sql: string): boolean {
  return sql.split('\n', 20).some((line) => line.trim().toLowerCase() === NO_TRANSACTION_DIRECTIVE);
}

/** Creates `schema_migrations` if this is a fresh database. */
export async function ensureSchemaMigrationsTable(db: Queryable): Promise<void> {
  await db.query(CREATE_TABLE_SQL);
}

function toAppliedMigration(row: unknown): AppliedMigration {
  if (typeof row !== 'object' || row === null) {
    throw new MigrationPlanError('Unreadable row in schema_migrations.');
  }

  const { version, filename, checksum } = row as Record<string, unknown>;
  const parsedVersion = typeof version === 'string' ? Number.parseInt(version, 10) : version;

  if (typeof parsedVersion !== 'number' || !Number.isFinite(parsedVersion)) {
    throw new MigrationPlanError('schema_migrations row has an unreadable version.');
  }
  if (typeof filename !== 'string' || typeof checksum !== 'string') {
    throw new MigrationPlanError(
      `schema_migrations row for version ${String(parsedVersion)} is incomplete.`,
    );
  }

  return { version: parsedVersion, filename, checksum };
}

/** Reads the applied history, oldest first. */
export async function readAppliedMigrations(db: Queryable): Promise<AppliedMigration[]> {
  const result = await db.query(SELECT_APPLIED_SQL);
  return result.rows.map(toAppliedMigration);
}

async function applyMigration(db: Queryable, source: MigrationSource): Promise<number> {
  const inTransaction = !runsOutsideTransaction(source.sql);
  const startedAt = Date.now();

  if (inTransaction) await db.query('BEGIN');

  try {
    await db.query(source.sql);
    const elapsedMs = Date.now() - startedAt;
    await db.query(INSERT_APPLIED_SQL, [
      source.file.version,
      source.file.filename,
      source.checksum,
      elapsedMs,
    ]);
    if (inTransaction) await db.query('COMMIT');
    return elapsedMs;
  } catch (error) {
    if (inTransaction) {
      try {
        await db.query('ROLLBACK');
      } catch {
        // The original failure is what the operator needs to see.
      }
    }
    throw error;
  }
}

/**
 * Applies every migration not yet recorded, in version order, each in its own
 * transaction together with its `schema_migrations` row. A failure stops the
 * run: earlier migrations stay applied, the failing one is rolled back whole.
 */
export async function runMigrations(
  db: Queryable,
  sources: readonly MigrationSource[],
  options: RunOptions = {},
): Promise<RunResult> {
  const log = options.log ?? ((): void => undefined);
  const dryRun = options.dryRun ?? false;

  await ensureSchemaMigrationsTable(db);
  await db.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

  try {
    const applied = await readAppliedMigrations(db);
    const byFilename = new Map(sources.map((source) => [source.file.filename, source]));
    const checksums = new Map(sources.map((source) => [source.file.filename, source.checksum]));
    const plan = planMigrations(
      sources.map((source) => source.file),
      applied,
      checksums,
    );

    log(`${String(plan.appliedCount)} already applied, ${String(plan.pending.length)} pending`);

    if (dryRun) {
      for (const file of plan.pending) log(`would apply ${file.filename}`);
      return { applied: [], pending: plan.pending, alreadyApplied: plan.appliedCount };
    }

    const appliedNow: MigrationFile[] = [];

    for (const file of plan.pending) {
      const source = byFilename.get(file.filename);
      if (source === undefined) {
        throw new MigrationPlanError(`Contents of "${file.filename}" were not loaded.`);
      }

      const elapsedMs = await applyMigration(db, source);
      appliedNow.push(file);
      log(`applied ${file.filename} (${String(elapsedMs)} ms)`);
    }

    return { applied: appliedNow, pending: [], alreadyApplied: plan.appliedCount };
  } finally {
    await db.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
  }
}
