/**
 * The one place a CLI writes to the console.
 *
 * Three commands print to a terminal today - `db:migrate`, `db:reconcile` and
 * `catalogue:import` - and one of them, the catalogue importer, is run by the
 * client against his own spreadsheet while he is keying it. That is not
 * developer output. It is the first thing this system ever says to the person
 * who bought it, and invariant 19 covers it exactly as it covers a screen.
 *
 * So every line leaves through `CliOutput`, which holds a translator and a tag,
 * and there is no `console.log` anywhere else. Two things follow from that:
 *
 *   **The lint rule has one file to watch.** `ssbazar/no-hardcoded-strings`
 *   treats `console.*` as a sink; concentrating the sinks here means a new
 *   command cannot quietly grow its own English by importing `console`.
 *
 *   **The tag is not prose.** `[catalogue]` is the program's name, the way a
 *   syslog tag is, and it is passed in as an identifier rather than written
 *   into a message. Nothing in the bracket needs translating, and nothing
 *   inside a translated message needs a bracket.
 *
 * Language resolution is the caller's job and happens as late as it can - after
 * the database connection, when there is one, because `app_settings` is where
 * the answer lives. `usage()` and the early argument errors run before that and
 * take whatever `resolveLanguageOffline` gives them.
 */

import { createTranslator, type MessageParams, type TranslationKey } from '@ssbazar/shared';
import type { Language, TranslatableMessage, Translator } from '@ssbazar/shared';

export interface CliOutput {
  readonly language: Language;
  readonly t: Translator;
  /** One tagged line to stdout. */
  say(key: TranslationKey, params?: MessageParams): void;
  /** One tagged line to stderr. */
  warn(key: TranslationKey, params?: MessageParams): void;
  /** A key and params handed over by a module that does not know the language. */
  report(message: TranslatableMessage): void;
  /** A tagged line already rendered - a table row, a joined list. */
  line(text: string): void;
  /** A blank line, for spacing a report. */
  blank(): void;
  /** Untagged, for a usage block that is pasted into a terminal. */
  plain(text: string): void;
}

export function createCliOutput(tag: string, language: Language): CliOutput {
  const t = createTranslator(language);
  const prefix = `[${tag}] `;

  const line = (text: string): void => {
    console.log(prefix + text);
  };

  return {
    language,
    t,
    line,
    say: (key, params) => {
      line(t(key, params));
    },
    report: (message) => {
      line(t(message.messageKey, message.params));
    },
    warn: (key, params) => {
      console.error(prefix + t(key, params));
    },
    blank: () => {
      console.log('');
    },
    plain: (text) => {
      console.log(text);
    },
  };
}

export interface UsageOption {
  /**
   * As typed at the shell. Never translated - `--dry-run` is a token the
   * operator has to type back character for character, and a Hindi build that
   * renamed it would print instructions that do not work.
   */
  readonly flag: string;
  readonly description: TranslationKey;
}

export interface Usage {
  /** The synopsis line. */
  readonly synopsis: TranslationKey;
  readonly options: readonly UsageOption[];
  /** Paragraphs after the options - what the columns are, where the docs are. */
  readonly notes: readonly TranslatableMessage[];
}

/**
 * Prints `--help`, as a table rather than as a paragraph.
 *
 * The shape matters more than it looks. A usage block written as one string is
 * half prose and half syntax - `--dry-run` must survive translation untouched
 * while the sentence beside it must not - and there is no way to say that about
 * a paragraph. Splitting it means the flags are data, the descriptions are
 * keys, and the two cannot be confused for each other by the next person or by
 * the lint rule.
 */
export function printUsage(output: CliOutput, usage: Usage): void {
  const { t } = output;
  const width = Math.max(...usage.options.map((option) => option.flag.length));

  output.plain(t(usage.synopsis));

  if (usage.options.length > 0) {
    output.plain('');
    for (const option of usage.options) {
      output.plain(`  ${pad(option.flag, width)}   ${t(option.description)}`);
    }
  }

  for (const note of usage.notes) {
    output.plain('');
    output.plain(t(note.messageKey, note.params));
  }
}

/**
 * Pads to a column width, counting characters rather than display columns.
 *
 * Devanagari makes that distinction real: combining matras (ि, ी, ू) are
 * separate code points that take no width of their own, so a Hindi reason
 * string counts longer than it looks and its column comes out short. Aligning a
 * mixed-script table properly needs grapheme segmentation and a monospace font
 * that has the glyphs, and a terminal is not guaranteed to have either.
 *
 * Left as characters deliberately, and confined to reports where a ragged
 * column costs nothing. Anything where alignment carries meaning - a receipt,
 * a shelf label - is rendered, not printed (invariant 21).
 */
export function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}
