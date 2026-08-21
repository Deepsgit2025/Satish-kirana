import { timestampFromName } from './config.js';

/**
 * Which dumps to keep and which to delete.
 *
 * Pure, and separated from the code that does the deleting, because this is the
 * part that can destroy the only copy of the shop's data. It gets to be a
 * function of a list of names and an instant, with tests that run in
 * milliseconds and never touch a disk.
 *
 * Two rules, and the second is the one that matters:
 *
 *   **Expired means older than the retention window**, measured from the
 *   timestamp in the filename.
 *
 *   **The newest dump is never expired**, however old it is. If the nightly job
 *   has been failing for a fortnight, every dump on the disk is outside a
 *   7-day window and a naive prune would delete all of them — turning a
 *   backup job that stopped into a shop with no backups at all, on the same
 *   night, without anybody doing anything. Retention exists to remove what is
 *   redundant. Nothing that is the last copy is redundant.
 *
 * A stale newest dump is not swallowed either: `expiredBefore` leaves it in
 * `keep`, and the caller reports its age as outstanding drift.
 */

export interface DumpFile {
  readonly filename: string;
  readonly takenAt: Date;
}

export interface RetentionPlan {
  /** Newest first, so `keep[0]` is the dump restore-verify will read. */
  readonly keep: readonly DumpFile[];
  readonly prune: readonly DumpFile[];
}

/** Parses the dump names out of a directory listing, newest first. */
export function readDumpFiles(filenames: readonly string[]): DumpFile[] {
  return filenames
    .filter((filename) => filename.endsWith('.dump'))
    .flatMap((filename) => {
      const takenAt = timestampFromName(filename);
      return takenAt === null ? [] : [{ filename, takenAt }];
    })
    .sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime());
}

export function planRetention(
  dumps: readonly DumpFile[],
  now: Date,
  retentionDays: number,
): RetentionPlan {
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  const ordered = [...dumps].sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime());

  const keep: DumpFile[] = [];
  const prune: DumpFile[] = [];

  for (const [index, dump] of ordered.entries()) {
    // index 0 is the newest. It is kept unconditionally — see above.
    if (index === 0 || dump.takenAt.getTime() >= cutoff) keep.push(dump);
    else prune.push(dump);
  }

  return { keep, prune };
}

/** How many whole hours old the newest dump is, or null when there is none. */
export function ageInHours(dumps: readonly DumpFile[], now: Date): number | null {
  const [newest] = [...dumps].sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime());
  if (newest === undefined) return null;
  return Math.floor((now.getTime() - newest.takenAt.getTime()) / (60 * 60 * 1000));
}

/**
 * WAL segment names are 24 hex digits — timeline, then log, then segment — and
 * they sort lexicographically in the order Postgres writes them. That is what
 * makes "delete everything before this one" a string comparison.
 */
const WAL_SEGMENT = /^[0-9A-F]{24}$/;

export interface WalPrunePlan {
  readonly prune: readonly string[];
  readonly kept: number;
}

/**
 * Which archived WAL segments are no longer needed.
 *
 * `oldestNeeded` is the segment the oldest base backup we are still keeping
 * starts from. Everything before it can only replay onto a base backup we have
 * already deleted, so it recovers nothing.
 *
 * Three things are never pruned, and each has cost somebody a recovery
 * somewhere:
 *
 *   **Anything when `oldestNeeded` is null.** No base backup means no way to
 *   know what is needed, and the safe answer to that is to keep everything and
 *   let the check report a growing archive. A WAL archive that pruned itself on
 *   a schedule with nothing to anchor it would be deleting the only copy of
 *   every transaction since the last dump.
 *
 *   **`.history` files.** Bytes each, and without them a recovery cannot follow
 *   a timeline switch — which is exactly the situation a recovery is in.
 *
 *   **Anything that is not a plain segment name.** `.backup` labels, `.partial`
 *   files, and whatever a future Postgres adds. If this function does not
 *   recognise it, it does not delete it.
 */
export function planWalPrune(
  entries: readonly string[],
  oldestNeeded: string | null,
): WalPrunePlan {
  if (oldestNeeded === null || !WAL_SEGMENT.test(oldestNeeded)) {
    return { prune: [], kept: entries.length };
  }

  const prune = entries.filter((name) => WAL_SEGMENT.test(name) && name < oldestNeeded);
  return { prune, kept: entries.length - prune.length };
}
