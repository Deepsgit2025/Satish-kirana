/**
 * A CSV reader, to RFC 4180.
 *
 * Written rather than depended on: CLAUDE.md says no new dependency without
 * asking, and this system runs unattended in a shop for years, so the fewer
 * things that can need a security update the better. The whole grammar is four
 * rules - fields split on commas, a field may be quoted, a quote inside a quoted
 * field is doubled, and a quoted field may span lines - and it is exercised by
 * its own test file rather than trusted.
 *
 * What it handles, because the client's file will arrive from Excel:
 *
 *   - a UTF-8 byte order mark, which Excel writes and which otherwise becomes
 *     part of the first column name, so `barcode` never matches
 *   - CRLF line endings
 *   - quoted fields containing commas, quotes and newlines
 *   - blank lines anywhere, skipped
 *
 * Every record carries the physical line it started on. That is the number the
 * client sees in the spreadsheet's row gutter, and it is the only thing that
 * makes an error report actionable on a file of several thousand rows.
 */

import { type MessageParams, TranslatableError, type TranslationKey } from '@ssbazar/shared';

/**
 * A file that cannot be read at all, as opposed to a row that cannot be
 * imported. Carries a key, not a sentence: the client runs this against his own
 * spreadsheet and reads whatever comes back, so it has to arrive in his
 * language (invariant 19). Row-level reasons take the same route through
 * `RowIssue.reasonKey`.
 */
export class CsvError extends TranslatableError {
  constructor(messageKey: CsvErrorKey, params: MessageParams = {}) {
    super(messageKey, params);
    this.name = 'CsvError';
  }
}

type CsvErrorKey = Extract<TranslationKey, `error.csv.${string}`>;

export interface CsvRecord {
  /** 1-based physical line where this record begins. */
  readonly line: number;
  readonly fields: readonly string[];
}

const BOM = '﻿';

export function parseCsv(text: string): CsvRecord[] {
  const source = text.startsWith(BOM) ? text.slice(BOM.length) : text;
  const records: CsvRecord[] = [];

  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  /** Whether anything at all has been seen for the current record. */
  let started = false;

  const endRecord = (): void => {
    fields.push(field);
    // A line with nothing on it is not a record of one empty field. Trailing
    // newlines and stray blank rows in the middle of a sheet are both common.
    if (started || fields.length > 1) records.push({ line: recordLine, fields });
    fields = [];
    field = '';
    started = false;
  };

  for (let i = 0; i < source.length; i += 1) {
    const ch = source.charAt(i);

    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line += 1;
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      started = true;
      continue;
    }
    if (ch === ',') {
      fields.push(field);
      field = '';
      started = true;
      continue;
    }
    // A bare CR is only ever the first half of a CRLF here. Classic Mac files
    // using CR alone predate this shop by twenty years.
    if (ch === '\r') continue;
    if (ch === '\n') {
      endRecord();
      line += 1;
      recordLine = line;
      continue;
    }

    field += ch;
    started = true;
  }

  if (inQuotes) {
    throw new CsvError('error.csv.unterminated_quote', { line: recordLine });
  }
  if (started || fields.length > 0) endRecord();

  return records;
}

export interface CsvTable {
  /** Header names, trimmed and lowercased. */
  readonly columns: readonly string[];
  readonly rows: readonly CsvRow[];
}

export interface CsvRow {
  readonly line: number;
  /** Raw field values, trimmed, keyed by column name. */
  readonly values: ReadonlyMap<string, string>;
  /** Number of fields actually present, for the "wrong column count" check. */
  readonly fieldCount: number;
}

/**
 * Reads the first record as a header and keys every following record by it.
 *
 * A row with the wrong number of fields is still returned - short rows read as
 * empty values and long rows drop the extras - because deciding what to do
 * about it is the validator's job. Losing the row here would mean losing its
 * line number too, and a row that vanishes from both the import and the error
 * report is the worst outcome available.
 */
export function readCsvTable(text: string): CsvTable {
  const records = parseCsv(text);
  const [header, ...rest] = records;

  if (header === undefined) throw new CsvError('error.csv.empty_file');

  const columns = header.fields.map((name) => name.trim().toLowerCase());
  const duplicates = columns.filter((name, index) => columns.indexOf(name) !== index);
  if (duplicates.length > 0) {
    throw new CsvError('error.csv.duplicate_heading', {
      columns: [...new Set(duplicates)].join(', '),
    });
  }

  const rows = rest.map((record) => {
    const values = new Map<string, string>();
    columns.forEach((name, index) => {
      values.set(name, (record.fields[index] ?? '').trim());
    });
    return { line: record.line, values, fieldCount: record.fields.length };
  });

  return { columns, rows };
}
