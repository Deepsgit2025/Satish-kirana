/**
 * `COALESCE(name_hi, name)`, in TypeScript.
 *
 * Invariant 20 and `docs/DECISIONS.md` D20: the Hindi columns are nullable and
 * fall back to English when blank, so the client fills Hindi names for the few
 * hundred items that matter rather than doubling his catalogue data entry. That
 * is a deliberate trade, and it means every read of a bilingual column has a
 * fallback in it. This is that fallback, written once.
 *
 * Two forms, because the fallback has to happen in two places and they are not
 * interchangeable:
 *
 *   **In SQL**, when the database is picking or ordering - a product search
 *   sorted by name has to sort by the name being shown, or the results come
 *   back in an order the customer's eye cannot follow. See the server's
 *   `localisedColumn`.
 *
 *   **In TypeScript**, here, when a row is already in hand carrying both
 *   columns - the offline SQLite cache on the counters keeps both, and the
 *   receipt renderer needs `name_hi` separately anyway to decide between text
 *   and raster mode (invariant 21).
 *
 * "Blank" means NULL *or* empty *or* whitespace. `COALESCE` alone only catches
 * NULL, and a spreadsheet import produces `''` far more often than it produces
 * NULL - a cell somebody tabbed through. A product whose Hindi name is one
 * space is a product that prints as nothing at all on a raster receipt.
 */

import type { Language } from './language.js';

/** A value that has an English form and an optional Hindi one. */
export interface LocalisedText {
  readonly en: string;
  readonly hi?: string | null | undefined;
}

/** Narrows as well as answers, so a caller that checked can then use it. */
function hasText(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value.trim().length > 0;
}

/**
 * The form to show. English is returned for `language: 'en'` even when a Hindi
 * value exists - the fallback runs one way only.
 */
export function localisedText(language: Language, text: LocalisedText): string {
  if (language === 'hi' && hasText(text.hi)) return text.hi;
  return text.en;
}

/**
 * Whether this text will actually print in Devanagari, which is what decides
 * raster versus text mode on a receipt (invariant 21, `docs/plan.md` Part 2).
 *
 * Note what it is *not*: it is not "the language is Hindi". A bill rung up by a
 * Hindi-speaking cashier whose items all lack `name_hi` prints entirely in
 * Latin and must stay in fast text mode. The question is about the strings on
 * the document, not about the person holding the terminal - and at 1,000 bills
 * a day the difference is about an hour of queue time.
 */
export function needsDevanagari(language: Language, texts: readonly LocalisedText[]): boolean {
  return language === 'hi' && texts.some((text) => hasText(text.hi));
}

/**
 * Any string carrying a Devanagari codepoint, whatever language was asked for.
 *
 * Asked of the string rather than of the setting, because the two disagree
 * often: a store running in English still holds `name_hi` on the products the
 * client bothered to fill in, and one of those on a bill is what pushes the
 * receipt into raster mode (invariant 21).
 *
 * By script property rather than by codepoint range, so the extended blocks -
 * `Devanagari_Ext`, and `Devanagari_Ext_A` from Unicode 15.1 - come along
 * without this line having to list them.
 */
export function hasDevanagari(value: string): boolean {
  return /\p{Script=Devanagari}/u.test(value);
}
