/**
 * Which language a given person sees, and how that is decided.
 *
 * The chain is fixed by `docs/plan.md` Part 2 and by the column comment on
 * `employees.preferred_language`:
 *
 *   employees.preferred_language  →  app_settings.default_language  →  'en'
 *
 * Every step of it is allowed to be absent or wrong. `preferred_language` is
 * nullable by design - most staff never open the setting. `default_language`
 * lives in `app_settings.value`, which is TEXT holding every setting in the
 * system, so nothing at the database level stops it being `'', 'EN', 'english'`
 * or a typo somebody made in a settings screen at eight in the evening.
 *
 * So resolution never throws and never returns undefined. A language the system
 * does not have is not an error worth stopping a sale for; it is a reason to
 * fall through to the next step. The last step is a constant, which is what
 * makes the whole chain total.
 */

export const LANGUAGES = ['en', 'hi'] as const;

export type Language = (typeof LANGUAGES)[number];

/**
 * Where the chain ends. English rather than Hindi because it is the language
 * every string is written in first - `hi.json` falls back to `en.json` key by
 * key, so English is the only one guaranteed complete.
 */
export const FALLBACK_LANGUAGE: Language = 'en';

/** Endonyms: a language picker shows each language in that language. */
export const LANGUAGE_NAMES: Readonly<Record<Language, string>> = {
  en: 'English',
  hi: 'हिन्दी',
};

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}

/**
 * Reads a language out of whatever a column, an environment variable or a
 * command line actually contained. Returns null for anything unrecognised, so
 * the caller decides what the next fallback is rather than having 'en'
 * substituted underneath it.
 *
 * Tolerant about case and surrounding whitespace only. `'hindi'` and `'hi-IN'`
 * are *not* accepted: they are a settings screen writing something this system
 * does not define, and quietly guessing at them is how a value nobody can
 * explain ends up in the database.
 */
export function parseLanguage(value: unknown): Language | null {
  if (typeof value !== 'string') return null;
  const normalised = value.trim().toLowerCase();
  return isLanguage(normalised) ? normalised : null;
}

export interface LanguagePreferences {
  /** `employees.preferred_language` for the signed-in user. NULL is normal. */
  readonly employeePreference?: unknown;
  /** `app_settings.default_language`. */
  readonly storeDefault?: unknown;
}

/**
 * The chain, in one place, so the counter, the office and the server cannot
 * disagree about whose preference wins.
 */
export function resolveLanguage(preferences: LanguagePreferences = {}): Language {
  return (
    parseLanguage(preferences.employeePreference) ??
    parseLanguage(preferences.storeDefault) ??
    FALLBACK_LANGUAGE
  );
}
