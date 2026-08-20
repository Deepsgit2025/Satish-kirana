import { type CatalogueApi, type CatalogueResult, type CatalogueValues } from '@ssbazar/shared';
import { describe, expect, it } from 'vitest';

import { databaseNow } from '../db/clock.js';
import { asRow } from '../db/rows.js';
import type { Queryable } from '../db/queryable.js';
import { withRollback } from '../testing/database.js';
import { queryId } from '../testing/catalog-fixtures.js';
import { createCatalogueApi, type SessionRunner } from './api.js';

/**
 * The catalogue contract, exercised end to end without an Electron window.
 *
 * That is the point of the boundary being a plain interface over a
 * `SessionRunner` (docs/DECISIONS.md D42): the thing the renderer will call is
 * callable here, against a real database, with no main process and no IPC. A
 * boundary that could only be tested through a running app is a boundary nobody
 * tests.
 *
 * In production the runner opens a transaction per call. Here it hands every
 * call the *same* rolled-back transaction, so a product created by one call is
 * visible to the next - which is what makes a create-then-read test possible at
 * all. What that does not cover is the main process supplying a real runner;
 * there is nothing in this file to get that wrong, and stage 3 wires it.
 */

const HEADER =
  'barcode,name,name_hi,short_name,hsn_code,tax_rate,mrp,sale_price,purchase_price,unit,category,reorder_level';

const DAY_MS = 24 * 60 * 60 * 1000;

function fields(over: Partial<CatalogueValues> = {}): CatalogueValues {
  return {
    barcode: 'APITEST-0001',
    name: 'Basmati Rice 5kg',
    name_hi: 'बासमती चावल',
    short_name: 'RICE 5KG',
    hsn_code: '100630',
    tax_rate: '5',
    mrp: '520',
    sale_price: '495',
    purchase_price: '410',
    unit: 'Kg',
    category: 'Grocery',
    reorder_level: '10',
    ...over,
  };
}

/** Every call on one session, so the test can build on what it just wrote. */
function sharedSession(db: Queryable): SessionRunner {
  return (work) => work(db);
}

/** One active employee to be, so writes have an author. */
async function seedEmployee(db: Queryable, empCode = 'T-OFFICE-1'): Promise<number> {
  return queryId(
    db,
    `INSERT INTO employees (emp_code, name) VALUES ($1, 'Test Operator') RETURNING id`,
    [empCode],
  );
}

/**
 * An api with somebody signed in, which is the state every write needs.
 *
 * Signing in is part of the fixture rather than part of each test because a
 * write without it is refused - see the "a write needs somebody signed in"
 * cases below, which are the ones that check that on purpose.
 */
async function withApi(work: (api: CatalogueApi, db: Queryable) => Promise<void>): Promise<void> {
  await withRollback(async (db) => {
    const api = createCatalogueApi(sharedSession(db));
    const employeeId = await seedEmployee(db);
    ok(await api.signIn({ employeeId }));
    await work(api, db);
  });
}

/** The same, with nobody signed in. */
async function withSignedOutApi(
  work: (api: CatalogueApi, db: Queryable) => Promise<void>,
): Promise<void> {
  await withRollback(async (db) => {
    await work(createCatalogueApi(sharedSession(db)), db);
  });
}

/** Narrows to the success case and fails the test with the reason if it is not. */
function ok<T>(result: CatalogueResult<T>): T {
  if (!result.ok) {
    throw new Error(
      `expected success, got ${result.failure.message.messageKey}: ${result.failure.detail ?? ''}`,
    );
  }
  return result.value;
}

function failureKey<T>(result: CatalogueResult<T>): string {
  if (result.ok) throw new Error('expected a failure');
  return result.failure.message.messageKey;
}

/** Yesterday, from the database clock, so a later edit can close the row. */
async function yesterday(db: Queryable): Promise<string> {
  const now = await databaseNow(db);
  return new Date(now.getTime() - DAY_MS).toISOString();
}

async function seed(
  api: CatalogueApi,
  db: Queryable,
  over: Partial<CatalogueValues> = {},
): Promise<number> {
  const saved = ok(
    await api.saveProduct({
      productId: null,
      values: fields(over),
      reason: 'Opening catalogue',
      effectiveFrom: await yesterday(db),
    }),
  );
  if (saved.productId === null) throw new Error('fixture product was rejected');
  return saved.productId;
}

