import { createLanguageSession, type LanguageSession } from '@ssbazar/shared/i18n';

/**
 * The renderer's language session.
 *
 * `session.ts` in `@ssbazar/shared` says this is what a React context holds in
 * step 7, and this is it - a plain module today because nothing needs it to be
 * more than that yet.
 *
 * **It resolves with no preferences**, which falls back to English. The real
 * source is `employees.preferred_language` for whoever is signed in, then
 * `app_settings.default_language` - neither of which the renderer can read,
 * because reading them means a contract method and there is no sign-in yet.
 * That arrives with the real screens.
 *
 * What matters now is that every string already goes through `t`. Invariant 19
 * is cheap to honour from the first line and expensive to retrofit: D34's whole
 * argument for building i18n before the first screen was that retrofitting is
 * where you discover a string was assembled from fragments, or interpolated
 * mid-sentence in a way Hindi word order will not take.
 *
 * Imported from `@ssbazar/shared/i18n` rather than the package barrel. The
 * barrel carries `font-files.ts` and therefore `node:path`, which a browser
 * bundle cannot have (docs/DECISIONS.md D42).
 */
export const language: LanguageSession = createLanguageSession({});

export const { t } = language;
