import {
  type BulkEditRequest,
  type CatalogueApi,
  catalogueFailure,
  type CatalogueResult,
  catalogueValue,
  type EditResult,
  type GetProductRequest,
  type ImportFileRequest,
  type ImportReport,
  isTranslatableError,
  type ListProductIdsRequest,
  type ListProductsRequest,
  type ProductDetail,
  type ProductPage,
  type SaveProductRequest,
  type CategoryOption,
  type SaveResult,
  type TaxSlabOption,
  type SignedInEmployee,
  type SignInRequest,
} from '@ssbazar/shared';

import type { SessionRunner } from '../db/session.js';
import { describeError } from '../describe-error.js';
import { findActiveEmployee, listActiveEmployees } from './employees.js';
import { importCatalogue } from './import.js';
import {
  applyBulkEdit,
  createProduct,
  type EditOptions,
  ProductEditError,
  readProductDetail,
  updateProduct,
} from './product-edit.js';
import {
  listCategories,
  listTaxSlabs,
  searchProductIds,
  searchProducts,
} from './product-search.js';

/**
 * The catalogue contract, implemented against a database session.
 *
 * This is the far side of the boundary `@ssbazar/shared/catalogue/contract`
 * declares (docs/DECISIONS.md D42). It lives here rather than in shared for one
 * reason: everything it calls takes a `Queryable`, and `packages/shared` is
 * bundled into the renderer and the counter app, neither of which may carry a
 * `pg` dependency - the renderer having a database connection is precisely the
 * shortcut the boundary exists to close off.
 *
 * **There is no logic below.** Every method unpacks a request, calls the step-7
 * core, and wraps what comes back. It does exactly three things the core does
 * not, and each is a property of the wire rather than of the catalogue:
 *
 *   1. **Opens a session per call**, through the `SessionRunner` the caller
 *      supplies, so one IPC call is one transaction. The core deliberately does
 *      no transaction handling.
 *   2. **Parses `effectiveFrom` from ISO text**, once, here. `Date` does not
 *      survive JSON, and `null` means "now" - which the core takes from the
 *      *database* clock, never from the renderer's.
 *   3. **Turns a thrown error into a returned failure.** A thrown error does not
 *      survive IPC with its class or its translation key intact, so it is
 *      converted while both are still in hand.
 *
 * If a rule ever appears in this file, it has been copied out of the validator
 * and the two will drift - which is D41's failure at the UI boundary instead of
 * between the screen and the importer.
 */

/** Re-exported so a caller needs one import to hold the boundary and drive it. */
export type { SessionRunner };

/** ISO text to a `Date`, or a failure naming the value that would not parse. */
function parseEffectiveFrom(iso: string | null): { at?: Date; bad?: string } {
  if (iso === null) return {};

  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return { bad: iso };
  return { at };
}

/**
 * Builds the `EditOptions` a write takes from the wire fields that describe it.
 *
 * `effectiveFrom` is omitted rather than set to undefined when the request says
 * "now": `exactOptionalPropertyTypes` is on, and the core's default - reading
 * the database clock - only applies to a property that is genuinely absent.
 */
function editOptions(reason: string, changedBy: number, at: Date | undefined): EditOptions {
  const base = { reason, changedBy };
  return at === undefined ? base : { ...base, effectiveFrom: at };
}

/**
 * Runs one operation, converting anything thrown into a returned failure.
 *
 * A `TranslatableError` already carries the key and numbers a person needs -
 * an unreadable CSV, a rate with two slabs in force - so it passes through
 * whole and the renderer translates it (invariant 19, D39). Anything else is a
 * fault the operator can do nothing about: they get one sentence saying nothing
 * changed, and the real text goes to `detail` for the log and the diagnostics
 * bundle, in English, where whoever is supporting the shop will read it.
 */
async function attempt<T>(work: () => Promise<T>): Promise<CatalogueResult<T>> {
  try {
    return catalogueValue(await work());
  } catch (error) {
    if (isTranslatableError(error)) {
      // Copied into a plain object, never passed on as the Error itself. A
      // `TranslatableError` satisfies `TranslatableMessage` structurally, so
      // returning it typechecks and works in process - and then loses
      // `messageKey` and `params` crossing IPC, because structured clone gives
      // Errors special treatment and keeps only name, message and stack. The
      // renderer receives `{}` and can say nothing to the operator.
      return catalogueFailure(error.messageKey, error.params, describeError(error));
    }
    if (error instanceof ProductEditError) {
      return catalogueFailure('error.catalogue.no_such_product', {}, describeError(error));
    }
    return catalogueFailure('error.catalogue.request_failed', {}, describeError(error));
  }
}

