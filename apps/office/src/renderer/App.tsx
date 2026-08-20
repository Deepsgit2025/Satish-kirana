import type { SignedInEmployee } from '@ssbazar/shared/catalogue';
import { useCallback, useEffect, useState } from 'react';

import { catalogue } from './catalogue.js';
import { t } from './language.js';
import { BulkGridView } from './views/BulkGridView.js';
import { ImportView } from './views/ImportView.js';
import { ProductFormView } from './views/ProductFormView.js';
import { ProductListView } from './views/ProductListView.js';
import { SignInView } from './views/SignInView.js';

/**
 * The product master: three views over one catalogue, plus the import panel,
 * behind sign-in.
 *
 * No router. Four views are a state variable, and a router would be a
 * dependency bought to avoid writing this line (build-order step 7's dependency
 * review). The one piece of navigation that carries anything is the list
 * handing a product id to the form - which is the "find it, then fix it" path
 * D41 says the two views exist to make short.
 *
 * **The sign-in gate here is a convenience, not the enforcement.** A write with
 * nobody signed in is refused by the main process, which is the only place a
 * refusal counts; this saves the operator from filling in a form that was never
 * going to be accepted (docs/DECISIONS.md D42, D44).
 */
type ViewName = 'list' | 'product' | 'bulk' | 'import';

export function App(): React.JSX.Element {
  const [view, setView] = useState<ViewName>('list');
  const [editing, setEditing] = useState<number | null>(null);
  const [employee, setEmployee] = useState<SignedInEmployee | null>(null);

  const refreshEmployee = useCallback(() => {
    void catalogue.currentEmployee().then((current) => {
      setEmployee(current.ok ? current.value : null);
    });
  }, []);

  // The main process holds the session, so the renderer asks rather than
  // remembers. A window reloaded mid-shift comes back signed in.
  useEffect(refreshEmployee, [refreshEmployee]);

  function open(productId: number | null): void {
    setEditing(productId);
    setView('product');
  }

  if (employee === null) {
    return (
      <main>
        <h1>{t('office.catalogue.title')}</h1>
        <SignInView onSignedIn={refreshEmployee} />
      </main>
    );
  }

  return (
    <main>
      <h1>{t('office.catalogue.title')}</h1>
      <p>
        {t('office.signin.signed_in_as', { name: employee.name })}{' '}
        <button
          type="button"
          onClick={() => {
            void catalogue.signOut().then(refreshEmployee);
          }}
        >
          {t('office.signin.sign_out')}
        </button>
      </p>

      <nav>
        <button
          type="button"
          disabled={view === 'list'}
          onClick={() => {
            setView('list');
          }}
        >
          {t('office.catalogue.view.list')}
        </button>
        <button
          type="button"
          onClick={() => {
            open(null);
          }}
        >
          {t('office.catalogue.new_product')}
        </button>
        <button
          type="button"
          disabled={view === 'bulk'}
          onClick={() => {
            setView('bulk');
          }}
        >
          {t('office.catalogue.view.bulk')}
        </button>
        <button
          type="button"
          disabled={view === 'import'}
          onClick={() => {
            setView('import');
          }}
        >
          {t('office.catalogue.view.import')}
        </button>
      </nav>

      {view === 'list' && <ProductListView onEdit={open} />}
      {view === 'product' && (
        <ProductFormView
          productId={editing}
          onDone={() => {
            setView('list');
          }}
        />
      )}
      {view === 'bulk' && <BulkGridView />}
      {view === 'import' && <ImportView />}
    </main>
  );
}
