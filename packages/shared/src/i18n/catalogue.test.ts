import { describe, expect, it } from 'vitest';

import en from './locales/en.json' with { type: 'json' };
import hi from './locales/hi.json' with { type: 'json' };
import { CATALOGUES, collectKeys, lookupMessage, type MessageTree } from './catalogue.js';
import { LANGUAGES } from './language.js';
import { translate } from './translator.js';

/**
 * The catalogue's own integrity, which nothing else can check.
 *
 * `TranslationKey` already makes a key that is not in `en.json` a compile
 * error, so nothing here needs to guard that. What the type system cannot see
 * is the *other* file: `hi.json` is an ordinary JSON file that no TypeScript
 * ever imports for its shape, and a key missing from it degrades silently to
 * English at the till. Silently is the problem - it looks like it works.
 *
 * Placeholder parity is the same class of failure one level down. A Hindi
 * sentence that drops `{count}` reads perfectly and reports nothing, and the
 * number the cashier needed is simply not on the screen.
 */

const flatten = (tree: MessageTree): string[] => collectKeys(tree);

describe('the message catalogues', () => {
  it('has the same keys in both languages', () => {
    // Not `toEqual` on the sets: the diff on a missing key is the whole
    // diagnosis, and a set difference prints it as a list.
    const english = flatten(en);
    const hindi = flatten(hi);

    expect(english.filter((key) => !hindi.includes(key))).toEqual([]);
    expect(hindi.filter((key) => !english.includes(key))).toEqual([]);
  });

  it('has the same plural forms in both languages', () => {
    for (const key of flatten(en)) {
      const english = lookupMessage(en, key);
      const hindi = lookupMessage(hi, key);

      expect(typeof english, key).toBe(typeof hindi);
    }
  });

  it('uses the same placeholders in both languages', () => {
    const placeholders = (message: unknown): string[] =>
      [...JSON.stringify(message).matchAll(/\{(\w+)\}/gu)]
        .map((match) => match[1] ?? '')
        .sort((a, b) => a.localeCompare(b, 'en'));

    for (const key of flatten(en)) {
      // A Hindi sentence that dropped {count} would read fine and be wrong -
      // there is no other way to catch that.
      expect(placeholders(lookupMessage(hi, key)), key).toEqual(
        placeholders(lookupMessage(en, key)),
      );
    }
  });

  it('leaves no message empty in either language', () => {
    for (const language of LANGUAGES) {
      for (const key of flatten(CATALOGUES[language])) {
        const message = lookupMessage(CATALOGUES[language], key);
        const forms = typeof message === 'string' ? [message] : [message?.one, message?.other];

        for (const form of forms) expect(form?.trim(), `${language}:${key}`).toBeTruthy();
      }
    }
  });

  it('writes every Hindi message in Devanagari or in a term that stays Latin', () => {
    // A Hindi entry that is still the English sentence is the failure this
    // catches - a placeholder somebody meant to come back to. Latin-only
    // entries do exist and are correct (GST, HSN, npm commands, `ms`), so the
    // test asks for Devanagari only where the English has real prose in it.
    const untranslated: string[] = [];

    for (const key of flatten(hi)) {
      const english = lookupMessage(en, key);
      const hindi = lookupMessage(hi, key);
      if (typeof english !== 'string' || typeof hindi !== 'string') continue;

      // Prose means at least three separate runs of letters. "ok" and
      // "(default database)" are not sentences; "A bill needs at least one
      // line" is.
      const words = english.match(/\p{L}{2,}/gu) ?? [];
      if (words.length < 3) continue;

      if (!/\p{Script=Devanagari}/u.test(hindi)) untranslated.push(key);
    }

    expect(untranslated).toEqual([]);
  });

  it('resolves a key to its sentence in each language', () => {
    // One end-to-end case, so the mapping is not vacuous: the keys the
    // validator now reports really do land on the words the client reads.
    expect(translate('en', 'catalogue.issue.hsn_not_six_digits')).toBe('must be exactly 6 digits');
    expect(translate('hi', 'catalogue.issue.hsn_not_six_digits')).toBe('ठीक 6 अंकों का होना चाहिए');
  });
});
