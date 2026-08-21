import type { Queryable } from '../db/queryable.js';
import { asRow, firstRow, readId, readText } from '../db/rows.js';
import {
  readMigrationFilenames,
  readStockFacts,
  readTableCounts,
  type BackupManifest,
} from './manifest.js';

/**
 * What a restored dump has to prove before anybody calls it a backup.
 *
 * Each assertion is a named comparison with an expected and an actual, and the
 * name is an identifier rather than a sentence - `rows:public.stock_ledger`,
 * `stock:drift`. A failure is read in a support session next to a stack trace
 * and a filename, which is the side of docs/DECISIONS.md D39's line where
 * things are named rather than translated.
 *
 * Four groups, and only the first two are what the plan asked for. The other
 * two are here because building this found ways a restore can come back wrong
 * while every row count matches:
 *
 *   **The migration set.** Cheap, and it catches a dump taken from the wrong
 *   database or at the wrong schema version - a mistake that otherwise
 *   surfaces as a restore that works and a system that does not.
 *
 *   **A row count per table**, against the manifest.
 *
 *   **`stock_on_hand` against `stock_ledger`**, through `stock_on_hand_drift` -
 *   the view the rebuild test proved (CLAUDE.md invariant 22). Asserted inside
 *   the restored database, so what is checked is the restore's own consistency
 *   rather than the live database's.
 *
 *   **That the restore did not run the triggers.** This is the subtle one.
 *   `stamp_recorded_at` overwrites `recorded_at` with `now()` on every INSERT
 *   into `stock_ledger`, and `apply_stock_ledger_to_on_hand` writes
 *   `stock_on_hand` from it. A data-only restore fires both: every restored
 *   movement gets today's `recorded_at`, the offline-versus-synced gap
 *   invariant 11 exists to preserve is erased across the whole history, and the
 *   cache is rebuilt from rows it should merely have received. Row counts still
 *   match. Nothing errors.
 *
 *   A full `pg_restore` does not do that - triggers live in the post-data
 *   section and are created after the data lands - but "does not, in this
 *   version, with these flags" is not a thing to leave unchecked in the one
 *   procedure that runs when everything else has already failed. Comparing the
 *   newest `recorded_at` against the manifest costs one query and turns a
 *   silent corruption into a named failure.
 *
 *   **That sequences came back ahead of the data.** A restored database whose
 *   `stock_ledger_id_seq` sits below `max(id)` issues ids that already exist.
 *   Checked inside the restore against its own rows rather than against the
 *   manifest, because sequences are non-transactional and a manifest figure
 *   would be a snapshot of something that was never in one.
 */

export interface Assertion {
  readonly name: string;
  readonly ok: boolean;
  readonly expected: string;
  readonly actual: string;
}

const SEQUENCES_SQL = `
  SELECT s.schemaname   AS sequence_schema,
         s.sequencename AS sequence_name,
         s.last_value   AS last_value,
         tn.nspname     AS table_schema,
         t.relname      AS table_name,
         a.attname      AS column_name
    FROM pg_sequences s
    JOIN pg_namespace n  ON n.nspname = s.schemaname
    JOIN pg_class c      ON c.relname = s.sequencename AND c.relnamespace = n.oid
    JOIN pg_depend d     ON d.objid = c.oid
                        AND d.classid = 'pg_class'::regclass
                        AND d.deptype IN ('a', 'i')
    JOIN pg_class t      ON t.oid = d.refobjid AND t.relkind IN ('r', 'p')
    JOIN pg_namespace tn ON tn.oid = t.relnamespace
    JOIN pg_attribute a  ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
   WHERE c.relkind = 'S'
   ORDER BY s.schemaname, s.sequencename`;

function compare(name: string, expected: string, actual: string): Assertion {
  return { name, expected, actual, ok: expected === actual };
}

