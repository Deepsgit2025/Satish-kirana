import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { DEVANAGARI_FACES, devanagariFont, fontPath, fontStack } from './fonts.js';

/**
 * That the font is really there, and is really the kind of font a receipt
 * needs.
 *
 * Worth a test rather than a glance, because both failures are silent and both
 * surface on paper. A missing file makes every Hindi glyph a tofu box on a
 * document handed to a customer. A file missing its shaping tables is worse:
 * it renders, so nothing looks broken, and the conjuncts come out wrong.
 */

/** The four bytes an OpenType/TrueType file starts with. */
const TRUETYPE = 0x00010000;

function tableTags(path: string): string[] {
  const bytes = readFileSync(path);
  expect(bytes.readUInt32BE(0)).toBe(TRUETYPE);

  const count = bytes.readUInt16BE(4);
  return Array.from({ length: count }, (_unused, index) =>
    bytes.toString('ascii', 12 + index * 16, 16 + index * 16),
  );
}

describe('the bundled Devanagari font', () => {
  it.each(DEVANAGARI_FACES)('$file is a TrueType file that is actually present', (face) => {
    expect(tableTags(fontPath(face)).length).toBeGreaterThan(0);
  });

  it.each(DEVANAGARI_FACES)('$file carries the tables Devanagari shaping needs', (face) => {
    // Devanagari is not a script you can lay out left to right and be done.
    // `GSUB` is what turns क + ् + ष into one conjunct glyph, `GPOS` is what
    // puts a matra in the right place relative to it, and `GDEF` is what tells
    // the shaper which marks are marks. A subset without these renders
    // something - which is exactly why a test is worth more than looking at it.
    expect(tableTags(fontPath(face))).toEqual(expect.arrayContaining(['GSUB', 'GPOS', 'GDEF']));
  });

  it('offers a regular and a bold face', () => {
    expect(devanagariFont(400).file).toContain('Regular');
    expect(devanagariFont(700).file).toContain('Bold');
  });
});

describe('fontStack', () => {
  it('leads with Devanagari for a Hindi user', () => {
    expect(fontStack('hi')[0]).toBe('Noto Sans Devanagari');
  });

  it('still lists Devanagari for an English user', () => {
    // A store set to English still shows `name_hi` on the products that have
    // one, and a product name is the string on the screen most likely to be in
    // the other script.
    expect(fontStack('en')).toContain('Noto Sans Devanagari');
  });
});
