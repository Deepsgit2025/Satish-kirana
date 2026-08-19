import { describe, expect, it } from 'vitest';

import { apportion, roundMoney } from './money.js';

/**
 * `roundMoney` is the one rounding function of CLAUDE.md invariant 1. Everything
 * that produces a money figure goes through it, so its edge cases are the edge
 * cases of every bill the shop ever prints.
 */
describe('roundMoney', () => {
  it('rounds the reference receipt lines', () => {
    // 112.00 and 44.00 at 5% inclusive - the two lines of the D-Mart receipt.
    expect(roundMoney(112 / 1.05)).toBe(106.67);
    expect(roundMoney(44 / 1.05)).toBe(41.9);
  });

  it('rounds a half paisa away from zero, not to even', () => {
    expect(roundMoney(0.125)).toBe(0.13);
    expect(roundMoney(0.135)).toBe(0.14);
    expect(roundMoney(-0.125)).toBe(-0.13);
  });

  it('rounds the decimal the operator typed, not the double behind it', () => {
    // 2.675 is stored as 2.67499999999999982..., so a naive scale-and-round
    // gives 2.67 and the shop is short a paisa on every such line.
    expect(roundMoney(2.675)).toBe(2.68);
    expect(roundMoney(1.005)).toBe(1.01);
    expect(roundMoney(-2.675)).toBe(-2.68);
  });

  it('leaves a value that is already at 2 decimals alone', () => {
    expect(roundMoney(106.67)).toBe(106.67);
    expect(roundMoney(0)).toBe(0);
    expect(roundMoney(-0.01)).toBe(-0.01);
  });

  it('is idempotent', () => {
    for (const value of [112 / 1.05, 44 / 1.05, 2.675, 348.5714285714286, -19.005]) {
      expect(roundMoney(roundMoney(value))).toBe(roundMoney(value));
    }
  });

  it('rounds quantities at 3 decimals and whole rupees at 0', () => {
    // quantity is NUMERIC(12,3) - loose goods sell by weight.
    expect(roundMoney(0.7555, 3)).toBe(0.756);
    expect(roundMoney(1 / 3, 3)).toBe(0.333);
    expect(roundMoney(155.5, 0)).toBe(156);
    expect(roundMoney(155.4999, 0)).toBe(155);
  });

  it('holds at the magnitudes a day of billing reaches', () => {
    expect(roundMoney(999_999.005)).toBe(999_999.01);
    expect(roundMoney(1_234_567.894_9)).toBe(1_234_567.89);
  });

  it('rejects values that are not finite numbers', () => {
    expect(() => roundMoney(Number.NaN)).toThrow(RangeError);
    expect(() => roundMoney(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => roundMoney(1.5, 1.5)).toThrow(RangeError);
    expect(() => roundMoney(1.5, -1)).toThrow(RangeError);
  });
});

/**
 * `apportion` is the other half of invariant 1's arithmetic: a rupee figure that
 * has to be split over lines without losing or inventing a paisa. Used for the
 * bill discount (invariant 4) and for pushing group tax back onto lines.
 */
describe('apportion', () => {
  it('splits a bill discount pro-rata by taxable value', () => {
    // Rs 50 off a bill with 5% lines (106.6667 + 41.9048) and an 18% line (200).
    const shares = apportion(50, [112 / 1.05, 44 / 1.05, 200]);

    expect(shares).toEqual([15.3, 6.01, 28.69]);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(50, 10);
  });

  it('gives the leftover paise to the largest weight, lowest line first on a tie', () => {
    // 10.00 over three equal lines is 3.333... each; someone must take the paisa.
    expect(apportion(10, [100, 100, 100])).toEqual([3.34, 3.33, 3.33]);
    expect(apportion(10, [100, 300, 100])).toEqual([2, 6, 2]);
  });

  it('splits group tax back onto its lines without drift', () => {
    expect(apportion(3.71, [106.67, 41.9])).toEqual([2.66, 1.05]);
  });

  it('always sums to exactly the amount handed to it', () => {
    const cases: readonly (readonly [number, readonly number[]])[] = [
      [50, [112 / 1.05, 44 / 1.05, 200]],
      [3.71, [106.67, 41.9]],
      [0.01, [1, 1, 1, 1, 1, 1, 1]],
      [99.99, [1, 2, 3, 4, 5, 6, 7, 8, 9]],
      [1234.56, [0.001, 999, 17.5]],
    ];

    for (const [total, weights] of cases) {
      const shares = apportion(total, weights);
      expect(roundMoney(shares.reduce((a, b) => a + b, 0))).toBe(roundMoney(total));
      expect(shares).toHaveLength(weights.length);
    }
  });

  it('gives a weightless line nothing', () => {
    expect(apportion(10, [0, 100])).toEqual([0, 10]);
  });

  it('splits nothing into nothing, even when every weight is zero', () => {
    expect(apportion(0, [0, 0])).toEqual([0, 0]);
    expect(apportion(0, [5, 5])).toEqual([0, 0]);
  });

  it('returns the whole amount to a single line', () => {
    expect(apportion(7.77, [42])).toEqual([7.77]);
  });

  it('refuses to split an amount across nothing to split it by', () => {
    expect(() => apportion(10, [0, 0])).toThrow(RangeError);
    expect(() => apportion(10, [])).toThrow(RangeError);
    expect(() => apportion(-1, [1, 1])).toThrow(RangeError);
    expect(() => apportion(10, [1, -1])).toThrow(RangeError);
    expect(() => apportion(Number.NaN, [1])).toThrow(RangeError);
  });
});
