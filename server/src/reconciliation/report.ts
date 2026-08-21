import type { TranslationKey } from '@ssbazar/shared';

import { pad, type CliOutput } from '../cli/output.js';
import type { Queryable } from '../db/queryable.js';
import { readReconciliationHealth, type CheckOutcome } from './health.js';

/**
 * Printing the health panel to a terminal.
 *
 * Shared by `db:reconcile`, `backup:run` and `backup:verify` so the three say
 * the same thing the same way. That is not tidiness: docs/DECISIONS.md D30's
 * claim is that there is **one** surface, and three commands that each
 * described a run in their own words would be three surfaces wearing the same
 * table's data.
 *
 * The check keys are not translated. `stock_on_hand` and `backup_restore_verify`
 * are the names of rows in `reconciliation_checks`, and a support call goes
 * better when the person on the phone and the person at the machine are saying
 * the same string (docs/DECISIONS.md D39). The statuses around them are words,
 * and words get translated.
 */

const KEY_COLUMN = 22;
const STATUS_COLUMN = 8;

/** "clean", or the outstanding count and as much of the reason as there is. */
export function summariseOutcome(output: CliOutput, outcome: CheckOutcome): string {
  const { t } = output;
  if (outcome.status === 'ok' && outcome.detail === null) return t('cli.reconcile.clean');

  if (outcome.status === 'ok') {
    // A clean backup still has something to say - which file, how large. The
    // data checks leave detail null when clean and fall through above.
    return outcome.detail ?? t('cli.reconcile.clean');
  }

  const outstanding = t('cli.reconcile.outstanding', { count: outcome.outstanding });
  if (outcome.detail === null) return outstanding;

  // The detail names files, ids and quantities, assembled by the check itself.
  // It stays as it came: translating "product 412 at location 3" would mean the
  // checks reporting keys, and what they report is a row of numbers.
  return t('cli.reconcile.outstanding_detail', { summary: outstanding, detail: outcome.detail });
}

/** One line per outcome, in the panel's own column order. */
export function printOutcomes(
  output: CliOutput,
  outcomes: readonly CheckOutcome[],
  timingKey: TranslationKey,
): void {
  const { t } = output;

  for (const outcome of outcomes) {
    output.line(
      `${pad(outcome.checkKey, KEY_COLUMN)} ` +
        `${pad(t(`cli.reconcile.status.${outcome.status}`), STATUS_COLUMN)} ` +
        `${summariseOutcome(output, outcome)} ` +
        t(timingKey, { durationMs: outcome.durationMs, corrected: outcome.corrected }),
    );
  }
}

/**
 * Names every check the panel considers unattended.
 *
 * Printed by all three commands, deliberately. Whichever one an operator
 * happens to run, they find out that something else stopped running - which is
 * the failure D30 says has to be as loud as drift, and the one nobody goes
 * looking for.
 */
export async function warnUnattended(output: CliOutput, db: Queryable): Promise<void> {
  const { t } = output;

  for (const row of await readReconciliationHealth(db)) {
    if (row.health === 'overdue' || row.health === 'never_run') {
      output.say('cli.reconcile.unattended', {
        check: row.key,
        health: t(`cli.reconcile.health.${row.health}`),
      });
    }
  }
}
