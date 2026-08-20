import type { TranslatableMessage } from '../i18n/errors.js';
import type { TranslationKey } from '../i18n/catalogue.js';
import type { MessageParams } from '../i18n/translator.js';

/**
 * The catalogue contract: what the product master screen may ask the catalogue
 * core to do, as types both sides of the wire share.
 *
 * Electron runs the screen and the database in separate JavaScript contexts, so
 * every call a view makes crosses a serialisation boundary (docs/DECISIONS.md
 * D42). This file is that boundary, written once. It lives in
 * `@ssbazar/shared` because that is the only package the renderer, the counter
 * and the server all import - a request shape declared separately on each side
 * is one that drifts, and drifts silently, because both sides still compile.
 *
 * **Nothing here does anything.** There is no validation, no arithmetic and no
 * SQL. Every operation is implemented in `server/src/catalog/api.ts` on top of
 * the step-7 core, and a rule that appears in this file is a rule that has been
 * copied out of the validator - which is the failure D41 exists to prevent, one
 * layer up.
 *
 * **Everything crossing the wire is JSON-safe**, and that is stricter than
 * Electron requires. Structured clone would carry a `Date` or a `Map`; JSON
 * would not, and the same request shapes are the obvious thing to send over the
 * LAN when a counter talks to the store server. So:
 *
 *   - instants are ISO 8601 strings, parsed once on the far side;
 *   - money and quantities are exact decimal *text*, as they are everywhere
 *     else in this system - a float would lose paise in transit;
 *   - ids are numbers, and lists are arrays.
 *
 * **A failure crosses as a key, not a sentence.** `TranslatableMessage` is the
 * shape the validator and the migration runner already produce; the renderer
 * translates it with its own session. An English string serialised here would
 * be an English string on a Hindi screen (invariant 19, D39).
 */

/* -------------------------------------------------------------------------
 * Columns
 * ---------------------------------------------------------------------- */

/**
 * The columns a catalogue row has, in the order the template file lists them.
 *
 * Here rather than in the validator because the create and edit forms are built
 * from this list: the screen has to know which fields exist and which may be
 * left blank, and it must be the same answer the file path uses or the form
 * will offer a column the importer has never heard of.
 */
export const REQUIRED_COLUMNS = [
  'barcode',
  'name',
  'short_name',
  'hsn_code',
  'tax_rate',
  'mrp',
  'sale_price',
  'unit',
] as const;

export const OPTIONAL_COLUMNS = ['name_hi', 'purchase_price', 'category', 'reorder_level'] as const;

export const CATALOGUE_COLUMNS: readonly string[] = [...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS];

/**
 * One catalogue row as text, keyed by column name.
 *
 * The vocabulary every route speaks: a line of the CSV, the create form, the
 * edit form, a row of the bulk grid. Text throughout because that is what a
 * spreadsheet cell and a form field both hold, and validating the text is what
 * makes "must be exactly 6 digits" mean the same thing on all four.
 */
export interface CatalogueValues {
  barcode: string;
  name: string;
  name_hi: string;
  short_name: string;
  hsn_code: string;
  tax_rate: string;
  mrp: string;
  sale_price: string;
  purchase_price: string;
  unit: string;
  category: string;
  reorder_level: string;
}

/* -------------------------------------------------------------------------
 * What comes back about a row that would not go in
 * ---------------------------------------------------------------------- */

/** The `catalogue.issue.*` half of the catalogue, and nothing else. */
export type IssueKey = Extract<TranslationKey, `catalogue.issue.${string}`>;

export interface RowIssue {
  /**
   * Which row this is about, in whatever produced it: the physical line in the
   * file - what the spreadsheet's row gutter shows - or the row number on the
   * bulk grid, or 1 for a single form. The number the person looking at the
   * screen can find, in other words, which is the whole reason it exists.
   */
  readonly line: number;
  readonly column: string;
  readonly value: string;
  /** Why the row was left out, as a key - never as English. */
  readonly reasonKey: IssueKey;
  readonly reasonParams: MessageParams;
}

/* -------------------------------------------------------------------------
 * The list view
 * ---------------------------------------------------------------------- */

export interface ProductFilter {
  /** Matched against name, name_hi, short_name, item_code and barcode. */
  readonly text?: string;
  readonly categoryId?: number | null;
  readonly taxSlabId?: number | null;
  readonly status?: 'active' | 'discontinued';
  /** Products at or below their reorder level. */
  readonly belowReorderLevel?: boolean;
  readonly limit?: number;
  readonly offset?: number;
}

export interface ProductListRow {
  readonly productId: number;
  readonly itemCode: string;
  readonly name: string;
  readonly nameHi: string | null;
  readonly shortName: string;
  readonly barcode: string | null;
  readonly hsnCode: string;
  readonly categoryId: number | null;
  readonly categoryName: string | null;
  readonly taxSlabId: number;
  readonly slabName: string;
  readonly unit: string;
  readonly mrp: string;
  readonly salePrice: string;
  readonly purchasePrice: string;
  readonly reorderLevel: string;
  readonly status: string;
}

