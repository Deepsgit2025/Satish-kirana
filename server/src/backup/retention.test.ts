import { describe, expect, it } from 'vitest';

import {
  backupStem,
  readBackupConfig,
  timestampFromName,
  verifyConnection,
  verifyToolEnv,
} from './config.js';
import { ageInHours, planRetention, planWalPrune, readDumpFiles } from './retention.js';
import { isRollableForward, type BaseBackup } from './wal.js';

/**
 * Retention, tested exhaustively because it is the only code in this project
 * that deletes the shop's data.
 *
 * All of it is pure - a list of filenames and an instant in, a list of
 * filenames out - which is the reason it was separated from the code that does
 * the unlinking. Every case below runs in microseconds and nothing is ever at
 * risk while they run.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function nameFor(daysAgo: number, now: Date): string {
  return `${backupStem('ssbazar', new Date(now.getTime() - daysAgo * DAY_MS))}.dump`;
}

describe('backup filenames', () => {
  it('round-trips an instant through the name, to the second', () => {
    const at = new Date('2026-08-21T18:30:00.000Z');
    expect(backupStem('ssbazar', at)).toBe('ssbazar-20260821T183000Z');
    expect(timestampFromName('ssbazar-20260821T183000Z.dump')?.toISOString()).toBe(
      at.toISOString(),
    );
  });

  it('reads the manifest name too, so the pair stays together', () => {
    expect(timestampFromName('ssbazar-20260821T183000Z.manifest.json')).not.toBeNull();
  });

  it('ignores anything that is not one of ours', () => {
    for (const name of [
      'notes.txt',
      'ssbazar.dump',
      'ssbazar-2026-08-21.dump',
      'ssbazar-20260821T183000Z.dump.tmp',
      '',
    ]) {
      expect(timestampFromName(name)).toBeNull();
    }
  });

  it('leaves a stray file out of the dump list rather than guessing at it', () => {
    const files = readDumpFiles([
      'ssbazar-20260821T183000Z.dump',
      'ssbazar-20260820T183000Z.dump',
      'ssbazar-20260821T183000Z.manifest.json',
      'README.txt',
      'partial-copy.dump',
    ]);

    expect(files.map((file) => file.filename)).toEqual([
      'ssbazar-20260821T183000Z.dump',
      'ssbazar-20260820T183000Z.dump',
    ]);
  });
});

describe('dump retention', () => {
  const now = new Date('2026-08-21T23:30:00.000Z');

  it('keeps the window and prunes what is behind it', () => {
    const dumps = readDumpFiles([1, 2, 3, 8, 9, 30].map((days) => nameFor(days, now)));
    const { keep, prune } = planRetention(dumps, now, 7);

    expect(keep.map((dump) => dump.filename)).toEqual([1, 2, 3].map((days) => nameFor(days, now)));
    expect(prune.map((dump) => dump.filename)).toEqual(
      [8, 9, 30].map((days) => nameFor(days, now)),
    );
  });

  it('never prunes the only dump there is, however old it is', () => {
    // The nightly job has been failing for a month. A retention pass that
    // measured only against the calendar would delete the last copy the shop
    // has, on a night when nothing is going to replace it.
    const dumps = readDumpFiles([nameFor(40, now)]);
    const { keep, prune } = planRetention(dumps, now, 7);

    expect(prune).toHaveLength(0);
    expect(keep).toHaveLength(1);
  });

  it('never prunes the newest even when every dump is expired', () => {
    const dumps = readDumpFiles([20, 25, 40].map((days) => nameFor(days, now)));
    const { keep, prune } = planRetention(dumps, now, 7);

    expect(keep.map((dump) => dump.filename)).toEqual([nameFor(20, now)]);
    expect(prune).toHaveLength(2);
  });

  it('does not lose a dump taken exactly on the boundary', () => {
    const dumps = readDumpFiles([nameFor(0, now), nameFor(7, now)]);
    const { prune } = planRetention(dumps, now, 7);
    expect(prune).toHaveLength(0);
  });

  it('reports the newest dump age, which is how a stale set is noticed', () => {
    const dumps = readDumpFiles([nameFor(2, now), nameFor(5, now)]);
    expect(ageInHours(dumps, now)).toBe(48);
    expect(ageInHours([], now)).toBeNull();
  });

  it('handles an empty directory without inventing a plan', () => {
    const { keep, prune } = planRetention([], now, 7);
    expect(keep).toHaveLength(0);
    expect(prune).toHaveLength(0);
  });
});

describe('WAL retention', () => {
  const segments = [
    '000000010000000000000001',
    '000000010000000000000002',
    '000000010000000000000003',
    '000000010000000000000004',
  ];

  it('prunes only what is behind the oldest base backup it must serve', () => {
    const { prune, kept } = planWalPrune(segments, '000000010000000000000003');

    expect(prune).toEqual(['000000010000000000000001', '000000010000000000000002']);
    expect(kept).toBe(2);
  });

  it('prunes nothing at all when there is no base backup to anchor the archive', () => {
    // Without a base backup, nothing in the archive is replayable and nothing
    // in it is safely deletable either. Keeping it and reporting the problem is
    // the only honest answer.
    const { prune, kept } = planWalPrune(segments, null);

    expect(prune).toHaveLength(0);
    expect(kept).toBe(segments.length);
  });

  it('keeps history and label files, whatever the cutoff', () => {
    const entries = [
      ...segments,
      '00000002.history',
      '000000010000000000000001.00000028.backup',
      '000000010000000000000002.partial',
    ];
    const { prune } = planWalPrune(entries, '000000010000000000000004');

    expect(prune).toEqual([
      '000000010000000000000001',
      '000000010000000000000002',
      '000000010000000000000003',
    ]);
  });

  it('refuses a cutoff that is not a segment name rather than guessing', () => {
    expect(planWalPrune(segments, 'latest').prune).toHaveLength(0);
  });

  it('sorts a timeline switch the way Postgres writes it', () => {
    // The timeline is the high-order part of the name, so a segment on
    // timeline 2 is never behind one on timeline 1.
    const across = ['000000010000000000000009', '000000020000000000000001'];
    expect(planWalPrune(across, '000000020000000000000001').prune).toEqual([
      '000000010000000000000009',
    ]);
  });
});

describe('backup configuration', () => {
  it('lays the three directories out under one root', () => {
    const config = readBackupConfig({
      BACKUP_LOCAL_DIR: '/var/backups/ssbazar',
      PGDATABASE: 'ssbazar',
    });

    expect(config.dumpDir.endsWith('dumps')).toBe(true);
    expect(config.baseDir.endsWith('base')).toBe(true);
    expect(config.walDir.endsWith('wal')).toBe(true);
    expect(config.retentionDays).toBe(7);
    expect(config.verifyDatabase).toBe('ssbazar_verify');
  });

  it('refuses to point restore-verify at the live database', () => {
    // The verify drops and recreates whatever it is given. One typo away from
    // the shop's data, so the typo has to be a refusal.
    expect(() =>
      readBackupConfig({ PGDATABASE: 'ssbazar', BACKUP_VERIFY_DATABASE: 'ssbazar' }),
    ).toThrow(/live database/);
  });

  it('refuses a retention window that is not a positive number of days', () => {
    for (const value of ['0', '-3', 'seven', '1.5']) {
      expect(() =>
        readBackupConfig({ PGDATABASE: 'ssbazar', BACKUP_RETENTION_DAYS: value }),
      ).toThrow(/BACKUP_RETENTION_DAYS/);
    }
  });

  it('treats a blank setting as unset, for every setting', () => {
    // `.env.example` documents "leave this to the default" as a name with
    // nothing after the `=`, which arrives as '' rather than undefined - and
    // `'' ?? fallback` is ''. That reached CREATE DATABASE as an empty
    // identifier on the first real run of backup:verify, and the operator got
    // `zero-length delimited identifier`, which names no setting at all.
    const blank = readBackupConfig({
      PGDATABASE: 'ssbazar',
      BACKUP_LOCAL_DIR: '',
      BACKUP_RETENTION_DAYS: '',
      BACKUP_BASE_EVERY_DAYS: '',
      BACKUP_VERIFY_DATABASE: '',
      PG_BIN_DIR: '',
    });
    const unset = readBackupConfig({ PGDATABASE: 'ssbazar' });

    expect(blank).toEqual(unset);
    expect(blank.retentionDays).toBe(7);
    expect(blank.baseBackupEveryDays).toBe(7);
    expect(blank.verifyDatabase).toBe('ssbazar_verify');
    expect(blank.binDir).toBeNull();
  });

  it('still names the live database in the guard when the scratch name is left blank', () => {
    // The default is derived from PGDATABASE, so it can never collide - but the
    // guard has to be reached with a real name rather than an empty one.
    expect(
      readBackupConfig({ PGDATABASE: 'ssbazar', BACKUP_VERIFY_DATABASE: '  ' }).verifyDatabase,
    ).toBe('ssbazar_verify');
  });
});

describe('the restore-verify role', () => {
  // docs/DECISIONS.md D47: CREATEDB lives on a dedicated backup role, not on
  // the role that runs billing. These settings are how the elevated half of
  // backup:verify reaches that role while the run is still recorded on the
  // health panel as whoever ran the job.
  it('falls back to the ambient PGUSER when no separate role is configured', () => {
    const config = readBackupConfig({ PGDATABASE: 'ssbazar' });

    expect(config.verifyUser).toBeNull();
    expect(config.verifyPassword).toBeNull();

    // Empty, so `pg` and the child process both read PG* exactly as every other
    // connection in this codebase does. A development machine needs no split.
    expect(verifyConnection(config)).toEqual({});
    expect(verifyToolEnv(config)).toEqual({});
  });

  it('hands the role to both the driver and the child process', () => {
    const config = readBackupConfig({
      PGDATABASE: 'ssbazar',
      BACKUP_VERIFY_PGUSER: 'ssbazar_backup',
      BACKUP_VERIFY_PGPASSWORD: 'secret',
    });

    expect(verifyConnection(config)).toEqual({ user: 'ssbazar_backup', password: 'secret' });
    // pg_restore takes credentials through the environment, never through an
    // argument - arguments are visible in the process list and environments
    // are not.
    expect(verifyToolEnv(config)).toEqual({ PGUSER: 'ssbazar_backup', PGPASSWORD: 'secret' });
  });

  it('allows a role with no password, for trust or peer authentication', () => {
    const config = readBackupConfig({
      PGDATABASE: 'ssbazar',
      BACKUP_VERIFY_PGUSER: 'ssbazar_backup',
    });

    expect(verifyConnection(config)).toEqual({ user: 'ssbazar_backup' });
    expect(verifyToolEnv(config)).toEqual({ PGUSER: 'ssbazar_backup' });
  });

  it('refuses a password with no role rather than silently ignoring it', () => {
    // The dangerous shape: the connection succeeds as the ambient PGUSER, the
    // verify passes, and the separation D47 asked for is simply absent with
    // nothing anywhere saying so.
    expect(() =>
      readBackupConfig({ PGDATABASE: 'ssbazar', BACKUP_VERIFY_PGPASSWORD: 'secret' }),
    ).toThrow(/BACKUP_VERIFY_PGUSER is not/);
  });
});

describe('a base backup that can be rolled forward', () => {
  // The distinction that made wal_archive report `ok` while point-in-time
  // recovery was impossible: archiving was on, a base backup existed, the
  // archiver had never failed - and the backup predated archiving, so the WAL
  // between the two was never written anywhere (docs/DECISIONS.md D46).
  function baseBackup(archiveModeAtBackup: string | null): BaseBackup {
    return {
      directory: 'base-20260821T040657Z',
      takenAt: new Date('2026-08-21T04:06:57Z'),
      startWal: '000000010000000000000008',
      sizeBytes: 5174667,
      archiveModeAtBackup,
    };
  }

  it('accepts a backup taken while archiving was running', () => {
    expect(isRollableForward(baseBackup('on'))).toBe(true);
    expect(isRollableForward(baseBackup('always'))).toBe(true);
  });

  it('rejects one taken while archiving was off', () => {
    expect(isRollableForward(baseBackup('off'))).toBe(false);
  });

  it('rejects one whose sidecar does not say', () => {
    // Written before this was recorded. Unknown is not the same as fine, and
    // treating it as fine is the exact mistake being guarded against - it
    // self-clears the next time a base backup is taken.
    expect(isRollableForward(baseBackup(null))).toBe(false);
  });
});