describe('the catalogue contract', () => {
  it('lists, gets, saves and bulk-edits through one interface', async () => {
    await withApi(async (api, db) => {
      const productId = await seed(api, db);

      const page = ok(await api.listProducts({ filter: { text: 'APITEST-' } }));
      expect(page.total).toBe(1);
      expect(page.rows[0]).toMatchObject({ productId, salePrice: '495.00' });

      const detail = ok(await api.getProduct({ productId }));
      expect(detail.values).toMatchObject({ sale_price: '495.00', tax_rate: '5.00' });
      expect(detail.itemCode).toMatch(/^SKU-\d{6}$/);

      // The form submits back exactly the shape it was given.
      const saved = ok(
        await api.saveProduct({
          productId,
          values: { ...detail.values, name: 'Basmati Rice 5kg Premium' },
          reason: 'Name corrected',
          effectiveFrom: null,
        }),
      );
      expect(saved).toMatchObject({ applied: 1, rejected: 0, productId });

      const edited = ok(
        await api.bulkEdit({
          productIds: [productId],
          change: { field: 'sale_price', value: '510' },
          reason: 'March price revision',
          effectiveFrom: null,
        }),
      );
      expect(edited).toMatchObject({ applied: 1, rejected: 0 });
      expect(ok(await api.getProduct({ productId })).values.sale_price).toBe('510.00');
    });
  });

  it('returns every id the filter matches, for "apply to all"', async () => {
    await withApi(async (api, db) => {
      const first = await seed(api, db, { barcode: 'APITEST-A', short_name: 'A' });
      const second = await seed(api, db, { barcode: 'APITEST-B', short_name: 'B' });

      const ids = ok(await api.listProductIds({ filter: { text: 'APITEST-', limit: 1 } }));

      expect([...ids].sort()).toEqual([first, second].sort());
    });
  });

  it('imports a file, and reports a dry run without writing', async () => {
    await withApi(async (api) => {
      const text = [
        HEADER,
        '8901000000009,Rice,,RICE,100630,5,520,495,410,Kg,Grocery,10',
        '8901000000008,Short HSN,,SHORT,1006,5,100,90,80,Kg,Grocery,',
      ].join('\n');

      const before = ok(await api.listProducts({ filter: {} })).total;

      const dry = ok(await api.importCatalogueFile({ text, dryRun: true }));
      expect(dry).toMatchObject({ dryRun: true, totalRows: 2, imported: 0, rejected: 1 });
      // Measured against what was there, not against zero: this database holds
      // the shop's own catalogue the moment anybody imports one (CLAUDE.md,
      // Working practices).
      expect(ok(await api.listProducts({ filter: {} })).total).toBe(before);

      const real = ok(await api.importCatalogueFile({ text, dryRun: false }));
      expect(real).toMatchObject({ imported: 1, rejected: 1 });
      expect(real.issues[0]?.reasonKey).toBe('catalogue.issue.hsn_not_six_digits');
    });
  });
});

describe('what counts as a failure', () => {
  it('treats a rejected row as a success that reports issues', async () => {
    await withApi(async (api, db) => {
      const productId = await seed(api, db, { mrp: '500', sale_price: '450' });

      // The operation ran and did what it could. Only the row was refused, and
      // the screen needs the reason - which `ok: false` would not carry.
      const result = await api.bulkEdit({
        productIds: [productId],
        change: { field: 'sale_price', value: '550' },
        reason: 'March price revision',
        effectiveFrom: null,
      });

      expect(result.ok).toBe(true);
      const value = ok(result);
      expect(value).toMatchObject({ applied: 0, rejected: 1, rejectedProductIds: [productId] });
      expect(value.issues[0]?.reasonKey).toBe('catalogue.issue.sale_price_above_mrp');
    });
  });

  it('fails the whole call when the request names a product that is not there', async () => {
    await withApi(async (api) => {
      expect(failureKey(await api.getProduct({ productId: 999_999_999 }))).toBe(
        'error.catalogue.no_such_product',
      );
    });
  });

  it('fails with the key the core raised, not a generic one', async () => {
    await withApi(async (api) => {
      // An unclosed quote makes the rest of the file one enormous field, so
      // there is no row to report against. The reason still has to reach the
      // operator in their own language, which means the key has to survive the
      // trip (invariant 19, D39).
      const result = await api.importCatalogueFile({
        text: `${HEADER}\n"8901,Never closed,,X,100630,5,1,1,,Kg,,`,
        dryRun: true,
      });

      expect(failureKey(result)).toBe('error.csv.unterminated_quote');

      // And it arrives as plain data rather than as the Error that raised it.
      // A `TranslatableError` satisfies `TranslatableMessage` structurally, so
      // handing one straight back typechecks and works perfectly in process -
      // then crosses IPC as `{}`, because structured clone keeps only an
      // Error's name, message and stack and drops everything else. The screen
      // gets a failure it cannot name.
      if (!result.ok) {
        expect(result.failure.message).not.toBeInstanceOf(Error);
        expect(Object.keys(result.failure.message).sort()).toEqual(['messageKey', 'params']);
      }
    });
  });

  it('refuses a date it cannot read, before touching the database', async () => {
    await withApi(async (api, db) => {
      const productId = await seed(api, db);

      const result = await api.bulkEdit({
        productIds: [productId],
        change: { field: 'sale_price', value: '400' },
        reason: 'March price revision',
        effectiveFrom: 'next tuesday',
      });

      expect(failureKey(result)).toBe('error.catalogue.invalid_date');
      if (!result.ok) expect(result.failure.message.params).toEqual({ value: 'next tuesday' });

      // And nothing moved.
      expect(ok(await api.getProduct({ productId })).values.sale_price).toBe('495.00');
    });
  });
});

