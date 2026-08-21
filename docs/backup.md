# Local backup

Three jobs, one health panel. Nightly logical dumps with 7-day retention, a WAL archive anchored
by a periodic base backup, and a restore that is actually performed rather than assumed.

Everything reports to `reconciliation_health` — the same surface as the tax cache and stock drift
checks (`docs/DECISIONS.md` D30). There is no backup log, no backup email and no backup banner.
If you want to know whether last night worked, you look where you look for everything else.

---

## The two kinds of backup, and why both

They are not redundant and neither replaces the other.

**The nightly `pg_dump`** is a *logical* backup — a description of the data. It restores into a
fresh database on any compatible Postgres, it is the thing `backup:verify` proves weekly, and it
is what you reach for when the answer is "put yesterday back". Its cost is the window: everything
between the dump and the failure is gone.

**WAL archiving plus a base backup** is *physical* recovery. `pg_basebackup` takes a byte-level
copy of the cluster, and the archived WAL segments replay on top of it to any instant after it.
That is what turns "we lost today's trading" into "we lost the last few minutes".

**Archived WAL cannot be replayed onto a restored `pg_dump`.** A logical restore produces a new
cluster with its own timeline; the archive belongs to the old one. So WAL archiving without a
base backup fills a disk and recovers nothing — see `docs/DECISIONS.md` D46. The `wal_archive`
check reports a missing base backup as a fault for exactly this reason.

---

## Layout

`BACKUP_LOCAL_DIR` (see `.env.example`) holds three directories:

```
<BACKUP_LOCAL_DIR>/
  dumps/   ssbazar-20260821T032721Z.dump           pg_dump --format=custom, compressed
           ssbazar-20260821T032721Z.manifest.json  what was true when it was taken
  base/    base-20260821T032721Z/                  pg_basebackup output, gzipped tar
           base-20260821T032721Z.json              start WAL segment, for pruning
  wal/     000000010000000000000007                archived segments
```

The timestamp in a filename is UTC and is the **only** thing retention reads. Not the mtime:
copying a backup directory to a USB drive rewrites every mtime, and retention that trusted it
would treat a week of history as having all arrived at once.

### Retention

- Dumps older than `BACKUP_RETENTION_DAYS` (7) are pruned, **except the newest, which never is**.
  If the nightly job has been failing for a fortnight, every dump on disk is outside the window
  and a plain calendar rule would delete the last copy the shop has on a night when nothing is
  going to replace it. Retention removes what is redundant; nothing that is the last copy is.
- Base backups: the newest two are kept. Two rather than one because while a new one is being
  written the previous is the only complete copy.
- WAL is pruned against the **oldest base backup still kept**, never against the calendar. With
  no base backup, nothing is pruned at all — there is no way to know what is needed, and the
  safe answer to that is to keep everything and report it.

---

## The three checks

| Check | Runs | Reports |
|---|---|---|
| `local_backup` | nightly | the dump was taken, is readable, and the directory is sound |
| `wal_archive` | nightly | archiving is on and keeping up, and a base backup anchors it |
| `backup_restore_verify` | weekly | the newest dump restores and the assertions hold |

Read the status like this:

- **`failed`** — the check could not complete. `pg_dump` exited non-zero, the scratch database
  would not restore, the directory is unwritable. **The state of the backups is unknown.**
- **`drift`** — the check ran and what it looked at is wrong. `outstanding` counts the problems.
- **`overdue` / `never_run`** — nothing is running it. As serious as either of the above: a check
  nobody runs is indistinguishable from a check that always passes, right up until it matters.

---

## Setting it up

**Create the `ssbazar_backup` role first, before any backup job is run on this machine** (D47) —
the development machine had no superuser available to create it, so both attributes ended up on
the application role there, and that shortcut must not be repeated on the shop's server.

Then WAL archiving, then scheduling, in that order: archiving has to be in force before the first
base backup is taken, or that backup cannot be rolled forward (D48).

### 1. The backup role

Two attributes are needed that no role has by default: `CREATEDB`, so `backup:verify` can build
and drop its scratch database, and `REPLICATION`, so `pg_basebackup` can open a replication
connection.

