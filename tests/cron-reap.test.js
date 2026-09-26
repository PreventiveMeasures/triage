// Auth + config gates for the Vercel Cron reaper endpoint (api/reap.ts).
//
// The actual sweep (reapOrphans against Neon + Vercel Blob) needs the optional
// peer-dep SDKs and a live backend, so it isn't exercised here — reapOrphans
// itself is covered by the objstore reaper tests. These pin the
// security/config behaviour unique to the endpoint: it fails CLOSED without
// the CRON_SECRET bearer, and 500s (rather than throwing) when the backend env
// is absent. Both gates return before any opener runs, so no SDK is needed.
//
// api/reap.ts reads env ONCE at module load, so each case imports a FRESH
// module instance after setting env — a unique `?case=` query busts the module
// cache so the top-level `const {…} = env` re-evaluates. The deps it imports
// (server-e2e/objstore/*) are specifier-cached and shared, so only reap.ts re-runs.

import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { env } from 'node:process'

const SNAP = ['CRON_SECRET', 'DATABASE_URL', 'E2E_DATABASE_URL', 'MANAGED_DATABASE_URL', 'BLOB_READ_WRITE_TOKEN']
const opened = []
mock.module('../server-e2e/objstore/store-neon.ts', { namedExports: {
  openNeonObjstore: url => { opened.push(url); return Promise.resolve({}) },
} })
mock.module('../server-e2e/objstore/blob-vercel.ts', { namedExports: { openVercelBlobBackend: () => Promise.resolve({}) } })
mock.module('../server-e2e/objstore/reaper.ts', { namedExports: { reapOrphans: () => Promise.resolve() } })
let importN = 0

// Set the given env (clearing the backend keys first), import a fresh handler so
// it captures exactly that env, then restore the prior env. The handler holds
// the captured values in its module closure, so the restore doesn't affect it.
async function loadHandler(envVals) {
  const saved = SNAP.map((k) => [k, env[k]])
  for (const k of SNAP) delete env[k]
  for (const [k, v] of Object.entries(envVals)) env[k] = v
  try {
    return (await import(`../api/reap.ts?case=${++importN}`)).default
  } finally {
    for (const [k, v] of saved) { if (v === undefined) delete env[k]; else env[k] = v }
  }
}

function run(handler, authorization) {
  const res = {
    statusCode: null, body: null,
    writeHead(code) { this.statusCode = code; return this },
    end(body) { this.body = body },
  }
  return handler({ headers: authorization == null ? {} : { authorization } }, res).then(() => res)
}

test('cron reap: 401 (fail closed) when CRON_SECRET is unset — even with a bearer', async () => {
  const handler = await loadHandler({})
  assert.equal((await run(handler, 'Bearer anything')).statusCode, 401)
})

test('cron reap: 401 when the bearer does not match CRON_SECRET', async () => {
  const handler = await loadHandler({ CRON_SECRET: 'topsecret' })
  assert.equal((await run(handler, undefined)).statusCode, 401, 'missing header')
  assert.equal((await run(handler, 'Bearer wrong')).statusCode, 401, 'wrong token')
  assert.equal((await run(handler, 'topsecret')).statusCode, 401, 'missing "Bearer " prefix')
})

test('cron reap: 500 not-configured when authed but Neon/Blob env is absent', async () => {
  const handler = await loadHandler({ CRON_SECRET: 'topsecret' })
  const res = await run(handler, 'Bearer topsecret')
  assert.equal(res.statusCode, 500)
  assert.equal(JSON.parse(res.body).error, 'not-configured')
})

test('cron reap selects the shared or e2e-specific URL, never the managed URL', async () => {
  for (const urls of [{ DATABASE_URL: 'postgres://shared' }, { E2E_DATABASE_URL: 'postgres://e2e', MANAGED_DATABASE_URL: 'postgres://managed' }]) {
    const handler = await loadHandler({ CRON_SECRET: 'secret', BLOB_READ_WRITE_TOKEN: 'blob', ...urls })
    assert.equal((await run(handler, 'Bearer secret')).statusCode, 200)
    assert.equal(opened.at(-1), urls.DATABASE_URL ?? urls.E2E_DATABASE_URL)
  }
  const handler = await loadHandler({ CRON_SECRET: 'secret', BLOB_READ_WRITE_TOKEN: 'blob', MANAGED_DATABASE_URL: 'postgres://managed' })
  const before = opened.length
  assert.equal((await run(handler, 'Bearer secret')).statusCode, 500)
  assert.equal(opened.length, before)
})

test('cron reap rejects global/dedicated URL conflicts without touching storage', async () => {
  const before = opened.length
  for (const key of ['E2E_DATABASE_URL', 'MANAGED_DATABASE_URL']) {
    const handler = await loadHandler({ CRON_SECRET: 'secret', BLOB_READ_WRITE_TOKEN: 'blob', DATABASE_URL: 'postgres://shared', [key]: 'postgres://dedicated' })
    assert.equal((await run(handler, 'Bearer wrong')).statusCode, 401)
    const response = await run(handler, 'Bearer secret')
    assert.equal(response.statusCode, 500)
    assert.match(JSON.parse(response.body).detail, /DATABASE_URL cannot be combined/u)
  }
  assert.equal(opened.length, before)
})
