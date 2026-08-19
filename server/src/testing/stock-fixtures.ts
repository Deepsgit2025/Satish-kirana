import type { Queryable } from '../db/queryable.js';
import { queryId } from './catalog-fixtures.js';

/**
 * Stock fixtures.
 *
 * Locations are created rather than invented. `stock_ledger.location_id` is a
 * foreign key as of `007_locations.sql`, so a test that posts against a made-up
 * integer no longer inserts - which is the point of the key, and the reason it
 * was worth adding before any real stock existed.
 */

/** One location, returned by id. Codes read like the labels on the shelves. */
export async function seedLocation(
  db: Queryable,
  code: string,
  locationType: 'rack' | 'godown' | 'cold' | 'counter_display' = 'rack',
): Promise<number> {
  return queryId(
    db,
    `INSERT INTO locations (code, name, location_type)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [code, `Test location ${code}`, locationType],
  );
}

/** A rack, a godown and a counter display - the three kinds stock actually moves between. */
export async function seedLocations(db: Queryable, prefix: string): Promise<number[]> {
  return [
    await seedLocation(db, `${prefix}-A-01-3`, 'rack'),
    await seedLocation(db, `${prefix}-GODOWN`, 'godown'),
    await seedLocation(db, `${prefix}-TILL`, 'counter_display'),
  ];
}
