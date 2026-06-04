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
// (server/objstore/*) are specifier-cached and shared, so only reap.ts re-runs.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { env } from 'node:process'

const SNAP = ['CRON_SECRET', 'DATABASE_URL', 'BLOB_READ_WRITE_TOKEN']
let importN = 0

// Set the given env (clearing the three keys first), import a fresh handler so
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
