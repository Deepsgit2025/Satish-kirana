import type { TranslationKey } from '../i18n/catalogue.js';
import { TranslatableError } from '../i18n/errors.js';
import type { MessageParams } from '../i18n/translator.js';
import { apportion, roundMoney } from './money.js';

/**
 * The tax engine. One document in, one set of stored figures out - the same
 * shape for a sale, a purchase, a credit note or a debit note (docs/schema.md,
 * "one table, one tax engine").
 *
 * The rules it exists to enforce, from CLAUDE.md:
 *
 *   1. One rounding function, one call site. The three formulas below appear
 *      exactly once each; nothing else in the codebase may recompute them.
 *
 *          line_taxable  = round(rate x qty / (1 + total_rate/100), 2)
 *          group_taxable = SUM(line_taxable)
 *          group_cgst    = round(group_taxable x cgst_rate/100, 2)
 *
 *      Tax is charged on the group, never per line and summed. On the reference
 *      receipt, per line gives 3.72 where the group gives 3.71, and the bill
 *      stops tying out.
 *
 *   2. Rates arrive as a snapshot on the line. This module never looks anything
 *      up - no tax_slabs, no products - so a six-month-old bill reprints at the
 *      rates it was sold at.
 *
 *   3. `round_off` comes back as a figure to store, not something a screen works
 *      out later. Two devices must never disagree about the last paisa.
 *
 *   4. A bill-level discount is apportioned pro-rata by taxable value and taken
 *      off before tax, or the GST breakup does not tie out and GSTR-1 is wrong.
 *
 * Money is `number` here and NUMERIC(12,2) in Postgres. Everything that leaves
 * this module has been through `roundMoney`, so a caller can store it as-is.
 */

/** How the price on a line is quoted. Retail is inclusive; suppliers are not. */
export type PriceTaxType = 'inclusive' | 'exclusive';

/** `round_off_mode` in app_settings. */
export type RoundOffMode = 'nearest' | 'up' | 'down';

/**
 * The four rates copied onto the line at sale time (invariant 2).
 *
 * Intra-state supply carries CGST and SGST; inter-state carries IGST. Which one
 * applies is decided from `place_of_supply` by the caller, before it gets here.
 */
export interface TaxRateSnapshot {
  readonly cgstRate: number;
  readonly sgstRate: number;
  readonly igstRate: number;
  readonly cessRate: number;
}

export interface BillLineInput {
  /** `transaction_lines.line_no` - the printed order, and the tie-break on splits. */
  readonly lineNo: number;
  readonly qty: number;
  /** Price per unit, inclusive or exclusive per `rateTaxType`. */
  readonly rate: number;
  readonly rateTaxType: PriceTaxType;
  /** Line-level discount in rupees, off this line only. */
  readonly discountAmount?: number;
  readonly taxRates: TaxRateSnapshot;
}

export interface RoundOffPolicy {
  readonly enabled: boolean;
  readonly mode: RoundOffMode;
  /** Increment in rupees. `round_off_to`, 1.00 in the seeded settings. */
  readonly to: number;
}

export interface BillInput {
  readonly lines: readonly BillLineInput[];
  /** Header-level discount, spread across the lines before tax. */
  readonly billDiscountAmount?: number;
  readonly roundOff?: RoundOffPolicy;
}

/** One `transaction_lines` row's worth of figures. */
export interface ComputedBillLine {
  readonly lineNo: number;
  readonly taxGroupIndex: number;
  readonly lineGross: number;
  readonly discountAmount: number;
  /** This line's share of the bill-level discount. */
  readonly billDiscountShare: number;
  readonly taxableAmount: number;
  readonly cgstAmount: number;
  readonly sgstAmount: number;
  readonly igstAmount: number;
  readonly cessAmount: number;
  readonly lineTotal: number;
}

/** One `transaction_tax_summary` row - the printed GST breakup block. */
export interface ComputedTaxGroup {
  readonly taxGroupIndex: number;
  readonly cgstRate: number;
  readonly sgstRate: number;
  readonly igstRate: number;
  readonly cessRate: number;
  readonly taxableAmount: number;
  readonly cgstAmount: number;
  readonly sgstAmount: number;
  readonly igstAmount: number;
  readonly cessAmount: number;
  readonly totalAmount: number;
}

