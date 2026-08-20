import type {
  BulkField,
  EditResult,
  MrpPolicy,
  ProductListRow,
  TaxSlabOption,
} from '@ssbazar/shared/catalogue';
import { useCallback, useEffect, useState } from 'react';

import { catalogue } from '../catalogue.js';
import { Issues } from '../components/Issues.js';
import { t } from '../language.js';

const PAGE_SIZE = 50;

/**
 * The bulk grid: narrow to a set, change one field, apply to all of it.
 *
 * **No virtualisation, and none needed.** The grid renders a page of fifty and
 * holds the selection as a set of ids, so selecting two thousand products
 * costs two thousand numbers rather than two thousand table rows. A data-grid
 * package would buy scrolling performance for a list this screen never draws
 * (build-order step 7's dependency review).
 *
 * The two ways to select are deliberately different acts. Ticking rows selects
 * what is visible; "select all matching" asks the server for every id the
 * filter covers, which is usually far more than is on screen - so the count
 * beside it is the whole point of the button.
 */
const FIELDS: readonly BulkField[] = [
  'sale_price',
  'mrp',
  'purchase_price',
  'tax_rate',
  'category',
  'reorder_level',
];

export function BulkGridView(): React.JSX.Element {
  const [text, setText] = useState('');
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<readonly ProductListRow[]>([]);
  const [total, setTotal] = useState(0);
  const [slabs, setSlabs] = useState<readonly TaxSlabOption[]>([]);

  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [field, setField] = useState<BulkField>('sale_price');
  const [value, setValue] = useState('');
  const [mrpPolicy, setMrpPolicy] = useState<MrpPolicy>('keep');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [reason, setReason] = useState('');

  const [result, setResult] = useState<EditResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const search = useCallback(async (): Promise<void> => {
    const page = await catalogue.listProducts({
      filter: { text, limit: PAGE_SIZE, offset },
    });
    if (page.ok) {
      setRows(page.value.rows);
      setTotal(page.value.total);
    }
  }, [text, offset]);

  useEffect(() => {
    void search();
  }, [search]);

  useEffect(() => {
    void catalogue.listTaxSlabs().then((listed) => {
      if (listed.ok) setSlabs(listed.value);
    });
  }, []);

  function toggle(productId: number): void {
    const next = new Set(selected);
    if (next.has(productId)) next.delete(productId);
    else next.add(productId);
    setSelected(next);
  }

  async function selectAllMatching(): Promise<void> {
    const ids = await catalogue.listProductIds({ filter: { text } });
    if (ids.ok) setSelected(new Set(ids.value));
  }

  async function apply(): Promise<void> {
    setFailure(null);
    setResult(null);

    const applied = await catalogue.bulkEdit({
      productIds: [...selected],
      change: { field, value, mrpPolicy },
      reason,
      // A date means the change is pending until then, and the nightly job
      // moves both caches on the day (D27). Blank means now, taken from the
      // database clock rather than this machine's.
      effectiveFrom: effectiveFrom === '' ? null : new Date(effectiveFrom).toISOString(),
    });

    if (!applied.ok) {
      setFailure(t(applied.failure.message.messageKey, applied.failure.message.params));
      return;
    }
    setResult(applied.value);
    await search();
  }

  return (
    <section>
      <h2>{t('office.catalogue.view.bulk')}</h2>
      <label>
        {t('office.catalogue.search')}{' '}
        <input
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setOffset(0);
          }}
        />
      </label>
      <p>{t('office.catalogue.showing', { shown: rows.length, total })}</p>
      <button
        type="button"
        onClick={() => {
          setSelected(new Set([...selected, ...rows.map((row) => row.productId)]));
        }}
      >
        {t('office.catalogue.select_all')}
      </button>{' '}
      <button
        type="button"
        onClick={() => {
          void selectAllMatching();
        }}
      >
        {t('office.catalogue.select_all_matching', { count: total })}
      </button>{' '}
      <button
        type="button"
        onClick={() => {
          setSelected(new Set());
        }}
      >
        {t('office.catalogue.clear_selection')}
      </button>
      <p>{t('office.catalogue.selected', { count: selected.size })}</p>
      <table>
        <thead>
          <tr>
            <th />
            <th>{t('office.catalogue.item_code')}</th>
            <th>{t('office.field.name')}</th>
            <th>{t('office.field.tax_rate')}</th>
            <th>{t('office.field.mrp')}</th>
            <th>{t('office.field.sale_price')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.productId}>
              <td>
                <input
                  type="checkbox"
                  checked={selected.has(row.productId)}
                  onChange={() => {
                    toggle(row.productId);
                  }}
                />
              </td>
              <td>{row.itemCode}</td>
              <td>{row.nameHi ?? row.name}</td>
              <td>{row.slabName}</td>
              <td>{row.mrp}</td>
              <td>{row.salePrice}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        type="button"
        disabled={offset === 0}
        onClick={() => {
          setOffset(Math.max(0, offset - PAGE_SIZE));
        }}
      >
        {t('office.catalogue.previous')}
      </button>{' '}
      <button
        type="button"
        disabled={offset + rows.length >= total}
        onClick={() => {
          setOffset(offset + PAGE_SIZE);
        }}
      >
        {t('office.catalogue.next')}
      </button>
      <hr />
      <label>
        {t('office.catalogue.set_field')}{' '}
        <select
          value={field}
          onChange={(event) => {
            setField(event.target.value as BulkField);
            setValue('');
          }}
        >
          {/* Column names, not labels: these are the headings in the client's
              own spreadsheet, so translating them would name a column that is
              not there (D39). */}
          {FIELDS.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>{' '}
      <label>
        {t('office.catalogue.to_value')}{' '}
        {field === 'tax_rate' && slabs.length > 0 ? (
          <select
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
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
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
            }}
          />
        )}
      </label>
      {field === 'tax_rate' && (
        <p>
          <label>
            {t('office.catalogue.mrp_policy')}{' '}
            <select
              value={mrpPolicy}
              onChange={(event) => {
                setMrpPolicy(event.target.value as MrpPolicy);
              }}
            >
              <option value="keep">{t('office.catalogue.mrp_keep')}</option>
              <option value="recompute">{t('office.catalogue.mrp_recompute')}</option>
            </select>
          </label>
        </p>
      )}
      <p>
        <label>
          {t('office.catalogue.effective_from')}{' '}
          <input
            type="date"
            value={effectiveFrom}
            onChange={(event) => {
              setEffectiveFrom(event.target.value);
            }}
          />
        </label>
        <small> {t('office.catalogue.effective_note')}</small>
      </p>
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
        disabled={selected.size === 0 || value === '' || reason === ''}
        onClick={() => {
          void apply();
        }}
      >
        {t('office.catalogue.apply')}
      </button>
      {failure !== null && <p>{failure}</p>}
      {result !== null && (
        <>
          <p>{t('office.catalogue.applied_count', { count: result.applied })}</p>
          <Issues issues={result.issues} />
        </>
      )}
    </section>
  );
}
