import type { Queryable } from '../db/queryable.js';
import { runAndRecordCheck, type CheckOutcome } from '../reconciliation/health.js';
import { describeFailures, failedAssertions } from './assertions.js';
import type { BackupConfig } from './config.js';
import { inspectDumpSet, pruneDumps, takeDump } from './dump.js';
import { verifyLatestDump } from './verify.js';
import { runArchiveMaintenance, summariseArchive } from './wal.js';

/**
 * The three backup jobs, as checks on the one health surface - docs/
 * DECISIONS.md D30.
 *
 * There is no second mechanism here. No log file to tail, no email, no red
 * banner that appears on the day something breaks. Each job does its work and
 * writes one row to `reconciliation_runs`, the same table the tax cache and
 * stock drift checks write to, read through the same `reconciliation_health`
 * view, and printed by the same `db:reconcile` summary. A backup that stopped a
 * fortnight ago reads as `overdue` in the same column as a cache that stopped
 * being refreshed, because it is the same column.
 *
 * That is the whole point of D30 and it is worth being blunt about why: backup
 * status is the single most tempting thing in a system to give its own special
 * display, and a system with four places to look at is a system where nobody
 * looks anywhere.
 *
 * **`detail` carries the good news too.** The other checks leave it null when
 * clean, because "no drift" is the whole of what there is to say. A backup has
 * more: which file, how large, how many kept. That is what somebody reads at
 * six in the morning to decide whether last night is recoverable, and it is
 * what the diagnostics bundle will pick up when it needs the last successful
 * backup time.
 */

export const LOCAL_BACKUP_CHECK = 'local_backup';
export const WAL_ARCHIVE_CHECK = 'wal_archive';
export const RESTORE_VERIFY_CHECK = 'backup_restore_verify';

export type BackupOutcome = CheckOutcome;

/** How many problems a `detail` string names before it says "and N more". */
const DETAIL_SAMPLE = 3;

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function summariseProblems(problems: readonly string[]): string {
  const shown = problems.slice(0, DETAIL_SAMPLE);
  if (problems.length > DETAIL_SAMPLE) {
    shown.push(`and ${String(problems.length - DETAIL_SAMPLE)} more`);
  }
  return shown.join('; ');
}

/**
 * Takes the nightly dump, prunes what has expired, and reports on the directory
 * that is left.
 *
 * The dump is taken before anything is pruned, always. Pruning first would, on
 * the night `pg_dump` fails, delete a copy the shop still needs in order to
 * make room for one that never arrives.
 */
export async function runLocalBackupCheck(
  db: Queryable,
  config: BackupConfig,
  now: Date,
): Promise<BackupOutcome> {
  return runAndRecordCheck(db, LOCAL_BACKUP_CHECK, async () => {
    const dump = await takeDump(config);
    const pruned = await pruneDumps(config, now);
    const set = await inspectDumpSet(config, now);

    const summary =
      `${dump.manifest.dumpFile} ${megabytes(dump.sizeBytes)}, ` +
      `${String(dump.tocEntries)} archive entries, ${String(dump.durationMs)} ms; ` +
      `${String(set.dumps.length)} dumps kept (${megabytes(set.totalBytes)})` +
      (pruned > 0 ? `, ${String(pruned)} pruned` : '');

    return {
      outstanding: set.problems.length,
      // Pruning an expired dump is the job running normally, not drift being
      // repaired. See 010_backup_health.sql on why `corrects` is false here.
      corrected: 0,
      detail:
        set.problems.length === 0
          ? summary
          : `${summary} - ${summariseProblems(set.problems.map((problem) => problem.what))}`,
    };
  });
}

/**
 * Checks WAL archiving, takes a base backup when one is due, and prunes the
 * archive against the oldest base backup still kept.
 */
export async function runWalArchiveCheck(
  db: Queryable,
  config: BackupConfig,
  now: Date,
): Promise<BackupOutcome> {
  return runAndRecordCheck(db, WAL_ARCHIVE_CHECK, async () => {
    const report = await runArchiveMaintenance(db, config, now);
    const summary = summariseArchive(report);

    return {
      outstanding: report.problems.length,
      corrected: 0,
      detail:
        report.problems.length === 0
          ? summary
          : `${summary} - ${summariseProblems(report.problems)}`,
    };
  });
}

/**
 * Restores the newest dump into a scratch database and asserts it against the
 * manifest written beside it.
 *
 * Reports only. A dump that fails to restore is left exactly where it is: there
 * is nothing to correct, and the file is the evidence.
 */
export async function runRestoreVerifyCheck(
  db: Queryable,
  config: BackupConfig,
): Promise<BackupOutcome> {
  return runAndRecordCheck(db, RESTORE_VERIFY_CHECK, async () => {
    const result = await verifyLatestDump(config);
    const failures = failedAssertions(result.assertions);

    const summary =
      `${result.manifest.dumpFile} restored into ${config.verifyDatabase}, ` +
      `${String(result.assertions.length - failures.length)}/${String(result.assertions.length)} ` +
      `assertions passed, ${String(result.durationMs)} ms`;

    // pg_restore warns on stderr and still exits 0. A version mismatch is a
    // warning today and an unrestorable archive in two years, so it goes in the
    // detail rather than into a stream nobody read.
    const warnings = result.restoreWarnings === '' ? '' : ` [${result.restoreWarnings}]`;

    return {
      outstanding: failures.length,
      corrected: 0,
      detail:
        failures.length === 0
          ? `${summary}${warnings}`
          : `${summary}${warnings} - ${describeFailures(result.assertions)}`,
    };
  });
}

/**
 * The nightly pair. Both run even when the first reports trouble: a panel with
 * one of two backup rows filled in is worse than a panel with two bad ones,
 * because the row that did not report looks like a row that passed.
 */
export async function runNightlyBackup(
  db: Queryable,
  config: BackupConfig,
  now: Date,
): Promise<BackupOutcome[]> {
  return [await runLocalBackupCheck(db, config, now), await runWalArchiveCheck(db, config, now)];
}