/** The money columns of the `transactions` row. */
export interface ComputedBillTotals {
  /** `item_count` - the "Items: 2" figure. */
  readonly itemCount: number;
  /** `total_qty` - the "Qty: 3" figure. */
  readonly totalQty: number;
  /** Sum of rate x qty as entered, before any discount. */
  readonly grossAmount: number;
  readonly lineDiscountAmount: number;
  readonly billDiscountAmount: number;
  readonly taxableAmount: number;
  readonly cgstAmount: number;
  readonly sgstAmount: number;
  readonly igstAmount: number;
  readonly cessAmount: number;
  /** Taxable plus tax, before round off. */
  readonly totalAmount: number;
  /** Stored, never recomputed for display (invariant 3). */
  readonly roundOff: number;
  /** What the customer pays. */
  readonly netAmount: number;
}

export interface ComputedBill {
  readonly lines: readonly ComputedBillLine[];
  readonly groups: readonly ComputedTaxGroup[];
  readonly totals: ComputedBillTotals;
}

/**
 * Why a bill would not compute.
 *
 * Stable strings, and deliberately the same strings as the tail of the
 * `error.tax.*` keys in `en.json` / `hi.json` - `taxErrorKey` is the whole of
 * the mapping. A cashier who reads Hindi gets the reason in Hindi, and the code
 * is what crosses the sync boundary and lands in a log, unchanged by either.
 *
 * Adding a code without adding its message does not compile: the template
 * literal below has to land inside `TranslationKey`, which is derived from
 * `en.json`. That is the check worth having, because the failure it prevents -
 * an English sentence appearing at a Hindi terminal - only shows up on the day
 * a bill will not total, which is the worst day to discover it.
 */
export type TaxErrorCode =
  | 'bill.no_lines'
  | 'bill.discount_invalid'
  | 'bill.discount_exceeds_total'
  | 'line.qty_invalid'
  | 'line.rate_invalid'
  | 'line.tax_rate_invalid'
  | 'line.igst_with_cgst'
  | 'line.discount_invalid'
  | 'line.discount_exceeds_line'
  | 'roundoff.increment_invalid'
  | 'roundoff.increment_below_paisa'
  | 'roundoff.mode_invalid';

export function taxErrorKey(code: TaxErrorCode): TranslationKey {
  return `error.tax.${code}`;
}

/**
 * Raised for every rule above, so callers can catch them as one class.
 *
 * Carries the code and the numbers that go in the sentence, never the sentence.
 * `Error.message` is filled from the English catalogue by `TranslatableError`,
 * so a stack trace still reads properly without any English being written here.
 */
export class TaxInputError extends TranslatableError {
  readonly code: TaxErrorCode;

  constructor(code: TaxErrorCode, params: MessageParams = {}) {
    super(taxErrorKey(code), params);
    this.name = 'TaxInputError';
    this.code = code;
  }
}

/** `round_off_enabled` / `round_off_mode` / `round_off_to` as seeded in 001. */
export const DEFAULT_ROUND_OFF: RoundOffPolicy = { enabled: true, mode: 'nearest', to: 1 };

/** A line with its arithmetic prepared, before the bill discount is spread. */
interface PreparedLine {
  readonly input: BillLineInput;
  readonly rates: TaxRateSnapshot;
  /** 1 + total_rate/100 for an inclusive price, 1 for an exclusive one. */
  readonly divisor: number;
  readonly lineGross: number;
  readonly discountAmount: number;
  /** Line amount after its own discount, in the domain the price was quoted in. */
  readonly netAmount: number;
  /** Taxable value before the bill discount, unrounded - the apportioning weight. */
  readonly basis: number;
}

/** Lines sharing one rate signature: one `transaction_tax_summary` row. */
interface GroupInProgress {
  readonly taxGroupIndex: number;
  readonly rates: TaxRateSnapshot;
  readonly members: number[];
}

/**
 * Computes every money figure on a document from its lines.
 *
 * Order matters and is the order below: line amount, line discount, bill
 * discount apportioned by taxable value, taxable value rounded per line, lines
 * grouped by rate, tax charged on the group, group tax pushed back onto the
 * lines, round off last.
 */
