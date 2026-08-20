import { describe, expect, it } from 'vitest';

import {
  type BillInput,
  type BillLineInput,
  type ComputedBill,
  computeBillTax,
  restateInclusivePrice,
  type RoundOffPolicy,
  TaxInputError,
  type TaxRateSnapshot,
} from './bill-tax.js';

/** GST 5% intra-state, as seeded in 001_foundation.sql. */
const GST_5: TaxRateSnapshot = { cgstRate: 2.5, sgstRate: 2.5, igstRate: 0, cessRate: 0 };
const GST_18: TaxRateSnapshot = { cgstRate: 9, sgstRate: 9, igstRate: 0, cessRate: 0 };
const GST_0: TaxRateSnapshot = { cgstRate: 0, sgstRate: 0, igstRate: 0, cessRate: 0 };
/** Inter-state: one IGST rate, no CGST/SGST. */
const IGST_18: TaxRateSnapshot = { cgstRate: 0, sgstRate: 0, igstRate: 18, cessRate: 0 };

function line(lineNo: number, qty: number, rate: number, taxRates: TaxRateSnapshot): BillLineInput {
  return { lineNo, qty, rate, rateTaxType: 'inclusive', taxRates };
}

function exclusiveLine(
  lineNo: number,
  qty: number,
  rate: number,
  taxRates: TaxRateSnapshot,
): BillLineInput {
  return { lineNo, qty, rate, rateTaxType: 'exclusive', taxRates };
}

/** The two lines of the reference receipt: 1 x 112.00 and 2 x 22.00, both 5%. */
const referenceLines: readonly BillLineInput[] = [line(1, 1, 112, GST_5), line(2, 2, 22, GST_5)];

/**
 * The reference receipt - a real D-Mart bill, 5% slab, GST-inclusive prices.
 *
 * CLAUDE.md invariant 1 and `docs/build-order.md` step 2 quoted this bill as
 * 106.67 + 41.91 = 148.58 taxable until this engine was built. That set cannot
 * hold: 148.58 + 3.71 + 3.71 is 156.00, not the 155.99 the receipt prints, and
 * it leaves no 0.01 round_off. Working back from the printed total,
 * 155.99 - 7.42 = 148.57 - exactly what invariant 1's own formula gives:
 *
 *     44.00 / 1.05 = 41.904761...  ->  41.90   (41.91 needs a second rounding
 *                                               pass at 3dp, or a ceiling)
 *
 * The docs now read 41.90 / 148.57. If a later change makes this suite fail on
 * those two figures, the arithmetic above is the thing to check first: every
 * other figure on the receipt, including the cash the customer handed over,
 * reproduces to the paisa and pins them.
 */
describe('the reference receipt', () => {
  const bill = computeBillTax({ lines: referenceLines });

  it('rounds each line taxable on its own', () => {
    expect(bill.lines.map((l) => l.taxableAmount)).toEqual([106.67, 41.9]);
  });

  it('sums the line taxables into the group taxable', () => {
    expect(bill.groups).toHaveLength(1);
    expect(bill.groups[0]?.taxableAmount).toBe(148.57);
  });

  it('taxes the group, never the line', () => {
    // The whole point of invariant 1. Per line: round(106.67 x 2.5%) = 2.67 plus
    // round(41.90 x 2.5%) = 1.05 is 3.72, and the bill stops tying out.
    expect(bill.groups[0]?.cgstAmount).toBe(3.71);
    expect(bill.groups[0]?.sgstAmount).toBe(3.71);
    expect(bill.groups[0]?.totalAmount).toBe(155.99);
  });

  it('stores the round off and the net the customer pays', () => {
    expect(bill.totals.totalAmount).toBe(155.99);
    expect(bill.totals.roundOff).toBe(0.01);
    expect(bill.totals.netAmount).toBe(156);
    // The cash figure on the receipt: 112.00 + 44.00.
    expect(bill.totals.netAmount).toBe(bill.totals.grossAmount);
  });

  it('reports the Items and Qty counts the receipt prints', () => {
    expect(bill.totals.itemCount).toBe(2);
    expect(bill.totals.totalQty).toBe(3);
  });

  it('splits group tax back onto the lines so the columns still add up', () => {
    // Line tax is an apportionment of group tax, never computed per line.
    expect(bill.lines.map((l) => l.cgstAmount)).toEqual([2.66, 1.05]);
    expect(bill.lines.map((l) => l.lineTotal)).toEqual([111.99, 44]);
  });
});

