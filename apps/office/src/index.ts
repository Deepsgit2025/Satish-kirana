import { createLanguageSession, type LanguageSession } from '@ssbazar/shared';

/**
 * Entry point for the office app.
 *
 * Electron, React and the local SQLite cache still arrive with the first screen
 * (see docs/build-order.md). What is here now is the i18n bootstrap, for the
 * reason given in `docs/DECISIONS.md` D34: the product master is the first
 * screen in the system and it comes *after* i18n, so that its several hundred
 * strings are written through the translator the first time rather than
 * retrofitted.
 *
 * The office machine is on the LAN with the server beside it, so it is less
 * exposed to the offline case than a counter. It resolves the same way anyway —
 * one chain, one answer, whichever machine is asking.
 */

export { type LanguageSession };

/** What the local cache mirrors of the two language settings. */
export interface CachedLanguageSettings {
  /** `employees.preferred_language` for whoever is signed in. */
  readonly employeePreference?: unknown;
  /** `app_settings.default_language`, as last synced from the store server. */
  readonly storeDefault?: unknown;
}

/**
 * The language, translator and font stack for whoever is at the office machine.
 *
 * Every user-facing string in the back office resolves through the `t` it
 * returns (CLAUDE.md invariant 19) — including the import error report, which
 * the product master screen renders from the same `RowIssue.reasonKey` values
 * that `catalogue:import` prints at the terminal today.
 */
export function officeLanguageSession(cached: CachedLanguageSettings = {}): LanguageSession {
  return createLanguageSession(cached);
}
