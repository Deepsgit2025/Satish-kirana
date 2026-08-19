/**
 * Public API of @ssbazar/shared.
 *
 * The tax engine (build-order step 2). i18n lands here in step 6.
 *
 * `computeBillTax` is the only place bill arithmetic happens - counters, office
 * and server all call it, so all three agree to the paisa. `roundMoney` is the
 * one rounding function of CLAUDE.md invariant 1; anything else that has to
 * round a rupee figure uses it rather than rounding for itself.
 */

export { apportion, roundMoney } from './tax/money.js';
export {
  type BillInput,
  type BillLineInput,
  type ComputedBill,
  type ComputedBillLine,
  type ComputedBillTotals,
  type ComputedTaxGroup,
  computeBillTax,
  DEFAULT_ROUND_OFF,
  type PriceTaxType,
  type RoundOffMode,
  type RoundOffPolicy,
  type TaxErrorCode,
  TaxInputError,
  type TaxRateSnapshot,
} from './tax/bill-tax.js';
