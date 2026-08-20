import { fileURLToPath } from 'node:url';

import { createCatalogueApi, createPool, createPooledSessionRunner } from '@ssbazar/server';
import { type CatalogueApi, CATALOGUE_CHANNELS } from '@ssbazar/shared';
import { app, BrowserWindow, ipcMain } from 'electron';

/**
 * The office app's main process: a window, a database pool, and one IPC handler
 * per contract method.
 *
 * This is the privileged side of the boundary. It holds the Postgres pool and
 * the catalogue core; the renderer holds a typed stub and no way to reach past
 * it (docs/DECISIONS.md D42).
 *
 * **The window settings below are CLAUDE.md invariant 23 and are not tuneable.**
 * `contextIsolation` on and `nodeIntegration` off keep the renderer out of Node;
 * `sandbox` left at its default of on keeps the renderer process inside the OS
 * sandbox as well, which is why the preload is CommonJS - a sandboxed preload
 * cannot be an ES module, and that constraint is worth more than the
 * convenience of matching the rest of the workspace.
 *
 * The one thing loosening any of them would buy is a screen reaching the
 * database directly, which is the failure the whole boundary exists to prevent.
 */

const isDev = process.env.NODE_ENV === 'development';
const devServerUrl = process.env.VITE_DEV_SERVER_URL;

const rendererIndex = fileURLToPath(new URL('../renderer/index.html', import.meta.url));
const preloadScript = fileURLToPath(new URL('../preload/index.cjs', import.meta.url));

/**
 * Wires every contract method to its channel.
 *
 * Driven from `CATALOGUE_CHANNELS` rather than written out, so a method added
 * to the contract cannot be left without a handler - the channel map already
 * fails to compile in that case, and this loop means it fails to *run* without
 * one too.
 *
 * **The request is trusted here, and that is a property of what the renderer
 * is**, not an oversight. It is our own bundle, loaded from disk, with no
 * remote content and no way to navigate anywhere else. The day this window
 * loads anything it did not ship with, every request arriving here becomes
 * untrusted input and needs checking at this line.
 */
function registerCatalogueHandlers(api: CatalogueApi): void {
  const methods = Object.keys(CATALOGUE_CHANNELS) as (keyof CatalogueApi)[];

  for (const method of methods) {
    ipcMain.handle(CATALOGUE_CHANNELS[method], async (_event, request: unknown) => {
      // One call, one transaction, one plain-data result - never a thrown
      // error, which would not survive the trip with its key intact.
      //
      // Bound rather than extracted: the implementation does not use `this`
      // today, and an unbound method that starts to would fail here rather
      // than where the mistake was made.
      const call = (api[method] as (input: unknown) => Promise<unknown>).bind(api);
      return call(request);
    });
  }
}

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      preload: preloadScript,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  if (devServerUrl !== undefined) {
    await window.loadURL(devServerUrl);
    if (isDev) window.webContents.openDevTools({ mode: 'detach' });
  } else {
    await window.loadFile(rendererIndex);
  }
}

/**
 * Loads the repo `.env`, the way every other entry point in this workspace
 * does.
 *
 * The CLIs get it from `node --env-file-if-exists=.env`, which Electron has no
 * equivalent of - so without this the pool starts with no `PGPASSWORD` and
 * every call comes back "client password must be a string". It fails as a
 * clean `request_failed` result rather than a crash, which is the error path
 * working, and is also exactly how it would go unnoticed.
 *
 * **This is the development path.** A packaged app installed in the shop has no
 * repo beside it and must read its connection settings from somewhere it owns;
 * that arrives with packaging in build-order step 9. Missing here is not fatal
 * on purpose - `PG*` may be set in the environment instead.
 */
function loadDevEnvironment(): void {
  try {
    process.loadEnvFile(fileURLToPath(new URL('../../../../.env', import.meta.url)));
  } catch {
    // No .env beside the repo. PG* may be set already; if not, the first call
    // reports it rather than the window failing to open.
  }
}

async function main(): Promise<void> {
  loadDevEnvironment();
  const pool = createPool();
  registerCatalogueHandlers(createCatalogueApi(createPooledSessionRunner(pool)));

  await app.whenReady();
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });

  app.on('window-all-closed', () => {
    // The office machine is a desktop, not a Mac-style dock app: closing the
    // window means finished. The pool is drained first so an in-flight
    // transaction commits or rolls back rather than dying with the process.
    void pool.end().finally(() => {
      app.quit();
    });
  });
}

void main();