describe('tax groups', () => {
  const bill = computeBillTax({ lines: [...referenceLines, line(3, 1, 236, GST_18)] });

  it('groups lines by their snapshotted rates, in printed order', () => {
    expect(bill.groups.map((g) => g.taxGroupIndex)).toEqual([1, 2]);
    expect(bill.groups.map((g) => g.cgstRate)).toEqual([2.5, 9]);
    expect(bill.lines.map((l) => l.taxGroupIndex)).toEqual([1, 1, 2]);
  });

  it('taxes each group separately', () => {
    expect(bill.groups[0]).toMatchObject({ taxableAmount: 148.57, cgstAmount: 3.71 });
    expect(bill.groups[1]).toMatchObject({ taxableAmount: 200, cgstAmount: 18, sgstAmount: 18 });
  });

  it('totals the bill across groups', () => {
    expect(bill.totals).toMatchObject({
      taxableAmount: 348.57,
      cgstAmount: 21.71,
      sgstAmount: 21.71,
      totalAmount: 391.99,
      roundOff: 0.01,
      netAmount: 392,
    });
  });
});

/**
 * Invariant 4. A flat Rs 50 off a bill holding 5% and 18% items is split by
 * taxable value *before* tax, or the GST breakup does not tie out and GSTR-1 is
 * wrong.
 */
describe('a bill-level discount', () => {
  const bill = computeBillTax({
    lines: [...referenceLines, line(3, 1, 236, GST_18)],
    billDiscountAmount: 50,
  });

  it('apportions pro-rata by taxable value, down to the line', () => {
    // Taxable values before discount: 106.6667, 41.9048, 200.00 of 348.5714.
    expect(bill.lines.map((l) => l.billDiscountShare)).toEqual([15.3, 6.01, 28.69]);
  });

  it('hands out every paisa of the discount and no more', () => {
    const shared = bill.lines.reduce((total, l) => total + l.billDiscountShare, 0);

    expect(shared).toBeCloseTo(50, 10);
    expect(bill.totals.billDiscountAmount).toBe(50);
  });

  it('discounts before tax, so each group is taxed on the reduced value', () => {
    expect(bill.groups[0]).toMatchObject({ taxableAmount: 128.28, cgstAmount: 3.21 });
    expect(bill.groups[1]).toMatchObject({ taxableAmount: 175.69, cgstAmount: 15.81 });
  });

  it('takes exactly Rs 50 off what the customer pays', () => {
    expect(bill.totals.taxableAmount).toBe(303.97);
    expect(bill.totals.totalAmount).toBe(342.01);
    expect(bill.totals.roundOff).toBe(-0.01);
    expect(bill.totals.netAmount).toBe(342);
    expect(bill.totals.netAmount).toBe(bill.totals.grossAmount - 50);
  });

  it('refuses a discount larger than the bill', () => {
    expect(() => computeBillTax({ lines: referenceLines, billDiscountAmount: 200 })).toThrow(
      TaxInputError,
    );
  });
});

describe('tax-exclusive prices', () => {
  // Supplier prices are quoted without GST; the rate is the taxable value.
  const bill = computeBillTax({
    lines: [exclusiveLine(1, 1, 100, GST_18), exclusiveLine(2, 3, 33.33, GST_18)],
  });

  it('takes the line amount as the taxable value, adding tax on top', () => {
    expect(bill.lines.map((l) => l.taxableAmount)).toEqual([100, 99.99]);
    expect(bill.groups[0]).toMatchObject({
      taxableAmount: 199.99,
      cgstAmount: 18,
      sgstAmount: 18,
      totalAmount: 235.99,
    });
  });

  it('still rounds off the bill', () => {
    expect(bill.totals).toMatchObject({ totalAmount: 235.99, roundOff: 0.01, netAmount: 236 });
  });

  it('reads an inclusive and an exclusive line at the same rate as one group', () => {
    const mixed = computeBillTax({
      lines: [exclusiveLine(1, 1, 100, GST_18), line(2, 1, 236, GST_18)],
    });

    expect(mixed.groups).toHaveLength(1);
    expect(mixed.groups[0]?.taxableAmount).toBe(300);
  });
});

