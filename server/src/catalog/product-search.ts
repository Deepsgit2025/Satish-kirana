import type { Queryable } from '../db/queryable.js';
import type {
  CategoryOption,
  ProductFilter,
  ProductListRow,
  ProductPage,
  TaxSlabOption,
} from '@ssbazar/shared';

import { asRow, readId, readInt, readNullableId, readNullableText, readText } from '../db/rows.js';

/**
 * The list view: browse, search and filter the catalogue.
 *
 * The first of the product master's three views (docs/DECISIONS.md D41), and
 * the one with no rules in it - it reads, and everything that writes goes
 * through `product-edit.ts`. It is also how the bulk grid gets its selection:
 * the operator filters to a category or a slab, selects what comes back, and
 * sets one field across it. So the filters here and the fields the grid can set
 * are deliberately the same vocabulary.
 *
 * **Search is over what is written on the packet**, in either language: name,
 * Hindi name, short name, item code and barcode. A shop assistant looking for
 * a product knows what it says on the front of it, not what the office called
 * it, and `COALESCE(name_hi, name)` is what the screen displays anyway
 * (CLAUDE.md invariant 20).
 */

/**
 * `ProductFilter`, `ProductListRow` and `ProductPage` are defined in
 * `@ssbazar/shared` and re-exported here. They cross the IPC boundary intact -
 * the list view renders these rows in a different JavaScript context from the
 * one that queried them (docs/DECISIONS.md D42).
 */
export type { ProductFilter, ProductListRow, ProductPage };

/** Enough to fill a screen, small enough that a stray browse is not a scan. */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/**
 * Turns what the operator typed into a LIKE pattern.
 *
 * **A parameter is not enough here.** Passing the search text as `$1` stops it
 * being read as SQL, but `%` and `_` inside a LIKE *value* are still wildcards,
 * so a search for `100%` - a real product, `100% Atta 10kg` - matches every row
 * in the catalogue. On the list screen that is a confusing result. On the way
 * into the bulk grid it is a selection of the whole catalogue when the operator
 * asked for one product, and the next click changes a price on all of it.
 *
 * Backslash is Postgres's default LIKE escape character, so escaping it and the
 * two wildcards is the whole job; no ESCAPE clause is needed.
 */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/**
 * One WHERE clause, built once and used by both the page query and the count,
 * so the total can never describe a different set from the rows.
 *
 * `$1` is the already-escaped pattern, or NULL when no text was given - which
 * short-circuits the whole OR chain.
 */
const WHERE_SQL = `
  WHERE ($1::text IS NULL
         OR p.name ILIKE $1
         OR p.name_hi ILIKE $1
         OR p.short_name ILIKE $1
         OR p.item_code ILIKE $1
         OR EXISTS (SELECT 1 FROM product_barcodes pb
                     WHERE pb.product_id = p.id AND pb.barcode ILIKE $1))
    AND ($2::bigint IS NULL OR p.category_id = $2)
    AND ($3::bigint IS NULL OR p.tax_slab_id = $3)
    AND ($4::product_status IS NULL OR p.status = $4)
    AND ($5::boolean IS NOT TRUE
         OR COALESCE((SELECT sum(soh.qty) FROM stock_on_hand soh WHERE soh.product_id = p.id), 0)
            <= p.reorder_level)`;

const SELECT_SQL = `
  SELECT p.id,
         p.item_code,
         p.name,
         p.name_hi,
         p.short_name,
         p.hsn_code,
         p.category_id,
         p.tax_slab_id,
         p.mrp,
         p.sale_price,
         p.purchase_price,
         p.reorder_level,
         p.status,
         b.barcode,
         c.name       AS category_name,
         s.name       AS slab_name,
         u.short_name AS unit
    FROM products p
    LEFT JOIN product_barcodes b ON b.product_id = p.id AND b.is_primary
    LEFT JOIN categories c ON c.id = p.category_id
    JOIN units u ON u.id = p.base_unit_id
    JOIN tax_slabs s ON s.id = p.tax_slab_id
  ${WHERE_SQL}
  ORDER BY p.name, p.id
   LIMIT $6 OFFSET $7`;

const COUNT_SQL = `
  SELECT count(*)::int AS n
    FROM products p
  ${WHERE_SQL}`;

