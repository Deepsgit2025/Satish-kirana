import { createLanguageSession, type LanguageSession } from '@ssbazar/shared';

/**
 * Entry point for the counter app.
 *
 * Electron, React and the local SQLite cache still arrive with the first screen
 * (see docs/build-order.md). What is here now is the i18n bootstrap, because
 * step 6 comes before step 7 on purpose: the lint rule and the translator have
 * to exist before there is a screen to write strings into, or the first several
 * hundred go in the wrong way and get retrofitted (docs/DECISIONS.md D34).
 *
 * The counter is the hard case for language resolution and the reason this
 * takes cached values rather than a database handle. It bills through a server
 * outage — that is its whole job — so the answer has to come from the local
 * cache's mirror of `employees.preferred_language` and
 * `app_settings.default_language`. Both may be stale, absent, or hold something
 * written by a version of the app that no longer exists. None of that is a
 * reason to refuse a sale, so resolution is total and ends at English.
 */

export { type LanguageSession };

/** What the local SQLite cache mirrors of the two language settings. */
export interface CachedLanguageSettings {
  /** `employees.preferred_language` for whoever is signed in at this counter. */
  readonly employeePreference?: unknown;
  /** `app_settings.default_language`, as last synced from the store server. */
  readonly storeDefault?: unknown;
}

/**
 * The language, translator and font stack for the cashier at this terminal.
 *
 * Called once at sign-in and again when a cashier changes their preference.
 * Every user-facing string on the counter resolves through the `t` it returns
 * (CLAUDE.md invariant 19).
 */
export function counterLanguageSession(cached: CachedLanguageSettings = {}): LanguageSession {
  return createLanguageSession(cached);
}
