import type {
  CategoryOption,
  ProductFilter,
  ProductListRow,
  TaxSlabOption,
} from '@ssbazar/shared/catalogue';
import { useCallback, useEffect, useState } from 'react';

import { catalogue } from '../catalogue.js';
import { t } from '../language.js';

const PAGE_SIZE = 50;

/**
 * The list view: find a product.
 *
 * It is also where a bulk selection starts, which is why the filter shape here
 * and the one `listProductIds` takes are the same `ProductFilter` - the
 * operator narrows to what they mean, and the grid then works on exactly that
 * set rather than on whatever happened to be on screen.
 *
 * **The total is shown next to the page count on purpose.** "Apply to all 2,140
 * matching" is a very different act from "apply to the 50 in front of me", and
 * an operator who cannot see the difference will eventually make the wrong one.
 */
export function ProductListView({
  onEdit,
}: {
  onEdit: (productId: number) => void;
}): React.JSX.Element {
  const [text, setText] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [taxSlabId, setTaxSlabId] = useState('');
  const [status, setStatus] = useState('');
  const [belowReorder, setBelowReorder] = useState(false);
  const [offset, setOffset] = useState(0);

  const [categories, setCategories] = useState<readonly CategoryOption[]>([]);
  const [slabs, setSlabs] = useState<readonly TaxSlabOption[]>([]);
  const [rows, setRows] = useState<readonly ProductListRow[]>([]);
  const [total, setTotal] = useState(0);

  const search = useCallback(async (): Promise<void> => {
    const filter: ProductFilter = {
      text,
      categoryId: categoryId === '' ? null : Number(categoryId),
      taxSlabId: taxSlabId === '' ? null : Number(taxSlabId),
      ...(status === '' ? {} : { status: status as 'active' | 'discontinued' }),
      belowReorderLevel: belowReorder,
      limit: PAGE_SIZE,
      offset,
    };

    const page = await catalogue.listProducts({ filter });
    if (page.ok) {
      setRows(page.value.rows);
      setTotal(page.value.total);
    }
    // A failed read leaves the previous rows on screen rather than blanking it:
    // the operator is mid-task, and an empty table reads as "no products".
  }, [text, categoryId, taxSlabId, status, belowReorder, offset]);

  useEffect(() => {
    void search();
  }, [search]);

  useEffect(() => {
    void catalogue.listCategories().then((listed) => {
      if (listed.ok) setCategories(listed.value);
    });
    void catalogue.listTaxSlabs().then((listed) => {
      if (listed.ok) setSlabs(listed.value);
    });
  }, []);

  /**
   * Any filter change returns to the first page. Staying on page five of a new
   * search shows nothing, which reads as "no products" rather than as paging.
   */
  function narrow(apply: () => void): void {
    apply();
    setOffset(0);
  }

  return (
    <section>
      <h2>{t('office.catalogue.view.list')}</h2>
      <label>
        {t('office.catalogue.search')}{' '}
        <input
          value={text}
          onChange={(event) => {
            const next = event.target.value;
            narrow(() => {
              setText(next);
            });
          }}
        />
      </label>{' '}
      <label>
        {t('office.catalogue.filter_category')}{' '}
        <select
          value={categoryId}
          onChange={(event) => {
            const next = event.target.value;
            narrow(() => {
              setCategoryId(next);
            });
          }}
        >
          <option value="">{t('office.catalogue.all')}</option>
          {categories.map((category) => (
            <option key={category.categoryId} value={String(category.categoryId)}>
              {category.name}
            </option>
          ))}
        </select>
      </label>{' '}
      <label>
        {t('office.catalogue.filter_slab')}{' '}
        <select
          value={taxSlabId}
          onChange={(event) => {
            const next = event.target.value;
            narrow(() => {
              setTaxSlabId(next);
            });
          }}
        >
          <option value="">{t('office.catalogue.all')}</option>
          {slabs.map((slab) => (
            <option key={slab.taxSlabId} value={String(slab.taxSlabId)}>
              {slab.name}
            </option>
          ))}
        </select>
      </label>{' '}
      <label>
        {t('office.catalogue.filter_status')}{' '}
        <select
          value={status}
          onChange={(event) => {
            const next = event.target.value;
            narrow(() => {
              setStatus(next);
            });
          }}
        >
          <option value="">{t('office.catalogue.all')}</option>
          <option value="active">{t('office.catalogue.status_active')}</option>
          <option value="discontinued">{t('office.catalogue.status_discontinued')}</option>
        </select>
      </label>{' '}
      <label>
        <input
          type="checkbox"
          checked={belowReorder}
          onChange={(event) => {
            const next = event.target.checked;
            narrow(() => {
              setBelowReorder(next);
            });
          }}
        />{' '}
        {t('office.catalogue.below_reorder')}
      </label>
      <p>{t('office.catalogue.showing', { shown: rows.length, total })}</p>
      {rows.length === 0 ? (
        <p>{t('office.catalogue.none_found')}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t('office.catalogue.item_code')}</th>
              <th>{t('office.field.name')}</th>
              <th>{t('office.field.barcode')}</th>
              <th>{t('office.field.category')}</th>
              <th>{t('office.field.tax_rate')}</th>
              <th>{t('office.field.mrp')}</th>
              <th>{t('office.field.sale_price')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.productId}>
                <td>{row.itemCode}</td>
                {/* COALESCE(name_hi, name) is the display rule — invariant 20. */}
                <td>{row.nameHi ?? row.name}</td>
                <td>{row.barcode}</td>
                <td>{row.categoryName}</td>
                <td>{row.slabName}</td>
                <td>{row.mrp}</td>
                <td>{row.salePrice}</td>
                <td>
                  <button
                    type="button"
                    onClick={() => {
                      onEdit(row.productId);
                    }}
                  >
                    {t('office.catalogue.edit')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
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
    </section>
  );
}
