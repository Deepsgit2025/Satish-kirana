import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Where the local backups live, and what "expired" means.
 *
 * Everything here is derived from environment variables so the store server,
 * the office machine and a developer laptop can point at different disks
 * without a code change. Nothing in this file touches the filesystem: it turns
 * an environment into a set of absolute paths and numbers, which is what makes
 * the retention arithmetic testable without writing a single dump.
 *
 * The directory layout is three siblings under one root, and they are separate
 * because their lifetimes are:
 *
 *   dumps/  the nightly logical dump, plus a manifest per dump. Pruned by age.
 *   base/   pg_basebackup output. The anchor the WAL archive replays onto.
 *   wal/    archived WAL segments. Pruned against the oldest base backup that
 *           is still being kept, never against the calendar.
 *
 * `BACKUP_LOCAL_DIR` in `.env.example` reads `/var/backups/ssbazar`, which is
 * the store server. A Windows machine needs a Windows path; there is no sane
 * default that suits both, so an unset value resolves under the user's home
 * directory rather than at the filesystem root, where it would either fail on
 * permissions or silently create `C:\var`.
 */

/** UTC, compact, sortable — `ssbazar-20260821T183000Z.dump`. */
const STAMP = /^[a-z0-9_-]+-(\d{8}T\d{6}Z)\.(dump|manifest\.json)$/;

export const DUMP_SUFFIX = '.dump';
export const MANIFEST_SUFFIX = '.manifest.json';

export interface BackupConfig {
  /** Root of the local backup area. Everything below is inside it. */
  readonly root: string;
  readonly dumpDir: string;
  readonly baseDir: string;
  readonly walDir: string;
  /** Dumps older than this are pruned — except the newest, which never is. */
  readonly retentionDays: number;
  /** A base backup older than this makes the WAL archive stale. */
  readonly baseBackupEveryDays: number;
  /** The database restore-verify builds and throws away. Never the live one. */
  readonly verifyDatabase: string;
  /** The database being backed up, from `PGDATABASE`. */
  readonly database: string;
  /**
   * The role restore-verify does its elevated work as, or null to use the
   * ambient `PGUSER` — `docs/DECISIONS.md` D47.
   *
   * `backup:verify` opens two different kinds of connection and only one of
   * them needs a privilege:
   *
   *   to the **live** database, to record the run on the health panel. That is
   *   one INSERT into `reconciliation_runs` and wants no rights beyond what the
   *   application already has.
   *
   *   to the **maintenance and scratch** databases, to CREATE, restore into,
   *   assert against and DROP. That needs `CREATEDB`.
   *
   * Splitting them is the whole point of D47: the role that runs billing keeps
   * no elevated attribute, and the role that can create databases is used by
   * one weekly job and owns nothing but scratch databases.
   *
   * There is deliberately no host or port override. The scratch database is
   * created on the same cluster the dump came from; a setting suggesting
   * otherwise would invite pointing this at another server, which is a
   * different job with different failure modes (D47 again — the throwaway
   * cluster that was measured and not chosen).
   */
  readonly verifyUser: string | null;
  readonly verifyPassword: string | null;
  /**
   * Directory holding `pg_dump` and friends, when they are not on `PATH`. A
   * Windows scheduled task runs with a different `PATH` from the shell the
   * installer typed into, and that difference shows up as "pg_dump is not
   * recognised" at 23:30 with nobody watching.
   */
  readonly binDir: string | null;
}

/**
 * A positive whole number of days, or the default when unset.
 *
 * The digits-only test is doing real work. `Number.parseInt('1.5')` is 1 and
 * `Number.parseInt('7 days')` is 7, so a check that only looked at the result
 * would accept a mistyped setting, quietly mean something else by it, and then
 * delete backups on a schedule nobody chose.
 */
function integerFrom(value: string | undefined, fallback: number, name: string): number {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === '') return fallback;

  const parsed = Number.parseInt(trimmed, 10);
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(
      `${name} must be a positive whole number of days, not ${JSON.stringify(value)}`,
    );
  }
  return parsed;
}

/**
 * A setting's value, or the fallback when it is unset **or blank**.
 *
 * `??` is not enough and the difference has already cost a failed run. A
 * variable written into `.env` with nothing after the `=` - which is how
 * `.env.example` documents "leave this to the default" - arrives as `''`, and
 * `'' ?? fallback` is `''`. What reached `CREATE DATABASE` was an empty
 * identifier and what reached the operator was `zero-length delimited
 * identifier`, which says nothing about which setting was wrong.
 *
 * An unset variable and a variable set to nothing are the same intent. Every
 * setting read here goes through this, so there is one answer rather than one
 * per call site.
 */
