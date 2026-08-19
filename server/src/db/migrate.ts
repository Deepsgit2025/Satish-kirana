import { readdir, readFile } from 'node:fs/promises';

import pg from 'pg';

import { describeError } from '../describe-error.js';
import { checksum, collectMigrationFiles, MigrationPlanError } from './migration-plan.js';
import { type MigrationSource, runMigrations } from './migration-runner.js';

/**
 * `npm run db:migrate` - applies every migration in server/migrations that this
 * database has not seen yet, in numeric order, and records it in
 * `schema_migrations`.
 *
 * Connection settings come from the PG* environment variables (see .env.example).
 * Pass --dry-run to list what would be applied without changing anything.
 */

const MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url);

const USAGE = `Usage: npm run db:migrate [-- --dry-run]

  --dry-run   List pending migrations without applying them.
  --help      Show this message.

Connection settings are read from PGHOST, PGPORT, PGDATABASE, PGUSER and
PGPASSWORD - see .env.example.`;

function log(message: string): void {
  console.log(`[migrate] ${message}`);
}

/** Loads every migration file with its contents and checksum, in version order. */
async function loadMigrationSources(directory: URL): Promise<MigrationSource[]> {
  const entries = await readdir(directory);
  const files = collectMigrationFiles(entries);

  return Promise.all(
    files.map(async (file) => {
      const sql = await readFile(new URL(file.filename, directory), 'utf8');
      return { file, sql, checksum: checksum(sql) };
    }),
  );
}

function describeTarget(): string {
  const database = process.env.PGDATABASE ?? '(default database)';
  const host = process.env.PGHOST ?? 'localhost';
  const port = process.env.PGPORT ?? '5432';
  return `${database} at ${host}:${port}`;
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }

  const dryRun = argv.includes('--dry-run');
  const sources = await loadMigrationSources(MIGRATIONS_DIR);

  log(describeTarget());
  if (sources.length === 0) {
    log('no migrations in server/migrations yet');
    return 0;
  }

  const client = new pg.Client();
  await client.connect();

  try {
    const result = await runMigrations(client, sources, { dryRun, log });

    if (dryRun) {
      log(`dry run: ${String(result.pending.length)} migration(s) would be applied`);
    } else {
      log(`done: ${String(result.applied.length)} migration(s) applied`);
    }
    return 0;
  } finally {
    await client.end();
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const message = describeError(error);

  if (error instanceof MigrationPlanError) {
    console.error(`[migrate] ${message}`);
  } else {
    console.error(`[migrate] failed: ${message}`);
    if (message.includes('ECONNREFUSED') || message.includes('ETIMEDOUT')) {
      console.error(`[migrate] could not reach ${describeTarget()} - is Postgres running?`);
    }
  }
  process.exitCode = 1;
}
