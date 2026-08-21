import pg from 'pg';

import { createCliOutput, printUsage, type Usage } from '../cli/output.js';
import { describeError } from '../describe-error.js';
import { resolveLanguageFor, resolveLanguageOffline } from '../i18n/language.js';
import { printOutcomes, warnUnattended } from '../reconciliation/report.js';
import { runRestoreVerifyCheck } from './checks.js';
import { readBackupConfig } from './config.js';

/**
 * `npm run backup:verify` - restores the newest dump and checks what came back.
 *
 * D22 in one line: a backup nobody has restored is not a backup. This is the
 * local half of that, run weekly; the monthly cloud verification is the same
 * idea against a downloaded, decrypted copy and arrives with the cloud vault.
 *
 * The connection this command opens is to the **live** database, and it is used
 * for one thing only: recording the run on the health panel. Everything the
 * verify actually does happens in files and in the scratch database, which is
 * why this is safe to run in the middle of a trading day.
 */

const TAG = 'verify';

const USAGE: Usage = {
  synopsis: 'cli.verify.usage',
  options: [
    { flag: '--lang=hi', description: 'cli.verify.option_lang' },
    { flag: '--help', description: 'cli.common.option_help' },
  ],
  notes: [
    { messageKey: 'cli.verify.description', params: {} },
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
    output.say('cli.verify.scratch', { database: config.verifyDatabase });

    const outcome = await runRestoreVerifyCheck(client, config);

    printOutcomes(output, [outcome], 'cli.backup.timing');
    await warnUnattended(output, client);

    return outcome.status === 'ok' ? 0 : 1;
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
