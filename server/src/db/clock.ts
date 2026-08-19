import type { Queryable } from './queryable.js';
import { firstRow, readTimestamp } from './rows.js';

/**
 * The database's own idea of the current instant.
 *
 * Anything writing an effective-dated row has to date it from here rather than
 * from `new Date()`. Postgres `now()` is the transaction timestamp, fixed at
 * BEGIN, and the triggers that maintain caches compare against it - so a row
 * dated from the client clock lands a few milliseconds in the *future*, no
 * assignment is in force at `now()`, and the reconciliation check reports every
 * row of a fresh import as drift until the clock catches up.
 *
 * See the `now()` note in CLAUDE.md, Working practices.
 */
export async function databaseNow(db: Queryable): Promise<Date> {
  const { rows } = await db.query('SELECT now() AS at');
  return readTimestamp(firstRow(rows), 'at');
}
