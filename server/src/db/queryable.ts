/**
 * The slice of `pg.Client` that everything in this workspace talks to.
 *
 * Modules take this rather than a `pg.Client`, so a caller can hand over a
 * client, a pooled connection, or a session already inside a transaction. That
 * is what lets the migration runner be tested without a live server, and what
 * lets a database-backed test roll its whole fixture back afterwards.
 */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}
