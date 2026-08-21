import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Queryable } from '../db/queryable.js';
import { firstRow, readInt, readNullableText, readText } from '../db/rows.js';
import { runTool } from './commands.js';
import { backupStem, timestampFromName, type BackupConfig } from './config.js';
import { planWalPrune } from './retention.js';

/**
 * WAL archiving, and the base backup without which it recovers nothing.
 *
 * This is the half of local backup that is easy to ship broken, so the reason
 * is written here rather than left to be rediscovered - docs/DECISIONS.md D46
 * carries the same argument in full.
 *
 * A nightly `pg_dump` is a **logical** backup: a description of the data, which
 * restores into a new cluster with a new timeline and new WAL of its own.
 * Archived WAL segments belong to the old cluster and cannot be replayed onto
 * it. So WAL archiving alongside nothing but logical dumps produces a directory
 * that grows forever and can never be used - the worst possible outcome, since
 * it costs disk continuously and looks like protection the whole time.
 *
 * WAL becomes recoverable only on top of a **physical** base backup taken with
 * `pg_basebackup`. That pair is what turns "we lose everything since 23:30"
 * into "we lose the last few minutes", which for a shop writing a thousand
 * bills a day is the difference between a bad evening and a lost one.
 *
 * Hence three things here rather than one:
 *
 *   the archive itself, and whether Postgres is keeping up with it
 *   a base backup on a schedule, anchoring the archive
 *   pruning, against the oldest base backup still kept - never the calendar
 */

export interface ArchiveStatus {
  readonly archiveMode: string;
  readonly archiveCommand: string | null;
  readonly walLevel: string;
  readonly archivedCount: number;
  readonly failedCount: number;
  readonly lastArchivedWal: string | null;
  readonly lastArchivedTime: string | null;
  readonly lastFailedWal: string | null;
  readonly lastFailedTime: string | null;
  readonly currentWalFile: string;
}

export interface BaseBackup {
  readonly directory: string;
  readonly takenAt: Date;
  readonly startWal: string | null;
  readonly sizeBytes: number;
  /**
   * `archive_mode` as it stood when this backup was taken, or null for a
   * sidecar written before this was recorded.
   *
   * A base backup taken while archiving was off cannot be rolled forward, ever.
   * The segments written between it and the moment archiving was switched on
   * were never archived and do not exist anywhere, so the WAL chain has a hole
   * at its start and recovery stops at the end of the backup's own streamed
   * WAL.
   *
   * This is not hypothetical: it is what the first base backup on this project
   * turned out to be. Archiving was configured but pending a restart, the
   * backup was taken anyway, the restart happened an hour later, and the check
   * then reported `ok` - archiving on, a base backup present, no archiver
   * failures - for a pairing that could not recover anything. Every individual
   * fact was true and the conclusion was wrong.
   *
   * Postgres does not create gaps on its own: a failed `archive_command` is
   * retried on the same segment forever rather than skipped, so `failed_count`
   * catches an outage while it is happening. The one way a hole appears in the
   * middle of an otherwise healthy archive is somebody switching archiving off
   * and on again - which is exactly what this field records.
   */
  readonly archiveModeAtBackup: string | null;
}

/** Whether a base backup has an archive that can extend it. */
export function isRollableForward(backup: BaseBackup): boolean {
  return backup.archiveModeAtBackup === 'on' || backup.archiveModeAtBackup === 'always';
}

export interface ArchiveReport {
  readonly status: ArchiveStatus;
  readonly baseBackups: readonly BaseBackup[];
  readonly walSegments: number;
  readonly walBytes: number;
  readonly walPruned: number;
  readonly baseBackupTaken: BaseBackup | null;
  readonly problems: readonly string[];
}

const STATUS_SQL = `
  SELECT current_setting('archive_mode')    AS archive_mode,
         current_setting('archive_command') AS archive_command,
         current_setting('wal_level')       AS wal_level,
         a.archived_count::int              AS archived_count,
         a.failed_count::int                AS failed_count,
         a.last_archived_wal                AS last_archived_wal,
         a.last_archived_time::text         AS last_archived_time,
         a.last_failed_wal                  AS last_failed_wal,
         a.last_failed_time::text           AS last_failed_time,
         pg_walfile_name(pg_current_wal_lsn()) AS current_wal_file
    FROM pg_stat_archiver a`;

