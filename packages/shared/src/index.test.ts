import { describe, expect, it } from 'vitest';

describe('@ssbazar/shared', () => {
  it('has a resolvable entry point', async () => {
    const shared: unknown = await import('@ssbazar/shared');

    expect(shared).toBeTypeOf('object');
  });
});
