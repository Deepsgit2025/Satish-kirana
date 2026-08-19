/**
 * The two money primitives. Every rupee figure the system produces goes through
 * one of them - CLAUDE.md invariant 1, "one rounding function, one call site".
 *
 * Neither knows anything about tax. The tax formulas live in `bill-tax.ts` and
 * nowhere else; these are the arithmetic they are allowed to use.
 */

/** Beyond this the epsilon below stops being meaningful, and no money needs it. */
const MAX_DECIMALS = 6;

/**
 * Nudge applied before rounding, to round the decimal the operator typed rather
 * than the binary double standing in for it: 2.675 is held as
 * 2.67499999999999982..., and rounding that gives 2.67 - a paisa short on every
 * such line, every day, for years.
 *
 * Relative, because the error in a double grows with its magnitude. 1e-11 sits
 * far above that error (~1e-15 relative, even after a division and a few sums)
 * and far below half a paisa for any amount this shop will ever ring up.
 */
const EPSILON_RATIO = 1e-11;
const EPSILON_FLOOR = 1e-9;

/**
 * Rounds to `decimals` places, half away from zero - the rule Indian retail
 * prints and the one the GST breakup is checked against.
 *
 * `decimals` is 2 for money, 3 for quantity (NUMERIC(12,3) - loose goods sell by
 * weight) and 0 when working in whole paise.
 */
export function roundMoney(value: number, decimals = 2): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`Cannot round ${String(value)}: expected a finite number.`);
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new RangeError(
      `Cannot round to ${String(decimals)} decimals: expected a whole number of places, ` +
        `0 to ${String(MAX_DECIMALS)}.`,
    );
  }

  const factor = 10 ** decimals;
  const magnitude = Math.abs(value) * factor;
  const epsilon = Math.max(magnitude * EPSILON_RATIO, EPSILON_FLOOR);
  const rounded = Math.floor(magnitude + 0.5 + epsilon);

  // Never hand back -0: it reads as 0 everywhere except an equality check.
  if (rounded === 0) return 0;
  return (value < 0 ? -rounded : rounded) / factor;
}

/**
 * Splits `total` across `weights` so the parts sum to exactly `total`, to the
 * paisa.
 *
 * Used twice, both times for something that must not leak: apportioning a
 * bill-level discount across lines before tax (invariant 4), and pushing a
 * group's tax back onto its lines so the printed line column still adds up to
 * the GST breakup.
 *
 * Largest remainder: every part is floored to whole paise, then the paise left
 * over go one each to the parts that lost the most in the flooring. That keeps
 * each part within a paisa of its exact share and the sum exact. Ties go to the
 * larger weight, then to the earlier line, so two identical bills never split
 * differently.
 */
export function apportion(total: number, weights: readonly number[]): number[] {
  if (!Number.isFinite(total) || total < 0) {
    throw new RangeError(`Cannot apportion ${String(total)}: expected a positive amount.`);
  }
  if (weights.length === 0) {
    throw new RangeError('Cannot apportion an amount across no lines.');
  }
  for (const weight of weights) {
    if (!Number.isFinite(weight) || weight < 0) {
      throw new RangeError(`Cannot apportion by weight ${String(weight)}: expected 0 or more.`);
    }
  }

  const minorTotal = roundMoney(total * 100, 0);
  if (minorTotal === 0) return weights.map(() => 0);

  const weightTotal = weights.reduce((running, weight) => running + weight, 0);
  if (weightTotal <= 0) {
    throw new RangeError('Cannot apportion an amount across lines that are all weightless.');
  }

  const exact = weights.map((weight) => (minorTotal * weight) / weightTotal);
  const minorShares = exact.map((share) => Math.floor(share));
  let leftover = minorTotal - minorShares.reduce((running, share) => running + share, 0);

  const byRemainder = exact
    .map((share, index) => ({
      remainder: share - Math.floor(share),
      weight: weights[index] ?? 0,
      index,
    }))
    .sort((a, b) => b.remainder - a.remainder || b.weight - a.weight || a.index - b.index);

  for (const { index } of byRemainder) {
    if (leftover <= 0) break;
    minorShares[index] = (minorShares[index] ?? 0) + 1;
    leftover -= 1;
  }

  return minorShares.map((minor) => minor / 100);
}
