/**
 * `COALESCE(name_hi, name)`, on the database side.
 *
 * Invariant 20 in the one place it has to be spelled in SQL: a query that
 * *selects* a bilingual column, and more importantly one that orders or
 * searches by it. The TypeScript half is `localisedText` in `@ssbazar/shared`,
 * for rows already in hand.
 *
 * Both halves have to exist, and they are not interchangeable. A product list
 * sorted in Postgres by `name` and then displayed as `name_hi` comes back in an
 * order the eye cannot follow: the customer asks for आटा, the cashier sees it
 * at the top of the screen, and the row is actually filed under "Atta" three
 * screens down. The sort key has to be the string being shown.
 *
 * Why not a view or a generated column, which would be tidier: because the
 * expression depends on who is looking. `display_name` cannot be one stored
 * column when the same row is Hindi for one cashier and English for the next,
 * and a pair of views doubles every future migration that touches products.
 *
 * Interpolating SQL from an argument is normally how injection happens. It is
 * safe here and only here because nothing user-supplied reaches it: the column
 * names are literals written at the call site, and `language` is a two-value
 * union the type system will not widen. Anything arriving as text has gone
 * through `parseLanguage` long before this.
 */

import type { Language } from '@ssbazar/shared';

/**
 * The expression to select or sort by.
 *
 * `NULLIF(btrim(...), '')` rather than a bare `COALESCE`, because a spreadsheet
 * import produces an empty cell far more often than it produces NULL - somebody
 * tabbed through the Hindi column - and `COALESCE` alone would take the empty
 * string happily and print a product with no name on it.
 */
export function localisedColumn(
  language: Language,
  hindiColumn: string,
  englishColumn: string,
): string {
  if (language !== 'hi') return englishColumn;
  return `COALESCE(NULLIF(btrim(${hindiColumn}), ''), ${englishColumn})`;
}

/** `localisedColumn(...) AS alias`, for a SELECT list. */
export function localisedColumnAs(
  language: Language,
  hindiColumn: string,
  englishColumn: string,
  alias: string,
): string {
  return `${localisedColumn(language, hindiColumn, englishColumn)} AS ${alias}`;
}

/** The display name of a product, in whichever language was asked for. */
export function productNameColumn(language: Language, table = 'p'): string {
  return localisedColumn(language, `${table}.name_hi`, `${table}.name`);
}

/** The short name, which is what fits on a receipt line and a shelf label. */
export function productShortNameColumn(language: Language, table = 'p'): string {
  return localisedColumn(language, `${table}.short_name_hi`, `${table}.short_name`);
}

export function categoryNameColumn(language: Language, table = 'c'): string {
  return localisedColumn(language, `${table}.name_hi`, `${table}.name`);
}

export function unitNameColumn(language: Language, table = 'u'): string {
  return localisedColumn(language, `${table}.name_hi`, `${table}.name`);
}

export function unitShortNameColumn(language: Language, table = 'u'): string {
  return localisedColumn(language, `${table}.short_name_hi`, `${table}.short_name`);
}
