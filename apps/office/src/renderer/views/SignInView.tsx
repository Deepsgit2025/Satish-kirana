import type { CatalogueResult, SignedInEmployee } from '@ssbazar/shared/catalogue';
import { useEffect, useState } from 'react';

import { catalogue, describeResult } from '../catalogue.js';
import { t } from '../language.js';

/**
 * Who is at the machine.
 *
 * This exists before the real screens do, and that ordering is the point
 * (build-order step 7, remaining scope). Every `product_prices` and
 * `product_tax_assignments` row carries `changed_by`; building the edit screens
 * first would mean building them against a placeholder author and swapping it
 * underneath them later, which is how history rows end up quietly wrong.
 *
 * **It identifies; it does not authenticate.** Picking a name off a list is not
 * a password, so what the audit trail records is who *said* they were at the
 * machine. For one office desk in R0 that is the honest trade, and it is still
 * far better than no attribution at all. `employees.pin_hash` is in the schema
 * and nothing writes it yet - whoever builds real sign-in decides the scheme,
 * and this screen is where it goes.
 */
export function SignInView({ onSignedIn }: { onSignedIn: () => void }): React.JSX.Element {
  const [employees, setEmployees] = useState<readonly SignedInEmployee[]>([]);
  const [chosen, setChosen] = useState('');
  const [result, setResult] = useState<CatalogueResult<unknown> | null>(null);

  useEffect(() => {
    void catalogue.listEmployees().then((listed) => {
      setResult(listed);
      if (listed.ok) setEmployees(listed.value);
    });
  }, []);

  async function enter(): Promise<void> {
    const signedIn = await catalogue.signIn({ employeeId: Number(chosen) });
    setResult(signedIn);
    if (signedIn.ok) onSignedIn();
  }

  return (
    <section>
      <h2>{t('office.signin.title')}</h2>
      <label>
        {t('office.signin.choose')}{' '}
        <select
          value={chosen}
          onChange={(event) => {
            setChosen(event.target.value);
          }}
        >
          <option value="" />
          {employees.map((employee) => (
            <option key={employee.employeeId} value={String(employee.employeeId)}>
              {employee.name} ({employee.empCode})
            </option>
          ))}
        </select>
      </label>{' '}
      <button
        type="button"
        disabled={chosen === ''}
        onClick={() => {
          void enter();
        }}
      >
        {t('office.signin.enter')}
      </button>
      {result?.ok === false && <pre>{describeResult(result)}</pre>}
    </section>
  );
}
