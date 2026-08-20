/**
 * The i18n surface a browser context may import.
 *
 * Everything here is plain data and pure functions. What it deliberately leaves
 * out is `font-files.ts` - the only part of i18n that reaches for `node:path`,
 * and enough on its own to break a renderer or preload bundle at load
 * (docs/DECISIONS.md D42).
 *
 * Reached as `@ssbazar/shared/i18n`. The full barrel `@ssbazar/shared` still
 * exports everything and is what the server and the CLIs use; a screen imports
 * from here instead, and the packaging is what makes "instead" enforceable
 * rather than remembered.
 */

export {
  CATALOGUES,
  collectKeys,
  lookupMessage,
  type Message,
  type MessageTree,
  type PluralMessage,
  type TranslationKey,
} from './catalogue.js';
export {
  DEVANAGARI_FACES,
  DEVANAGARI_FAMILY,
  devanagariFont,
  type FontFace,
  fontStack,
} from './fonts.js';
export { isTranslatableError, TranslatableError, type TranslatableMessage } from './errors.js';
export {
  FALLBACK_LANGUAGE,
  isLanguage,
  type Language,
  LANGUAGE_NAMES,
  LANGUAGES,
  type LanguagePreferences,
  parseLanguage,
  resolveLanguage,
} from './language.js';
export { hasDevanagari, localisedText, type LocalisedText, needsDevanagari } from './localised.js';
export { type PluralCategory, pluralCategory } from './plural.js';
export { createLanguageSession, type LanguageSession } from './session.js';
export { createTranslator, type MessageParams, translate, type Translator } from './translator.js';