**Create a role for them. Do not grant them to `ssbazar_app`** (`docs/DECISIONS.md` D47). The
role that runs billing carries no elevated attribute at all.

```sql
-- as a superuser, on the store server
CREATE ROLE ssbazar_backup LOGIN PASSWORD '<choose one>' CREATEDB REPLICATION;

-- pg_dump must be able to read every table, including ones added by later migrations
GRANT pg_read_all_data TO ssbazar_backup;

-- and the jobs record their runs on the health panel like every other check
GRANT INSERT ON reconciliation_runs TO ssbazar_backup;
GRANT USAGE, SELECT ON SEQUENCE reconciliation_runs_id_seq TO ssbazar_backup;
GRANT SELECT ON reconciliation_checks, reconciliation_health TO ssbazar_backup;
```

`pg_hba.conf` needs a replication line for it, or `pg_basebackup` is refused before it starts:

```
host    replication     ssbazar_backup    127.0.0.1/32    scram-sha-256
```

The privilege this hands over is smaller than it reads. The shop's database is owned by
`postgres`, and `DROP DATABASE` requires ownership or superuser — so `CREATEDB` confers **no**
ability to drop it. The grant is precisely: may create databases, and may drop the ones it
created. The realistic worst case is disk exhaustion, not data loss.

#### Two ways to use it

**Run the scheduled tasks as `ssbazar_backup`** — set `PGUSER` and `PGPASSWORD` in the task's own
environment. Simplest, and the grants above are exactly what it needs.

**Or keep the tasks on the application role and elevate only the verify.** `backup:verify` opens
two different kinds of connection and only one of them needs a privilege: it records its run on
the health panel against the live database, and it creates, restores into, reads and drops the
scratch database. `BACKUP_VERIFY_PGUSER` and `BACKUP_VERIFY_PGPASSWORD` point the second kind at
the backup role while the first stays as whoever ran the job:

```
BACKUP_VERIFY_PGUSER=ssbazar_backup
BACKUP_VERIFY_PGPASSWORD=<the password above>
```

With those set, `ssbazar_backup` needs neither the `reconciliation_*` grants nor
`pg_read_all_data` — it only ever touches databases it made and is about to delete. `backup:run`
still needs the role for `pg_basebackup`, so this shape suits a machine where the weekly verify
and the nightly backup are scheduled differently.

Setting the password without the user is refused rather than ignored: the connection would
otherwise succeed as `PGUSER`, the verify would pass, and the separation would silently not be
there.

On a development machine where none of this separation is worth the trouble, the two attributes
on the application role work identically:

```sql
ALTER ROLE ssbazar_app CREATEDB;
ALTER ROLE ssbazar_app REPLICATION;
```

### 2. WAL archiving

Windows — appended to `postgresql.conf` (the file takes the **last** setting of a name, so an
appended block wins over the commented defaults and is removed by deleting it):

```
wal_level = replica
archive_mode = on
archive_command = 'if not exist "C:\\ProgramData\\ssbazar\\backups\\wal\\%f" (copy "%p" "C:\\ProgramData\\ssbazar\\backups\\wal\\%f") else (exit /b 1)'
archive_timeout = 300
```

Linux store server:

```
wal_level = replica
archive_mode = on
archive_command = 'test ! -f /var/backups/ssbazar/wal/%f && cp %p /var/backups/ssbazar/wal/%f'
archive_timeout = 300
```

Three things about that command:

- **It refuses to overwrite** and returns non-zero instead. A jammed archive is visible —
  `pg_stat_archiver.failed_count` rises, `wal_archive` reports it, WAL accumulates in `pg_wal`
  where somebody notices. A silent overwrite corrupts the archive quietly, which is worse.
- **It runs as the Postgres service account**, not as whoever installed the system. On Windows
  that is `NT AUTHORITY\NetworkService`, which is why the archive directory belongs under
  `C:\ProgramData` with an explicit grant rather than in a user profile:
  `icacls C:\ProgramData\ssbazar\backups /grant "NETWORK SERVICE":(OI)(CI)M /T`
- **`copy` and `cp` do not fsync.** A power cut in the instant between the copy returning and the
  filesystem flushing can leave a truncated segment. Accepted here; the base backup is the
  belt to this brace.