/** Sidecar written beside each base backup, so pruning needs no parsing of tar. */
const BASE_MARKER_SUFFIX = '.json';

export async function readArchiveStatus(db: Queryable): Promise<ArchiveStatus> {
  const { rows } = await db.query(STATUS_SQL);
  const row = firstRow(rows);
  const command = readText(row, 'archive_command');

  return {
    archiveMode: readText(row, 'archive_mode'),
    // Postgres reports an unset archive_command as "(disabled)", which reads
    // like a value rather than an absence. Normalised so callers test for null.
    archiveCommand: command === '' || command === '(disabled)' ? null : command,
    walLevel: readText(row, 'wal_level'),
    archivedCount: readInt(row, 'archived_count'),
    failedCount: readInt(row, 'failed_count'),
    lastArchivedWal: readNullableText(row, 'last_archived_wal'),
    lastArchivedTime: readNullableText(row, 'last_archived_time'),
    lastFailedWal: readNullableText(row, 'last_failed_wal'),
    lastFailedTime: readNullableText(row, 'last_failed_time'),
    currentWalFile: readText(row, 'current_wal_file'),
  };
}

async function directorySize(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    total += entry.isDirectory() ? await directorySize(full) : (await stat(full)).size;
  }
  return total;
}

/** Base backups on disk, newest first, read from their sidecars. */
export async function readBaseBackups(config: BackupConfig): Promise<BaseBackup[]> {
  let entries: string[];
  try {
    entries = await readdir(config.baseDir);
  } catch {
    return [];
  }

  const backups: BaseBackup[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(BASE_MARKER_SUFFIX)) continue;

    const takenAt = timestampFromName(entry.replace(BASE_MARKER_SUFFIX, '.dump'));
    if (takenAt === null) continue;

    const sidecar = JSON.parse(await readFile(path.join(config.baseDir, entry), 'utf8')) as {
      directory?: unknown;
      startWal?: unknown;
      archiveModeAtBackup?: unknown;
    };
    const directory = typeof sidecar.directory === 'string' ? sidecar.directory : '';
    if (directory === '') continue;

    const full = path.join(config.baseDir, directory);
    let sizeBytes = 0;
    try {
      sizeBytes = await directorySize(full);
    } catch {
      // The sidecar outlived its directory. Reported as a problem below rather
      // than skipped, because a base backup that is only a sidecar is exactly
      // the thing WAL pruning would otherwise trust.
    }

    backups.push({
      directory,
      takenAt,
      startWal: typeof sidecar.startWal === 'string' ? sidecar.startWal : null,
      sizeBytes,
      archiveModeAtBackup:
        typeof sidecar.archiveModeAtBackup === 'string' ? sidecar.archiveModeAtBackup : null,
    });
  }

  return backups.sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime());
}

/**
 * Takes a base backup with `pg_basebackup`, and records the WAL segment it
 * starts from.
 *
 * The segment is read *before* the backup starts, so it is at or behind the
 * real start point. Erring behind is the safe direction: pruning then keeps a
 * segment or two more than strictly needed, where erring ahead would delete WAL
 * the backup requires and leave a base backup that cannot reach consistency.
 *
 * `--wal-method=stream` puts the WAL written during the backup inside it, so
 * the base backup is restorable to a consistent point on its own even if the
 * archive has a gap. It costs a second replication connection and is worth it:
 * the archive is the thing most likely to have been quietly broken.
 *
 * The backup is then read back with `pg_verifybackup`, which checks every file
 * against the `backup_manifest` `pg_basebackup` wrote beside them. Same
 * reasoning as the `pg_restore --list` readback on a dump: an exit code of zero
 * from the program that wrote a file is not evidence the file is good, and this
 * is the one class of file where finding out late is the whole problem. It
 * throws on failure, so a bad base backup becomes a failed run rather than a
 * directory that looks like protection.
 */
