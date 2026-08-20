/**
 * Reading a person's language out of the database.
 *
 * The chain itself - preference, then store default, then English - lives in
 * `@ssbazar/shared` so the counter and the office resolve it identically from
 * their own caches. This module is only the two queries, and the rule about
 * what to do when they cannot be run.
 *
 * That rule matters more than it looks. Every consumer here is offline-first:
 * a counter bills through a server outage, and `db:migrate` prints its
 * friendliest message - "could not reach Postgres" - in exactly the situation
 * where the settings table is unreachable. So a language is resolved from
 * whatever *is* available, in this order:
 *
 *   1. an explicit choice on the command line or in `SSBAZAR_LANG`
 *   2. `employees.preferred_language` for the signed-in employee
 *   3. `app_settings.default_language`
 *   4. English
 *
 * Steps 2 and 3 need a database. Step 1 and step 4 do not, which is what makes
 * `resolveLanguageOffline` usable before a connection exists and after one has
 * failed.
 */

import { parseLanguage, resolveLanguage, type Language } from '@ssbazar/shared';

import type { Queryable } from '../db/queryable.js';
import { asRow, readNullableText } from '../db/rows.js';

const DEFAULT_LANGUAGE_SQL = `
  SELECT value
    FROM app_settings
   WHERE key = 'default_language'`;

const EMPLOYEE_LANGUAGE_SQL = `
  SELECT preferred_language::text AS preferred_language
    FROM employees
   WHERE id = $1`;

/** `app_settings.default_language`, or null if the row is missing or blank. */
export async function readDefaultLanguage(db: Queryable): Promise<Language | null> {
  const result = await db.query(DEFAULT_LANGUAGE_SQL);
  const row = result.rows[0];
  if (row === undefined) return null;
  return parseLanguage(readNullableText(asRow(row), 'value'));
}

/** `employees.preferred_language`. NULL is the normal case, not an error. */
export async function readEmployeeLanguage(
  db: Queryable,
  employeeId: number,
): Promise<Language | null> {
  const result = await db.query(EMPLOYEE_LANGUAGE_SQL, [employeeId]);
  const row = result.rows[0];
  if (row === undefined) return null;
  return parseLanguage(readNullableText(asRow(row), 'preferred_language'));
}

export interface LanguageRequest {
  /** `--lang=hi`, a settings toggle, or anything else explicit. Wins outright. */
  readonly explicit?: unknown;
  /** Signed-in employee, if there is one. A CLI run by a scheduler has none. */
  readonly employeeId?: number | undefined;
}

/**
 * The part of the chain that needs nothing but the process environment.
 *
 * `SSBAZAR_LANG` is here so that a CLI failing to reach Postgres still fails in
 * the operator's language, and so that a support call can reproduce what the
 * client saw without editing his settings.
 */
export function resolveLanguageOffline(request: LanguageRequest = {}): Language {
  return resolveLanguage({
    employeePreference: request.explicit,
    storeDefault: process.env.SSBAZAR_LANG,
  });
}

/**
 * The full chain. Falls back to `resolveLanguageOffline` rather than throwing
 * when the database will not answer - a language is never the reason to stop.
 */
export async function resolveLanguageFor(
  db: Queryable,
  request: LanguageRequest = {},
): Promise<Language> {
  const explicit = parseLanguage(request.explicit);
  if (explicit !== null) return explicit;

  try {
    const employeePreference =
      request.employeeId === undefined ? null : await readEmployeeLanguage(db, request.employeeId);

    return resolveLanguage({
      employeePreference,
      storeDefault: (await readDefaultLanguage(db)) ?? process.env.SSBAZAR_LANG,
    });
  } catch {
    // A settings read that fails is not worth surfacing: the caller is about to
    // print something, and printing it in English beats not printing it.
    return resolveLanguageOffline(request);
  }
}
