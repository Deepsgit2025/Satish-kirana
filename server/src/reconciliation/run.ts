import pg from 'pg';

import { createCliOutput, printUsage, type Usage } from '../cli/output.js';
import { describeError } from '../describe-error.js';
import { resolveLanguageFor, resolveLanguageOffline } from '../i18n/language.js';
import { runAllReconciliationChecks } from './checks.js';
import { printOutcomes, warnUnattended } from './report.js';

/**
 * `npm run db:reconcile` - runs every read-only reconciliation check once and
 * prints the health panel as it now stands.
 *
 * Three checks run from here: the two cache comparisons and the stock drift
 * check. The backup jobs report to the same panel but are not run from this
 * command - taking a dump is not a read-only comparison, and a nightly job that
 * shells out to `pg_dump` would change what typing this means. They have their
 * own commands, `backup:run` and `backup:verify`, and their own scheduled
 * times.
 *
 * What this command does do for them is name them when they go quiet:
 * `warnUnattended` reads the whole view, so a backup that has not run in a
 * fortnight is reported here even though nothing here runs it. That is the
 * point of one surface (docs/DECISIONS.md D30) - whichever command an operator
 * happens to type, they find out what has stopped.
 *
 * Exit code is 1 when any check reports drift or fails, so a scheduler that
 * only watches exit codes still notices.
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

async function main(argv: readonly string[]): Promise<number> {
  const explicit = explicitLanguage(argv);

  if (argv.includes('--help') || argv.includes('-h')) {
    printUsage(createCliOutput(TAG, resolveLanguageOffline({ explicit })), USAGE);
    return 0;
  }

  const client = new pg.Client();
  await client.connect();
  const output = createCliOutput(TAG, await resolveLanguageFor(client, { explicit }));

  try {
    const outcomes = await runAllReconciliationChecks(client);

    printOutcomes(output, outcomes, 'cli.reconcile.timing');
    await warnUnattended(output, client);

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
