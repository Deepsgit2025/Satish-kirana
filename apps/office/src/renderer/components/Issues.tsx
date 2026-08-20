import type { RowIssue } from '@ssbazar/shared/catalogue';

import { t } from '../language.js';

/**
 * Why rows did not go in.
 *
 * The same `RowIssue` the CSV importer produces, rendered the same way on every
 * screen that can produce one - which is the visible half of D41: one rule set
 * means one kind of complaint, so an operator who has read an import report can
 * read a bulk-edit report without learning anything new.
 *
 * **The column name is not translated.** It is the heading in the client's own
 * spreadsheet, so a translated `hsn_code` would name a column that is not there
 * (D39). The reason beside it is a key and is translated; the value is whatever
 * was typed.
 */
export function Issues({ issues }: { issues: readonly RowIssue[] }): React.JSX.Element | null {
  if (issues.length === 0) return null;

  return (
    <div>
      <p>{t('office.catalogue.rejected_rows')}</p>
      <table>
        <tbody>
          {issues.map((issue, index) => (
            <tr key={`${String(issue.line)}-${issue.column}-${String(index)}`}>
              <td>{issue.line}</td>
              <td>
                <code>{issue.column}</code>
              </td>
              <td>{issue.value}</td>
              <td>{t(issue.reasonKey, issue.reasonParams)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The issues that belong to one field of a single-row form. */
export function fieldIssues(issues: readonly RowIssue[], column: string): RowIssue[] {
  return issues.filter((issue) => issue.column === column);
}
