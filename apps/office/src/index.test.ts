import { describe, expect, it } from 'vitest';

import { officeLanguageSession } from './index.js';

describe('@ssbazar/office', () => {
  it('resolves the shared workspace package', async () => {
    const shared: unknown = await import('@ssbazar/shared');

    expect(shared).toBeTypeOf('object');
  });

  it('resolves language the same way the counter does', () => {
    const session = officeLanguageSession({ employeePreference: 'hi', storeDefault: 'en' });

    expect(session.language).toBe('hi');
    expect(session.t('cli.catalogue.dry_run_note')).toBe('ड्राई रन — कुछ भी नहीं लिखा गया');
  });

  it('falls back to English with nothing cached', () => {
    expect(officeLanguageSession().language).toBe('en');
  });

  it('renders an import issue from the key the validator reported', () => {
    // The import screen in step 7 shows the same report `catalogue:import`
    // prints today, from the same `RowIssue.reasonKey`. Neither owns the
    // English, which is what lets the validator stay a pure function of a file.
    const session = officeLanguageSession({ storeDefault: 'hi' });

    expect(session.t('catalogue.issue.hsn_not_six_digits')).toBe('ठीक 6 अंकों का होना चाहिए');
  });
});
