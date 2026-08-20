# SS Super Bazar — Retail Management System

Offline-first supermarket POS, inventory and back-office system.

**Topology:** two billing counters + one office machine + an always-on store server, all on a wired LAN. ~1,000 bills/day. Counters keep billing when the network or server is down and sync when it returns.

## Documentation

| File | What's in it |
|---|---|
| `CLAUDE.md` | Invariants — the rules that must never be broken |
| `docs/plan.md` | Scope, release schedule, decisions |
| `docs/schema.md` | Every table, column and design rule |
| `docs/modules.md` | Module list with sizing |
| `docs/build-order.md` | Ordered build steps |
| `docs/i18n.md` | How every user-facing string reaches the reader, in their language |

## Layout

```
server/        Postgres + API + sync + backup jobs
  migrations/  numbered SQL, append-only, never edited after commit
apps/counter/  billing terminal (Electron, local SQLite cache)
apps/office/   back office (Electron)
packages/shared/  tax engine, types, i18n — used by all apps
  i18n/locales/  en.json, hi.json — every user-facing string
assets/fonts/  Noto Sans Devanagari (OFL), for Hindi on screen and on receipts
tools/         the project's own ESLint rules
scripts/       backup, restore-verify, seed
```

## Getting started

```bash
cp .env.example .env      # fill in local values
npm install
npm run db:migrate
npm run dev
```

## Non-negotiables

Read `CLAUDE.md` before writing code. The short version:

- Ledgers are append-only. Stock is derived, never stored as a mutable quantity.
- Tax is snapshotted on every line. Never join to `tax_slabs` when rendering a document.
- One rounding function, one call site.
- Void, don't delete. Reverse, don't edit.
- No hardcoded user-facing strings — everything through i18n. `npm run lint` fails the build on one.

## Security

Never commit: `.env`, AWS keys, the backup encryption passphrase, customer or employee data, or database dumps. All are covered by `.gitignore` — check before every commit.
