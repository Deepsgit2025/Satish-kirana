import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type FontFace } from './fonts.js';

/**
 * Where the Devanagari font *file* is, on a filesystem.
 *
 * Split out of `fonts.ts` because it is the only part of i18n that needs Node.
 * `fonts.ts` keeps the family name, the face list and the CSS stack, which are
 * plain data a browser context needs too - and a renderer that imported them
 * through a module carrying `node:path` would get `node:path` externalised into
 * its bundle and fail at load (docs/DECISIONS.md D42; the preload hit exactly
 * this).
 *
 * So: this module is for the receipt raster renderer and for whatever loads
 * font bytes. Nothing in a renderer or a preload may import it.
 */

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
