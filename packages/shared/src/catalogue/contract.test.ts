import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CATALOGUE_CHANNELS } from './contract.js';

/**
 * The two things about the contract that types cannot check for you.
 *
 * Everything else in `contract.ts` is a type, and a type that is wrong stops
 * the build. These two are wrong at runtime, quietly, in the shop.
 */

const PACKAGE_JSON = fileURLToPath(new URL('../../package.json', import.meta.url));

function packageManifest(): { dependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as {
    dependencies?: Record<string, string>;
  };
}

describe('the IPC channel names', () => {
  it('are all different', () => {
    // `satisfies Record<keyof CatalogueApi, string>` proves every method has a
    // channel. It does not prove they have *different* channels - two methods
    // sharing a string compiles perfectly and routes both to whichever handler
    // registered last, which shows up as a save that silently runs a search.
    const names = Object.values(CATALOGUE_CHANNELS);

    expect(new Set(names).size).toBe(names.length);
  });

  it('are namespaced, so another module cannot collide with them', () => {
    for (const name of Object.values(CATALOGUE_CHANNELS)) {
      expect(name).toMatch(/^catalogue:[a-z-]+$/);
    }
  });
});

describe('the contract module is safe to import from a browser context', () => {
  it('imports nothing at runtime — every import is type-only', () => {
    // The preload and, later, the renderer import `CATALOGUE_CHANNELS` from
    // here. Reaching it through the package barrel instead pulls in the font
    // helpers, which run `new URL(..., import.meta.url)` at module load; a
    // bundler targeting CommonJS rewrites that to `new URL(..., '' + {}.url)`,
    // which throws. In a preload the throw happens before
    // `contextBridge.exposeInMainWorld`, so `window.catalogue` never exists and
    // every screen fails with no clue as to why.
    //
    // `@ssbazar/shared/catalogue` exists so that import drags nothing. This is
    // what keeps it true: with every import type-only, the compiled module has
    // no imports at all and cannot reach Node from anywhere.
    const source = readFileSync(fileURLToPath(new URL('contract.ts', import.meta.url)), 'utf8');
    const imports = source.match(/^import .*$/gm) ?? [];

    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) {
      expect(line, line).toMatch(/^import type /);
    }
  });
});

describe('@ssbazar/shared stays free of the database', () => {
  it('declares no runtime dependencies at all', () => {
    // The guard behind docs/DECISIONS.md D42. This package is bundled into the
    // Electron renderer and into the counter app, so a `pg` import here would
    // put a database driver inside a browser context - which is the exact
    // shortcut the IPC boundary exists to make unavailable. D42 claims the
    // dependency graph makes that impossible rather than merely discouraged,
    // and this is what makes the claim true.
    //
    // Adding a dependency here is not forbidden by accident. If one is ever
    // genuinely needed, this test is the conversation about whether it belongs
    // in a package the renderer loads (CLAUDE.md: no new dependency without
    // asking).
    expect(packageManifest().dependencies ?? {}).toEqual({});
  });
});
