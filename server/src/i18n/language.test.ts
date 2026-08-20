import { describe, expect, it } from 'vitest';

import type { Queryable } from '../db/queryable.js';
import { withRollback } from '../testing/database.js';
import {
  readDefaultLanguage,
  readEmployeeLanguage,
  resolveLanguageFor,
  resolveLanguageOffline,
} from './language.js';

/**
 * The resolution chain against the real schema.
 *
 * Against Postgres rather than a fake because both ends of it are schema
 * facts: `employees.preferred_language` is a `language_code` enum returning as
 * text, and `app_settings.default_language` is a row in a key/value table whose
 * `value` column is TEXT. A fake would be asserting what this file believes
 * about those two, which is the thing worth checking.
 *
 * Every case runs inside `withRollback`, including the ones that change the
 * store default, so a developer's own setting is put back however the test
 * ends.
 */

const EMPLOYEE_SQL = `
  INSERT INTO employees (emp_code, name, preferred_language)
  VALUES ($1, $2, $3::language_code)
  RETURNING id`;

async function makeEmployee(db: Queryable, language: 'en' | 'hi' | null): Promise<number> {
  // A unique code per row: `employees` is a shared table with real staff in it
  // on a developer machine, and a fixture must not collide with one.
  const code = `T18N/${String(Date.now() % 1_000_000)}${String(Math.floor(Math.random() * 1000))}`;
  const { rows } = await db.query(EMPLOYEE_SQL, [code, 'i18n fixture', language]);
  const row = rows[0] as { id: string };
  return Number.parseInt(row.id, 10);
}

async function setStoreDefault(db: Queryable, value: string): Promise<void> {
  await db.query(`UPDATE app_settings SET value = $1 WHERE key = 'default_language'`, [value]);
}

describe('reading the language settings', () => {
  it('reads the store default that migration 001 seeded', async () => {
    await withRollback(async (db) => {
      expect(await readDefaultLanguage(db)).toBe('en');
    });
  });

  it('reads an employee preference, and null when there is none', async () => {
    await withRollback(async (db) => {
      expect(await readEmployeeLanguage(db, await makeEmployee(db, 'hi'))).toBe('hi');
      expect(await readEmployeeLanguage(db, await makeEmployee(db, null))).toBeNull();
    });
  });

  it('returns null for an employee who does not exist', async () => {
    await withRollback(async (db) => {
      // A stale session id after a staff member is removed. It resolves to the
      // store default rather than failing, which is what the caller wants.
      expect(await readEmployeeLanguage(db, -1)).toBeNull();
    });
  });
});

describe('resolveLanguageFor', () => {
  it('prefers the employee over the store default', async () => {
    await withRollback(async (db) => {
      const employeeId = await makeEmployee(db, 'hi');

      expect(await resolveLanguageFor(db, { employeeId })).toBe('hi');
    });
  });

  it('uses the store default when the employee has no preference', async () => {
    await withRollback(async (db) => {
      const employeeId = await makeEmployee(db, null);
      await setStoreDefault(db, 'hi');

      expect(await resolveLanguageFor(db, { employeeId })).toBe('hi');
    });
  });

  it('uses the store default when there is no employee at all', async () => {
    await withRollback(async (db) => {
      // The CLI case. `catalogue:import` is run from a terminal by the client,
      // with no session and nobody signed in.
      await setStoreDefault(db, 'hi');

      expect(await resolveLanguageFor(db)).toBe('hi');
    });
  });

  it('lets an explicit choice outrank both', async () => {
    await withRollback(async (db) => {
      const employeeId = await makeEmployee(db, 'hi');

      expect(await resolveLanguageFor(db, { employeeId, explicit: 'en' })).toBe('en');
    });
  });

  it('steps past a store default nothing can read', async () => {
    await withRollback(async (db) => {
      // `app_settings.value` is TEXT and holds every setting in the system, so
      // there is no constraint stopping this. A cashier must not meet an error
      // because of it.
      await setStoreDefault(db, 'Hindi');

      expect(await resolveLanguageFor(db)).toBe('en');
    });
  });

  it('answers in English rather than throwing when the query fails', async () => {
    // Offline-first, at the smallest scale it occurs: the settings read is on
    // the path of things that print during an outage, and a language is never
    // a reason to stop. `db:migrate` prints "could not reach Postgres" in
    // exactly the situation where `app_settings` cannot be read.
    const broken: Queryable = {
      query: () => Promise.reject(new Error('connection terminated unexpectedly')),
    };

    await expect(resolveLanguageFor(broken)).resolves.toBe('en');
  });
});

describe('resolveLanguageOffline', () => {
  it('takes an explicit choice before anything else', () => {
    expect(resolveLanguageOffline({ explicit: 'hi' })).toBe('hi');
  });

  it('falls back to English with nothing to go on', () => {
    expect(resolveLanguageOffline()).toBe('en');
  });
});
