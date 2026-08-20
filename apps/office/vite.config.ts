import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The renderer bundle.
 *
 * A bundler is needed here and nowhere else in this workspace: the main process
 * and the preload run under Node's resolver, but a browser context cannot
 * resolve a bare `react` import on its own.
 *
 * `base: './'` matters. The built page is loaded from disk with `loadFile`, so
 * absolute asset paths would resolve against the filesystem root and the window
 * would come up blank with nothing in the console to explain it.
 */
export default defineConfig({
  root: fileURLToPath(new URL('src/renderer', import.meta.url)),
  base: './',
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('dist/renderer', import.meta.url)),
    emptyOutDir: true,
    // Source maps for a build that will be debugged over a phone line from
    // another city rather than on the machine that made it (build-order step 9).
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