export function computeBillTax(bill: BillInput): ComputedBill {
  const policy = bill.roundOff ?? DEFAULT_ROUND_OFF;
  const billDiscount = bill.billDiscountAmount ?? 0;

  if (bill.lines.length === 0) {
    throw new TaxInputError('bill.no_lines');
  }
  if (!Number.isFinite(billDiscount) || billDiscount < 0) {
    throw new TaxInputError('bill.discount_invalid', { amount: String(billDiscount) });
  }
  checkRoundOffPolicy(policy);

  const prepared = bill.lines.map(prepareLine);

  const discountable = roundMoney(prepared.reduce((running, line) => running + line.netAmount, 0));
  if (billDiscount > discountable) {
    throw new TaxInputError('bill.discount_exceeds_total', {
      discount: billDiscount.toFixed(2),
      total: discountable.toFixed(2),
    });
  }

  // Invariant 4: split by taxable value, before tax.
  const discountShares =
    billDiscount === 0
      ? prepared.map(() => 0)
      : apportion(
          billDiscount,
          prepared.map((line) => line.basis),
        );

  // Invariant 1, first formula: one call site, per line.
  const taxableAmounts = prepared.map((line, index) =>
    roundMoney((line.netAmount - (discountShares[index] ?? 0)) / line.divisor),
  );

  const groups = groupByRates(prepared);
  const lineTax = prepared.map(() => ({ cgst: 0, sgst: 0, igst: 0, cess: 0 }));

  const computedGroups = groups.map((group) => {
    const weights = group.members.map((index) => taxableAmounts[index] ?? 0);

    // Invariant 1, second formula: sum the rounded line values, then tax that.
    const taxableAmount = roundMoney(weights.reduce((running, value) => running + value, 0));

    // Invariant 1, third formula: tax the group, once, per component.
    const cgstAmount = roundMoney((taxableAmount * group.rates.cgstRate) / 100);
    const sgstAmount = roundMoney((taxableAmount * group.rates.sgstRate) / 100);
    const igstAmount = roundMoney((taxableAmount * group.rates.igstRate) / 100);
    const cessAmount = roundMoney((taxableAmount * group.rates.cessRate) / 100);

    // Line tax is the group's tax shared out, never charged per line: that is
    // what keeps the printed line column adding up to the GST breakup.
    const cgstShares = apportion(cgstAmount, weights);
    const sgstShares = apportion(sgstAmount, weights);
    const igstShares = apportion(igstAmount, weights);
    const cessShares = apportion(cessAmount, weights);

    group.members.forEach((lineIndex, position) => {
      lineTax[lineIndex] = {
        cgst: cgstShares[position] ?? 0,
        sgst: sgstShares[position] ?? 0,
        igst: igstShares[position] ?? 0,
        cess: cessShares[position] ?? 0,
      };
    });

    return {
      taxGroupIndex: group.taxGroupIndex,
      cgstRate: group.rates.cgstRate,
      sgstRate: group.rates.sgstRate,
      igstRate: group.rates.igstRate,
      cessRate: group.rates.cessRate,
      taxableAmount,
      cgstAmount,
      sgstAmount,
      igstAmount,
      cessAmount,
      totalAmount: roundMoney(taxableAmount + cgstAmount + sgstAmount + igstAmount + cessAmount),
    } satisfies ComputedTaxGroup;
  });

  const groupOfLine = new Map<number, number>();
  for (const group of groups) {
    for (const index of group.members) groupOfLine.set(index, group.taxGroupIndex);
  }

  const lines = prepared.map((line, index) => {
    const tax = lineTax[index] ?? { cgst: 0, sgst: 0, igst: 0, cess: 0 };
    const taxableAmount = taxableAmounts[index] ?? 0;

    return {
      lineNo: line.input.lineNo,
      taxGroupIndex: groupOfLine.get(index) ?? 1,
      lineGross: line.lineGross,
      discountAmount: line.discountAmount,
      billDiscountShare: discountShares[index] ?? 0,
      taxableAmount,
      cgstAmount: tax.cgst,
      sgstAmount: tax.sgst,
      igstAmount: tax.igst,
      cessAmount: tax.cess,
      lineTotal: roundMoney(taxableAmount + tax.cgst + tax.sgst + tax.igst + tax.cess),
    } satisfies ComputedBillLine;
  });

  const sumGroups = (pick: (group: ComputedTaxGroup) => number): number =>
    roundMoney(computedGroups.reduce((running, group) => running + pick(group), 0));

  const taxableAmount = sumGroups((group) => group.taxableAmount);
  const cgstAmount = sumGroups((group) => group.cgstAmount);
  const sgstAmount = sumGroups((group) => group.sgstAmount);
  const igstAmount = sumGroups((group) => group.igstAmount);
  const cessAmount = sumGroups((group) => group.cessAmount);
  const totalAmount = roundMoney(taxableAmount + cgstAmount + sgstAmount + igstAmount + cessAmount);
  const roundOff = policy.enabled ? roundOffFor(totalAmount, policy) : 0;

  const totals: ComputedBillTotals = {
    itemCount: lines.length,
    totalQty: roundMoney(
      prepared.reduce((running, line) => running + line.input.qty, 0),
      3,
    ),
    grossAmount: roundMoney(prepared.reduce((running, line) => running + line.lineGross, 0)),
    lineDiscountAmount: roundMoney(
      prepared.reduce((running, line) => running + line.discountAmount, 0),
    ),
    billDiscountAmount: roundMoney(discountShares.reduce((running, share) => running + share, 0)),
    taxableAmount,
    cgstAmount,
    sgstAmount,
    igstAmount,
    cessAmount,
    totalAmount,
    roundOff,
    netAmount: roundMoney(totalAmount + roundOff),
  };

  return { lines, groups: computedGroups, totals };
}

