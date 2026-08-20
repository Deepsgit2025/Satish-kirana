import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

/**
 * The preload bundle: one CommonJS file, `electron` left external.
 *
 * Bundling rather than compiling because the preload imports
 * `CATALOGUE_CHANNELS` from `@ssbazar/shared`, which is ESM-only. A sandboxed
 * preload must be CommonJS, and `require()` of an ESM package fails - so the
 * constant is inlined here instead of being fetched at runtime. That keeps the
 * channel names written once (docs/DECISIONS.md D42) without giving up the
 * sandbox to get them.
 *
 * `electron` stays external because it is provided by the runtime, not by npm.
 */
export default defineConfig({
  build: {
    outDir: fileURLToPath(new URL('dist/preload', import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
    lib: {
      entry: fileURLToPath(new URL('src/preload/index.ts', import.meta.url)),
      formats: ['cjs'],
      fileName: () => 'index.cjs',
    },
    rollupOptions: {
      external: ['electron'],
    },
  },
});
