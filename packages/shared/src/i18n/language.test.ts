import { describe, expect, it } from 'vitest';

import { FALLBACK_LANGUAGE, isLanguage, parseLanguage, resolveLanguage } from './language.js';

/**
 * The resolution chain, and specifically its behaviour on bad input.
 *
 * `employees.preferred_language` is a real enum and cannot hold rubbish.
 * `app_settings.default_language` is a row in a key/value table whose `value`
 * column is TEXT holding every setting in the system, so nothing at the
 * database level stops a settings screen writing `'EN'`, `'english'` or `''`
 * into it. Everything below is about that column.
 */

describe('parseLanguage', () => {
  it('reads the two languages the system has', () => {
    expect(parseLanguage('en')).toBe('en');
    expect(parseLanguage('hi')).toBe('hi');
  });

  it('tolerates case and surrounding whitespace', () => {
    // Both are what a settings screen or a hand-edited row produces.
    expect(parseLanguage(' HI ')).toBe('hi');
    expect(parseLanguage('En')).toBe('en');
  });

  it('refuses anything else rather than guessing', () => {
    // `hindi` and `hi-IN` are a settings screen writing something this system
    // does not define. Quietly accepting them is how a value nobody can explain
    // ends up in the database and outlives the person who put it there.
    expect(parseLanguage('hindi')).toBeNull();
    expect(parseLanguage('hi-IN')).toBeNull();
    expect(parseLanguage('')).toBeNull();
    expect(parseLanguage(null)).toBeNull();
    expect(parseLanguage(undefined)).toBeNull();
    expect(parseLanguage(7)).toBeNull();
  });
});

describe('resolveLanguage', () => {
  it('prefers the employee over the store default', () => {
    expect(resolveLanguage({ employeePreference: 'hi', storeDefault: 'en' })).toBe('hi');
  });

  it('falls through to the store default when the employee has no preference', () => {
    // The normal case. `preferred_language` is nullable because most staff
    // never open the setting.
    expect(resolveLanguage({ employeePreference: null, storeDefault: 'hi' })).toBe('hi');
  });

  it('falls through to English when neither is set', () => {
    expect(resolveLanguage({})).toBe(FALLBACK_LANGUAGE);
    expect(resolveLanguage()).toBe('en');
  });

  it('steps past an unreadable value instead of stopping on it', () => {
    // The whole reason the chain is total. A cashier does not get an error
    // because somebody typed 'english' into a settings box eight months ago.
    expect(resolveLanguage({ employeePreference: 'english', storeDefault: 'hi' })).toBe('hi');
    expect(resolveLanguage({ employeePreference: 'english', storeDefault: 'urdu' })).toBe('en');
  });
});

describe('isLanguage', () => {
  it('narrows only the exact codes', () => {
    expect(isLanguage('en')).toBe(true);
    expect(isLanguage('HI')).toBe(false);
    expect(isLanguage(null)).toBe(false);
  });
});