function qualify(schema: string, name: string): string {
  return `${schema}.${name}`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** Sequences must be at or past the highest id their own column holds. */
async function assertSequences(db: Queryable): Promise<Assertion[]> {
  const { rows } = await db.query(SEQUENCES_SQL);
  const assertions: Assertion[] = [];

  for (const value of rows) {
    const row = asRow(value);
    const sequence = qualify(readText(row, 'sequence_schema'), readText(row, 'sequence_name'));
    const table =
      quoteIdentifier(readText(row, 'table_schema')) +
      '.' +
      quoteIdentifier(readText(row, 'table_name'));
    const column = quoteIdentifier(readText(row, 'column_name'));

    const maxResult = await db.query(`SELECT max(${column}) AS n FROM ${table}`);
    const maxRow = firstRow(maxResult.rows);
    const highest = maxRow.n === null ? null : readId(maxRow, 'n');

    // No rows, so nothing can collide however the sequence stands.
    if (highest === null) continue;

    const lastValue = row.last_value === null ? null : readId(row, 'last_value');

    assertions.push({
      name: `sequence:${sequence}`,
      ok: lastValue !== null && lastValue >= highest,
      expected: `>= ${String(highest)}`,
      actual: lastValue === null ? 'unused' : String(lastValue),
    });
  }

  return assertions;
}

/**
 * Runs every assertion against `db`, which must be the restored scratch
 * database. Returns them all rather than stopping at the first failure - one
 * table short and one sequence behind are different faults, and reporting only
 * the alphabetically first would hide the other until the next weekly run.
 */
export async function assertRestoredDatabase(
  db: Queryable,
  manifest: BackupManifest,
): Promise<Assertion[]> {
  const assertions: Assertion[] = [];

  const migrations = await readMigrationFilenames(db);
  assertions.push(compare('migrations', manifest.migrations.join(','), migrations.join(',')));

  const restoredTables = await readTableCounts(db);
  const restoredByName = new Map(
    restoredTables.map((table) => [qualify(table.schema, table.name), table.rows]),
  );

  assertions.push(
    compare(
      'tables',
      manifest.tables.map((table) => qualify(table.schema, table.name)).join(','),
      [...restoredByName.keys()].join(','),
    ),
  );

  for (const table of manifest.tables) {
    const name = qualify(table.schema, table.name);
    const actual = restoredByName.get(name);
    assertions.push(
      compare(
        `rows:${name}`,
        String(table.rows),
        actual === undefined ? 'missing' : String(actual),
      ),
    );
  }

  const stock = await readStockFacts(db);

  // The step-4 check, run inside the restore: stock_on_hand against the sum of
  // stock_ledger. Zero is the only acceptable answer, here as in the live
  // database.
  assertions.push(compare('stock:drift', '0', String(stock.driftRows)));
  assertions.push(
    compare('stock:ledger_rows', String(manifest.stock.ledgerRows), String(stock.ledgerRows)),
  );
  assertions.push(
    compare('stock:on_hand_rows', String(manifest.stock.onHandRows), String(stock.onHandRows)),
  );
  assertions.push(
    compare('stock:total_qty', manifest.stock.totalQty ?? 'none', stock.totalQty ?? 'none'),
  );
  assertions.push(
    compare(
      'stock:max_ledger_id',
      manifest.stock.maxLedgerId === null ? 'none' : String(manifest.stock.maxLedgerId),
      stock.maxLedgerId === null ? 'none' : String(stock.maxLedgerId),
    ),
  );
  assertions.push(
    compare(
      'stock:max_recorded_at',
      manifest.stock.maxRecordedAt ?? 'none',
      stock.maxRecordedAt ?? 'none',
    ),
  );

  assertions.push(...(await assertSequences(db)));

  return assertions;
}

export function failedAssertions(assertions: readonly Assertion[]): Assertion[] {
  return assertions.filter((assertion) => !assertion.ok);
}

/** One line per failure, short enough for the panel's `detail` column. */
export function describeFailures(assertions: readonly Assertion[], limit = 3): string {
  const failures = failedAssertions(assertions);
  const shown = failures
    .slice(0, limit)
    .map(
      (assertion) => `${assertion.name}: expected ${assertion.expected}, got ${assertion.actual}`,
    );

  if (failures.length > limit) shown.push(`and ${String(failures.length - limit)} more`);
  return shown.join('; ');
}
