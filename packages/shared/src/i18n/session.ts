/**
 * Everything an app needs to render in one language, resolved once.
 *
 * A screen wants three things together and always the same three: which
 * language it is in, how to say something in it, and which fonts to ask for.
 * Handing them out separately is how they drift - a component that resolves the
 * language for itself and a stylesheet that resolved it earlier disagree the
 * first time somebody changes the setting without reloading.
 *
 * Built from values rather than from a database, deliberately. The counters are
 * offline-first: they bill through a server outage, so the language has to come
 * from the local SQLite cache's mirror of `employees.preferred_language` and
 * `app_settings.default_language`, not from a query that may not answer. Both
 * arrive here as `unknown` because that is what a cache row is - the mirror can
 * hold whatever was last synced, including a value written before this version
 * of the app existed. `resolveLanguage` is total, so neither can fail.
 *
 * In step 7 this is what a React context holds. It is a plain object today
 * because nothing needs it to be more than that yet.
 */

import { fontStack } from './fonts.js';
import { type Language, type LanguagePreferences, resolveLanguage } from './language.js';
import { createTranslator, type Translator } from './translator.js';

export interface LanguageSession {
  readonly language: Language;
  /** The one call every user-facing string in the app goes through. */
  readonly t: Translator;
  /** CSS font-family stack, most specific first. */
  readonly fonts: readonly string[];
}

export function createLanguageSession(preferences: LanguagePreferences = {}): LanguageSession {
  const language = resolveLanguage(preferences);

  return {
    language,
    t: createTranslator(language),
    fonts: fontStack(language),
  };
}
