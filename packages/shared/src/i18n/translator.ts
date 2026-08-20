/**
 * Turning a key into a sentence.
 *
 * The whole of invariant 19 comes down to one call - `t('some.key', params)` -
 * so this module is deliberately small and deliberately total. It never throws.
 *
 * That is a decision about where this code runs, not a shortcut. `t` is on the
 * path of every screen the cashier sees and every line of every receipt. A
 * translator that threw on a missing key would take the till down over a typo
 * in a file nobody compiles, in the middle of the evening rush, and the failure
 * would surface as a blank screen rather than as the missing word it is.
 *
 * So a key that cannot be resolved degrades, in this order:
 *
 *   1. the message in the requested language
 *   2. the message in English - `hi.json` is allowed to lag, exactly as
 *      `name_hi` is allowed to be NULL (invariant 20)
 *   3. the key itself, which is at least searchable
 *
 * Step 3 must never happen in a shipped build, and it cannot: `TranslationKey`
 * is derived from `en.json`, so an unresolvable key does not compile, and
 * `catalogue.test.ts` asserts `hi.json` has every key `en.json` has. The
 * fallback exists for the case those two cannot cover - a key assembled at
 * runtime by code that has not been written yet.
 */

import { CATALOGUES, lookupMessage, type Message, type TranslationKey } from './catalogue.js';
import { FALLBACK_LANGUAGE, type Language } from './language.js';
import { pluralCategory } from './plural.js';

/**
 * Values spliced into a message. `count` is reserved: when present it also
 * chooses between a message's `one` and `other` forms.
 */
export type MessageParams = Readonly<Record<string, string | number>>;

export interface Translator {
  (key: TranslationKey, params?: MessageParams): string;
  readonly language: Language;
}

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Replaces `{name}` with `params.name`.
 *
 * A placeholder with no matching parameter is left standing rather than
 * replaced with a blank. "Bill discount {amount} is not a positive amount" is
 * a bug report; "Bill discount  is not a positive amount" is a mystery.
 */
function interpolate(template: string, params: MessageParams | undefined): string {
  if (params === undefined) return template;

  return template.replace(PLACEHOLDER, (placeholder, name: string) => {
    const value = params[name];
    return value === undefined ? placeholder : String(value);
  });
}

function selectForm(
  message: Message,
  language: Language,
  params: MessageParams | undefined,
): string {
  if (typeof message === 'string') return message;

  // A plural message with no count cannot be chosen between. `other` is the
  // safer half: it reads as a general statement in both languages.
  const count = params?.count;
  if (typeof count !== 'number') return message.other;

  return message[pluralCategory(language, count)];
}

/**
 * One-off translation. `createTranslator` is nicer where a language is already
 * settled; this is for the places holding a language and a key and nothing else.
 */
export function translate(language: Language, key: TranslationKey, params?: MessageParams): string {
  const message =
    lookupMessage(CATALOGUES[language], key) ?? lookupMessage(CATALOGUES[FALLBACK_LANGUAGE], key);

  if (message === undefined) return key;

  return interpolate(selectForm(message, language, params), params);
}

/**
 * Binds a language once, so a screen or a CLI holds `t` rather than passing a
 * language through every call.
 */
export function createTranslator(language: Language): Translator {
  const translator = (key: TranslationKey, params?: MessageParams): string =>
    translate(language, key, params);

  return Object.defineProperty(translator, 'language', {
    value: language,
    enumerable: true,
  }) as Translator;
}
