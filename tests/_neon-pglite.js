// Test-only: exercise `server/db-neon.ts`'s Neon code path against an
// in-process Postgres (PGlite) instead of a real Neon endpoint, so the
// previously-untested Neon backend runs under the same suite as SQLite.
//
// `openNeonDb` dynamically imports `server/neon-driver.ts` — the single
// re-export wrapper for the optional `@neondatabase/serverless` peer
// dep. We mock THAT local module so the import resolves to a
// PGlite-backed shim of the driver's `neon()` callable. Mocking the
// local wrapper (rather than the bare specifier) works even though the
// peer dep isn't installed: node:test's `mock.module` can only
// intercept a resolvable specifier, and a local path always resolves —
// the mock loader serves these exports without ever evaluating the
// wrapper's `export *`, so PGlite stands in for the real driver.
//
// Requires `--experimental-test-module-mocks` (set in the project's
// `test` script). Import this helper from a *.test.js file — it
// registers the module mock at import time.

import { after, mock } from 'node:test'
import { PGlite } from '@electric-sql/pglite'

import { openNeonDb } from '../server/db-neon.ts'

// One PGlite instance shared across the whole file. WASM init costs
// ~1-2s, so creating an instance per test would dominate the suite's
// runtime; instead `freshNeonDb` DROPs the table before each open so
// every test still starts from a clean schema (which also re-exercises
// openNeonDb's DDL bootstrap each time). node:test runs the tests in a
// file sequentially, so the shared instance sees no inter-test races;
// the in-test `Promise.all` races are serialised by PGlite's single
// connection exactly as `tryCommitNeon`'s advisory lock intends.
let sharedPg = null
let counter = 0

function sharedInstance() {
  if (!sharedPg) sharedPg = new PGlite()
  return sharedPg
}

// Build the lazy "query descriptor" + transaction shim mirroring the
// slice of the `@neondatabase/serverless` surface that the Neon planes
// use:
//   • sql(text, params)            — awaited standalone, resolves to rows[]
//   • sql.transaction([q, q, ...]) — runs the descriptors in ONE PGlite
//                                    transaction (BEGIN…COMMIT), in
//                                    order, resolves to rows[][]
// The descriptor is a thenable that defers execution until awaited, so
// the same object can either run standalone OR be collected by
// `transaction()` and run inside the pipelined transaction — exactly
// how the real driver's query objects behave. `transaction()` reads
// `.text`/`.params` off each descriptor (it never awaits them, which
// would double-execute them outside the transaction).
function makeNeonSql(pg) {
  const sql = (text, params = []) => ({
    text,
    params,
    // Lazy thenable: execution is deferred until the descriptor is
    // awaited, so the same object can run standalone (`await sql(...)`)
    // OR be collected by `transaction()` and run inside one BEGIN…COMMIT
    // — mirroring the real driver's pipelined-transaction query objects.
    // eslint-disable-next-line unicorn/no-thenable
    then: (resolve, reject) => pg.query(text, params).then((r) => r.rows).then(resolve, reject),
  })
  sql.transaction = (queries) =>
    pg.transaction(async (tx) => {
      const out = []
      for (const q of queries) out.push((await tx.query(q.text, q.params)).rows)
      return out
    })
  return sql
}

// The mocked `neon(url)` is synchronous (matching the real driver,
// which holds no connection — HTTP is stateless), so it hands back a
// shim over the shared instance immediately; PGlite's own methods await
// readiness internally on first use.
mock.module('../server/neon-driver.ts', {
  namedExports: { neon: () => makeNeonSql(sharedInstance()) },
})

// Open a fresh, isolated Neon-backed Handle over the shared in-process
// PGlite. Returns the same `{ handle, cleanup }` shape as the SQLite
// `freshDb` helper in `server-db.test.js`, plus the raw `pg` for the
// few Neon-specific assertions that need direct SQL (e.g. probing the
// `keyframe` CHECK constraint) and the `connectionString` for reopen
// tests. `handle.close()` is a no-op on the Neon backend (stateless
// HTTP); the shared PGlite is closed once, after all tests.
export async function freshNeonDb() {
  const pg = sharedInstance()
  await pg.exec('DROP TABLE IF EXISTS workspace_revision')
  const connectionString = `pglite://test-${++counter}`
  const handle = await openNeonDb(connectionString)
  return {
    handle,
    pg,
    connectionString,
    cleanup: async () => { await handle.close() },
  }
}

after(async () => {
  if (sharedPg) {
    await sharedPg.close()
    sharedPg = null
  }
})
