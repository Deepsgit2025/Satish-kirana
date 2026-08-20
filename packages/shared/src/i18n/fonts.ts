/**
 * Where the Devanagari font is, asked once.
 *
 * Three things need the same file and must not each decide for themselves: the
 * receipt raster renderer (invariant 21), and the two Electron apps' stylesheets.
 * If they disagree, a bill previewed on screen and the same bill on paper break
 * their lines in different places, and the person comparing them has no way to
 * tell which one is wrong.
 *
 * `assets/fonts/README.md` covers what the file is and why it is committed
 * rather than fetched. This module is only the address.
 */

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Language } from './language.js';

export interface FontFace {
  readonly family: string;
  readonly weight: 400 | 700;
  readonly file: string;
}

export const DEVANAGARI_FAMILY = 'Noto Sans Devanagari';

export const DEVANAGARI_FACES: readonly FontFace[] = [
  { family: DEVANAGARI_FAMILY, weight: 400, file: 'NotoSansDevanagari-Regular.ttf' },
  { family: DEVANAGARI_FAMILY, weight: 700, file: 'NotoSansDevanagari-Bold.ttf' },
];

/**
 * Overridden by `SSBAZAR_FONT_DIR`.
 *
 * The default resolves relative to this module, which is correct running from
 * `src` under tsx and from `dist` after a build - both sit the same distance
 * below the repository root. It is *not* correct inside a packaged Electron
 * app, where the asset lands in the platform's resources directory. That is
 * what the environment variable is for, and the packaging step is expected to
 * set it rather than this file growing a list of platform layouts.
 */
const DEFAULT_FONT_DIR = new URL('../../../../assets/fonts/', import.meta.url);

export function fontDirectory(): string {
  const override = process.env.SSBAZAR_FONT_DIR;
  if (override !== undefined && override.trim().length > 0) return override.trim();
  return fileURLToPath(DEFAULT_FONT_DIR);
}

/** Absolute path to one face, for a renderer that loads font bytes. */
export function fontPath(face: FontFace): string {
  return join(fontDirectory(), face.file);
}

export function devanagariFont(weight: 400 | 700 = 400): FontFace {
  const face = DEVANAGARI_FACES.find((candidate) => candidate.weight === weight);
  // The array is a literal two entries long and both weights are in it; the
  // check is here so the return type is not a lie.
  if (face === undefined) throw new RangeError(`No Devanagari face at weight ${String(weight)}.`);
  return face;
}

/**
 * The CSS stack for a language, most specific first.
 *
 * Devanagari leads for Hindi and is still listed for English, because a shop
 * running in English still displays `name_hi` wherever a product has one, and a
 * product name is the one string on the screen most likely to be in the other
 * script.
 */
export function fontStack(language: Language): readonly string[] {
  const system = ['Segoe UI', 'system-ui', 'sans-serif'];
  return language === 'hi'
    ? [DEVANAGARI_FAMILY, ...system]
    : [...system.slice(0, 2), DEVANAGARI_FAMILY, 'sans-serif'];
}
