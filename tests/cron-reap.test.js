// Auth + config gates for the Vercel Cron reaper endpoint (api/reap.ts).
//
// The actual sweep (reapOrphans against Neon + Vercel Blob) needs the optional
// peer-dep SDKs and a live backend, so it isn't exercised here — reapOrphans
// itself is covered by the objstore reaper tests. These pin the
// security/config behaviour unique to the endpoint: it fails CLOSED without
// the CRON_SECRET bearer, and 500s (rather than throwing) when the backend env
// is absent. Both gates return before any opener runs, so no SDK is needed.

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { env } from 'node:process'

const { default: handler } = await import('../api/reap.ts')

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    writeHead(code) { this.statusCode = code; return this },
    end(body) { this.body = body },
  }
}

function run(authorization) {
  const res = fakeRes()
  return handler({ headers: authorization == null ? {} : { authorization } }, res).then(() => res)
}

const SNAP = ['CRON_SECRET', 'DATABASE_URL', 'BLOB_READ_WRITE_TOKEN']
const saved = {}
function setEnv(vals) {
  for (const k of SNAP) { saved[k] = env[k]; delete env[k] }
  for (const [k, v] of Object.entries(vals)) env[k] = v
}
afterEach(() => {
  for (const k of SNAP) { if (saved[k] === undefined) delete env[k]; else env[k] = saved[k] }
})

test('cron reap: 401 (fail closed) when CRON_SECRET is unset — even with a bearer', async () => {
  setEnv({})
  assert.equal((await run('Bearer anything')).statusCode, 401)
})

test('cron reap: 401 when the bearer does not match CRON_SECRET', async () => {
  setEnv({ CRON_SECRET: 'topsecret' })
  assert.equal((await run(undefined)).statusCode, 401, 'missing header')
  assert.equal((await run('Bearer wrong')).statusCode, 401, 'wrong token')
  assert.equal((await run('topsecret')).statusCode, 401, 'missing "Bearer " prefix')
})

test('cron reap: 500 not-configured when authed but Neon/Blob env is absent', async () => {
  setEnv({ CRON_SECRET: 'topsecret' })
  const res = await run('Bearer topsecret')
  assert.equal(res.statusCode, 500)
  assert.equal(JSON.parse(res.body).error, 'not-configured')
})
