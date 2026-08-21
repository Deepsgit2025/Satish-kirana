import pg from 'pg';

import { firstRow, readNullableText } from '../db/rows.js';
import { assertRestoredDatabase, failedAssertions, type Assertion } from './assertions.js';
import { runTool } from './commands.js';
import { verifyConnection, verifyToolEnv, type BackupConfig } from './config.js';
import { latestDumpWithManifest } from './dump.js';
import type { BackupManifest } from './manifest.js';

/**
 * Restoring the newest dump into a scratch database and asking whether it came
 * back.
 *
 * D22 states the reason in one line: a backup nobody has restored is not a
 * backup. Everything else here is about making that safe to run unattended.
 *
 * **It never touches the live database.** The dump and the manifest are files;
 * the assertions run inside the restored copy. The only connection to anything
 * else is the maintenance database, and the only statements sent there are
 * CREATE and DROP against a name that is not the live one.
 *
 * **Every connection opened here can be a different role from the one running
 * the job** - `BACKUP_VERIFY_PGUSER`, `docs/DECISIONS.md` D47. Everything in
 * this file is the elevated half of `backup:verify`: creating, restoring into,
 * reading and dropping a scratch database, which is what needs `CREATEDB`. The
 * other half - recording the run on the health panel - happens in the CLI,
 * against the live database, as whatever role the scheduled task runs as, and
 * wants nothing beyond an INSERT into `reconciliation_runs`.
 *
 * That split is the point. The role that runs billing keeps no elevated
 * attribute, and the role that can create databases is used by one weekly job
 * and owns nothing but databases it made and is about to delete.
 *
 * **What it will and will not drop.** The scratch database is created with a
 * marker comment. On the next run the marker is what permits the drop: no
 * marker, no drop, and the run fails instead. `BACKUP_VERIFY_DATABASE` is one
 * typo away from naming something real, and the consequence of that typo has to
 * be a refusal rather than a restore over the top of the shop's data.
 *
 * **`--exit-on-error` is not optional.** `pg_restore` defaults to carrying on
 * past errors and exiting 0. A verify that took that default would restore
 * three tables out of forty, assert what it could, and report success - which
 * is a worse outcome than having no verify, because it is evidence of the wrong
 * thing.
 *
 * `--single-transaction` is deliberately not used, even though it is tempting.
 * The point of this job is to rehearse the restore that will be run for real
 * one bad morning, and that one will be an ordinary `pg_restore`. A verify that
 * exercises a different code path from the recovery proves the wrong procedure.
 */

const MARKER = 'ssbazar restore-verify scratch database - dropped and recreated on every run';

export interface VerifyResult {
  readonly dumpPath: string;
  readonly manifest: BackupManifest;
  readonly assertions: readonly Assertion[];
  readonly restoreWarnings: string;
  readonly durationMs: number;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * `COMMENT ON DATABASE` takes no parameters - it is utility SQL, not a query -
 * so the marker has to be inlined. It is a constant defined in this file rather
 * than anything a caller supplies, and it is quoted anyway.
 */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function maintenanceDatabase(env: NodeJS.ProcessEnv): string {
  const configured = env.BACKUP_MAINTENANCE_DATABASE?.trim();
  return configured === undefined || configured === '' ? 'postgres' : configured;
}

/**
 * Drops the scratch database if it is ours, and creates it empty.
 *
 * Refuses outright when a database of that name exists without our marker.
 * `WITH (FORCE)` closes anything still connected - a psql window left open from
 * last week's investigation would otherwise block the drop and fail the job for
 * a reason that has nothing to do with the backup.
 */
async function recreateScratchDatabase(config: BackupConfig): Promise<void> {
  const client = new pg.Client({
    database: maintenanceDatabase(process.env),
    ...verifyConnection(config),
  });
  await client.connect();

  try {
    const { rows } = await client.query(
      `SELECT shobj_description(oid, 'pg_database') AS marker
         FROM pg_database WHERE datname = $1`,
      [config.verifyDatabase],
    );

    if (rows.length > 0) {
      const marker = readNullableText(firstRow(rows), 'marker');
      if (marker !== MARKER) {
        throw new Error(
          `${config.verifyDatabase} exists and was not created by restore-verify, so it will ` +
            'not be dropped. Point BACKUP_VERIFY_DATABASE at a scratch name, or remove that ' +
            'database by hand once you are sure what it is.',
        );
      }
      await client.query(`DROP DATABASE ${quoteIdentifier(config.verifyDatabase)} WITH (FORCE)`);
    }

    await client.query(`CREATE DATABASE ${quoteIdentifier(config.verifyDatabase)}`);
    await client.query(
      `COMMENT ON DATABASE ${quoteIdentifier(config.verifyDatabase)} IS ${quoteLiteral(MARKER)}`,
    );
  } finally {
    await client.end();
  }
}

async function dropScratchDatabase(config: BackupConfig): Promise<void> {
  const client = new pg.Client({
    database: maintenanceDatabase(process.env),
    ...verifyConnection(config),
  });
  await client.connect();

  try {
    await client.query(
      `DROP DATABASE IF EXISTS ${quoteIdentifier(config.verifyDatabase)} WITH (FORCE)`,
    );
  } finally {
    await client.end();
  }
}

/**
 * Restores the newest dump and runs every assertion against it.
 *
 * The scratch database is dropped afterwards however this ends, including when
 * an assertion fails - what a person needs in order to investigate is the dump
 * file and the failure list, both of which survive. Leaving a half-restored
 * database behind on the store server would be one more thing filling a disk
 * that a backup job is already competing for.
 */
export async function verifyLatestDump(config: BackupConfig): Promise<VerifyResult> {
  const startedAt = Date.now();
  const { dumpPath, manifest } = await latestDumpWithManifest(config);

  await recreateScratchDatabase(config);

  try {
    const { stderr } = await runTool(
      config,
      'pg_restore',
      [
        '--exit-on-error',
        '--no-owner',
        '--no-privileges',
        '--no-password',
        `--dbname=${config.verifyDatabase}`,
        dumpPath,
      ],
      { env: verifyToolEnv(config) },
    );

    const client = new pg.Client({ database: config.verifyDatabase, ...verifyConnection(config) });
    await client.connect();

    try {
      const assertions = await assertRestoredDatabase(client, manifest);
      return {
        dumpPath,
        manifest,
        assertions,
        restoreWarnings: stderr.trim(),
        durationMs: Date.now() - startedAt,
      };
    } finally {
      await client.end();
    }
  } finally {
    await dropScratchDatabase(config);
  }
}

export { failedAssertions };