function textFrom(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? fallback : trimmed;
}

function defaultRoot(): string {
  return path.join(homedir(), '.ssbazar', 'backups');
}

/**
 * Reads the configuration out of `env`, defaulting anything unset.
 *
 * Takes the environment rather than reading `process.env` directly so a test
 * can hand it one, and so the two CLIs cannot drift apart on what a variable
 * means.
 */
export function readBackupConfig(env: NodeJS.ProcessEnv = process.env): BackupConfig {
  const root = path.resolve(textFrom(env.BACKUP_LOCAL_DIR, defaultRoot()));
  const database = textFrom(env.PGDATABASE, '');
  const verifyDatabase = textFrom(
    env.BACKUP_VERIFY_DATABASE,
    `${database === '' ? 'ssbazar' : database}_verify`,
  );

  if (database !== '' && verifyDatabase === database) {
    throw new Error(
      `BACKUP_VERIFY_DATABASE is ${verifyDatabase}, which is the live database. ` +
        'Restore-verify drops and recreates whatever it is pointed at.',
    );
  }

  const binDir = textFrom(env.PG_BIN_DIR, '');
  const verifyUser = textFrom(env.BACKUP_VERIFY_PGUSER, '');
  const verifyPassword = textFrom(env.BACKUP_VERIFY_PGPASSWORD, '');

  // A password with no user is always a mistake, and a silent one: the
  // connection succeeds as the ambient PGUSER, the verify appears to work, and
  // the separation D47 asked for is not there. Failing here is the only way
  // anybody finds out.
  if (verifyUser === '' && verifyPassword !== '') {
    throw new Error(
      'BACKUP_VERIFY_PGPASSWORD is set but BACKUP_VERIFY_PGUSER is not, so the password would ' +
        'be ignored and restore-verify would quietly run as PGUSER instead.',
    );
  }

  return {
    root,
    dumpDir: path.join(root, 'dumps'),
    baseDir: path.join(root, 'base'),
    walDir: path.join(root, 'wal'),
    retentionDays: integerFrom(env.BACKUP_RETENTION_DAYS, 7, 'BACKUP_RETENTION_DAYS'),
    baseBackupEveryDays: integerFrom(env.BACKUP_BASE_EVERY_DAYS, 7, 'BACKUP_BASE_EVERY_DAYS'),
    verifyDatabase,
    database,
    verifyUser: verifyUser === '' ? null : verifyUser,
    verifyPassword: verifyPassword === '' ? null : verifyPassword,
    binDir: binDir === '' ? null : path.resolve(binDir),
  };
}

/**
 * Connection settings for the scratch database work, as `pg` wants them.
 *
 * Empty when no separate role is configured, which leaves `pg` to read the
 * ambient `PG*` variables exactly as it does everywhere else in this codebase.
 */
export function verifyConnection(config: BackupConfig): { user?: string; password?: string } {
  return {
    ...(config.verifyUser === null ? {} : { user: config.verifyUser }),
    ...(config.verifyPassword === null ? {} : { password: config.verifyPassword }),
  };
}

/**
 * The same settings as environment overrides, for `pg_restore`.
 *
 * The password goes into the child's environment rather than onto its command
 * line, for the reason `commands.ts` gives: arguments are visible to every
 * process on the machine through the process list, and environments are not.
 */
export function verifyToolEnv(config: BackupConfig): NodeJS.ProcessEnv {
  return {
    ...(config.verifyUser === null ? {} : { PGUSER: config.verifyUser }),
    ...(config.verifyPassword === null ? {} : { PGPASSWORD: config.verifyPassword }),
  };
}

/** `ssbazar-20260821T183000Z` — the stem both the dump and its manifest share. */
export function backupStem(database: string, at: Date): string {
  const stamp = at
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return `${database}-${stamp}`;
}

/**
 * The instant encoded in a backup filename, or null if it is not one of ours.
 *
 * Read from the name rather than from the file's mtime deliberately. Copying a
 * backup directory to a USB drive rewrites every mtime, and retention that
 * trusted mtime would then treat a week of history as having all arrived today
 * — and delete none of it, or all of it, depending on which way the copy went.
 * The name is the only part of a backup that survives being moved.
 */
export function timestampFromName(filename: string): Date | null {
  const match = STAMP.exec(filename);
  if (match === null) return null;

  const [, stamp] = match;
  if (stamp === undefined) return null;

  const iso =
    `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T` +
    `${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`;

  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at;
}