/**
 * The catalogue contract over `run`.
 *
 * One of these is held by the main process and handed to the IPC handlers; the
 * renderer holds a twin backed by `ipcRenderer.invoke`. Both satisfy
 * `CatalogueApi`, so the screens cannot tell which one they have - and a test
 * can give them the real one.
 */
export function createCatalogueApi(run: SessionRunner): CatalogueApi {
  /**
   * Who is signed in, held here and nowhere the renderer can reach.
   *
   * One employee at a time: the office machine is one desk with one person at
   * it. When that stops being true it becomes a per-window session, and this is
   * the line that changes.
   */
  let employee: SignedInEmployee | null = null;

  /** The author of a write, or a refusal. Never a default, never null. */
  function author(): number | CatalogueResult<never> {
    if (employee === null) return catalogueFailure('error.catalogue.not_signed_in');
    return employee.employeeId;
  }

  return {
    async listEmployees(): Promise<CatalogueResult<readonly SignedInEmployee[]>> {
      return attempt(async () => run((db) => listActiveEmployees(db)));
    },

    async signIn(request: SignInRequest): Promise<CatalogueResult<SignedInEmployee>> {
      const found = await attempt(async () =>
        run((db) => findActiveEmployee(db, request.employeeId)),
      );
      if (!found.ok) return found;
      if (found.value === null) return catalogueFailure('error.catalogue.unknown_employee');

      employee = found.value;
      return catalogueValue(employee);
    },

    async signOut(): Promise<CatalogueResult<null>> {
      employee = null;
      return Promise.resolve(catalogueValue(null));
    },

    async currentEmployee(): Promise<CatalogueResult<SignedInEmployee | null>> {
      return Promise.resolve(catalogueValue(employee));
    },

    async listProducts(request: ListProductsRequest): Promise<CatalogueResult<ProductPage>> {
      return attempt(async () => run((db) => searchProducts(db, request.filter)));
    },

    async listCategories(): Promise<CatalogueResult<readonly CategoryOption[]>> {
      return attempt(async () => run((db) => listCategories(db)));
    },

    async listTaxSlabs(): Promise<CatalogueResult<readonly TaxSlabOption[]>> {
      return attempt(async () => run((db) => listTaxSlabs(db)));
    },

    async listProductIds(
      request: ListProductIdsRequest,
    ): Promise<CatalogueResult<readonly number[]>> {
      return attempt(async () => run((db) => searchProductIds(db, request.filter)));
    },

    async getProduct(request: GetProductRequest): Promise<CatalogueResult<ProductDetail>> {
      return attempt(async () => run((db) => readProductDetail(db, request.productId)));
    },

    async saveProduct(request: SaveProductRequest): Promise<CatalogueResult<SaveResult>> {
      const changedBy = author();
      if (typeof changedBy !== 'number') return changedBy;

      const { at, bad } = parseEffectiveFrom(request.effectiveFrom);
      if (bad !== undefined)
        return catalogueFailure('error.catalogue.invalid_date', { value: bad });

      return attempt(async () =>
        run(async (db) => {
          const options = editOptions(request.reason, changedBy, at);
          const { productId } = request;

          // Null creates, an id updates. The single-product form does both, so
          // the contract has one method rather than making the screen choose.
          if (productId === null) return createProduct(db, request.values, options);

          const result = await updateProduct(db, productId, request.values, options);
          // The id that was saved, so the screen has it either way. Null only
          // when the row was rejected and nothing was written.
          return { ...result, productId: result.applied > 0 ? productId : null };
        }),
      );
    },

    async bulkEdit(request: BulkEditRequest): Promise<CatalogueResult<EditResult>> {
      const changedBy = author();
      if (typeof changedBy !== 'number') return changedBy;

      const { at, bad } = parseEffectiveFrom(request.effectiveFrom);
      if (bad !== undefined)
        return catalogueFailure('error.catalogue.invalid_date', { value: bad });

      return attempt(async () =>
        run((db) =>
          applyBulkEdit(
            db,
            { productIds: request.productIds, change: request.change },
            editOptions(request.reason, changedBy, at),
          ),
        ),
      );
    },

    async importCatalogueFile(request: ImportFileRequest): Promise<CatalogueResult<ImportReport>> {
      // A dry run writes nothing and has no author to record, so it is the one
      // route here that does not need somebody signed in. Importing does.
      const changedBy = request.dryRun ? null : author();
      if (typeof changedBy === 'object' && changedBy !== null) return changedBy;

      return attempt(async () =>
        run((db) =>
          importCatalogue(db, request.text, {
            dryRun: request.dryRun,
            changedBy: typeof changedBy === 'number' ? changedBy : null,
          }),
        ),
      );
    },
  };
}
