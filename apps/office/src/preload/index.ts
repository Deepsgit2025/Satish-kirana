import { type CatalogueApi, CATALOGUE_CHANNELS } from '@ssbazar/shared/catalogue';
import { contextBridge, ipcRenderer } from 'electron';

/**
 * The whole of the renderer's access to the rest of the system.
 *
 * CLAUDE.md invariant 23: what goes on `window` is the typed contract and
 * nothing else. Not `ipcRenderer`, not `require`, not a filesystem helper, not
 * an "invoke any channel" escape hatch - each of which would hand a screen the
 * ability to go around the contract, which is the thing the contract exists to
 * make impossible (docs/DECISIONS.md D42).
 *
 * The bridge is built by walking `CATALOGUE_CHANNELS`, so the surface is
 * exactly the contract's methods by construction. There is no line here to
 * quietly add a seventh thing to.
 *
 * **This file ships as CommonJS.** A preload running in a sandboxed renderer
 * cannot be an ES module, and turning the sandbox off to match the workspace's
 * house style would trade an OS-level protection for a file extension. So the
 * source stays ESM like everything else and Vite emits CJS - which also inlines
 * `CATALOGUE_CHANNELS` rather than leaving a `require` of an ESM-only package
 * to fail at startup. `vite.preload.config.ts` owns this file; `tsc` skips it.
 */

const catalogue = Object.fromEntries(
  Object.entries(CATALOGUE_CHANNELS).map(([method, channel]) => [
    method,
    (request: unknown) => ipcRenderer.invoke(channel, request),
  ]),
) as unknown as CatalogueApi;

contextBridge.exposeInMainWorld('catalogue', catalogue);
