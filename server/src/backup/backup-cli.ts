import pg from 'pg';

import { createCliOutput, printUsage, type Usage } from '../cli/output.js';
import { databaseNow } from '../db/clock.js';
import { describeError } from '../describe-error.js';
import { resolveLanguageFor, resolveLanguageOffline } from '../i18n/language.js';
import { printOutcomes, warnUnattended } from '../reconciliation/report.js';
import { runNightlyBackup } from './checks.js';
import { readBackupConfig } from './config.js';

/**
 * `npm run backup:run` - the nightly job.
 *
 * Takes the compressed dump, prunes past the retention window, maintains the
 * WAL archive, and records both on the reconciliation health panel. It is the
 * command a scheduled task runs at `app_settings.backup_time` (23:30, after
 * close); see `docs/backup.md` for the Task Scheduler and cron entries.
 *
 * Exit code is 1 when either job reports a problem or fails, so a scheduler
 * watching only exit codes still notices - but the exit code is the weaker of
 * the two signals and is not the one to rely on. A scheduled task that stops
 * being run at all has no exit code to report, and that is the failure this
 * system is most likely to have: the panel's `last_run_at` is what catches it
 * (docs/DECISIONS.md D30).
 *
 * `now` comes from the database, not from `new Date()`. The dump's filename is
 * what retention reads to decide what has expired (CLAUDE.md, Working
 * practices), and a store server whose clock has drifted an hour would
 * otherwise name a backup into the future and age it out early.
 */

const TAG = 'backup';

const USAGE: Usage = {
  synopsis: 'cli.backup.usage',
  options: [
    { flag: '--lang=hi', description: 'cli.backup.option_lang' },
    { flag: '--help', description: 'cli.common.option_help' },
  ],
  notes: [
    { messageKey: 'cli.backup.description', params: {} },
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

  const config = readBackupConfig();
  const client = new pg.Client();
  await client.connect();
  const output = createCliOutput(TAG, await resolveLanguageFor(client, { explicit }));

  try {
    output.say('cli.backup.directory', { directory: config.root });
    output.say('cli.backup.retention', {
      days: config.retentionDays,
      baseDays: config.baseBackupEveryDays,
    });

    const outcomes = await runNightlyBackup(client, config, await databaseNow(client));

    printOutcomes(output, outcomes, 'cli.backup.timing');
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
