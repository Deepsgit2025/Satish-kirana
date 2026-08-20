/**
 * The i18n framework (build-order step 6).
 *
 * One catalogue for the whole monorepo rather than one per app. The counter,
 * the office and the server CLIs share a vocabulary - a product, a barcode, a
 * tax slab, a rejected row - and three copies of it drift into three different
 * Hindi words for "barcode" within a month. Ownership is handled by namespace
 * (`cli.*`, `error.*`, `catalogue.*`) instead.
 */

export {
  type Message,
  type MessageTree,
  type PluralMessage,
  type TranslationKey,
  collectKeys,
  CATALOGUES,
  lookupMessage,
} from './catalogue.js';
export {
  DEVANAGARI_FACES,
  DEVANAGARI_FAMILY,
  devanagariFont,
  type FontFace,
  fontDirectory,
  fontPath,
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
