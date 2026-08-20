import { describe, expect, it } from 'vitest';

import { CATALOGUES } from './catalogue.js';
import { pluralCategory } from './plural.js';
import { createTranslator, translate } from './translator.js';

/**
 * The translator's behaviour under the conditions it will actually meet: a
 * missing Hindi key, a missing parameter, a count of zero.
 *
 * All three are degradation paths rather than happy paths, and all three are on
 * the billing screen, so the thing being asserted throughout is that nothing
 * throws. A translator that threw would take the till down over a typo in a
 * file nobody compiles, in the middle of the evening rush.
 */

describe('translate', () => {
  it('returns the message for the language asked for', () => {
    expect(translate('en', 'cli.reconcile.clean')).toBe('clean');
    expect(translate('hi', 'cli.reconcile.clean')).toBe('कोई अंतर नहीं');
  });

  it('splices parameters into the message', () => {
    expect(translate('en', 'cli.migrate.would_apply', { filename: '007_locations.sql' })).toBe(
      'would apply 007_locations.sql',
    );
  });

  it('leaves an unfilled placeholder standing rather than blanking it', () => {
    // "Bill discount {amount} is not a positive amount" is a bug report.
    // "Bill discount  is not a positive amount" is a mystery.
    expect(translate('en', 'error.tax.bill.discount_invalid', {})).toContain('{amount}');
  });

  it('never throws on a key that does not resolve', () => {
    // Not reachable from typed code - TranslationKey is derived from en.json -
    // but reachable from a key assembled at runtime, and the till must survive
    // it. The key comes back, which is at least searchable.
    const key = 'nothing.like.this' as Parameters<typeof translate>[1];

    expect(translate('en', key)).toBe('nothing.like.this');
  });

  describe('plurals', () => {
    it('picks the English form on n = 1 and the other form otherwise', () => {
      expect(translate('en', 'cli.migrate.done', { count: 1 })).toBe('done: 1 migration applied');
      expect(translate('en', 'cli.migrate.done', { count: 3 })).toBe('done: 3 migrations applied');
      expect(translate('en', 'cli.migrate.done', { count: 0 })).toBe('done: 0 migrations applied');
    });

    it('gives Hindi the singular at zero, which English does not', () => {
      // CLDR hi: `one` covers i = 0 and 1. Getting this wrong is not a crash,
      // it is a line that reads slightly wrong on every report, forever.
      expect(pluralCategory('hi', 0)).toBe('one');
      expect(pluralCategory('en', 0)).toBe('other');

      expect(pluralCategory('hi', 1)).toBe('one');
      expect(pluralCategory('hi', 2)).toBe('other');
    });

    it('treats a fractional count as plural in both languages', () => {
      // "0.5 kg" must not take the singular, in either language.
      expect(pluralCategory('hi', 0.5)).toBe('other');
      expect(pluralCategory('en', 0.5)).toBe('other');
    });

    it('falls back to the plural form when no count is given', () => {
      expect(translate('en', 'cli.migrate.done')).toBe('done: {count} migrations applied');
    });
  });

  describe('falling back', () => {
    it('uses English when a key is missing from hi.json', () => {
      // Mirrors invariant 20 at the string level: Hindi is allowed to lag, the
      // same way `name_hi` is allowed to be NULL. `catalogue.test.ts` asserts
      // that it does not lag today; this asserts what the till does on the day
      // somebody adds a key and only fills in one file.
      //
      // The gap has to be made rather than found, precisely because the parity
      // test forbids a real one. Removing it from the loaded catalogue and
      // putting it back is the only way to walk the path the code would
      // actually take.
      const hindi = CATALOGUES.hi as { cli: { reconcile: { clean?: unknown } } };
      const removed = hindi.cli.reconcile.clean;

      try {
        delete hindi.cli.reconcile.clean;

        expect(translate('hi', 'cli.reconcile.clean')).toBe('clean');
      } finally {
        hindi.cli.reconcile.clean = removed;
      }

      expect(translate('hi', 'cli.reconcile.clean')).toBe('कोई अंतर नहीं');
    });
  });
});

describe('createTranslator', () => {
  it('binds a language and carries it', () => {
    const t = createTranslator('hi');

    expect(t.language).toBe('hi');
    expect(t('cli.reconcile.clean')).toBe('कोई अंतर नहीं');
  });

  it('resolves the same as the standalone form', () => {
    const t = createTranslator('en');

    expect(t('cli.catalogue.dry_run_note')).toBe(translate('en', 'cli.catalogue.dry_run_note'));
  });
});
