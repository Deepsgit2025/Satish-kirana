import { assignProductPrice, assignProductSlab } from '../catalog/product-history.js';
import type { Queryable } from '../db/queryable.js';
import { postStockMovement, type StockTxnType } from '../stock/stock-ledger.js';
import { seedProduct, seededSlabId } from './catalog-fixtures.js';
import { seedLocations } from './stock-fixtures.js';

/**
 * A catalogue and a stock ledger the size of the rebuild fixture: 100
 * randomised movements across 5 products and 3 locations.
 *
 * The shop has not opened and the client's spreadsheet has not started
 * (docs/DECISIONS.md, Open items), so there is no real catalogue to back up.
 * This is what stands in for one - and it is sized to match the fixture the
 * stock ledger rebuild test uses because that shape is already known to
 * exercise the parts that matter: ties on `occurred_at`, negative balances, a
 * pair driven to exactly zero, and every `txn_type` in the enum.
 *
 * **This is a fixture, not a second rebuild test.** `stock-on-hand-rebuild
 * .test.ts` keeps its own copy of the generator on purpose. That test is the
 * safety net for the whole project (CLAUDE.md invariant 22) and must not be
 * able to fail, or pass, because something changed in a shared helper it does
 * not own. The duplication is ten lines of pseudo-random number generator and
 * is worth it.
 *
 * Everything writes through the real schema, so a fixture that stops being
 * possible - a tightened constraint, a new NOT NULL - fails here rather than
 * quietly diverging from what the shop will actually hold.
 */

export const SYNTHETIC_MOVEMENTS = 100;
export const SYNTHETIC_PRODUCTS = 5;

/** Fixed, so a failure reproduces exactly rather than "sometimes". */
const SEED = 20260821;

const TXN_TYPES: readonly StockTxnType[] = [
  'sale',
  'sale_return',
  'purchase',
  'adjustment',
  'transfer_in',
  'transfer_out',
];

/** mulberry32 - small, seedable, good enough to shuffle test data. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, from: readonly T[]): T {
  const item = from[Math.floor(random() * from.length)];
  if (item === undefined) throw new Error('empty choice list');
  return item;
}

export interface SyntheticStock {
  readonly products: readonly number[];
  readonly locations: readonly number[];
  readonly movements: number;
}

/**
 * Seeds the fixture against `db`.
 *
 * `now` is the database's own instant, not `new Date()` - movements are dated
 * relative to it, and CLAUDE.md's note on `now()` applies to every one of them.
 */
export async function seedSyntheticStock(
  db: Queryable,
  prefix: string,
  now: Date,
): Promise<SyntheticStock> {
  const random = makeRandom(SEED);
  const slabId = await seededSlabId(db, 'GST 5%');

  const products: number[] = [];
  for (let i = 0; i < SYNTHETIC_PRODUCTS; i += 1) {
    const productId = await seedProduct(db, {
      itemCode: `${prefix}-${String(i)}`,
      taxSlabId: slabId,
      name: `Synthetic product ${String(i)}`,
    });

    // `seedProduct` writes the caches - products.tax_slab_id, sale_price, mrp -
    // and nothing else. A product with a cache and no history behind it is
    // exactly what `product_tax_cache_drift` and `product_price_cache_drift`
    // exist to find, so a fixture that stopped there would leave the health
    // panel reporting drift that is an artefact of the fixture rather than a
    // fault in the shop. It is the same close-then-open path the importer and
    // the product master take (docs/DECISIONS.md D41), so what this leaves
    // behind is indistinguishable from an imported catalogue.
    await assignProductSlab(db, {
      productId,
      taxSlabId: slabId,
      effectiveFrom: now,
      reason: 'Synthetic fixture',
    });
    await assignProductPrice(db, {
      productId,
      salePrice: '495.00',
      mrp: '520.00',
      taxType: 'inclusive',
      effectiveFrom: now,
      reason: 'Synthetic fixture',
    });

    products.push(productId);
  }

  const locations = await seedLocations(db, prefix);

  // Four instants, so movements collide on occurred_at in bulk. Ties are the
  // case a rebuild ordering by timestamp instead of by id would get wrong.
  const hour = 60 * 60 * 1000;
  const instants = [6, 4, 2, 1].map((back) => new Date(now.getTime() - back * hour));

  for (let i = 0; i < SYNTHETIC_MOVEMENTS; i += 1) {
    const magnitude = Math.round((random() * 20 + 0.001) * 1000) / 1000;

    await postStockMovement(db, {
      productId: pick(random, products),
      locationId: pick(random, locations),
      txnType: pick(random, TXN_TYPES),
      // Signed, three decimals, never zero - the column refuses zero and a
      // movement recording nothing is always a bug in the caller.
      qtyDelta: random() < 0.4 ? -magnitude : magnitude,
      refTable: 'synthetic_fixture',
      refId: i + 1,
      occurredAt: pick(random, instants),
    });
  }

  return { products, locations, movements: SYNTHETIC_MOVEMENTS };
}
