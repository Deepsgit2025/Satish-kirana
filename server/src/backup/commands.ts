import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import type { BackupConfig } from './config.js';

/**
 * Running `pg_dump`, `pg_restore`, `psql` and `pg_basebackup`.
 *
 * These are the only four places this system leaves the database driver and
 * uses a program instead, and there is no alternative: a logical dump is
 * `pg_dump`'s file format, and reimplementing it against `pg` would be
 * reimplementing the one thing that has to be right when everything else has
 * gone wrong.
 *
 * Three deliberate choices about how they are invoked.
 *
 * **`execFile`, never a shell.** Arguments go across as an array. A database
 * name with a space in it, a path under `C:\Program Files`, a password with a
 * quote in it — none of them can turn into an extra argument or a second
 * command. There is no string being parsed, so there is nothing to escape.
 *
 * **The password never appears in an argument.** It goes in the child's
 * environment as `PGPASSWORD`, because arguments are visible to every process
 * on the machine through the process list and environments are not. The rest of
 * the connection settings are inherited: `PGHOST`, `PGPORT`, `PGUSER` and
 * `PGDATABASE` are already in the environment these CLIs run in.
 *
 * **stderr is kept even on success.** `pg_dump` warns on stderr and exits 0;
 * "server version mismatch" is a warning today and a corrupt restore in two
 * years, and it belongs in the run detail rather than in a stream nobody read.
 */

const run = promisify(execFile);

/** A dump of a shop this size is megabytes; a restore's chatter is not much more. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export class CommandError extends Error {
  readonly command: string;
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(command: string, exitCode: number | null, stderr: string) {
    const reason = stderr.trim() === '' ? `exit ${String(exitCode ?? -1)}` : stderr.trim();
    super(`${command}: ${reason}`);
    this.name = 'CommandError';
    this.command = command;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Resolves a Postgres binary. `PG_BIN_DIR` wins over `PATH`, because a
 * scheduled task's `PATH` is not the installer's.
 */
export function toolPath(config: BackupConfig, tool: string): string {
  return config.binDir === null ? tool : path.join(config.binDir, tool);
}

export async function runTool(
  config: BackupConfig,
  tool: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
  const file = toolPath(config, tool);

  try {
    const { stdout, stderr } = await run(file, [...args], {
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      // Overrides layer on top of the inherited environment rather than
      // replacing it: `pg_restore` still needs PGHOST and PGPORT, and only the
      // credentials differ when restore-verify runs as its own role
      // (docs/DECISIONS.md D47).
      env: { ...process.env, ...options.env },
    });
    return { stdout, stderr };
  } catch (error) {
    const failure = error as { code?: unknown; stderr?: unknown; message?: unknown };
    const exitCode = typeof failure.code === 'number' ? failure.code : null;
    const stderr =
      typeof failure.stderr === 'string'
        ? failure.stderr
        : typeof failure.message === 'string'
          ? failure.message
          : '';

    throw new CommandError(tool, exitCode, stderr);
  }
}
