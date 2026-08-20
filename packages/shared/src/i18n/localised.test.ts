import { describe, expect, it } from 'vitest';

import { hasDevanagari, localisedText, needsDevanagari } from './localised.js';

/**
 * Invariant 20 - `COALESCE(name_hi, name)` - and the invariant 21 question that
 * rides on it.
 *
 * D20 is a trade the client made deliberately: Hindi columns are nullable so he
 * fills the few hundred items that matter instead of doubling his catalogue
 * data entry. Every one of these cases is therefore the normal case, not an
 * edge: most products have no `name_hi` and never will.
 */

describe('localisedText', () => {
  it('shows the Hindi name to a Hindi user', () => {
    expect(localisedText('hi', { en: 'Basmati Rice', hi: 'बासमती चावल' })).toBe('बासमती चावल');
  });

  it('falls back to English when the Hindi name is absent', () => {
    expect(localisedText('hi', { en: 'Toor Dal', hi: null })).toBe('Toor Dal');
    expect(localisedText('hi', { en: 'Toor Dal' })).toBe('Toor Dal');
  });

  it('falls back when the Hindi name is blank or only whitespace', () => {
    // `COALESCE` alone would not catch either. A spreadsheet import produces an
    // empty cell far more often than it produces NULL - a column somebody
    // tabbed through - and a product whose Hindi name is one space prints as
    // nothing at all on a raster receipt.
    expect(localisedText('hi', { en: 'Sugar', hi: '' })).toBe('Sugar');
    expect(localisedText('hi', { en: 'Sugar', hi: '   ' })).toBe('Sugar');
  });

  it('never falls the other way', () => {
    // English is English even where a Hindi name exists. The fallback runs one
    // direction only, or a shop set to English starts printing Devanagari on
    // its fast-path receipts and pays the raster cost it opted out of.
    expect(localisedText('en', { en: 'Basmati Rice', hi: 'बासमती चावल' })).toBe('Basmati Rice');
  });
});

describe('needsDevanagari', () => {
  it('is true when a Hindi user has at least one Hindi name on the document', () => {
    expect(needsDevanagari('hi', [{ en: 'Rice', hi: 'चावल' }, { en: 'Soap' }])).toBe(true);
  });

  it('is false for a Hindi user whose lines have no Hindi names', () => {
    // The mitigation D20 exists for, and the reason invariant 21 is phrased
    // about lines rather than about the user. A Hindi-speaking cashier ringing
    // up items that carry no `name_hi` prints entirely in Latin and must stay
    // in fast text mode: raster costs 3-4 seconds a bill, which is about an
    // hour of queue time a day at this volume.
    expect(needsDevanagari('hi', [{ en: 'Soap' }, { en: 'Rice', hi: '  ' }])).toBe(false);
  });

  it('is false for an English user however the products are filled in', () => {
    expect(needsDevanagari('en', [{ en: 'Rice', hi: 'चावल' }])).toBe(false);
  });
});

describe('hasDevanagari', () => {
  it('finds Devanagari wherever it appears', () => {
    expect(hasDevanagari('चावल')).toBe(true);
    expect(hasDevanagari('Rice चावल 5kg')).toBe(true);
  });

  it('is false for Latin, digits and rupee amounts', () => {
    expect(hasDevanagari('Basmati Rice 5kg')).toBe(false);
    expect(hasDevanagari('₹ 1,234.50')).toBe(false);
  });
});
