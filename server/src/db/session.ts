import pg from 'pg';

import type { Queryable } from './queryable.js';

/**
 * Getting a database session, and giving it back.
 *
 * The catalogue core does no transaction handling on purpose - the caller
 * supplies the session, which is what lets the CLI wrap a whole import in one
 * transaction and a test roll everything back. This is the production supplier:
 * a pooled connection, one transaction per unit of work.
 *
 * It lives in `server/` rather than in the app because it is the only thing in
 * the chain that touches `pg`. The office app holds a `SessionRunner` and never
 * learns what is behind it, so no part of an Electron bundle imports a database
 * driver (docs/DECISIONS.md D42, CLAUDE.md invariant 23).
 */

/**
 * How a unit of work gets a database session.
 *
 * The main process supplies `createPooledSessionRunner`. A test supplies
 * `withRollback`, whose signature is already exactly this - which is what lets
 * the whole IPC boundary be tested without an Electron window open.
 */
export type SessionRunner = <T>(work: (db: Queryable) => Promise<T>) => Promise<T>;

/**
 * One transaction per call, on a connection borrowed from `pool` and returned
 * however the call ends.
 *
 * **Committing or rolling back together is the point**, not the pooling. A bulk
 * edit of two hundred products writes four hundred history rows; a failure at
 * row one hundred and ninety must leave none of them, or the catalogue is in a
 * state no report can explain and no operator asked for (CLAUDE.md invariant 8
 * makes the same demand of stock movements).
 *
 * A `ROLLBACK` that itself fails is swallowed deliberately: the original error
 * is what the operator needs to see, the connection is destroyed rather than
 * reused on release, and rethrowing the rollback failure over the top would
 * replace a diagnosable problem with a confusing one.
 */
export function createPooledSessionRunner(pool: pg.Pool): SessionRunner {
  return async <T>(work: (db: Queryable) => Promise<T>): Promise<T> => {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // See above: the original error is the one worth having.
      }
      throw error;
    } finally {
      client.release();
    }
  };
}

/**
 * A pool from the standard `PG*` environment variables, the same ones the CLIs
 * read from `.env`.
 *
 * `max` is deliberately small. The office machine runs one operator; a pool
 * sized for a web server would hold connections the store server could be
 * giving to a counter mid-sale.
 */
export function createPool(max = 4): pg.Pool {
  return new pg.Pool({ max });
}
