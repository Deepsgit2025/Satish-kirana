import type { CatalogueApi, CatalogueResult } from '@ssbazar/shared/catalogue';

import { t } from './language.js';

/**
 * The renderer's handle on the catalogue.
 *
 * `window.catalogue` is put there by the preload and is the only thing on it
 * (CLAUDE.md invariant 23). Typed as the same `CatalogueApi` the main process
 * implements, so a screen cannot tell which side of the wire it is talking to -
 * and a change to the contract breaks both ends at once, which is the whole
 * reason the contract lives in `@ssbazar/shared`.
 */

declare global {
  interface Window {
    readonly catalogue: CatalogueApi;
  }
}

export const catalogue: CatalogueApi = window.catalogue;

/**
 * Renders a result for a placeholder screen.
 *
 * Stage 3 is proving the boundary carries real calls, not presenting them, so
 * this shows the raw value or the failure's key. **The key, not a sentence:**
 * a failure crosses as `TranslatableMessage` and the screen that eventually
 * replaces this one will resolve it through the i18n session (invariant 19).
 * Printing the key here keeps that visible rather than letting an English
 * string sneak in as a placeholder and then survive into the real screen.
 */
export function describeResult(result: CatalogueResult<unknown> | null): string {
  if (result === null) return t('office.catalogue.not_called');
  if (!result.ok) {
    return `FAILED ${result.failure.message.messageKey}\n${JSON.stringify(result.failure, null, 2)}`;
  }
  return JSON.stringify(result.value, null, 2);
}
