import { readdir, readFile } from 'node:fs/promises';

import pg from 'pg';

import { createCliOutput, printUsage, type CliOutput, type Usage } from '../cli/output.js';
import { describeError } from '../describe-error.js';
import { resolveLanguageFor, resolveLanguageOffline } from '../i18n/language.js';
import { checksum, collectMigrationFiles, MigrationPlanError } from './migration-plan.js';
import { type MigrationSource, runMigrations } from './migration-runner.js';

/**
 * `npm run db:migrate` - applies every migration in server/migrations that this
 * database has not seen yet, in numeric order, and records it in
 * `schema_migrations`.
 *
 * Connection settings come from the PG* environment variables (see .env.example).
 * Pass --dry-run to list what would be applied without changing anything.
 *
 * The command's own output is translated, like every other command's. What is
 * *not* translated is the text inside a `MigrationPlanError` - "this file has
 * changed since it was applied", "renumber it above the latest applied
 * migration". Those are read by whoever is installing or upgrading the system,
 * in the same session as a stack trace, and they name filenames and version
 * numbers rather than anything a shopkeeper acts on. They arrive here as
 * detail and are passed through as detail. `server/src/i18n/language.ts`
 * records where that line sits.
 */

const TAG = 'migrate';
const MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url);

const USAGE: Usage = {
  synopsis: 'cli.migrate.usage',
  options: [
    { flag: '--dry-run', description: 'cli.migrate.option_dry_run' },
    { flag: '--lang=hi', description: 'cli.migrate.option_lang' },
    { flag: '--help', description: 'cli.common.option_help' },
  ],
  notes: [{ messageKey: 'cli.common.connection', params: {} }],
};

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

function describeTarget(output: CliOutput): string {
  return output.t('cli.migrate.target', {
    database: process.env.PGDATABASE ?? output.t('cli.migrate.default_database'),
    host: process.env.PGHOST ?? 'localhost',
    port: process.env.PGPORT ?? '5432',
  });
}

function explicitLanguage(argv: readonly string[]): string | undefined {
  const flag = argv.find((argument) => argument.startsWith('--lang='));
  return flag?.slice('--lang='.length);
}

async function main(argv: readonly string[], output: CliOutput): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    printUsage(output, USAGE);
    return 0;
  }

  const dryRun = argv.includes('--dry-run');
  const sources = await loadMigrationSources(MIGRATIONS_DIR);

  output.line(describeTarget(output));
  if (sources.length === 0) {
    output.say('cli.migrate.none_present');
    return 0;
  }

  const client = new pg.Client();
  await client.connect();

  try {
    // The connection exists now, so the store's own setting can be honoured for
    // the rest of the run. Anything printed above this point - and anything
    // printed if the connect above throws - stays in the offline language.
    const connected = createCliOutput(
      TAG,
      await resolveLanguageFor(client, { explicit: explicitLanguage(argv) }),
    );

    const result = await runMigrations(client, sources, {
      dryRun,
      report: (message) => {
        connected.report(message);
      },
    });

    if (dryRun) {
      connected.say('cli.migrate.dry_run_summary', { count: result.pending.length });
    } else {
      connected.say('cli.migrate.done', { count: result.applied.length });
    }
    return 0;
  } finally {
    await client.end();
  }
}

const output = createCliOutput(
  TAG,
  resolveLanguageOffline({ explicit: explicitLanguage(process.argv.slice(2)) }),
);

try {
  process.exitCode = await main(process.argv.slice(2), output);
} catch (error) {
  const message = describeError(error);

  if (error instanceof MigrationPlanError) {
    output.line(message);
  } else {
    output.warn('cli.common.failed', { detail: message });
    if (message.includes('ECONNREFUSED') || message.includes('ETIMEDOUT')) {
      output.warn('cli.migrate.unreachable', { target: describeTarget(output) });
    }
  }
  process.exitCode = 1;
}
