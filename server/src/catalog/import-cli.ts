import { readFile } from 'node:fs/promises';

import pg from 'pg';

import { describeError } from '../describe-error.js';
import { CsvError } from './csv.js';
import { importCatalogue, type ImportReport } from './import.js';
import { CatalogueFileError } from './import-validation.js';

/**
 * `npm run catalogue:import -- <file> [--dry-run]`
 *
 * The client runs the dry form against his own spreadsheet while he is still
 * keying it, which is the whole point of building this before any screen
 * exists: he finds out that 40 rows carry a 4-digit HSN while he still
 * remembers those rows, not six weeks later in bulk.
 *
 * A dry run is wrapped in a transaction that is rolled back regardless, so
 * pointing it at the live database is safe even if something downstream one day
 * forgets to honour the flag.
 */

const USAGE = `Usage: npm run catalogue:import -- <file.csv> [--dry-run]

  --dry-run   Validate and report without writing anything.
  --help      Show this message.

Columns: barcode, name, name_hi, short_name, hsn_code, tax_rate, mrp,
sale_price, purchase_price, unit, category, reorder_level.
See docs/catalogue-import.md, and docs/catalogue-template.csv for a starting file.

Connection settings are read from PGHOST, PGPORT, PGDATABASE, PGUSER and
PGPASSWORD - see .env.example.`;

function log(message = ''): void {
  console.log(message.length === 0 ? '' : `[catalogue] ${message}`);
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

/** One line per rejected value, aligned so a long report stays readable. */
function printIssues(report: ImportReport): void {
  if (report.issues.length === 0) return;

  const columnWidth = Math.max(...report.issues.map((issue) => issue.column.length));
  const valueWidth = Math.min(24, Math.max(...report.issues.map((issue) => issue.value.length)));

  log();
  log('rejected rows — line numbers match the spreadsheet:');
  for (const issue of report.issues) {
    const value =
      issue.value.length > valueWidth ? `${issue.value.slice(0, valueWidth - 1)}…` : issue.value;
    log(
      `  line ${pad(String(issue.line), 6)} ${pad(issue.column, columnWidth)}  ` +
        `${pad(value, valueWidth)}  ${issue.reason}`,
    );
  }
}

function printSummary(report: ImportReport, path: string): void {
  log(`${path}: ${String(report.totalRows)} data row(s)`);

  if (report.dryRun) {
    log(
      `${String(report.totalRows - report.rejected)} would import, ${String(report.rejected)} rejected`,
    );
  } else {
    log(`${String(report.imported)} imported, ${String(report.rejected)} rejected`);
    if (report.categoriesCreated.length > 0) {
      log(`categories created: ${report.categoriesCreated.join(', ')}`);
    }
    if (report.hsnCodesCreated.length > 0) {
      log(`HSN codes added: ${report.hsnCodesCreated.join(', ')}`);
    }
  }

  printIssues(report);

  if (report.dryRun) {
    log();
    log('dry run — nothing was written');
  }
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }

  const dryRun = argv.includes('--dry-run');
  const path = argv.find((argument) => !argument.startsWith('--'));

  if (path === undefined) {
    console.error(USAGE);
    return 1;
  }

  const text = await readFile(path, 'utf8');
  const client = new pg.Client();
  await client.connect();

  try {
    await client.query('BEGIN');
    const report = await importCatalogue(client, text, { dryRun });
    // A dry run rolls back whatever it did not do, which costs nothing and
    // means the flag is honoured by the transaction and not only by the code.
    await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');

    printSummary(report, path);
    return report.rejected > 0 ? 1 : 0;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const message = describeError(error);

  if (error instanceof CsvError || error instanceof CatalogueFileError) {
    // The file could not be read at all, so there is no row-level report to
    // give - nothing was written.
    console.error(`[catalogue] the file could not be read: ${message}`);
  } else {
    console.error(`[catalogue] failed: ${message}`);
  }
  process.exitCode = 1;
}
