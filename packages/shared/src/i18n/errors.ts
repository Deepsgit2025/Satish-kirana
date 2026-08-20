/**
 * Errors that a person will read.
 *
 * The rule these exist to enforce is invariant 19 applied to the failure path,
 * which is where it is easiest to forget: a screen's labels get translated
 * because somebody looked at the screen, and the message that appears when the
 * bill will not total gets missed because nobody made it appear.
 *
 * So a `TranslatableError` carries a key and its parameters, never a sentence.
 * The English text still exists - `Error.message` is filled from `en.json` -
 * because a stack trace with an empty message helps nobody at three in the
 * morning. But it is *derived*, so there is exactly one place the English lives
 * and Hindi is one lookup away rather than one rewrite away.
 *
 *   catch (error) {
 *     if (error instanceof TranslatableError) show(t(error.messageKey, error.params));
 *   }
 *
 * The distinction that decides whether an error belongs here: would a cashier
 * or the shop owner see it? A failed Postgres connection or a checksum mismatch
 * on a migration is read by whoever is installing the system, in English, and
 * translating it buys nothing. "This barcode is already on a product" is read
 * by the person holding the packet.
 */

import type { TranslationKey } from './catalogue.js';
import { FALLBACK_LANGUAGE } from './language.js';
import { type MessageParams, translate } from './translator.js';

/**
 * Something to be said, as a key and its numbers - never as a sentence.
 *
 * The shape a module hands back when it has something for a person to read but
 * no business knowing which language they read in. A validator produces these,
 * a migration runner produces these, and the CLI or the screen at the edge is
 * the only thing that turns one into words.
 */
export interface TranslatableMessage {
  readonly messageKey: TranslationKey;
  readonly params: MessageParams;
}

export class TranslatableError extends Error implements TranslatableMessage {
  readonly messageKey: TranslationKey;
  readonly params: MessageParams;

  constructor(messageKey: TranslationKey, params: MessageParams = {}) {
    super(translate(FALLBACK_LANGUAGE, messageKey, params));
    this.name = 'TranslatableError';
    this.messageKey = messageKey;
    this.params = params;
  }
}

/** Narrow before reaching for `.messageKey`. */
export function isTranslatableError(error: unknown): error is TranslatableError {
  return error instanceof TranslatableError;
}
