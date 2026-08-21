import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import pg from 'pg';

import { databaseNow } from '../db/clock.js';
import type { Queryable } from '../db/queryable.js';
import { firstRow, readText } from '../db/rows.js';
import { backupStem, DUMP_SUFFIX, MANIFEST_SUFFIX, type BackupConfig } from './config.js';
import { runTool } from './commands.js';
import { captureManifest, type BackupManifest } from './manifest.js';
import { ageInHours, planRetention, readDumpFiles, type DumpFile } from './retention.js';

/**
 * Taking the nightly dump, and keeping the directory it lands in tidy.
 *
 * The dump is `pg_dump --format=custom`, which is compressed and is the only
 * format `pg_restore` can be selective about. Beside every dump sits a manifest
 * describing the database at the instant it was taken, and the two are written
 * from **one snapshot**:
 *
 *   1. open a REPEATABLE READ transaction and export its snapshot
 *   2. run `pg_dump --snapshot=` against it
 *   3. count everything in that same transaction
 *   4. roll it back - nothing here writes to the live database
 *
 * Without step 1 the manifest describes a slightly later database than the
 * file, and restore-verify reports a difference that is real, harmless and
 * indistinguishable from a corrupt backup. A check that cries wolf on the night
 * somebody works late is a check people learn to close.
 *
 * The job then reads the dump back with `pg_restore --list`. It parses the
 * archive's table of contents without restoring anything, which is the cheapest
 * possible proof that what was written is a readable archive rather than a
 * truncated file that a full disk left behind. It costs milliseconds and moves
 * the discovery of a bad dump from the weekly verify to the night it happened.
 */

export interface DumpResult {
  readonly dumpPath: string;
  readonly manifestPath: string;
  readonly sizeBytes: number;
  readonly tocEntries: number;
  readonly manifest: BackupManifest;
  readonly durationMs: number;
}

export interface DumpSetProblem {
  readonly what: string;
}

export interface DumpSet {
  readonly dumps: readonly DumpFile[];
  readonly newestAgeHours: number | null;
  readonly totalBytes: number;
  readonly problems: readonly DumpSetProblem[];
}

/** Older than this and the nightly job has missed a night, whatever it reports. */
const STALE_AFTER_HOURS = 36;

async function exportSnapshot(db: Queryable): Promise<string> {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const { rows } = await db.query('SELECT pg_export_snapshot() AS id');
  return readText(firstRow(rows), 'id');
}

function requireDatabase(config: BackupConfig): string {
  if (config.database === '') {
    throw new Error('PGDATABASE is not set, so there is no database to back up.');
  }
  return config.database;
}

/**
 * Counts the entries in the archive's table of contents. Throws if `pg_restore`
 * cannot read the file, which is the point of doing it.
 */
async function readTocEntries(config: BackupConfig, dumpPath: string): Promise<number> {
  const { stdout } = await runTool(config, 'pg_restore', ['--list', dumpPath]);
  return stdout.split('\n').filter((line) => line.trim() !== '' && !line.startsWith(';')).length;
}

/**
 * Takes one dump and writes its manifest. Returns where both landed.
 *
 * `takenAt` comes from the database rather than from `new Date()`, for the
 * reason CLAUDE.md gives under Working practices: the filename is how retention
 * decides what is expired, and a machine whose clock is an hour fast would name
 * a dump into the future and then age it out early.
 */