describe('a zero-rated line', () => {
  // Loose grain, milk, fresh vegetables - the 0% slab, seeded in 001.
  const bill = computeBillTax({ lines: [line(1, 1, 50, GST_0), line(2, 1, 112, GST_5)] });

  it('is its own tax group, taxed at nothing', () => {
    expect(bill.groups[0]).toMatchObject({
      taxGroupIndex: 1,
      cgstRate: 0,
      taxableAmount: 50,
      cgstAmount: 0,
      sgstAmount: 0,
      totalAmount: 50,
    });
  });

  it('passes its price straight through as taxable value', () => {
    expect(bill.lines[0]).toMatchObject({ taxableAmount: 50, lineTotal: 50 });
  });

  it('does not disturb the taxed group beside it', () => {
    expect(bill.groups[1]).toMatchObject({ taxableAmount: 106.67, cgstAmount: 2.67 });
    expect(bill.totals).toMatchObject({
      taxableAmount: 156.67,
      totalAmount: 162.01,
      netAmount: 162,
    });
  });
});

describe('inter-state supply', () => {
  it('charges IGST instead of CGST and SGST', () => {
    const bill = computeBillTax({ lines: [line(1, 1, 118, IGST_18)] });

    expect(bill.groups[0]).toMatchObject({
      taxableAmount: 100,
      igstAmount: 18,
      cgstAmount: 0,
      sgstAmount: 0,
      totalAmount: 118,
    });
  });

  it('refuses a line carrying IGST and CGST at once', () => {
    const broken: TaxRateSnapshot = { cgstRate: 2.5, sgstRate: 2.5, igstRate: 5, cessRate: 0 };

    expect(() => computeBillTax({ lines: [line(1, 1, 112, broken)] })).toThrow(TaxInputError);
  });
});

describe('line-level discount', () => {
  it('comes off the line before its taxable value is worked out', () => {
    const bill = computeBillTax({
      lines: [{ ...line(1, 1, 112, GST_5), discountAmount: 5 }, line(2, 2, 22, GST_5)],
    });

    expect(bill.lines[0]).toMatchObject({
      lineGross: 112,
      discountAmount: 5,
      taxableAmount: 101.9,
    });
    expect(bill.totals).toMatchObject({
      lineDiscountAmount: 5,
      taxableAmount: 143.8,
      netAmount: 151,
    });
  });

  it('refuses a discount larger than the line', () => {
    expect(() =>
      computeBillTax({ lines: [{ ...line(1, 1, 112, GST_5), discountAmount: 120 }] }),
    ).toThrow(TaxInputError);
  });
});

describe('round off', () => {
  const policy = (mode: RoundOffPolicy['mode'], to = 1): RoundOffPolicy => ({
    enabled: true,
    mode,
    to,
  });

  it('rounds to the nearest rupee by default', () => {
    const bill = computeBillTax({ lines: referenceLines });

    expect(bill.totals).toMatchObject({ roundOff: 0.01, netAmount: 156 });
  });

  it('rounds up when the store is set to round up', () => {
    const bill = computeBillTax({ lines: referenceLines, roundOff: policy('up') });

    expect(bill.totals).toMatchObject({ roundOff: 0.01, netAmount: 156 });
  });

  it('rounds down when the store is set to round down', () => {
    const bill = computeBillTax({ lines: referenceLines, roundOff: policy('down') });

    expect(bill.totals).toMatchObject({ roundOff: -0.99, netAmount: 155 });
  });

  it('leaves the total alone when round off is switched off', () => {
    const bill = computeBillTax({
      lines: referenceLines,
      roundOff: { enabled: false, mode: 'nearest', to: 1 },
    });

    expect(bill.totals).toMatchObject({ roundOff: 0, netAmount: 155.99 });
  });

  it('honours a round-off increment other than a rupee', () => {
    const bill = computeBillTax({ lines: referenceLines, roundOff: policy('nearest', 0.5) });

    expect(bill.totals).toMatchObject({ roundOff: 0.01, netAmount: 156 });
  });

  it('records no round off when the total already lands on the increment', () => {
    const bill = computeBillTax({ lines: [line(1, 1, 236, GST_18)] });

    expect(bill.totals).toMatchObject({ totalAmount: 236, roundOff: 0, netAmount: 236 });
  });

  it('refuses a rounding increment of nothing', () => {
    expect(() => computeBillTax({ lines: referenceLines, roundOff: policy('nearest', 0) })).toThrow(
      TaxInputError,
    );
  });
});

