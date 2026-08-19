import pg from 'pg';

import { describeError } from '../describe-error.js';
import { runAllReconciliationChecks } from './checks.js';
import { readReconciliationHealth } from './health.js';

/**
 * `npm run db:reconcile` - runs every reconciliation check once and prints the
 * health panel as it now stands.
 *
 * This is the entry point a scheduler calls. There is no scheduler yet: the
 * nightly job runner arrives with the backup work, and until then this is run by
 * hand or from Task Scheduler. The panel says `never_run` until something calls
 * it, which is the honest state and exactly what docs/DECISIONS.md D30 wants it
 * to say - a check nobody runs must not look like a check that passes.
 *
 * Exit code is 1 when any check reports drift or fails, so a scheduler that
 * only watches exit codes still notices.
 */

const USAGE = `Usage: npm run db:reconcile

Runs every check in reconciliation_checks and records the outcome. Exits 1 if
any check reports drift or fails.

Connection settings are read from PGHOST, PGPORT, PGDATABASE, PGUSER and
PGPASSWORD - see .env.example.`;

function log(message: string): void {
  console.log(`[reconcile] ${message}`);
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }

  const client = new pg.Client();
  await client.connect();

  try {
    const outcomes = await runAllReconciliationChecks(client);

    for (const outcome of outcomes) {
      const summary =
        outcome.status === 'ok'
          ? 'clean'
          : `${String(outcome.outstanding)} outstanding${outcome.detail === null ? '' : ` - ${outcome.detail}`}`;
      log(
        `${pad(outcome.checkKey, 20)} ${pad(outcome.status, 8)} ${summary} ` +
          `(${String(outcome.durationMs)} ms, ${String(outcome.corrected)} corrected)`,
      );
    }

    for (const row of await readReconciliationHealth(client)) {
      if (row.health === 'overdue' || row.health === 'never_run') {
        log(`${row.key} is ${row.health} - nothing is running this check`);
      }
    }

    return outcomes.some((outcome) => outcome.status !== 'ok') ? 1 : 0;
  } finally {
    await client.end();
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(`[reconcile] failed: ${describeError(error)}`);
  process.exitCode = 1;
}
