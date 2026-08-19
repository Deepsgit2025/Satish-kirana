import { describe, expect, it } from 'vitest';

import { CsvError, parseCsv, readCsvTable } from './csv.js';

/**
 * The parser is the one part of the import with no database in it, so it is
 * tested as a pure function against the shapes a spreadsheet actually produces.
 *
 * Most of these are not hypothetical. A product name with a comma in it, a BOM
 * on the first column heading, and CRLF line endings are what Excel writes by
 * default on Windows.
 */

describe('parseCsv', () => {
  it('splits plain fields and records', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([
      { line: 1, fields: ['a', 'b'] },
      { line: 2, fields: ['1', '2'] },
    ]);
  });

  it('reads CRLF line endings', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      { line: 1, fields: ['a', 'b'] },
      { line: 2, fields: ['1', '2'] },
    ]);
  });

  it('strips a byte order mark', () => {
    // Excel writes one. Left in place it becomes part of the first column
    // heading, and `barcode` silently never matches.
    const [header] = parseCsv('﻿barcode,name\n1,x');
    expect(header?.fields[0]).toBe('barcode');
  });

  it('keeps commas inside quoted fields', () => {
    expect(parseCsv('"Rice, Basmati",100').at(0)?.fields).toEqual(['Rice, Basmati', '100']);
  });

  it('unescapes doubled quotes', () => {
    expect(parseCsv('"He said ""hi""",2').at(0)?.fields).toEqual(['He said "hi"', '2']);
  });

  it('allows a newline inside a quoted field, and counts lines past it', () => {
    const records = parseCsv('"two\nlines",a\nnext,b');

    expect(records.at(0)?.fields).toEqual(['two\nlines', 'a']);
    // The second record starts on line 3, not line 2: the quoted newline
    // consumed one. Reporting line 2 would send the client to the wrong row.
    expect(records.at(1)).toEqual({ line: 3, fields: ['next', 'b'] });
  });

  it('keeps empty fields, and a trailing empty field', () => {
    expect(parseCsv('a,,c,').at(0)?.fields).toEqual(['a', '', 'c', '']);
  });

  it('skips blank lines without shifting the line numbers after them', () => {
    const records = parseCsv('a\n\n\nb');

    expect(records).toEqual([
      { line: 1, fields: ['a'] },
      { line: 4, fields: ['b'] },
    ]);
  });

  it('refuses a file with an unterminated quote', () => {
    // Fatal, and rightly so: everything after the stray quote is one field of
    // indeterminate content, so no row-level report of it would be truthful.
    expect(() => parseCsv('a,"unclosed\nb,c')).toThrow(CsvError);
  });

  it('returns nothing for an empty input', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('\n\n')).toEqual([]);
  });
});

describe('readCsvTable', () => {
  it('keys rows by lowercased headings', () => {
    const table = readCsvTable(' Barcode , NAME \n890,Rice');

    expect(table.columns).toEqual(['barcode', 'name']);
    expect(table.rows.at(0)?.values.get('barcode')).toBe('890');
    expect(table.rows.at(0)?.values.get('name')).toBe('Rice');
  });

  it('trims values', () => {
    const table = readCsvTable('a\n  spaced  ');
    expect(table.rows.at(0)?.values.get('a')).toBe('spaced');
  });

  it('keeps a short row rather than dropping it', () => {
    // The validator decides what to do about it. Dropping it here would lose
    // the line number too, and a row missing from both the import and the
    // error report is the worst possible outcome.
    const table = readCsvTable('a,b,c\n1,2');

    expect(table.rows).toHaveLength(1);
    expect(table.rows.at(0)?.fieldCount).toBe(2);
    expect(table.rows.at(0)?.values.get('c')).toBe('');
  });

  it('refuses duplicate headings', () => {
    expect(() => readCsvTable('a,b,a\n1,2,3')).toThrow(/Duplicate column heading: a/);
  });

  it('refuses an empty file', () => {
    expect(() => readCsvTable('')).toThrow(/empty/);
  });
});
