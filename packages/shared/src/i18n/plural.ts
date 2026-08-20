/**
 * Which of a message's two forms a count selects.
 *
 * English and Hindi have the same *set* of cardinal categories - CLDR gives
 * both `one` and `other` and nothing else - but not the same rule for choosing
 * between them, and the difference shows up on the first screen that reports a
 * count of zero:
 *
 *   en   0 → other   "0 rows rejected"
 *   hi   0 → one     "0 पंक्ति अस्वीकृत"
 *
 * Hindi's `one` covers i = 0 or 1: zero takes the singular. Getting this wrong
 * is not a crash, it is a line of Hindi that reads slightly wrong on every
 * report, forever, and nobody files a bug about it.
 *
 * Two languages, two rules, written out rather than pulled from `Intl`.
 * `Intl.PluralRules` would give the same answers, but it is an API whose data
 * ships with the runtime, and this system is meant to still be printing the
 * same receipts in eight years on whatever Node it is pinned to then.
 */

import type { Language } from './language.js';

export type PluralCategory = 'one' | 'other';

export function pluralCategory(language: Language, count: number): PluralCategory {
  const integer = Math.abs(Math.trunc(count));
  const isWhole = Number.isInteger(count);

  switch (language) {
    // CLDR hi: one ↔ i = 0..1 and v = 0. A fractional count is always `other`,
    // so "0.5 kg" does not take the singular.
    case 'hi':
      return isWhole && integer <= 1 ? 'one' : 'other';
    // CLDR en: one ↔ i = 1 and v = 0.
    case 'en':
      return isWhole && integer === 1 ? 'one' : 'other';
  }
}