export async function takeDump(config: BackupConfig): Promise<DumpResult> {
  const database = requireDatabase(config);
  const startedAt = Date.now();
  await mkdir(config.dumpDir, { recursive: true });

  const client = new pg.Client();
  await client.connect();

  try {
    const snapshotId = await exportSnapshot(client);

    // `databaseNow`, not a hand-rolled read of now(): node-postgres hands back
    // TIMESTAMPTZ as a Date object, not as text, so reading it as text throws.
    // There is one reader for this and it is in db/clock.ts.
    const takenAt = await databaseNow(client);

    const stem = backupStem(database, takenAt);
    const dumpPath = path.join(config.dumpDir, `${stem}${DUMP_SUFFIX}`);
    const manifestPath = path.join(config.dumpDir, `${stem}${MANIFEST_SUFFIX}`);

    await runTool(config, 'pg_dump', [
      '--format=custom',
      '--compress=6',
      // Never prompt. A scheduled task that asks for a password at 23:30 waits
      // for an answer that is not coming, and the backup that did not happen
      // looks exactly like a backup that is still running.
      '--no-password',
      `--snapshot=${snapshotId}`,
      `--file=${dumpPath}`,
      `--dbname=${database}`,
    ]);

    const manifest = await captureManifest(client, {
      database,
      dumpFile: `${stem}${DUMP_SUFFIX}`,
      takenAt,
    });

    await client.query('ROLLBACK');

    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    const { size } = await stat(dumpPath);
    const tocEntries = await readTocEntries(config, dumpPath);

    return {
      dumpPath,
      manifestPath,
      sizeBytes: size,
      tocEntries,
      manifest,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    await client.end();
  }
}

/**
 * Deletes dumps past the retention window, with their manifests. Returns how
 * many went.
 *
 * The plan comes from `planRetention`, which never expires the newest dump
 * whatever its age - see the reasoning there. This function does no arithmetic
 * of its own, deliberately: the code that decides what to delete and the code
 * that deletes it are separate so the first can be tested exhaustively without
 * anything being at risk.
 */
export async function pruneDumps(config: BackupConfig, now: Date): Promise<number> {
  const dumps = readDumpFiles(await readdir(config.dumpDir));
  const { prune } = planRetention(dumps, now, config.retentionDays);

  for (const dump of prune) {
    await rm(path.join(config.dumpDir, dump.filename), { force: true });
    await rm(path.join(config.dumpDir, dump.filename.replace(DUMP_SUFFIX, MANIFEST_SUFFIX)), {
      force: true,
    });
  }

  return prune.length;
}

/** What the dump directory holds, and anything wrong with it. */
export async function inspectDumpSet(config: BackupConfig, now: Date): Promise<DumpSet> {
  const problems: DumpSetProblem[] = [];

  let entries: string[];
  try {
    entries = await readdir(config.dumpDir);
  } catch {
    return {
      dumps: [],
      newestAgeHours: null,
      totalBytes: 0,
      problems: [{ what: `${config.dumpDir} does not exist or cannot be read` }],
    };
  }

  const dumps = readDumpFiles(entries);
  if (dumps.length === 0) {
    return {
      dumps,
      newestAgeHours: null,
      totalBytes: 0,
      problems: [{ what: `no dumps in ${config.dumpDir}` }],
    };
  }

  let totalBytes = 0;
  for (const dump of dumps) {
    const { size } = await stat(path.join(config.dumpDir, dump.filename));
    totalBytes += size;
    if (size === 0) problems.push({ what: `${dump.filename} is empty` });
  }

  const [newest] = dumps;
  if (
    newest !== undefined &&
    !entries.includes(newest.filename.replace(DUMP_SUFFIX, MANIFEST_SUFFIX))
  ) {
    problems.push({ what: `${newest.filename} has no manifest beside it` });
  }

  const newestAgeHours = ageInHours(dumps, now);
  if (newestAgeHours !== null && newestAgeHours > STALE_AFTER_HOURS) {
    problems.push({
      what: `newest dump is ${String(newestAgeHours)} hours old`,
    });
  }

  return { dumps, newestAgeHours, totalBytes, problems };
}

/**
 * The dump restore-verify will read, with its manifest.
 *
 * A missing directory and an empty one are the same answer to the operator -
 * there is nothing to verify - so they get the same message. Letting Node's
 * "ENOENT: no such file or directory, scandir ..." reach the health panel would
 * put a system call in the one column somebody reads at six in the morning.
 */
export async function latestDumpWithManifest(
  config: BackupConfig,
): Promise<{ dumpPath: string; manifest: BackupManifest }> {
  let entries: string[] = [];
  try {
    entries = await readdir(config.dumpDir);
  } catch {
    // Falls through to the "no dumps" message below.
  }

  const dumps = readDumpFiles(entries);
  const [newest] = dumps;
  if (newest === undefined) throw new Error(`no dumps in ${config.dumpDir} to verify`);

  const manifestPath = path.join(
    config.dumpDir,
    newest.filename.replace(DUMP_SUFFIX, MANIFEST_SUFFIX),
  );

  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as BackupManifest;
  } catch (error) {
    throw new Error(
      `${newest.filename} has no readable manifest, so there is nothing to check it against`,
      { cause: error },
    );
  }

  return { dumpPath: path.join(config.dumpDir, newest.filename), manifest };
}
