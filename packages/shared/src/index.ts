/**
 * Public API of @ssbazar/shared.
 *
 * The tax engine (build-order step 2) and the i18n framework (step 6).
 *
 * `computeBillTax` is the only place bill arithmetic happens - counters, office
 * and server all call it, so all three agree to the paisa. `roundMoney` is the
 * one rounding function of CLAUDE.md invariant 1; anything else that has to
 * round a rupee figure uses it rather than rounding for itself.
 *
 * `createTranslator` is the same idea applied to text: every user-facing string
 * in every app resolves through it, so invariant 19 has one call site the way
 * invariant 1 does.
 */

export { apportion, roundMoney } from './tax/money.js';
export {
  type BillInput,
  type BillLineInput,
  type ComputedBill,
  type ComputedBillLine,
  type ComputedBillTotals,
  type ComputedTaxGroup,
  computeBillTax,
  DEFAULT_ROUND_OFF,
  type PriceTaxType,
  type RoundOffMode,
  type RoundOffPolicy,
  type TaxErrorCode,
  taxErrorKey,
  TaxInputError,
  type TaxRateSnapshot,
} from './tax/bill-tax.js';

export {
  CATALOGUES,
  collectKeys,
  createLanguageSession,
  createTranslator,
  DEVANAGARI_FACES,
  DEVANAGARI_FAMILY,
  devanagariFont,
  FALLBACK_LANGUAGE,
  type FontFace,
  fontDirectory,
  fontPath,
  fontStack,
  hasDevanagari,
  isLanguage,
  isTranslatableError,
  type Language,
  LANGUAGE_NAMES,
  LANGUAGES,
  type LanguagePreferences,
  type LanguageSession,
  localisedText,
  type LocalisedText,
  lookupMessage,
  type Message,
  type MessageParams,
  type MessageTree,
  needsDevanagari,
  parseLanguage,
  type PluralCategory,
  pluralCategory,
  type PluralMessage,
  resolveLanguage,
  translate,
  TranslatableError,
  type TranslatableMessage,
  type TranslationKey,
  type Translator,
} from './i18n/index.js';
