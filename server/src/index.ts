/**
 * Public API of @ssbazar/server.
 *
 * What the Electron main process is allowed to reach for, and nothing else.
 * The office app holds a `CatalogueApi` and a `SessionRunner`; it never sees a
 * `Queryable`, a query, or `pg`, so no part of an Electron bundle imports a
 * database driver (docs/DECISIONS.md D42, CLAUDE.md invariant 23).
 *
 * Deliberately narrow. The catalogue core, the validator, the tax resolver and
 * the reconciliation jobs are all reachable by deep import from inside this
 * workspace and none of them are exported here - an app that wanted one of them
 * would be an app doing something the contract should be doing instead.
 */

export { createCatalogueApi } from './catalog/api.js';
export { createPool, createPooledSessionRunner, type SessionRunner } from './db/session.js';
