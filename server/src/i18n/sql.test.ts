import { describe, expect, it } from 'vitest';

import { withRollback } from '../testing/database.js';
import { localisedColumn, localisedColumnAs, productNameColumn } from './sql.js';

/**
 * `COALESCE(name_hi, name)` as Postgres actually evaluates it.
 *
 * The expression is short enough to read and get wrong anyway - the blank case
 * is the one that matters and the one a bare `COALESCE` misses - so it is run
 * against the database rather than string-compared. What is being checked is
 * the answer, not the SQL.
 */

async function display(
  db: Parameters<Parameters<typeof withRollback>[0]>[0],
  language: 'en' | 'hi',
  english: string,
  hindi: string | null,
): Promise<string> {
  const expression = localisedColumn(language, 'name_hi', 'name');
  const { rows } = await db.query(
    `SELECT ${expression} AS display FROM (SELECT $1::text AS name, $2::text AS name_hi) AS product`,
    [english, hindi],
  );
  return (rows[0] as { display: string }).display;
}

describe('localisedColumn', () => {
  it('shows the Hindi name to a Hindi user', async () => {
    await withRollback(async (db) => {
      expect(await display(db, 'hi', 'Basmati Rice', 'बासमती चावल')).toBe('बासमती चावल');
    });
  });

  it('falls back to English when the Hindi column is NULL', async () => {
    await withRollback(async (db) => {
      // The normal case, by design. D20: the client fills the few hundred items
      // that matter rather than doubling his catalogue data entry.
      expect(await display(db, 'hi', 'Toor Dal', null)).toBe('Toor Dal');
    });
  });

  it('falls back when the Hindi column is empty or only whitespace', async () => {
    await withRollback(async (db) => {
      // A bare COALESCE would return '' here and print a product with no name
      // on it. An imported spreadsheet produces this far more often than NULL.
      expect(await display(db, 'hi', 'Sugar', '')).toBe('Sugar');
      expect(await display(db, 'hi', 'Sugar', '   ')).toBe('Sugar');
    });
  });

  it('never falls the other way', async () => {
    await withRollback(async (db) => {
      expect(await display(db, 'en', 'Basmati Rice', 'बासमती चावल')).toBe('Basmati Rice');
    });
  });

  it('sorts by the name being shown, not by the English one', async () => {
    await withRollback(async (db) => {
      // The reason this has to happen in SQL at all. A list sorted by `name`
      // and displayed as `name_hi` comes back in an order the eye cannot
      // follow - the customer asks for आटा and the row is filed under "Atta".
      const expression = localisedColumn('hi', 'name_hi', 'name');
      const { rows } = await db.query(
        `SELECT ${expression} AS display
           FROM (VALUES ('Atta', 'आटा'), ('Basmati Rice', NULL), ('Chini', 'चीनी'))
                  AS product(name, name_hi)
          ORDER BY ${expression}`,
      );

      expect(rows.map((row) => (row as { display: string }).display)).toEqual([
        // Devanagari sorts after Latin in the default collation, which is
        // exactly what a Hindi-reading cashier scrolling the list will see.
        'Basmati Rice',
        'आटा',
        'चीनी',
      ]);
    });
  });
});

describe('the column builders', () => {
  it('returns the plain English column for an English user', () => {
    // No COALESCE at all: nothing for the planner to work around on the query
    // that runs for most of this shop's screens.
    expect(localisedColumn('en', 'p.name_hi', 'p.name')).toBe('p.name');
    expect(productNameColumn('en')).toBe('p.name');
  });

  it('aliases for a SELECT list', () => {
    expect(localisedColumnAs('en', 'p.name_hi', 'p.name', 'display_name')).toBe(
      'p.name AS display_name',
    );
  });

  it('qualifies by table alias so it can be joined', () => {
    expect(productNameColumn('hi', 'prod')).toContain('prod.name_hi');
  });
});
