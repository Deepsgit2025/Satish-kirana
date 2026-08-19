# Migrations

Numbered SQL, applied in order by `npm run db:migrate`, recorded in `schema_migrations`.

## Rules the runner enforces

- **Name files `<number>_<snake_case_name>.sql`** — `001_foundation.sql`, at least three
  digits. A `.sql` file that breaks the convention aborts the run rather than being skipped
  silently. Anything that is not `.sql` is ignored.
- **Never edit a committed migration.** The runner stores a SHA-256 of each applied file and
  refuses to run if one changed. Revert the edit and add a new migration instead.
- **Never delete or rename an applied migration.** Both abort the run.
- **Number above the highest applied migration.** A file numbered below one already applied is
  rejected, so every database applies migrations in the same order.

## How each file runs

One migration, one transaction — the SQL and its `schema_migrations` row commit together. A
failure rolls the whole file back and stops the run; migrations applied earlier stay applied.

A migration needing statements Postgres refuses inside a transaction (`CREATE INDEX
CONCURRENTLY`) opts out with a directive in its first lines:

```sql
-- migrate:no-transaction
CREATE INDEX CONCURRENTLY idx_stock_ledger_product ON stock_ledger (product_id);
```

Such a file can leave the schema half-changed if it fails, so use it only when necessary.

## Usage

```bash
npm run db:migrate                # apply everything pending
npm run db:migrate -- --dry-run   # list what would be applied
```

Connection settings come from `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` and `PGPASSWORD`
(see `.env.example`). Concurrent runs are serialised with a Postgres advisory lock.
