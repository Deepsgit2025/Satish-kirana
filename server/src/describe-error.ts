/**
 * Turns a thrown value into one line an operator can act on.
 *
 * Node's happy-eyeballs connect rejects with an `AggregateError` whose own
 * message is empty - "failed: " on the console tells the shopkeeper nothing when
 * Postgres is down, so the causes are unwrapped and their error codes used.
 */
export function describeError(error: unknown): string {
  if (error instanceof AggregateError) {
    const causes = error.errors.map(describeError).filter((message) => message.length > 0);
    if (causes.length === 0) return error.message.length > 0 ? error.message : 'unknown error';
    return [...new Set(causes)].join('; ');
  }

  if (error instanceof Error) {
    if (error.message.length > 0) return error.message;
    const { code } = error as { code?: unknown };
    return typeof code === 'string' ? code : 'unknown error';
  }

  return String(error);
}
