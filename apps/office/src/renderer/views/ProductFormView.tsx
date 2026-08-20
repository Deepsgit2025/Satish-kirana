import type { CatalogueValues, RowIssue, TaxSlabOption } from '@ssbazar/shared/catalogue';
import type { TranslationKey } from '@ssbazar/shared/i18n';
import { useEffect, useState } from 'react';

import { catalogue } from '../catalogue.js';
import { fieldIssues } from '../components/Issues.js';
import { t } from '../language.js';

/** Every column, in the order the form asks for them. */
const FIELDS = [
  'barcode',
  'name',
  'name_hi',
  'short_name',
  'hsn_code',
  'tax_rate',
  'mrp',
  'sale_price',
  'purchase_price',
  'unit',
  'category',
  'reorder_level',
] as const satisfies readonly (keyof CatalogueValues)[];

/** The one-line explanations that stop a field being got wrong twice. */
const NOTES: Partial<Record<keyof CatalogueValues, TranslationKey>> = {
  name_hi: 'office.catalogue.hindi_note',
  short_name: 'office.catalogue.short_name_note',
  sale_price: 'office.catalogue.sale_price_note',
  purchase_price: 'office.catalogue.purchase_price_note',
};

const EMPTY: CatalogueValues = {
  barcode: '',
  name: '',
  name_hi: '',
  short_name: '',
  hsn_code: '',
  tax_rate: '',
  mrp: '',
  sale_price: '',
  purchase_price: '',
  unit: '',
  category: '',
  reorder_level: '',
};

/**
 * The single-product view: create one, or fix one.
 *
 * It submits **the whole row**, not a patch. That is what lets the validator
 * see a complete row on this route exactly as it does for a line of a CSV
 * (docs/DECISIONS.md D41) - and it is why `getProduct` returns the same
 * `CatalogueValues` shape that `saveProduct` takes, so a form loaded and saved
 * untouched writes no history at all.
 *
 * Issues come back against columns and are shown under the field they belong
 * to. The column name in `RowIssue.column` is the spreadsheet heading and stays
 * English (D39); the label above the input is UI text and does not.
 */
export function ProductFormView({
  productId,
  onDone,
}: {
  productId: number | null;
  onDone: () => void;
}): React.JSX.Element {
  const [values, setValues] = useState<CatalogueValues>(EMPTY);
  const [reason, setReason] = useState('');
  const [slabs, setSlabs] = useState<readonly TaxSlabOption[]>([]);
  const [issues, setIssues] = useState<readonly RowIssue[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [title, setTitle] = useState(t('office.catalogue.creating'));

  useEffect(() => {
    void catalogue.listTaxSlabs().then((listed) => {
      if (listed.ok) setSlabs(listed.value);
    });
  }, []);

  useEffect(() => {
    if (productId === null) {
      setValues(EMPTY);
      setTitle(t('office.catalogue.creating'));
      return;
    }
    void catalogue.getProduct({ productId }).then((got) => {
      if (got.ok) {
        setValues(got.value.values);
        setTitle(t('office.catalogue.editing', { name: got.value.values.name }));
      } else {
        setFailure(t(got.failure.message.messageKey, got.failure.message.params));
      }
    });
  }, [productId]);

  function set(field: keyof CatalogueValues, next: string): void {
    setValues({ ...values, [field]: next });
    setSaved(false);
  }

  async function save(): Promise<void> {
    setFailure(null);
    const result = await catalogue.saveProduct({
      productId,
      values,
      reason,
      effectiveFrom: null,
    });

    if (!result.ok) {
      setFailure(t(result.failure.message.messageKey, result.failure.message.params));
      return;
    }
    setIssues(result.value.issues);
    setSaved(result.value.applied > 0);
    if (result.value.applied > 0 && productId === null) setValues(EMPTY);
  }

  return (
    <section>
      <h2>{title}</h2>
      {failure !== null && <p>{failure}</p>}
      {saved && <p>{t('office.catalogue.saved')}</p>}
      {FIELDS.map((field) => {
        const note = NOTES[field];
        const problems = fieldIssues(issues, field);
        return (
          <p key={field}>
            <label>
              {t(`office.field.${field}`)}{' '}
              {field === 'tax_rate' && slabs.length > 0 ? (
                <select
                  value={values.tax_rate}
                  onChange={(event) => {
                    set('tax_rate', event.target.value);
                  }}
                >
                  <option value="" />
                  {slabs.map((slab) => (
                    <option key={slab.taxSlabId} value={slab.totalRate}>
                      {slab.name}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={values[field]}
                  onChange={(event) => {
                    set(field, event.target.value);
                  }}
                />
              )}
            </label>
            {note !== undefined && <small> {t(note)}</small>}
            {problems.map((issue, index) => (
              <small key={index}> {t(issue.reasonKey, issue.reasonParams)}</small>
            ))}
          </p>
        );
      })}
      <p>
        <label>
          {t('office.catalogue.reason')}{' '}
          <input
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
            }}
          />
        </label>
      </p>
      <button
        type="button"
        // `reason` is required by the contract and has no default: it is what
        // a history row says when somebody asks why the price moved.
        disabled={reason === ''}
        onClick={() => {
          void save();
        }}
      >
        {productId === null ? t('office.catalogue.create') : t('office.catalogue.save')}
      </button>{' '}
      <button type="button" onClick={onDone}>
        {t('office.catalogue.cancel')}
      </button>
    </section>
  );
}