/** Validates one line and works out everything that does not depend on the bill. */
function prepareLine(input: BillLineInput): PreparedLine {
  // The line number is a parameter rather than a prefix glued onto an English
  // sentence: Hindi puts "पंक्ति {line}" in the same place here, but the moment a
  // message wants it elsewhere a prefix cannot follow (docs/DECISIONS.md D34).
  const where = { line: input.lineNo };

  if (!Number.isFinite(input.qty) || input.qty <= 0) {
    throw new TaxInputError('line.qty_invalid', where);
  }
  if (!Number.isFinite(input.rate) || input.rate < 0) {
    throw new TaxInputError('line.rate_invalid', where);
  }

  const rates = input.taxRates;
  for (const [name, rate] of [
    ['CGST', rates.cgstRate],
    ['SGST', rates.sgstRate],
    ['IGST', rates.igstRate],
    ['cess', rates.cessRate],
  ] as const) {
    if (!Number.isFinite(rate) || rate < 0) {
      throw new TaxInputError('line.tax_rate_invalid', {
        ...where,
        tax: name,
        rate: String(rate),
      });
    }
  }
  if (rates.igstRate > 0 && (rates.cgstRate > 0 || rates.sgstRate > 0)) {
    throw new TaxInputError('line.igst_with_cgst', where);
  }

  const discountAmount = input.discountAmount ?? 0;
  if (!Number.isFinite(discountAmount) || discountAmount < 0) {
    throw new TaxInputError('line.discount_invalid', {
      ...where,
      amount: String(discountAmount),
    });
  }

  const lineGross = roundMoney(input.rate * input.qty);
  if (discountAmount > lineGross) {
    throw new TaxInputError('line.discount_exceeds_line', {
      ...where,
      discount: discountAmount.toFixed(2),
      total: lineGross.toFixed(2),
    });
  }

  const totalRate = rates.cgstRate + rates.sgstRate + rates.igstRate + rates.cessRate;
  // Cess belongs in the divisor: an MRP-inclusive price includes it too.
  const divisor = input.rateTaxType === 'inclusive' ? 1 + totalRate / 100 : 1;
  const netAmount = roundMoney(lineGross - discountAmount);

  return {
    input,
    rates,
    divisor,
    lineGross,
    discountAmount,
    netAmount,
    basis: netAmount / divisor,
  };
}

/**
 * Collects lines into tax groups by their snapshotted rates, numbered in the
 * order they first appear on the bill - the printed `1)` / `2)` grouping.
 */
