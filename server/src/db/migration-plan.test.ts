import { describe, expect, it } from 'vitest';

import {
  type AppliedMigration,
  checksum,
  collectMigrationFiles,
  type MigrationFile,
  MigrationPlanError,
  parseMigrationFilename,
  planMigrations,
} from './migration-plan.js';

function checksumsOf(...files: readonly (readonly [string, string])[]): Map<string, string> {
  return new Map(files.map(([filename, sql]) => [filename, checksum(sql)]));
}

describe('parseMigrationFilename', () => {
  it('reads the version and name', () => {
    expect(parseMigrationFilename('001_foundation.sql')).toEqual({
      version: 1,
      name: 'foundation',
      filename: '001_foundation.sql',
    });
  });

  it('accepts multi-word names and more than three digits', () => {
    expect(parseMigrationFilename('0012_catalog_tax_slabs.sql')).toEqual({
      version: 12,
      name: 'catalog_tax_slabs',
      filename: '0012_catalog_tax_slabs.sql',
    });
  });

  it.each([
    '1_foundation.sql',
    'foundation.sql',
    '001-foundation.sql',
    '001_Foundation.sql',
    '001 foundation.sql',
    '001_foundation.sql.bak',
  ])('rejects %s', (filename) => {
    expect(parseMigrationFilename(filename)).toBeNull();
  });
});

describe('collectMigrationFiles', () => {
  it('orders by version, not by string', () => {
    const files = collectMigrationFiles(['010_stock.sql', '002_catalog.sql', '001_foundation.sql']);

    expect(files.map((file) => file.version)).toEqual([1, 2, 10]);
  });

  it('ignores files that are not .sql', () => {
    const files = collectMigrationFiles(['.gitkeep', 'README.md', '001_foundation.sql']);

    expect(files).toHaveLength(1);
  });

  it('refuses a .sql file that breaks the convention rather than skipping it', () => {
    expect(() => collectMigrationFiles(['001_foundation.sql', 'hotfix.sql'])).toThrow(
      MigrationPlanError,
    );
  });

  it('refuses two migrations with the same version', () => {
    expect(() => collectMigrationFiles(['001_foundation.sql', '0001_catalog.sql'])).toThrow(
      /share version 1/u,
    );
  });
});

describe('checksum', () => {
  it('is unchanged by line endings, so Windows and Linux agree', () => {
    expect(checksum('CREATE TABLE a();\r\nCREATE TABLE b();\r\n')).toBe(
      checksum('CREATE TABLE a();\nCREATE TABLE b();\n'),
    );
  });

  it('changes when the SQL changes', () => {
    expect(checksum('CREATE TABLE a();')).not.toBe(checksum('CREATE TABLE b();'));
  });
});

describe('planMigrations', () => {
  const foundation = '001_foundation.sql';
  const catalog = '002_catalog.sql';
  const foundationSql = 'CREATE TABLE stores();';
  const catalogSql = 'CREATE TABLE products();';

  const files: MigrationFile[] = collectMigrationFiles([foundation, catalog]);
  const checksums = checksumsOf([foundation, foundationSql], [catalog, catalogSql]);

  const appliedFoundation: AppliedMigration = {
    version: 1,
    filename: foundation,
    checksum: checksum(foundationSql),
  };

  it('returns every migration on an empty database', () => {
    const plan = planMigrations(files, [], checksums);

    expect(plan.pending.map((file) => file.filename)).toEqual([foundation, catalog]);
    expect(plan.appliedCount).toBe(0);
  });

  it('returns only what is left when some are applied', () => {
    const plan = planMigrations(files, [appliedFoundation], checksums);

    expect(plan.pending.map((file) => file.filename)).toEqual([catalog]);
    expect(plan.appliedCount).toBe(1);
  });

  it('returns nothing when the database is up to date', () => {
    const applied = [
      appliedFoundation,
      { version: 2, filename: catalog, checksum: checksum(catalogSql) },
    ];

    expect(planMigrations(files, applied, checksums).pending).toEqual([]);
  });

  it('refuses to run when an applied migration was edited', () => {
    const edited = checksumsOf([foundation, `${foundationSql} -- oops`], [catalog, catalogSql]);

    expect(() => planMigrations(files, [appliedFoundation], edited)).toThrow(/append-only/u);
  });

  it('refuses to run when an applied migration is missing from disk', () => {
    const onlyCatalog = collectMigrationFiles([catalog]);

    expect(() => planMigrations(onlyCatalog, [appliedFoundation], checksums)).toThrow(
      /missing from server\/migrations/u,
    );
  });

  it('refuses to run when an applied migration was renamed', () => {
    const renamed = collectMigrationFiles(['001_foundation_v2.sql', catalog]);
    const renamedChecksums = checksumsOf(
      ['001_foundation_v2.sql', foundationSql],
      [catalog, catalogSql],
    );

    expect(() => planMigrations(renamed, [appliedFoundation], renamedChecksums)).toThrow(
      /never renamed/u,
    );
  });

  it('refuses a new migration numbered below one already applied', () => {
    const stockSql = 'CREATE TABLE stock_ledger();';
    const applied = [
      appliedFoundation,
      { version: 15, filename: '0015_stock.sql', checksum: checksum(stockSql) },
    ];
    const gapFiller = collectMigrationFiles([foundation, '003_gap.sql', '0015_stock.sql']);
    const gapChecksums = checksumsOf(
      [foundation, foundationSql],
      ['003_gap.sql', 'CREATE TABLE gap();'],
      ['0015_stock.sql', stockSql],
    );

    expect(() => planMigrations(gapFiller, applied, gapChecksums)).toThrow(/numbered below 15/u);
  });
});
