import { describe, expect, it } from 'vitest';

import { counterLanguageSession } from './index.js';

describe('@ssbazar/counter', () => {
  it('resolves the shared workspace package', async () => {
    const shared: unknown = await import('@ssbazar/shared');

    expect(shared).toBeTypeOf('object');
  });

  it('gives the cashier their own language, and a translator bound to it', () => {
    const session = counterLanguageSession({ employeePreference: 'hi', storeDefault: 'en' });

    expect(session.language).toBe('hi');
    expect(session.t('cli.reconcile.clean')).toBe('कोई अंतर नहीं');
  });

  it('falls back to the store default when the cashier has no preference', () => {
    // The normal case: most staff never open the setting.
    const session = counterLanguageSession({ employeePreference: null, storeDefault: 'hi' });

    expect(session.language).toBe('hi');
  });

  it('still resolves when the cache holds nothing at all', () => {
    // A counter that has never synced, or one signed into before the first
    // sync completes. It bills anyway - offline-first means the language is
    // never the thing that stops a sale.
    expect(counterLanguageSession().language).toBe('en');
    expect(counterLanguageSession({ storeDefault: 'not a language' }).language).toBe('en');
  });

  it('asks for a Devanagari-capable font first in Hindi', () => {
    // Without this the cashier's own screen shows tofu for every product that
    // has a `name_hi`, whatever the receipt does.
    expect(counterLanguageSession({ storeDefault: 'hi' }).fonts[0]).toBe('Noto Sans Devanagari');
  });
});