describe('loose goods sold by weight', () => {
  it('rounds the line amount before anything else touches it', () => {
    // 0.755 kg at Rs 89.00/kg is 67.195 - the paisa is settled once, on the line.
    const bill = computeBillTax({ lines: [line(1, 0.755, 89, GST_5)] });

    expect(bill.lines[0]).toMatchObject({ lineGross: 67.2, taxableAmount: 64 });
    expect(bill.totals).toMatchObject({ totalQty: 0.755, totalAmount: 67.2, netAmount: 67 });
  });
});

describe('input the engine will not accept', () => {
  it('rejects a bill with no lines', () => {
    expect(() => computeBillTax({ lines: [] })).toThrow(TaxInputError);
  });

  it('rejects quantities and rates that cannot appear on a sale line', () => {
    expect(() => computeBillTax({ lines: [line(1, 0, 112, GST_5)] })).toThrow(TaxInputError);
    expect(() => computeBillTax({ lines: [line(1, -1, 112, GST_5)] })).toThrow(TaxInputError);
    expect(() => computeBillTax({ lines: [line(1, 1, -112, GST_5)] })).toThrow(TaxInputError);
    expect(() => computeBillTax({ lines: [line(1, Number.NaN, 112, GST_5)] })).toThrow(
      TaxInputError,
    );
  });

  it('rejects a negative tax rate', () => {
    const broken: TaxRateSnapshot = { cgstRate: -2.5, sgstRate: 2.5, igstRate: 0, cessRate: 0 };

    expect(() => computeBillTax({ lines: [line(1, 1, 112, broken)] })).toThrow(TaxInputError);
  });

  it('carries a code so the billing screen can say it in both languages', () => {
    try {
      computeBillTax({ lines: [] });
      expect.unreachable('an empty bill should not compute');
    } catch (error) {
      expect(error).toBeInstanceOf(TaxInputError);
      expect((error as TaxInputError).code).toBe('bill.no_lines');
    }
  });
});

/**
 * The arithmetic that has to hold on every bill the shop prints, whatever is on
 * it. If one of these fails, the GST breakup no longer ties out to the document.
 */
