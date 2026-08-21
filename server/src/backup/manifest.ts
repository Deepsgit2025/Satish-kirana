import type { Queryable } from '../db/queryable.js';
import { asRow, firstRow, readId, readInt, readText } from '../db/rows.js';

/**
 * What was true of the database at the instant the dump was taken.
 *
 * A manifest is written beside every dump, and restore-verify asserts the
 * restored database against it. That indirection is the whole design, and it
 * is worth being explicit about why the obvious alternative is wrong:
 *
 * **Restore-verify must never compare the restore against the live database.**
 * The dump is from last night; the shop has been trading since. Every row added
 * this morning would read as a discrepancy, the panel would show drift every
 * single day, and within a week nobody would look at it — which is worse than
 * having no check, because a check nobody reads still counts as coverage on a
 * list. Comparing against the manifest asks the only question that has a right
 * answer: **did this file come back as what went into it?**
 *
 * It also means the verify touches nothing but the scratch database, so it can
 * run at any hour, and on a different machine, without a connection to the
 * live one at all.
 *
 * **The manifest is captured in the dump's own snapshot.** `pg_export_snapshot`
 * hands `pg_dump --snapshot` the exact view of the database the counts were
 * taken from, so the two cannot disagree about a bill rung between them. At
 * 23:30 in a closed shop that gap is theoretical — but a verification that is
 * only reliable when nothing is happening reports its first false failure on
 * the night somebody works late, which is the night people learn to ignore it.
 */

export const MANIFEST_VERSION = 1;

export interface ManifestTable {
  readonly schema: string;
  readonly name: string;
  readonly rows: number;
}

export interface ManifestStock {
  readonly ledgerRows: number;
  readonly onHandRows: number;
  /** Zero at capture, or the dump preserves a fault. */
  readonly driftRows: number;
  readonly maxLedgerId: number | null;
  /**
   * Held as the text Postgres produced, never parsed into a number. Quantities
   * are NUMERIC(12,3); a JavaScript float can lose the third decimal and can
   * invent a difference that is not there (CLAUDE.md invariant 22 is the reason
   * the step that proved this compares in SQL).
   */
  readonly totalQty: string | null;
  /**
   * The newest `recorded_at` in `stock_ledger`, as text.
   *
   * This is the assertion that catches a restore having run the triggers.
   * `stamp_recorded_at` overwrites `recorded_at` with `now()` on every INSERT,
   * so if a restore loads data while that trigger exists, every row silently
   * gets today's date and the column invariant 11 depends on is destroyed —
   * quietly, with correct row counts and no error anywhere.
   */
  readonly maxRecordedAt: string | null;
}

export interface BackupManifest {
  readonly version: number;
  readonly database: string;
  readonly takenAt: string;
  readonly serverVersion: string;
  readonly dumpFile: string;
  readonly migrations: readonly string[];
  readonly tables: readonly ManifestTable[];
  readonly stock: ManifestStock;
}

/**
 * Every ordinary table, with its row count. Discovered rather than listed, so a
 * table added by a later migration is covered by this check the day it lands
 * instead of the day somebody remembers to add it here.
 *
 * Partitions are excluded (`relispartition`): their rows are already counted
 * through the parent, and counting both would double every figure.
 */
const TABLES_SQL = `
  SELECT n.nspname AS schema_name, c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r', 'p')
     AND NOT c.relispartition
     AND n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND n.nspname NOT LIKE 'pg_toast%'
   ORDER BY n.nspname, c.relname`;

const STOCK_SQL = `
  SELECT (SELECT count(*)::int FROM stock_ledger)                    AS ledger_rows,
         (SELECT count(*)::int FROM stock_on_hand)                   AS on_hand_rows,
         (SELECT count(*)::int FROM stock_on_hand_drift)             AS drift_rows,
         (SELECT max(id) FROM stock_ledger)                          AS max_ledger_id,
         (SELECT sum(qty_delta)::text FROM stock_ledger)             AS total_qty,
         (SELECT max(recorded_at)::text FROM stock_ledger)           AS max_recorded_at`;

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

async function countRows(db: Queryable, schema: string, table: string): Promise<number> {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)}`,
  );
  return readInt(firstRow(rows), 'n');
}

/** Row counts for every table, in the caller's snapshot. */
export async function readTableCounts(db: Queryable): Promise<ManifestTable[]> {
  const { rows } = await db.query(TABLES_SQL);

  const tables: ManifestTable[] = [];
  for (const value of rows) {
    const row = asRow(value);
    const schema = readText(row, 'schema_name');
    const name = readText(row, 'table_name');
    tables.push({ schema, name, rows: await countRows(db, schema, name) });
  }

  return tables;
}

export async function readStockFacts(db: Queryable): Promise<ManifestStock> {
  const { rows } = await db.query(STOCK_SQL);
  const row = firstRow(rows);

  return {
    ledgerRows: readInt(row, 'ledger_rows'),
    onHandRows: readInt(row, 'on_hand_rows'),
    driftRows: readInt(row, 'drift_rows'),
    maxLedgerId: row.max_ledger_id === null ? null : readId(row, 'max_ledger_id'),
    totalQty: row.total_qty === null ? null : readText(row, 'total_qty'),
    maxRecordedAt: row.max_recorded_at === null ? null : readText(row, 'max_recorded_at'),
  };
}

export async function readMigrationFilenames(db: Queryable): Promise<string[]> {
  const { rows } = await db.query(`SELECT filename FROM schema_migrations ORDER BY filename`);
  return rows.map((value) => readText(asRow(value), 'filename'));
}

async function readServerVersion(db: Queryable): Promise<string> {
  const { rows } = await db.query(`SELECT current_setting('server_version') AS v`);
  return readText(firstRow(rows), 'v');
}

/**
 * Captures everything the verify will assert. `db` must already be inside the
 * REPEATABLE READ transaction whose snapshot `pg_dump` was given, or the
 * manifest describes a different instant from the file it sits beside.
 */
export async function captureManifest(
  db: Queryable,
  options: { readonly database: string; readonly dumpFile: string; readonly takenAt: Date },
): Promise<BackupManifest> {
  return {
    version: MANIFEST_VERSION,
    database: options.database,
    takenAt: options.takenAt.toISOString(),
    serverVersion: await readServerVersion(db),
    dumpFile: options.dumpFile,
    migrations: await readMigrationFilenames(db),
    tables: await readTableCounts(db),
    stock: await readStockFacts(db),
  };
}
