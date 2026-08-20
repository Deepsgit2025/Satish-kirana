/**
 * The Devanagari font, as plain data.
 *
 * Three things need the same file and must not each decide for themselves: the
 * receipt raster renderer (invariant 21), and the two Electron apps' stylesheets.
 * If they disagree, a bill previewed on screen and the same bill on paper break
 * their lines in different places, and the person comparing them has no way to
 * tell which one is wrong.
 *
 * `assets/fonts/README.md` covers what the file is and why it is committed
 * rather than fetched. The filesystem path lives in `font-files.ts`, which needs
 * Node; everything here is safe to import from a browser context.
 */

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