describe('every bill ties out', () => {
  const bills: readonly (readonly [string, BillInput])[] = [
    ['reference receipt', { lines: referenceLines }],
    ['two groups', { lines: [...referenceLines, line(3, 1, 236, GST_18)] }],
    [
      'two groups, Rs 50 off',
      { lines: [...referenceLines, line(3, 1, 236, GST_18)], billDiscountAmount: 50 },
    ],
    [
      'a discount that will not divide',
      {
        lines: [line(1, 1, 100, GST_5), line(2, 1, 100, GST_5), line(3, 1, 100, GST_5)],
        billDiscountAmount: 10,
      },
    ],
    ['zero-rated beside taxed', { lines: [line(1, 1, 50, GST_0), line(2, 1, 112, GST_5)] }],
    ['exclusive prices', { lines: [exclusiveLine(1, 3, 33.33, GST_18)] }],
    ['inter-state', { lines: [line(1, 1, 118, IGST_18)] }],
    [
      'a long till roll',
      {
        lines: Array.from({ length: 40 }, (_, i) =>
          line(i + 1, (i % 4) + 0.5, 7.77 * (i + 1), i % 3 === 0 ? GST_5 : GST_18),
        ),
        billDiscountAmount: 37.77,
      },
    ],
  ];

  /** Adds already-rounded money without letting binary drift into the assertion. */
  const total = (values: readonly number[]): number =>
    Number(values.reduce((a, b) => a + b, 0).toFixed(2));

  for (const [name, input] of bills) {
    describe(name, () => {
      const bill: ComputedBill = computeBillTax(input);

      it('sums line taxables and line tax into the group', () => {
        for (const group of bill.groups) {
          const lines = bill.lines.filter((l) => l.taxGroupIndex === group.taxGroupIndex);

          expect(total(lines.map((l) => l.taxableAmount))).toBe(group.taxableAmount);
          expect(total(lines.map((l) => l.cgstAmount))).toBe(group.cgstAmount);
          expect(total(lines.map((l) => l.sgstAmount))).toBe(group.sgstAmount);
          expect(total(lines.map((l) => l.igstAmount))).toBe(group.igstAmount);
          expect(total(lines.map((l) => l.cessAmount))).toBe(group.cessAmount);
        }
      });

      it('sums group figures into the bill totals', () => {
        expect(total(bill.groups.map((g) => g.taxableAmount))).toBe(bill.totals.taxableAmount);
        expect(total(bill.groups.map((g) => g.cgstAmount))).toBe(bill.totals.cgstAmount);
        expect(total(bill.groups.map((g) => g.totalAmount))).toBe(bill.totals.totalAmount);
      });

      it('adds tax to taxable to reach the total, then round off to reach the net', () => {
        const { taxableAmount, cgstAmount, sgstAmount, igstAmount, cessAmount } = bill.totals;

        expect(total([taxableAmount, cgstAmount, sgstAmount, igstAmount, cessAmount])).toBe(
          bill.totals.totalAmount,
        );
        expect(total([bill.totals.totalAmount, bill.totals.roundOff])).toBe(bill.totals.netAmount);
        expect(Math.abs(bill.totals.roundOff)).toBeLessThan(1);
      });

      it('hands out the whole bill discount and nothing else', () => {
        expect(total(bill.lines.map((l) => l.billDiscountShare))).toBe(
          bill.totals.billDiscountAmount,
        );
        expect(bill.totals.billDiscountAmount).toBe(input.billDiscountAmount ?? 0);
      });

      it('gives every line a group and every group a line', () => {
        const indexes = new Set(bill.lines.map((l) => l.taxGroupIndex));

        expect(bill.groups.map((g) => g.taxGroupIndex)).toEqual([...indexes].sort((a, b) => a - b));
        expect(bill.lines).toHaveLength(input.lines.length);
      });
    });
  }
});

describe('restateInclusivePrice', () => {
  it('holds the ex-tax amount when a rate rises', () => {
    // ₹100 inclusive at 5% is ₹95.238... ex-tax. Passed on at 18% that is
    // 95.238... x 1.18 = ₹112.38, and the shop keeps what it kept before.
    expect(restateInclusivePrice(100, 5, 18)).toBe(112.38);
  });

  it('holds it when a rate falls', () => {
    expect(restateInclusivePrice(112.38, 18, 5)).toBe(100);
  });

  it('is a no-op when the rate does not move', () => {
    // A bulk reassignment can include products already on the target slab -
    // selecting a whole category to move will do it. Those must not drift.
    for (const price of [1, 44, 99.99, 495, 5000.55]) {
      expect(restateInclusivePrice(price, 18, 18)).toBe(price);
    }
  });

  it('restates to and from zero-rated', () => {
    expect(restateInclusivePrice(105, 5, 0)).toBe(100);
    expect(restateInclusivePrice(100, 0, 5)).toBe(105);
  });

  it('rounds once, at the end', () => {
    // Rounding the ex-tax figure first gives 41.90 x 1.18 = 49.44. Carrying it
    // unrounded gives 41.9047... x 1.18 = 49.4476..., which is 49.45. One paisa
    // per product, in the same direction, across every SKU in the run.
    expect(restateInclusivePrice(44, 5, 18)).toBe(49.45);
  });

  it('refuses a negative price or a negative rate', () => {
    expect(() => restateInclusivePrice(-1, 5, 18)).toThrow(RangeError);
    expect(() => restateInclusivePrice(100, -5, 18)).toThrow(RangeError);
    expect(() => restateInclusivePrice(100, 5, -18)).toThrow(RangeError);
    expect(() => restateInclusivePrice(Number.NaN, 5, 18)).toThrow(RangeError);
  });
});
