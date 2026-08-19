import { describe, expect, it } from 'vitest';

describe('@ssbazar/counter', () => {
  it('resolves the shared workspace package', async () => {
    const shared: unknown = await import('@ssbazar/shared');

    expect(shared).toBeTypeOf('object');
  });
});