export interface ProductPage {
  readonly rows: readonly ProductListRow[];
  /** Rows the filter matches in total, for the "showing 50 of 2,140" line. */
  readonly total: number;
}

/**
 * The options a filter dropdown offers.
 *
 * Both exist because the list view filters by category and by slab and has to
 * show the operator what there is to choose from. They are read methods with a
 * caller today rather than surface added in case - which is the test D42 sets.
 */
export interface CategoryOption {
  readonly categoryId: number;
  readonly name: string;
}

export interface TaxSlabOption {
  readonly taxSlabId: number;
  readonly name: string;
  /** Total GST as exact text — `5.00`, not a float. */
  readonly totalRate: string;
}

/** One product as the single-product form holds it. */
export interface ProductDetail {
  readonly productId: number;
  readonly itemCode: string;
  readonly status: string;
  readonly values: CatalogueValues;
}

/* -------------------------------------------------------------------------
 * The bulk grid
 * ---------------------------------------------------------------------- */

export type MrpPolicy = 'keep' | 'recompute';

/** The columns a bulk change may set - price, tax slab and category. */
export type BulkField =
  'sale_price' | 'mrp' | 'purchase_price' | 'tax_rate' | 'category' | 'reorder_level';

export interface BulkChange {
  readonly field: BulkField;
  /** The new value as text, which is exactly what a grid cell holds. */
  readonly value: string;
  /**
   * For `tax_rate` only: whether the printed prices absorb the rate change
   * (`keep`) or pass it on (`recompute`). Defaults to `keep`.
   */
  readonly mrpPolicy?: MrpPolicy;
}

/* -------------------------------------------------------------------------
 * What a write reports back
 * ---------------------------------------------------------------------- */

export interface EditResult {
  readonly applied: number;
  readonly rejected: number;
  /**
   * Why each rejected row was left out. `RowIssue.line` is the row's 1-based
   * position in the request - the grid row the operator is looking at, or 1 for
   * a single form.
   */
  readonly issues: readonly RowIssue[];
  /** Products the change did not reach, in request order. */
  readonly rejectedProductIds: readonly number[];
  readonly categoriesCreated: readonly string[];
  readonly hsnCodesCreated: readonly string[];
}

export interface SaveResult extends EditResult {
  /** Null when the row was rejected, or when this was an update. */
  readonly productId: number | null;
}

export interface ImportReport {
  readonly dryRun: boolean;
  /** Data rows in the file, excluding the heading. */
  readonly totalRows: number;
  readonly imported: number;
  readonly rejected: number;
  readonly issues: readonly RowIssue[];
  readonly categoriesCreated: readonly string[];
  readonly hsnCodesCreated: readonly string[];
}

/* -------------------------------------------------------------------------
 * Requests
 * ---------------------------------------------------------------------- */

/**
 * Who is at the machine.
 *
 * Established by `signIn` and held by the main process, never by the renderer.
 * `preferredLanguage` comes along because it is part of the employee record;
 * nothing reads it yet.
 */
export interface SignedInEmployee {
  readonly employeeId: number;
  readonly empCode: string;
  readonly name: string;
  readonly roleName: string | null;
  /** `employees.preferred_language`, or null when they have not set one. */
  readonly preferredLanguage: string | null;
}

export interface SignInRequest {
  readonly employeeId: number;
}

/**
 * The parts of a write that say why and when.
 *
 * **`changedBy` is deliberately not here.** Every history row carries
 * `changed_by`, and that column is the whole of the answer to "who changed this
 * price". If the renderer supplied it, a screen could name anybody as the author
 * of a change - which is not an audit trail, it is a text field. The main
 * process takes it from whoever signed in, and a write with nobody signed in is
 * refused rather than recorded against nobody.
 *
 * `reason` is not optional and has no default. It lands on
 * `product_prices.reason` and `product_tax_assignments.reason`, and it is the
 * one field that distinguishes a change made from the grid from the same change
 * arriving in a file (D41) - a screen that did not collect it would make every
 * history row say nothing.
 */
export interface WriteContextRequest {
  readonly reason: string;
  /**
   * ISO 8601, or null for "now" - which the far side takes from the database
   * clock, never from the renderer's. A machine whose clock is eight minutes
   * fast would otherwise date every price change eight minutes into the future,
   * where nothing is in force (CLAUDE.md, Working practices).
   */
  readonly effectiveFrom: string | null;
}

export interface ListProductsRequest {
  readonly filter: ProductFilter;
}

export interface ListProductIdsRequest {
  readonly filter: ProductFilter;
}

export interface GetProductRequest {
  readonly productId: number;
}

export interface SaveProductRequest extends WriteContextRequest {
  /** Null creates; an id updates. The single-product form does both. */
  readonly productId: number | null;
  /** The whole row as the form holds it, not a patch. */
  readonly values: CatalogueValues;
}

export interface BulkEditRequest extends WriteContextRequest {
  /** In the order the grid shows them: `RowIssue.line` is a position in this. */
  readonly productIds: readonly number[];
  readonly change: BulkChange;
}