/**
 * The claim the contract file makes about itself, checked rather than asserted.
 *
 * Electron's structured clone would carry a `Date` or a `Map` across; JSON
 * would not, and these same shapes are the obvious thing to send over the LAN
 * when a counter talks to the store server. A `Date` that slipped into a
 * response would work in the app and fail the day somebody put it on a socket.
 */
describe('everything crossing the wire is JSON-safe', () => {
  it('survives a JSON round trip unchanged, on every method', async () => {
    await withApi(async (api, db) => {
      const productId = await seed(api, db);
      const nextMonth = new Date((await databaseNow(db)).getTime() + 30 * DAY_MS).toISOString();

      const results: CatalogueResult<unknown>[] = [
        await api.listProducts({ filter: { text: 'APITEST-' } }),
        await api.listProductIds({ filter: {} }),
        await api.getProduct({ productId }),
        await api.getProduct({ productId: 999_999_999 }),
        await api.importCatalogueFile({ text: HEADER, dryRun: true }),
        await api.bulkEdit({
          productIds: [productId],
          change: { field: 'tax_rate', value: '18', mrpPolicy: 'recompute' },
          reason: 'GST 2.0 reassignment',
          effectiveFrom: nextMonth,
        }),
      ];

      for (const result of results) {
        expect(JSON.parse(JSON.stringify(result))).toEqual(result);
      }
    });
  });
});

/**
 * The audit trail's other half.
 *
 * `changed_by` answers "who changed this price", and the contract deliberately
 * has no field for the renderer to fill in - a screen that could name anybody
 * as the author of a change is not an audit trail, it is a text field. So the
 * only way a write gets an author is by somebody signing in, and the only thing
 * a write can do without one is refuse.
 */
describe('a write needs somebody signed in', () => {
  it('refuses to save, bulk-edit or import with nobody signed in', async () => {
    await withSignedOutApi(async (api) => {
      expect(
        failureKey(
          await api.saveProduct({
            productId: null,
            values: fields(),
            reason: 'Added by hand',
            effectiveFrom: null,
          }),
        ),
      ).toBe('error.catalogue.not_signed_in');

      expect(
        failureKey(
          await api.bulkEdit({
            productIds: [1],
            change: { field: 'sale_price', value: '10' },
            reason: 'Bulk',
            effectiveFrom: null,
          }),
        ),
      ).toBe('error.catalogue.not_signed_in');

      expect(failureKey(await api.importCatalogueFile({ text: HEADER, dryRun: false }))).toBe(
        'error.catalogue.not_signed_in',
      );
    });
  });

  it('still allows reading, and a dry run, without one', async () => {
    await withSignedOutApi(async (api) => {
      // The catalogue is not a secret from whoever is at the office machine,
      // and a dry run writes nothing and has no author to record. Refusing
      // these would only teach people to sign in as whoever is nearest.
      ok(await api.listProducts({ filter: {} }));
      ok(await api.listEmployees());
      ok(await api.importCatalogueFile({ text: HEADER, dryRun: true }));
      expect(ok(await api.currentEmployee())).toBeNull();
    });
  });

  it('records the signed-in employee as the author, not anything the caller said', async () => {
    await withRollback(async (db) => {
      const api = createCatalogueApi(sharedSession(db));
      const employeeId = await seedEmployee(db);
      ok(await api.signIn({ employeeId }));

      const saved = ok(
        await api.saveProduct({
          productId: null,
          values: fields(),
          reason: 'Added by hand',
          effectiveFrom: null,
        }),
      );

      const { rows } = await db.query(
        `SELECT changed_by FROM product_prices WHERE product_id = $1`,
        [saved.productId],
      );
      expect(rows).toHaveLength(1);
      expect(asRow(rows[0]).changed_by).toBe(String(employeeId));
    });
  });

  it('refuses an employee who is not on the active list', async () => {
    await withSignedOutApi(async (api) => {
      expect(failureKey(await api.signIn({ employeeId: 999_999_999 }))).toBe(
        'error.catalogue.unknown_employee',
      );
      expect(ok(await api.currentEmployee())).toBeNull();
    });
  });

  it('signs out, and writes stop again', async () => {
    await withApi(async (api) => {
      ok(await api.signOut());
      expect(ok(await api.currentEmployee())).toBeNull();
      expect(
        failureKey(
          await api.saveProduct({
            productId: null,
            values: fields(),
            reason: 'Added by hand',
            effectiveFrom: null,
          }),
        ),
      ).toBe('error.catalogue.not_signed_in');
    });
  });
});