export async function takeBaseBackup(
  db: Queryable,
  config: BackupConfig,
  takenAt: Date,
  status: ArchiveStatus,
): Promise<BaseBackup> {
  await mkdir(config.baseDir, { recursive: true });

  const { rows } = await db.query(`SELECT pg_walfile_name(pg_current_wal_lsn()) AS wal`);
  const startWal = readText(firstRow(rows), 'wal');

  const stem = backupStem('base', takenAt);
  const directory = path.join(config.baseDir, stem);
  await mkdir(directory, { recursive: true });

  await runTool(config, 'pg_basebackup', [
    `--pgdata=${directory}`,
    '--format=tar',
    '--gzip',
    '--compress=6',
    '--wal-method=stream',
    '--checkpoint=fast',
    '--no-password',
    `--label=${stem}`,
  ]);

  // `-n` skips the WAL check: the segments needed to reach consistency are
  // inside pg_wal.tar.gz rather than beside the data files, and asking
  // pg_verifybackup to look for them in a tar it cannot open fails a backup
  // that is sound.
  await runTool(config, 'pg_verifybackup', ['-n', directory]);

  const sizeBytes = await directorySize(directory);
  const archiveModeAtBackup = status.archiveMode;

  await writeFile(
    path.join(config.baseDir, `${stem}${BASE_MARKER_SUFFIX}`),
    `${JSON.stringify(
      {
        directory: stem,
        startWal,
        takenAt: takenAt.toISOString(),
        sizeBytes,
        archiveModeAtBackup,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  return { directory: stem, takenAt, startWal, sizeBytes, archiveModeAtBackup };
}

/**
 * Keeps the newest two base backups and deletes the rest.
 *
 * Two rather than one, always: while a new base backup is being written the
 * previous one is the only complete copy, and a scheme that kept exactly one
 * would have a window every week during which the shop has none.
 */
export async function pruneBaseBackups(config: BackupConfig, keep = 2): Promise<number> {
  const backups = await readBaseBackups(config);
  const expired = backups.slice(keep);

  for (const backup of expired) {
    await rm(path.join(config.baseDir, backup.directory), { recursive: true, force: true });
    await rm(path.join(config.baseDir, `${backup.directory}${BASE_MARKER_SUFFIX}`), {
      force: true,
    });
  }

  return expired.length;
}

/** Deletes archived WAL no base backup we keep could ever need. */
export async function pruneWal(config: BackupConfig, oldestNeeded: string | null): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(config.walDir);
  } catch {
    return 0;
  }

  const { prune } = planWalPrune(entries, oldestNeeded);
  for (const name of prune) {
    await rm(path.join(config.walDir, name), { force: true });
  }

  return prune.length;
}

async function walFootprint(config: BackupConfig): Promise<{ segments: number; bytes: number }> {
  let entries: string[];
  try {
    entries = await readdir(config.walDir);
  } catch {
    return { segments: 0, bytes: 0 };
  }

  let bytes = 0;
  for (const entry of entries) {
    bytes += (await stat(path.join(config.walDir, entry))).size;
  }
  return { segments: entries.length, bytes };
}

/**
 * Everything wrong with the archive itself, as of `status`.
 *
 * Separate from the base-backup checks because it is asked twice: once to
 * decide whether taking a base backup is worthwhile, and once at the end for
 * what the panel reports.
 */
function archiveProblems(status: ArchiveStatus): string[] {
  const problems: string[] = [];

  if (status.archiveMode !== 'on' && status.archiveMode !== 'always') {
    problems.push(
      `archive_mode is ${status.archiveMode} - point-in-time recovery is not possible. ` +
        'See docs/backup.md.',
    );
  }
  if (status.archiveCommand === null && status.archiveMode !== 'off') {
    problems.push('archive_mode is on but archive_command is unset, so nothing is being archived');
  }
  if (status.walLevel === 'minimal') {
    problems.push(`wal_level is ${status.walLevel}, which cannot support archiving`);
  }

  // The sharpest available signal that archiving is broken right now: the most
  // recent thing the archiver did was fail. A non-zero failed_count on its own
  // is history and may be a long-fixed permissions problem.
  const currentlyFailing =
    status.failedCount > 0 &&
    status.lastFailedTime !== null &&
    (status.lastArchivedTime === null || status.lastFailedTime > status.lastArchivedTime);

  if (currentlyFailing) {
    problems.push(
      `archiver is failing: ${String(status.failedCount)} failures, last on ` +
        `${status.lastFailedWal ?? 'unknown'} at ${status.lastFailedTime}`,
    );
  }

  return problems;
}

/**
 * The whole `wal_archive` job: take a base backup if one is due, prune, and
 * report everything wrong with the archive.
 *
 * Ordering matters. The base backup is taken *before* pruning, so the archive
 * is never trimmed against a backup set that is about to gain a member; and the
 * prune point comes from the **oldest** backup still kept rather than the
 * newest, because the older one is the one that needs the older WAL.
 */
export async function runArchiveMaintenance(
  db: Queryable,
  config: BackupConfig,
  now: Date,
): Promise<ArchiveReport> {
  // Read twice, deliberately. The first tells us whether it is worth taking a
  // base backup; the second is what gets reported, because taking one archives
  // several segments and a `.backup` label of its own. Reporting the first
  // reading alongside a footprint counted at the end put "archived=2" next to
  // "wal_segments=5" on the same line - two true figures from two different
  // moments, which is the kind of summary that teaches people not to trust the
  // panel.
  const archivingUsable = archiveProblems(await readArchiveStatus(db)).length === 0;

  let baseBackups = await readBaseBackups(config);
  const [newest] = baseBackups;
  const dueAfterMs = config.baseBackupEveryDays * 24 * 60 * 60 * 1000;

  // Due on the calendar, or due because nothing we hold can be rolled forward.
  // The second is not a scheduling question: a base backup taken while
  // archiving was off is not "slightly stale", it is unusable for recovery, and
  // waiting out the rest of the week would leave the shop with no
  // point-in-time recovery while the panel said there was some.
  const noneRollable = baseBackups.length > 0 && !baseBackups.some(isRollableForward);
  const due =
    newest === undefined || now.getTime() - newest.takenAt.getTime() >= dueAfterMs || noneRollable;

  let baseBackupTaken: BaseBackup | null = null;

  // A base backup is only worth taking when the archive it anchors is working.
  // Taking one against a broken archive writes gigabytes that recover nothing
  // and hides the real fault behind a fresh timestamp.
  if (due && archivingUsable) {
    baseBackupTaken = await takeBaseBackup(db, config, now, await readArchiveStatus(db));
    await pruneBaseBackups(config);
    baseBackups = await readBaseBackups(config);
  }

  // Everything below reports the archive as it now stands, after any base
  // backup this run took.
  const status = await readArchiveStatus(db);
  const problems = archiveProblems(status);

  if (due && !archivingUsable) {
    problems.push('a base backup is due but the WAL archive is not working, so it was not taken');
  }

  if (baseBackups.length === 0) {
    problems.push(
      'no base backup, so the archived WAL cannot be replayed onto anything ' +
        '(docs/DECISIONS.md D46)',
    );
  } else if (!baseBackups.some(isRollableForward)) {
    // Having a base backup and having a recoverable system are different
    // claims, and this is the gap between them.
    const oldest = baseBackups.at(-1);
    problems.push(
      'no base backup can be rolled forward: every one being kept was taken while archiving ' +
        `was ${oldest?.archiveModeAtBackup ?? 'not recorded'}, so the WAL between it and the ` +
        'archive was never written anywhere. Point-in-time recovery is not possible until a ' +
        'new base backup is taken (docs/DECISIONS.md D46).',
    );
  }

  const oldestKept = baseBackups.at(-1) ?? null;
  const walPruned = oldestKept === null ? 0 : await pruneWal(config, oldestKept.startWal);

  for (const backup of baseBackups) {
    if (backup.sizeBytes === 0) {
      problems.push(`base backup ${backup.directory} is empty or missing`);
    }
  }

  const { segments, bytes } = await walFootprint(config);

  return {
    status,
    baseBackups,
    walSegments: segments,
    walBytes: bytes,
    walPruned,
    baseBackupTaken,
    problems,
  };
}

/** Exported for the CLI's summary line. */
export function summariseArchive(report: ArchiveReport): string {
  const parts = [
    `archive_mode=${report.status.archiveMode}`,
    `archived=${String(report.status.archivedCount)}`,
    `failed=${String(report.status.failedCount)}`,
    `wal_segments=${String(report.walSegments)}`,
    // Both figures, always. "base_backups=2" alone is the reading that made
    // this check report ok while recovery was impossible.
    `base_backups=${String(report.baseBackups.length)}`,
    `rollable=${String(report.baseBackups.filter(isRollableForward).length)}`,
  ];
  if (report.walPruned > 0) parts.push(`wal_pruned=${String(report.walPruned)}`);
  if (report.baseBackupTaken !== null) parts.push(`base_taken=${report.baseBackupTaken.directory}`);
  return parts.join(' ');
}
