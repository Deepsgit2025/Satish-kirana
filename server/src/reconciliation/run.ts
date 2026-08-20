import pg from 'pg';

import { createCliOutput, pad, printUsage, type CliOutput, type Usage } from '../cli/output.js';
import { describeError } from '../describe-error.js';
import { resolveLanguageFor, resolveLanguageOffline } from '../i18n/language.js';
import { runAllReconciliationChecks, type ReconciliationOutcome } from './checks.js';
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
 *
 * The owner is a reader of this, not just a scheduler: D30 puts the same
 * statuses on the dashboard, so `ok` / `drift` / `overdue` are translated words
 * here rather than raw column values. The check keys are not - `stock_on_hand`
 * is the name of a thing in the database, and a support call goes better when
 * both ends are saying the same string.
 */

const TAG = 'reconcile';

const USAGE: Usage = {
  synopsis: 'cli.reconcile.usage',
  options: [
    { flag: '--lang=hi', description: 'cli.reconcile.option_lang' },
    { flag: '--help', description: 'cli.common.option_help' },
  ],
  notes: [
    { messageKey: 'cli.reconcile.description', params: {} },
    { messageKey: 'cli.common.connection', params: {} },
  ],
};

function explicitLanguage(argv: readonly string[]): string | undefined {
  const flag = argv.find((argument) => argument.startsWith('--lang='));
  return flag?.slice('--lang='.length);
}

/** "clean", or the outstanding count and as much of the reason as there is. */
function summarise(output: CliOutput, outcome: ReconciliationOutcome): string {
  const { t } = output;
  if (outcome.status === 'ok') return t('cli.reconcile.clean');

  const outstanding = t('cli.reconcile.outstanding', { count: outcome.outstanding });
  if (outcome.detail === null) return outstanding;

  // The detail names product ids and quantities, assembled by the check itself.
  // It stays as it came: translating "product 412 at location 3" would mean the
  // checks reporting keys, and what they actually report is a row of numbers.
  return t('cli.reconcile.outstanding_detail', { summary: outstanding, detail: outcome.detail });
}

async function main(argv: readonly string[]): Promise<number> {
  const explicit = explicitLanguage(argv);

  if (argv.includes('--help') || argv.includes('-h')) {
    printUsage(createCliOutput(TAG, resolveLanguageOffline({ explicit })), USAGE);
    return 0;
  }

  const client = new pg.Client();
  await client.connect();
  const output = createCliOutput(TAG, await resolveLanguageFor(client, { explicit }));
  const { t } = output;

  try {
    const outcomes = await runAllReconciliationChecks(client);

    for (const outcome of outcomes) {
      output.line(
        `${pad(outcome.checkKey, 20)} ${pad(t(`cli.reconcile.status.${outcome.status}`), 8)} ` +
          `${summarise(output, outcome)} ` +
          t('cli.reconcile.timing', {
            durationMs: outcome.durationMs,
            corrected: outcome.corrected,
          }),
      );
    }

    for (const row of await readReconciliationHealth(client)) {
      if (row.health === 'overdue' || row.health === 'never_run') {
        output.say('cli.reconcile.unattended', {
          check: row.key,
          health: t(`cli.reconcile.health.${row.health}`),
        });
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
  const output = createCliOutput(TAG, resolveLanguageOffline());
  output.warn('cli.common.failed', { detail: describeError(error) });
  process.exitCode = 1;
}