`archive_mode` **requires a restart**, not a reload. `archive_command` and `archive_timeout` take
a reload. Restart the service, then confirm:

```sql
SELECT pg_postmaster_start_time(), current_setting('archive_mode');
SELECT * FROM pg_stat_archiver;
```

`pg_postmaster_start_time()` is the one worth checking rather than assuming. A restart that did
not happen looks exactly like one that did until you read it.

Then force a segment through, so the archive is proven rather than configured:

```sql
SELECT pg_switch_wal();     -- superuser; otherwise write ~16 MB, or wait out archive_timeout
SELECT archived_count, last_archived_wal, failed_count FROM pg_stat_archiver;
```

A file should appear in `wal/`. `pg_waldump -p <wal dir> <segment>` proves it is replayable WAL
rather than a file of the right size.

**Take a base backup after this, not before.** A base backup taken while archiving was off can
never be rolled forward: the segments between it and the moment archiving started were not
archived and do not exist. `wal_archive` records the `archive_mode` in force when each base
backup was taken, reports `rollable=` beside `base_backups=`, and takes a fresh one immediately
when nothing it holds can be rolled forward (`docs/DECISIONS.md` D48).

### 3. Scheduling

`app_settings.backup_time` is 23:30 — after close. Nothing reads that value automatically; it is
the number to put in the scheduler.

Windows, as an administrator:

```
schtasks /Create /TN "ssbazar nightly backup" /TR "cmd /c cd /d C:\path\to\repo && npm run backup:run" /SC DAILY /ST 23:30 /RU SYSTEM
schtasks /Create /TN "ssbazar restore verify"  /TR "cmd /c cd /d C:\path\to\repo && npm run backup:verify" /SC WEEKLY /D SUN /ST 02:00 /RU SYSTEM
```

Linux:

```cron
30 23 * * *  cd /opt/ssbazar && npm run backup:run
 0  2 * * 0  cd /opt/ssbazar && npm run backup:verify
```

**Set `PG_BIN_DIR`.** A scheduled task's `PATH` is not the one the installer typed into, and the
failure surfaces at 23:30 as "pg_dump is not recognised" with nobody watching.

---

## Running by hand

```bash
npm run backup:run       # dump + prune + WAL maintenance
npm run backup:verify    # restore the newest dump and assert it
npm run db:reconcile     # the data checks, and it names anything that has gone quiet
```

All three exit 1 on trouble and print in `--lang=hi` as well as English.

---

## What restore-verify actually proves

It restores the newest dump into `BACKUP_VERIFY_DATABASE` and asserts it against the manifest
written beside the dump — **never against the live database**. The dump is from last night and
the shop has been trading since; comparing against live would report a difference every day,
and a check that cries wolf daily is a check nobody reads within a week. Comparing against the
manifest asks the only question with a right answer: *did this file come back as what went into
it?*

The manifest is captured inside the dump's own snapshot (`pg_export_snapshot` handed to
`pg_dump --snapshot`), so the counts and the file cannot disagree about a bill rung between them.

The assertions:

| Name | What it catches |
|---|---|
| `migrations` | the dump came from the wrong database, or the wrong schema version |
| `tables` | a table missing from the restore entirely |
| `rows:<schema>.<table>` | a row count that came back short, per table |
| `stock:drift` | `stock_on_hand` against the sum of `stock_ledger`, inside the restore — the `stock_on_hand_drift` view, the check proved by the rebuild test (CLAUDE.md invariant 22) |
| `stock:total_qty` | exact NUMERIC comparison of the ledger's sum, as text, never as a float |
| `stock:max_recorded_at` | **that the restore did not run the triggers.** `stamp_recorded_at` overwrites `recorded_at` with `now()` on every INSERT; a data-only restore fires it and silently stamps today over the whole history while every row count still matches |
| `sequence:<name>` | a sequence that came back below `max(id)`, which would issue ids that already exist |

The scratch database is created with a marker comment and **will not be dropped without it**.
`BACKUP_VERIFY_DATABASE` is one typo away from naming something real, and the consequence of that
typo has to be a refusal rather than a restore over the top of the shop's data.

---

## Restoring for real

The procedure this rehearses. Read it before you need it.

**From the nightly dump — "put yesterday back":**

