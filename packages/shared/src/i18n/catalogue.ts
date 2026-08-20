/**
 * The message catalogues, and the type that makes a wrong key a build failure.
 *
 * `en.json` is the source of truth in two senses. It is the one guaranteed
 * complete - `hi.json` falls back to it key by key, the same way `name_hi` falls
 * back to `name` (invariant 20) - and it is where `TranslationKey` comes from,
 * so `t('cli.migrate.dnoe')` does not compile. That is the half of invariant 19
 * a lint rule cannot do: the rule stops a string that was never externalised,
 * the type stops a key that does not resolve.
 *
 * Both files are imported rather than read from disk. The counters run offline
 * for days at a stretch, an Electron bundle has no `server/` directory next to
 * it, and a missing locale file at six in the evening is not a failure mode
 * worth having.
 */

import en from './locales/en.json' with { type: 'json' };
import hi from './locales/hi.json' with { type: 'json' };

import type { Language } from './language.js';

/**
 * A message with a count-dependent form. English and Hindi both use exactly the
 * two CLDR categories `one` and `other`, which is why this is a pair and not a
 * plural-rule engine - see `plural.ts` for the part that does differ.
 */
export interface PluralMessage {
  readonly one: string;
  readonly other: string;
}

export type Message = string | PluralMessage;

/** A namespace in the catalogue, or a message. */
export interface MessageTree {
  readonly [key: string]: Message | MessageTree;
}

/**
 * Every dotted path in `T` that lands on a message. Namespaces are not keys:
 * `'cli.migrate'` is not translatable and does not typecheck.
 */
type MessagePaths<T> = {
  [K in keyof T & string]: T[K] extends Message ? K : `${K}.${MessagePaths<T[K]>}`;
}[keyof T & string];

export type TranslationKey = MessagePaths<typeof en>;

export const CATALOGUES: Readonly<Record<Language, MessageTree>> = {
  en,
  hi,
};

function isPlural(value: unknown): value is PluralMessage {
  return typeof value === 'object' && value !== null && 'one' in value && 'other' in value;
}

function isMessage(value: unknown): value is Message {
  return typeof value === 'string' || isPlural(value);
}

/**
 * Walks a dotted path. Returns undefined rather than throwing for a path that
 * is absent or stops on a namespace, because the caller's next move is to try
 * the fallback language, not to fail.
 */
export function lookupMessage(tree: MessageTree, key: string): Message | undefined {
  let node: Message | MessageTree | undefined = tree;

  for (const segment of key.split('.')) {
    if (node === undefined || typeof node === 'string' || isPlural(node)) return undefined;
    node = node[segment];
  }

  return isMessage(node) ? node : undefined;
}

/** Every key in a catalogue, dotted, for the parity test. */
export function collectKeys(tree: MessageTree, prefix = ''): string[] {
  const keys: string[] = [];

  for (const [segment, value] of Object.entries(tree)) {
    const path = prefix.length === 0 ? segment : `${prefix}.${segment}`;
    if (isMessage(value)) keys.push(path);
    else keys.push(...collectKeys(value, path));
  }

  return keys.sort((a, b) => a.localeCompare(b, 'en'));
}
