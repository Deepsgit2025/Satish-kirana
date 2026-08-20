import type { CatalogueResult, ImportReport } from '@ssbazar/shared/catalogue';
import { useState } from 'react';

import { catalogue, describeResult } from '../catalogue.js';
import { t } from '../language.js';

/**
 * The import panel, as a placeholder.
 *
 * Included in stage 3 because `importCatalogueFile` is one of the six methods
 * the preload exposes, and a method nothing calls is a method nobody has
 * checked. It also carries the largest payload across the boundary - a
 * several-thousand-row file as a string - which is worth proving early rather
 * than discovering when the client sends his spreadsheet.
 *
 * Reading the file is the renderer's job, per the contract: `ImportFileRequest`
 * takes text, not a path, so the main process never opens a file on a name the
 * renderer chose.
 */
export function ImportView(): React.JSX.Element {
  const [text, setText] = useState('');
  const [result, setResult] = useState<CatalogueResult<ImportReport> | null>(null);

  async function run(dryRun: boolean): Promise<void> {
    setResult(await catalogue.importCatalogueFile({ text, dryRun }));
  }

  return (
    <section>
      <h2>{t('office.catalogue.view.import')}</h2>
      <label>
        {t('office.catalogue.choose_file')}{' '}
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file !== undefined) void file.text().then(setText);
          }}
        />
      </label>
      <p>{t('office.catalogue.file_loaded', { count: text.length })}</p>
      <button
        type="button"
        disabled={text === ''}
        onClick={() => {
          void run(true);
        }}
      >
        {t('office.catalogue.dry_run')}
      </button>{' '}
      <button
        type="button"
        disabled={text === ''}
        onClick={() => {
          void run(false);
        }}
      >
        {t('office.catalogue.run_import')}
      </button>
      <pre>{describeResult(result)}</pre>
    </section>
  );
}
