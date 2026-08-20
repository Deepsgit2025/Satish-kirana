# Bundled fonts

**Noto Sans Devanagari**, hinted TTF, from
[notofonts/notofonts.github.io](https://github.com/notofonts/notofonts.github.io/tree/main/fonts/NotoSansDevanagari/hinted/ttf).
Licensed under the SIL Open Font License 1.1 — see `OFL.txt`. The OFL permits
bundling and redistribution; the only conditions are that the licence travels
with the files and that a derived font is not called "Noto".

| File | SHA-256 |
|---|---|
| `NotoSansDevanagari-Regular.ttf` | `306b53ecfb182a504dd8a7446093c316387d2fd8dc350d0792ed1753fe0996cd` |
| `NotoSansDevanagari-Bold.ttf` | `3ad8362a06271814869838dcc3d161b13c9fb97681b627af1f7f283ea9387d56` |

## Why bundled rather than fetched or relied on

The store server and the three shop machines run with no internet for days at a
time, and a receipt that renders as tofu is a receipt the customer cannot read.
A font resolved from the operating system is not an option either: what is
installed on a Windows machine in a shop is not something this project controls,
and the same bill would print differently on each counter.

## Why *hinted*, and why TTF

Both matter for the printer, not the screen.

Receipts print at 203 dpi on a 576-dot line (`docs/plan.md` Part 2). Devanagari
at that size is a handful of pixels per glyph, and hinting is what keeps a matra
from disappearing into the stroke below it.

The `GSUB`, `GPOS` and `GDEF` tables are the reason a full TTF is bundled rather
than the web subsets Google Fonts serves. Devanagari is not a font where laying
glyphs out left to right gives you the word: conjuncts substitute (`क` + `्` +
`ष` becomes one glyph), matras reorder around the consonant they attach to, and
`GSUB` is the table that says so. Text shaped without it is not merely ugly, it
is wrong — and wrong on a printed document the shop hands to a customer.

## Where it is used

- **Receipt raster rendering.** ESC/POS has no Devanagari code page, so a bill
  carrying a Hindi item name is rendered to a bitmap with this font and sent in
  raster mode (CLAUDE.md invariant 21, `docs/DECISIONS.md` D20). That work
  arrives with the printing module; the font is here first because it is the
  part with a licence to check and a provenance to record.
- **Both Electron apps**, as the UI face for Hindi text.

Paths come from `@ssbazar/shared`'s `devanagariFont()` rather than being spelled
out at each call site, so there is one answer to "which file" when the raster
renderer and the apps disagree.