function toListRow(value: unknown): ProductListRow {
  const row = asRow(value);
  return {
    productId: readId(row, 'id'),
    itemCode: readText(row, 'item_code'),
    name: readText(row, 'name'),
    nameHi: readNullableText(row, 'name_hi'),
    shortName: readText(row, 'short_name'),
    barcode: readNullableText(row, 'barcode'),
    hsnCode: readText(row, 'hsn_code'),
    categoryId: readNullableId(row, 'category_id'),
    categoryName: readNullableText(row, 'category_name'),
    taxSlabId: readId(row, 'tax_slab_id'),
    slabName: readText(row, 'slab_name'),
    unit: readText(row, 'unit'),
    mrp: readText(row, 'mrp'),
    salePrice: readText(row, 'sale_price'),
    purchasePrice: readText(row, 'purchase_price'),
    reorderLevel: readText(row, 'reorder_level'),
    status: readText(row, 'status'),
  };
}

/**
 * A page of the catalogue, plus how many rows the filter matched in total.
 *
 * The total is what makes a bulk selection safe to trust: "apply to all 2,140
 * matching" is a very different act from "apply to the 100 on screen", and an
 * operator who cannot see the difference will eventually make the wrong one.
 */
export async function searchProducts(
  db: Queryable,
  filter: ProductFilter = {},
): Promise<ProductPage> {
  const text = filter.text?.trim();
  const params = [
    text === undefined || text.length === 0 ? null : likePattern(text),
    filter.categoryId ?? null,
    filter.taxSlabId ?? null,
    filter.status ?? null,
    filter.belowReorderLevel ?? false,
  ];

  const limit = Math.min(filter.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const offset = filter.offset ?? 0;

  const page = await db.query(SELECT_SQL, [...params, limit, offset]);
  const counted = await db.query(COUNT_SQL, params);

  return {
    rows: page.rows.map(toListRow),
    total: readInt(asRow(counted.rows[0]), 'n'),
  };
}

/**
 * Every product the filter matches, as ids, for "select all matching".
 *
 * Separate from `searchProducts` because the grid needs the whole set while the
 * screen only shows a page of it, and because ids are cheap where rows are not.
 * Capped at `MAX_LIMIT`: a selection larger than that is a request nobody meant
 * to make by hand, and the caller can see it was truncated by comparing against
 * the page total.
 */
export async function searchProductIds(
  db: Queryable,
  filter: ProductFilter = {},
): Promise<number[]> {
  const page = await searchProducts(db, { ...filter, limit: MAX_LIMIT, offset: 0 });
  return page.rows.map((row) => row.productId);
}

const CATEGORIES_SQL = `
  SELECT c.id, c.name
    FROM categories c
   WHERE EXISTS (SELECT 1 FROM products p WHERE p.category_id = c.id)
   ORDER BY c.name`;

/**
 * Categories that actually have products in them.
 *
 * Filtering to an empty category returns nothing and looks like a broken
 * screen, and the import creates categories freely (D41), so the tree will
 * carry ones nobody has stocked yet.
 */
export async function listCategories(db: Queryable): Promise<CategoryOption[]> {
  const { rows } = await db.query(CATEGORIES_SQL);
  return rows.map((value) => {
    const row = asRow(value);
    return { categoryId: readId(row, 'id'), name: readText(row, 'name') };
  });
}

const SLABS_SQL = `
  SELECT id, name, igst_rate
    FROM tax_slabs
   WHERE is_active
     AND effective_from <= current_date
     AND (effective_to IS NULL OR effective_to >= current_date)
   ORDER BY igst_rate`;

/**
 * Slabs in force today - the same set the importer resolves `tax_rate` against,
 * so the grid cannot offer a rate a file would reject.
 *
 * `igst_rate` is the slab's total: a row holds the same figure twice, once
 * whole and once split into CGST and SGST, kept equal by
 * `tax_slabs_split_matches_igst`.
 */
export async function listTaxSlabs(db: Queryable): Promise<TaxSlabOption[]> {
  const { rows } = await db.query(SLABS_SQL);
  return rows.map((value) => {
    const row = asRow(value);
    return {
      taxSlabId: readId(row, 'id'),
      name: readText(row, 'name'),
      totalRate: readText(row, 'igst_rate'),
    };
  });
}
