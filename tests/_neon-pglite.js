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
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

import { openNeonDb } from '../server/db-neon.ts'
import { openNeonObjstore } from '../server/objstore/store-neon.ts'
import { openFsBlobBackend } from '../server/objstore/blob-fs.ts'

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

// One-shot fault injection for `tryCommitNeon`'s unique-violation
// recovery path. PGlite is single-connection, so a real cross-replica
// race (a sibling bypassing the advisory lock with a direct INSERT)
// can't be reproduced naturally; `failNextCommit` stages it instead.
// The next pipelined commit transaction runs an optional `before(pg)`
// (e.g. land the sibling row) and then throws `error`. The standalone
// refetch queries inside the catch still hit real PGlite, so the
// recovery reads true post-conflict state. Consumed once, then cleared.
let pendingFault = null

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
  sql.transaction = async (queries) => {
    if (pendingFault) {
      const fault = pendingFault
      pendingFault = null
      if (fault.before) await fault.before(pg)
      throw fault.error
    }
    return pg.transaction(async (tx) => {
      const out = []
      for (const q of queries) out.push((await tx.query(q.text, q.params)).rows)
      return out
    })
  }
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
  pendingFault = null
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

// Stage a one-shot fault for the next pipelined commit transaction. See
// `pendingFault`. `fault` is `{ before?: (pg) => Promise<void>, error }`.
export function failNextCommit(fault) {
  pendingFault = fault
}

// ---- v1.objstore Neon plane (store-neon.ts) ----
// Pairs the PGlite metadata plane with a REAL filesystem byte plane —
// the same `openFsBlobBackend` the SQLite `openObjstore` uses — so only
// the metadata SQL differs from the SQLite suite. The objstore plane is
// lock-free (atomic version-CAS commits + content-addressed blobs), so
// there is no commit-lock helper to mock. The Neon Handle leaves `dir`
// unset, so ported tests compute staging/live paths from the returned
// `objDir` (live blobs are content-addressed: liveFilePath(objDir, tag,
// contentHash)).

const OBJSTORE_TABLES = 'workspace_object, workspace_object_staging'

export async function freshNeonObjstore() {
  pendingFault = null
  const pg = sharedInstance()
  await pg.exec(`DROP TABLE IF EXISTS ${OBJSTORE_TABLES}`)
  const root = mkdtempSync(path.join(tmpdir(), `deepview-neon-obj-${++counter}-`))
  const objDir = path.join(root, 'objstore')
  mkdirSync(objDir, { recursive: true })
  const handle = await openNeonObjstore(`pglite://objstore-${counter}`, openFsBlobBackend(objDir))
  return {
    handle,
    objDir,
    pg,
    cleanup: () => { rmSync(root, { recursive: true, force: true }) },
  }
}

// Two Neon Handles over the SAME PGlite + SAME blob dir — two replicas
// pointed at one Neon endpoint + blob store, the deployment shape the
// lock-free version-CAS commit path is built for (the SQLite suite only
// *simulates* this with two connections to one file). Used to pin the
// "exactly one of N racing commits wins, the rest get conflict"
// invariant the design rests on.
export async function twoNeonReplicas() {
  const fx = await freshNeonObjstore()
  const handle2 = await openNeonObjstore(`pglite://objstore-r2-${counter}`, openFsBlobBackend(fx.objDir))
  return {
    handle1: fx.handle,
    handle2,
    objDir: fx.objDir,
    pg: fx.pg,
    cleanup: fx.cleanup,
  }
}

after(async () => {
  if (sharedPg) {
    await sharedPg.close()
    sharedPg = null
  }
})