export interface ImportFileRequest {
  /** The file's contents. Reading it from disk is the renderer's job. */
  readonly text: string;
  readonly dryRun: boolean;
}

/* -------------------------------------------------------------------------
 * Results
 * ---------------------------------------------------------------------- */

/**
 * Every operation returns one of these rather than throwing.
 *
 * A thrown error does not survive IPC: the class is gone by the time it reaches
 * the renderer and the message is whatever Electron made of it. So a failure is
 * returned as data, carrying the key that names it - which is also the only way
 * a Hindi screen can render it in Hindi.
 *
 * A **rejected row is not a failure.** A file with thirty bad rows and a bulk
 * apply that skipped eight both succeed and report their issues in the value;
 * `ok: false` is for the whole operation coming apart - an unreadable file, a
 * product id that is not there, the database being down.
 */
export type CatalogueResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: CatalogueFailure };

export interface CatalogueFailure {
  /** What to show the operator, as a key and its numbers. */
  readonly message: TranslatableMessage;
  /**
   * For the log and the diagnostics bundle, never for the screen. English, and
   * whatever the far side knew - a constraint name, a stack. Null when there is
   * nothing beyond the message.
   */
  readonly detail: string | null;
}

/* -------------------------------------------------------------------------
 * The contract
 * ---------------------------------------------------------------------- */

/**
 * What the product master can ask for. One method per thing a view does:
 * `listProducts` and `listProductIds` for the list, `getProduct` and
 * `saveProduct` for the single-product form, `bulkEdit` for the grid, and
 * `importCatalogueFile` for the import screen.
 *
 * The renderer holds one of these backed by IPC; the main process holds one
 * backed by a database session; a test holds one backed by a rolled-back
 * transaction. All three are the same type, which is what makes it possible to
 * test the boundary without an Electron window open.
 */
export interface CatalogueApi {
  /** Everyone who could be at the machine, for the sign-in list. Active only. */
  listEmployees(): Promise<CatalogueResult<readonly SignedInEmployee[]>>;
  /** Establishes who is making changes. Every write depends on it. */
  signIn(request: SignInRequest): Promise<CatalogueResult<SignedInEmployee>>;
  signOut(): Promise<CatalogueResult<null>>;
  /** Null when nobody is signed in, which is the state the app starts in. */
  currentEmployee(): Promise<CatalogueResult<SignedInEmployee | null>>;
  listProducts(request: ListProductsRequest): Promise<CatalogueResult<ProductPage>>;
  /** Categories in use, for the list view's filter. */
  listCategories(): Promise<CatalogueResult<readonly CategoryOption[]>>;
  /** Slabs in force, for the list view's filter and the bulk grid's choices. */
  listTaxSlabs(): Promise<CatalogueResult<readonly TaxSlabOption[]>>;
  /** Every id the filter matches, for "apply to all matching". */
  listProductIds(request: ListProductIdsRequest): Promise<CatalogueResult<readonly number[]>>;
  getProduct(request: GetProductRequest): Promise<CatalogueResult<ProductDetail>>;
  saveProduct(request: SaveProductRequest): Promise<CatalogueResult<SaveResult>>;
  bulkEdit(request: BulkEditRequest): Promise<CatalogueResult<EditResult>>;
  importCatalogueFile(request: ImportFileRequest): Promise<CatalogueResult<ImportReport>>;
}

/**
 * The IPC channel each method travels on.
 *
 * Named here so the handler and the caller cannot disagree about the string.
 * A channel name is the one part of an IPC call TypeScript cannot check for
 * you - a typo compiles cleanly on both sides and fails at runtime, in the
 * shop, as a call that never returns.
 */
export const CATALOGUE_CHANNELS = {
  listEmployees: 'catalogue:list-employees',
  signIn: 'catalogue:sign-in',
  signOut: 'catalogue:sign-out',
  currentEmployee: 'catalogue:current-employee',
  listProducts: 'catalogue:list-products',
  listCategories: 'catalogue:list-categories',
  listTaxSlabs: 'catalogue:list-tax-slabs',
  listProductIds: 'catalogue:list-product-ids',
  getProduct: 'catalogue:get-product',
  saveProduct: 'catalogue:save-product',
  bulkEdit: 'catalogue:bulk-edit',
  importCatalogueFile: 'catalogue:import-file',
} as const satisfies Record<keyof CatalogueApi, string>;

export type CatalogueChannel = (typeof CATALOGUE_CHANNELS)[keyof typeof CATALOGUE_CHANNELS];

/** Convenience for the `ok: false` case, so no caller writes the shape out. */
export function catalogueFailure(
  messageKey: TranslationKey,
  params: MessageParams = {},
  detail: string | null = null,
): CatalogueResult<never> {
  return { ok: false, failure: { message: { messageKey, params }, detail } };
}

/** The same for the `ok: true` case. */
export function catalogueValue<T>(value: T): CatalogueResult<T> {
  return { ok: true, value };
}
