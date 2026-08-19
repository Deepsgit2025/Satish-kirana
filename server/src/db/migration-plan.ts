import { createHash } from 'node:crypto';

/**
 * Migration file discovery, ordering and validation. Pure functions only - no
 * filesystem, no database - so the rules below are testable without either.
 *
 * The rules exist because migrations are append-only (CLAUDE.md, "Working
 * practices"). Once a file has been applied on any machine it must never
 * change; the checksum recorded in `schema_migrations` is what proves it.
 */

/** A migration file on disk. */
export interface MigrationFile {
  /** Numeric prefix, e.g. 1 for `001_foundation.sql`. */
  readonly version: number;
  /** Descriptive part, e.g. `foundation`. */
  readonly name: string;
  readonly filename: string;
}

/** A row of `schema_migrations`. */
export interface AppliedMigration {
  readonly version: number;
  readonly filename: string;
  readonly checksum: string;
}

/** `001_foundation.sql` - at least three digits, then snake_case words. */
const FILENAME_PATTERN = /^(\d{3,})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;

/** Raised for every rule violation below, so callers can report them as one class. */
export class MigrationPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationPlanError';
  }
}

/** True for files the runner considers migrations at all. */
export function isSqlFile(filename: string): boolean {
  return filename.toLowerCase().endsWith('.sql');
}

/** Parses one filename, or returns null if it does not match the convention. */
export function parseMigrationFilename(filename: string): MigrationFile | null {
  const match = FILENAME_PATTERN.exec(filename);
  if (match === null) return null;

  const [, digits, name] = match;
  // The pattern guarantees both groups matched.
  if (digits === undefined || name === undefined) return null;

  return { version: Number.parseInt(digits, 10), name, filename };
}

/**
 * Validates and orders a directory listing.
 *
 * Non-`.sql` entries (`.gitkeep`, `README.md`) are ignored. A `.sql` file that
 * breaks the naming convention is an error rather than a skip - silently
 * ignoring a migration is how a schema drifts between machines.
 */
export function collectMigrationFiles(filenames: readonly string[]): MigrationFile[] {
  const files: MigrationFile[] = [];

  for (const filename of filenames) {
    if (!isSqlFile(filename)) continue;

    const parsed = parseMigrationFilename(filename);
    if (parsed === null) {
      throw new MigrationPlanError(
        `Migration "${filename}" does not match the naming convention ` +
          `<number>_<snake_case_name>.sql, e.g. 001_foundation.sql.`,
      );
    }
    files.push(parsed);
  }

  files.sort((a, b) => a.version - b.version);

  for (let i = 1; i < files.length; i += 1) {
    const previous = files[i - 1];
    const current = files[i];
    if (previous === undefined || current === undefined) continue;
    if (previous.version === current.version) {
      throw new MigrationPlanError(
        `Two migrations share version ${String(current.version)}: ` +
          `"${previous.filename}" and "${current.filename}". Renumber one of them.`,
      );
    }
  }

  return files;
}

/**
 * Checksum of a migration's contents.
 *
 * Line endings are normalised first: the dev machines are Windows and the store
 * server is Linux, and the same file must hash identically on both.
 */
export function checksum(sql: string): string {
  const normalised = sql.replace(/\r\n/gu, '\n').trimEnd();
  return createHash('sha256').update(normalised, 'utf8').digest('hex');
}

/** What the runner should do this run. */
export interface MigrationPlan {
  readonly pending: MigrationFile[];
  readonly appliedCount: number;
}

/**
 * Compares the files on disk against the rows in `schema_migrations` and
 * returns what is left to apply.
 *
 * Throws when the history is inconsistent:
 * - an applied migration is missing from disk (someone deleted it)
 * - an applied migration's contents changed (someone edited it)
 * - an applied migration was renamed
 * - a new migration is numbered below one already applied, which would make the
 *   order of application depend on which machine ran first
 */
export function planMigrations(
  files: readonly MigrationFile[],
  applied: readonly AppliedMigration[],
  checksums: ReadonlyMap<string, string>,
): MigrationPlan {
  const byVersion = new Map(files.map((file) => [file.version, file]));

  for (const record of applied) {
    const file = byVersion.get(record.version);

    if (file === undefined) {
      throw new MigrationPlanError(
        `Migration ${String(record.version)} ("${record.filename}") is recorded as applied ` +
          `but is missing from server/migrations. Restore the file - applied migrations are ` +
          `never deleted.`,
      );
    }

    if (file.filename !== record.filename) {
      throw new MigrationPlanError(
        `Migration ${String(record.version)} was applied as "${record.filename}" but is now ` +
          `named "${file.filename}". Applied migrations are never renamed.`,
      );
    }

    const current = checksums.get(file.filename);
    if (current !== undefined && current !== record.checksum) {
      throw new MigrationPlanError(
        `Migration "${file.filename}" has changed since it was applied. Migrations are ` +
          `append-only: revert the edit and add a new migration instead.`,
      );
    }
  }

  const appliedVersions = new Set(applied.map((record) => record.version));
  const highestApplied = applied.reduce((max, record) => Math.max(max, record.version), 0);
  const pending = files.filter((file) => !appliedVersions.has(file.version));

  for (const file of pending) {
    if (file.version < highestApplied) {
      throw new MigrationPlanError(
        `Migration "${file.filename}" is numbered below ${String(highestApplied)}, which has ` +
          `already been applied. Renumber it above the latest applied migration so every ` +
          `database applies migrations in the same order.`,
      );
    }
  }

  return { pending, appliedCount: applied.length };
}
