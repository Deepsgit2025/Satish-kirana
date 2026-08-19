/**
 * Reading values out of a `pg` result.
 *
 * Rows arrive as `unknown` and are picked apart here rather than cast, because
 * two of node-postgres' conventions bite quietly if you assume otherwise: BIGINT
 * comes back as a string, and so does NUMERIC - deliberately, so no precision is
 * lost in transit before the caller decides what to do about it. A cast would
 * hand you a `number` typed value holding `'106.67'`.
 *
 * Every reader names the column it failed on. A shape error here means a query
 * and a table have drifted apart, and the column name is the whole diagnosis.
 */

export class RowShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RowShapeError';
  }
}

export function asRow(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new RowShapeError('Expected a row object.');
  }
  return value as Record<string, unknown>;
}

/** The single row a query was expected to return. */
export function firstRow(rows: readonly unknown[]): Record<string, unknown> {
  if (rows.length !== 1) {
    throw new RowShapeError(`Expected exactly one row, got ${String(rows.length)}.`);
  }
  return asRow(rows[0]);
}

/** BIGINT, which arrives as text. */
export function readId(row: Record<string, unknown>, column: string): number {
  const value = row[column];
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed)) {
    throw new RowShapeError(`Column ${column} is not a usable id.`);
  }
  return parsed;
}

export function readNullableId(row: Record<string, unknown>, column: string): number | null {
  return row[column] === null || row[column] === undefined ? null : readId(row, column);
}

/** INTEGER, which arrives as a number already. */
export function readInt(row: Record<string, unknown>, column: string): number {
  const value = row[column];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new RowShapeError(`Column ${column} is not an integer.`);
  }
  return value;
}

/**
 * NUMERIC, which arrives as text.
 *
 * Fine for a rate, a quantity or a single money figure. Do not sum these in
 * JavaScript and compare the result against Postgres - money arithmetic goes
 * through the one rounding function in `@ssbazar/shared` (CLAUDE.md invariant
 * 1), and an exact comparison of two derived totals belongs in SQL.
 */
export function readNumeric(row: Record<string, unknown>, column: string): number {
  const value = row[column];
  const parsed = typeof value === 'string' ? Number.parseFloat(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
    throw new RowShapeError(`Column ${column} is not a usable number.`);
  }
  return parsed;
}

export function readText(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw new RowShapeError(`Column ${column} is not text.`);
  return value;
}

export function readNullableText(row: Record<string, unknown>, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  return readText(row, column);
}

export function readBoolean(row: Record<string, unknown>, column: string): boolean {
  const value = row[column];
  if (typeof value !== 'boolean') throw new RowShapeError(`Column ${column} is not a boolean.`);
  return value;
}

export function readTimestamp(row: Record<string, unknown>, column: string): Date {
  const value = row[column];
  if (!(value instanceof Date)) throw new RowShapeError(`Column ${column} is not a timestamp.`);
  return value;
}

export function readNullableTimestamp(row: Record<string, unknown>, column: string): Date | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  return readTimestamp(row, column);
}