```bash
# 1. Stop the applications. Nothing should be writing.
# 2. Rename the damaged database rather than dropping it; it is evidence.
psql -d postgres -c 'ALTER DATABASE ssbazar RENAME TO ssbazar_damaged_20260821'
psql -d postgres -c 'CREATE DATABASE ssbazar'

# 3. Restore. --exit-on-error is not optional: pg_restore's default is to carry
#    on past errors and exit 0, which would leave you with a partial database
#    and a success message.
pg_restore --exit-on-error --no-owner --no-privileges \
  --dbname=ssbazar "<BACKUP_LOCAL_DIR>/dumps/ssbazar-<stamp>.dump"

# 4. Confirm before letting anyone bill against it.
npm run db:reconcile
```

**Point-in-time, from the base backup and WAL** — when the loss since last night matters:

```bash
# 1. Stop Postgres. Move the data directory aside; do not delete it.
# 2. Unpack the newest base/base-<stamp>/base.tar.gz into the empty data directory.
# 3. In postgresql.conf:
#      restore_command = 'copy "<BACKUP_LOCAL_DIR>\\wal\\%f" "%p"'   # Windows
#      recovery_target_time = '2026-08-21 18:02:00+05:30'
# 4. Create an empty file named recovery.signal in the data directory.
# 5. Start Postgres. It replays and pauses at the target.
# 6. Check the data is what you expect, then: SELECT pg_wal_replay_resume();
```

Choosing a target time is the hard part and it is a decision, not a lookup. `occurred_at` and
`recorded_at` on `stock_ledger` are what tell you when the shop thought something happened versus
when the server saw it (CLAUDE.md invariant 11), and an hour's difference between them is a real
figure on a real document.

---

## Troubleshooting

**A green panel is a claim about a conclusion, not about the facts underneath it — check that
each fact still means what it appears to mean, because they can all be true and still compose
into a wrong answer.** That is not an abstraction: `wal_archive` once reported `ok` with archiving
on, a base backup present and no archiver failures, for a pairing that could not recover a single
transaction, because the base backup predated archiving and the WAL between them was never
written anywhere (D48).

| Symptom | What it usually is |
|---|---|
| `archive_mode` still `off` after restarting | The service was not actually restarted. `pg_postmaster_start_time()` says whether it was; a restart that did not happen looks exactly like one that did. `archive_mode` needs a restart, not a reload. |
| `wal_archive` says `rollable=0` | Every base backup being kept predates archiving. The next run takes a fresh one automatically; nothing needs doing by hand (D48). |
| `pg_wal` growing, `failed_count` climbing | The archive command is failing and Postgres is retrying the same segment rather than skipping it. Usually the service account cannot write to `wal/` — on Windows it runs as `NT AUTHORITY\NetworkService`, not as whoever installed this. |
| `pg_dump is not recognised` at 23:30 | A scheduled task's `PATH` is not the installer's. Set `PG_BIN_DIR`. |
| `zero-length delimited identifier` | A setting is blank where a name was expected. Blank and unset mean the same thing to every `BACKUP_*` variable; if one gets through to SQL, it names the wrong setting badly — check `BACKUP_VERIFY_DATABASE` first. |
| Verify refuses to drop the scratch database | It exists without the marker comment restore-verify puts on the databases it creates, so it was made by someone else. Confirm what it is before removing it by hand — the refusal is the guard against `BACKUP_VERIFY_DATABASE` naming something real. |
| `backup_restore_verify` says `failed`, not `drift` | The check could not complete, so the state of the backups is **unknown** — different from the check having run and found the backup wanting. Read the detail; it carries the error. |

## Related

- `docs/DECISIONS.md` D21 — the cloud vault this local layer feeds, and its tiered retention
- `docs/DECISIONS.md` D22 — monthly automated restore verification against the cloud copy
- `docs/DECISIONS.md` D30 — why all of this reports to one panel
- `docs/DECISIONS.md` D46 — why WAL archiving needs a base backup to mean anything
- `docs/DECISIONS.md` D47 — scratch database over a throwaway cluster, and where the privilege lives
- `docs/DECISIONS.md` D48 — why a base backup must post-date archiving to be worth anything
- `server/migrations/010_backup_health.sql` — the check registry
