import { describe, expect, it } from 'vitest';

import { describeError } from './describe-error.js';

function errnoError(code: string, message = ''): Error {
  return Object.assign(new Error(message), { code });
}

describe('describeError', () => {
  it('uses the message when there is one', () => {
    expect(describeError(new Error('relation "products" does not exist'))).toBe(
      'relation "products" does not exist',
    );
  });

  it('falls back to the error code when the message is empty', () => {
    expect(describeError(errnoError('ECONNREFUSED'))).toBe('ECONNREFUSED');
  });

  it('unwraps the AggregateError a refused connection produces', () => {
    const aggregate = new AggregateError(
      [errnoError('ECONNREFUSED'), errnoError('ECONNREFUSED')],
      '',
    );

    expect(describeError(aggregate)).toBe('ECONNREFUSED');
  });

  it('lists distinct causes', () => {
    const aggregate = new AggregateError([errnoError('ECONNREFUSED'), errnoError('ETIMEDOUT')], '');

    expect(describeError(aggregate)).toBe('ECONNREFUSED; ETIMEDOUT');
  });

  it('handles values that are not errors', () => {
    expect(describeError('boom')).toBe('boom');
  });
});
