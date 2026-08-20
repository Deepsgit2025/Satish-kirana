import { readFile } from 'node:fs/promises';

import { isTranslatableError } from '@ssbazar/shared';
import pg from 'pg';

import { createCliOutput, pad, printUsage, type CliOutput, type Usage } from '../cli/output.js';
import { describeError } from '../describe-error.js';
import { resolveLanguageFor, resolveLanguageOffline } from '../i18n/language.js';
import { importCatalogue, type ImportReport } from './import.js';
import { OPTIONAL_COLUMNS, REQUIRED_COLUMNS } from './import-validation.js';

/**
 * `npm run catalogue:import -- <file> [--dry-run] [--lang=hi]`
 *
 * The client runs the dry form against his own spreadsheet while he is still
 * keying it, which is the whole point of building this before any screen
 * exists: he finds out that 40 rows carry a 4-digit HSN while he still
 * remembers those rows, not six weeks later in bulk.
 *
 * Which makes this the first user-facing text in the system, and it goes
 * through `en.json` / `hi.json` like everything else. Nothing below writes a
 * sentence. The row-level reasons arrive from the validator as keys
 * (`RowIssue.reasonKey`) and are resolved here, once, in the language the
 * store is set to - so the same validator serves this terminal today and the
 * import screen in step 7 without either of them owning the English.
 *
 * A dry run is wrapped in a transaction that is rolled back regardless, so
 * pointing it at the live database is safe even if something downstream one day
 * forgets to honour the flag.
 */

const TAG = 'catalogue';

const USAGE: Usage = {
  synopsis: 'cli.catalogue.usage',
  options: [
    { flag: '--dry-run', description: 'cli.catalogue.option_dry_run' },
    { flag: '--lang=hi', description: 'cli.catalogue.option_lang' },
    { flag: '--help', description: 'cli.common.option_help' },
  ],
  notes: [
    {
      messageKey: 'cli.catalogue.columns',
      params: { columns: [...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS].join(', ') },
    },
    { messageKey: 'cli.catalogue.docs', params: {} },
    { messageKey: 'cli.common.connection', params: {} },
  ],
};

/** One line per rejected value, aligned so a long report stays readable. */
function printIssues(output: CliOutput, report: ImportReport): void {
  if (report.issues.length === 0) return;
  const { t } = output;

  const reasons = report.issues.map((issue) => t(issue.reasonKey, issue.reasonParams));
  const lineWidth = Math.max(
    t('cli.catalogue.heading.line').length,
    ...report.issues.map((issue) => String(issue.line).length),
  );
  const columnWidth = Math.max(
    t('cli.catalogue.heading.column').length,
    ...report.issues.map((issue) => issue.column.length),
  );
  const valueWidth = Math.min(24, Math.max(...report.issues.map((issue) => issue.value.length)));

  output.blank();
  output.say('cli.catalogue.rejected_heading');
  output.line(
    `  ${pad(t('cli.catalogue.heading.line'), lineWidth)}  ` +
      `${pad(t('cli.catalogue.heading.column'), columnWidth)}  ` +
      `${pad(t('cli.catalogue.heading.value'), valueWidth)}  ` +
      t('cli.catalogue.heading.reason'),
  );

  report.issues.forEach((issue, index) => {
    const value =
      issue.value.length > valueWidth ? `${issue.value.slice(0, valueWidth - 1)}…` : issue.value;
    output.line(
      `  ${pad(String(issue.line), lineWidth)}  ${pad(issue.column, columnWidth)}  ` +
        `${pad(value, valueWidth)}  ${reasons[index] ?? ''}`,
    );
  });
}

function printSummary(output: CliOutput, report: ImportReport, path: string): void {
  output.say('cli.catalogue.rows_read', { file: path, count: report.totalRows });

  if (report.dryRun) {
    output.say('cli.catalogue.dry_run_result', {
      importable: report.totalRows - report.rejected,
      rejected: report.rejected,
    });
  } else {
    output.say('cli.catalogue.result', {
      imported: report.imported,
      rejected: report.rejected,
    });
    if (report.categoriesCreated.length > 0) {
      output.say('cli.catalogue.categories_created', {
        names: report.categoriesCreated.join(', '),
      });
    }
    if (report.hsnCodesCreated.length > 0) {
      output.say('cli.catalogue.hsn_codes_created', { codes: report.hsnCodesCreated.join(', ') });
    }
  }

  printIssues(output, report);

  if (report.dryRun) {
    output.blank();
    output.say('cli.catalogue.dry_run_note');
  }
}

/** `--lang=hi`, which outranks both the employee preference and the store default. */
function explicitLanguage(argv: readonly string[]): string | undefined {
  const flag = argv.find((argument) => argument.startsWith('--lang='));
  return flag?.slice('--lang='.length);
}

async function main(argv: readonly string[]): Promise<number> {
  const explicit = explicitLanguage(argv);
  // Before any connection: usage and argument errors have to print without a
  // database, so they take the offline half of the chain.
  const early = createCliOutput(TAG, resolveLanguageOffline({ explicit }));

  if (argv.includes('--help') || argv.includes('-h')) {
    printUsage(early, USAGE);
    return 0;
  }

  const path = argv.find((argument) => !argument.startsWith('--'));

  if (path === undefined) {
    early.warn('cli.catalogue.no_file');
    printUsage(early, USAGE);
    return 1;
  }

  const text = await readFile(path, 'utf8');
  const client = new pg.Client();
  await client.connect();

  // Now that there is a connection, `app_settings.default_language` can answer.
  // There is no signed-in employee at a terminal, so the chain starts one step
  // in - see server/src/i18n/language.ts.
  const output = createCliOutput(TAG, await resolveLanguageFor(client, { explicit }));

  try {
    await client.query('BEGIN');
    const report = await importCatalogue(client, text, { dryRun: argv.includes('--dry-run') });
    // A dry run rolls back whatever it did not do, which costs nothing and
    // means the flag is honoured by the transaction and not only by the code.
    await client.query(argv.includes('--dry-run') ? 'ROLLBACK' : 'COMMIT');

    printSummary(output, report, path);
    return report.rejected > 0 ? 1 : 0;
  } catch (error) {
    await client.query('ROLLBACK');

    if (isTranslatableError(error)) {
      // The file could not be read at all, so there is no row-level report to
      // give - nothing was written. The reason arrives as a key, so it lands in
      // the client's language rather than in the validator's.
      output.warn('cli.catalogue.unreadable', {
        detail: output.t(error.messageKey, error.params),
      });
      return 1;
    }
    throw error;
  } finally {
    await client.end();
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  // Last resort: something that is not ours and has no key - a socket, a
  // permission, a disk. The sentence is translated; the detail is whatever the
  // runtime said, which is not ours to translate.
  const output = createCliOutput(TAG, resolveLanguageOffline());
  output.warn('cli.common.failed', { detail: describeError(error) });
  process.exitCode = 1;
}