function groupByRates(lines: readonly PreparedLine[]): GroupInProgress[] {
  const groups: GroupInProgress[] = [];
  const byKey = new Map<string, GroupInProgress>();

  lines.forEach((line, index) => {
    const { cgstRate, sgstRate, igstRate, cessRate } = line.rates;
    const key = `${String(cgstRate)}|${String(sgstRate)}|${String(igstRate)}|${String(cessRate)}`;
    let group = byKey.get(key);

    if (group === undefined) {
      group = { taxGroupIndex: groups.length + 1, rates: line.rates, members: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.members.push(index);
  });

  return groups;
}

/** Rejects a rounding increment that would make the round off meaningless. */
function checkRoundOffPolicy(policy: RoundOffPolicy): void {
  if (!policy.enabled) return;
  if (!Number.isFinite(policy.to) || policy.to <= 0) {
    throw new TaxInputError('roundoff.increment_invalid', { increment: String(policy.to) });
  }
}

/**
 * The paise to add to the total to land it on the store's rounding increment -
 * the value stored in `transactions.round_off` (invariant 3).
 *
 * Worked in whole paise so the increment divides exactly; 0.1 does not divide
 * cleanly in binary and would drop a rupee at the wrong moment.
 */
function roundOffFor(total: number, policy: RoundOffPolicy): number {
  const totalMinor = roundMoney(total * 100, 0);
  const stepMinor = roundMoney(policy.to * 100, 0);
  if (stepMinor <= 0) {
    throw new TaxInputError('roundoff.increment_below_paisa', {
      increment: policy.to.toFixed(2),
    });
  }

  const remainder = ((totalMinor % stepMinor) + stepMinor) % stepMinor;
  if (remainder === 0) return 0;

  const down = totalMinor - remainder;
  const up = down + stepMinor;
  let target: number;

  switch (policy.mode) {
    case 'up':
      target = up;
      break;
    case 'down':
      target = down;
      break;
    case 'nearest':
      // Half an increment rounds up, the way a receipt does.
      target = remainder * 2 >= stepMinor ? up : down;
      break;
    default:
      throw new TaxInputError('roundoff.mode_invalid', { mode: String(policy.mode) });
  }

  return roundMoney((target - totalMinor) / 100);
}

/**
 * Restates a tax-inclusive price from one total tax rate to another, holding
 * what the shop keeps constant.
 *
 * This is the "recompute" half of a bulk tax reassignment (build-order step 7).
 * A product moving from 5% to 18% either **absorbs** the change — the shelf
 * price stands and the shop earns less on every sale — or **passes it on**,
 * which means the printed price moves so that the ex-tax amount does not. This
 * computes the second one. Absorbing needs no arithmetic at all, which is the
 * asymmetry that makes it tempting to write this inline at the call site.
 *
 * It lives here because invariant 1 puts every tax formula in this file, and
 * because a bulk run applies it to hundreds of products in one transaction: a
 * second implementation that rounded differently would be discovered as a
 * paisa-per-line disagreement between the shelf label and the till.
 *
 *     ex_tax   = price / (1 + from_rate/100)
 *     restated = round(ex_tax x (1 + to_rate/100), 2)
 *
 * **Rounded once, at the end.** Rounding the intermediate ex-tax figure first
 * would bias every product in the run the same way, which is how a rate change
 * across 2,000 SKUs turns into a visible drift in margin.
 *
 * Rates are total rates — CGST + SGST + IGST + cess, the same sum
 * `prepareLine` divides by. Passing a half rate here halves the tax.
 */
export function restateInclusivePrice(
  price: number,
  fromTotalRate: number,
  toTotalRate: number,
): number {
  // A RangeError rather than a TaxInputError, for the reason roundMoney throws
  // one: these arrive from tax_slabs and product_prices, so a bad value is a
  // caller's bug and has no reader who needs it in Hindi (D39).
  if (!Number.isFinite(price) || price < 0) {
    throw new RangeError(`Cannot restate ${String(price)}: expected a price of zero or more.`);
  }
  for (const rate of [fromTotalRate, toTotalRate]) {
    if (!Number.isFinite(rate) || rate < 0) {
      throw new RangeError(`Cannot restate at rate ${String(rate)}: expected zero or more.`);
    }
  }

  const exTax = price / (1 + fromTotalRate / 100);
  return roundMoney(exTax * (1 + toTotalRate / 100));
}
