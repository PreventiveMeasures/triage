import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { githubJson, repoAccessToken } from '../server-managed/github-app.ts'

const privateKey = () => generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' })
const config = { githubAppId: '1', githubAppPrivateKey: privateKey() }
const datedToken = (token, lifetime = 60 * 60_000) => ({ token, expires_at: new Date(Date.now() + lifetime).toISOString() })

test('installation tokens coalesce concurrent mints and survive independent request configs', async () => {
  let calls = 0, finish
  const fetch = (_url, options) => {
    calls++
    assert.equal(options.method, 'POST')
    return new Promise(resolve => { finish = resolve })
  }
  const requests = Array.from({ length: 10 }, () => repoAccessToken({ ...config }, 7, fetch))
  await setImmediate()
  assert.equal(calls, 1)
  finish(Response.json(datedToken('shared-installation-token')))
  assert.deepEqual(await Promise.all(requests), Array.from({ length: 10 }, () => 'shared-installation-token'))
  assert.equal(await repoAccessToken(config, 7, fetch), 'shared-installation-token')
  assert.equal(calls, 1)
})

test('tokens expire after five minutes or before GitHub expiry, whichever comes first', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 })
  let calls = 0, lifetime = 60 * 60_000
  const fetch = () => Promise.resolve(Response.json(datedToken(`token-${++calls}`, lifetime)))
  assert.equal(await repoAccessToken(config, 7, fetch), 'token-1')
  t.mock.timers.tick(5 * 60_000 - 1)
  assert.equal(await repoAccessToken(config, 7, fetch), 'token-1')
  t.mock.timers.tick(1)
  lifetime = 2 * 60_000
  assert.equal(await repoAccessToken(config, 7, fetch), 'token-2')
  t.mock.timers.tick(60_000 - 1)
  assert.equal(await repoAccessToken(config, 7, fetch), 'token-2')
  t.mock.timers.tick(1)
  assert.equal(await repoAccessToken(config, 7, fetch), 'token-3', 'refresh with one minute left on the upstream token')
})

test('missing, invalid, expired, or nearly expired token dates are not reused', async () => {
  for (const expiresAt of [undefined, 'invalid', new Date(Date.now() - 1).toISOString(), new Date(Date.now() + 30_000).toISOString()]) {
    let calls = 0
    const fetch = () => Promise.resolve(Response.json({ token: `token-${++calls}`, expires_at: expiresAt }))
    assert.equal(await repoAccessToken(config, 7, fetch), 'token-1')
    assert.equal(await repoAccessToken(config, 7, fetch), 'token-2')
  }
})

test('failed and malformed token mints are retried, including signing failures', async () => {
  for (const failure of [() => Response.json({}, { status: 503 }), () => Response.json({}), () => Response.json(null)]) {
    let calls = 0
    const fetch = () => Promise.resolve(++calls === 1 ? failure() : Response.json(datedToken('recovered')))
    await assert.rejects(repoAccessToken(config, 7, fetch))
    assert.equal(await repoAccessToken(config, 7, fetch), 'recovered')
    assert.equal(calls, 2)
  }
  let calls = 0
  const fetch = () => { calls++; return Promise.resolve(Response.json(datedToken('unused'))) }
  const invalid = { ...config, githubAppPrivateKey: 'invalid key' }
  await assert.rejects(repoAccessToken(invalid, 7, fetch))
  await assert.rejects(repoAccessToken(invalid, 7, fetch))
  assert.equal(calls, 0)
})

test('cache entries are isolated by App, signing key, installation, and transport', async () => {
  let calls = 0
  const fetch = () => Promise.resolve(Response.json(datedToken(`token-${++calls}`)))
  assert.equal(await repoAccessToken(config, 7, fetch), 'token-1')
  assert.equal(await repoAccessToken(config, 8, fetch), 'token-2')
  assert.equal(await repoAccessToken({ ...config, githubAppId: '2' }, 7, fetch), 'token-3')
  assert.equal(await repoAccessToken({ ...config, githubAppPrivateKey: privateKey() }, 7, fetch), 'token-4')
  const otherFetch = () => Promise.resolve(Response.json(datedToken('other-transport')))
  assert.equal(await repoAccessToken(config, 7, otherFetch), 'other-transport')
  assert.equal(await repoAccessToken(config, 7, fetch), 'token-1')
  assert.equal(await repoAccessToken(config, null, fetch), null)
  assert.equal(await repoAccessToken({}, 7, fetch), null)
  assert.equal(calls, 4)
})

test('a rejected credential is evicted without evicting its newer replacement', async () => {
  let mints = 0
  const fetch = url => Promise.resolve(url.endsWith('/access_tokens')
    ? Response.json(datedToken(`token-${++mints}`)) : Response.json({}, { status: 401 }))
  const first = await repoAccessToken(config, 7, fetch)
  await assert.rejects(githubJson('https://api.github.com/repos/org/repo', first, fetch), /github-unauthorized/u)
  assert.equal(await repoAccessToken(config, 7, fetch), 'token-2')
  await assert.rejects(githubJson('https://api.github.com/repos/org/repo', first, fetch), /github-unauthorized/u)
  assert.equal(await repoAccessToken(config, 7, fetch), 'token-2', 'late rejection cannot drop a newer token')
  assert.equal(mints, 2)
})

test('installation token storage is bounded and retains recently used entries', async () => {
  let calls = 0
  const fetch = () => Promise.resolve(Response.json(datedToken(`token-${++calls}`)))
  for (let id = 1; id <= 256; id++) await repoAccessToken(config, id, fetch)
  assert.equal(await repoAccessToken(config, 1, fetch), 'token-1')
  await repoAccessToken(config, 257, fetch)
  assert.equal(await repoAccessToken(config, 1, fetch), 'token-1')
  assert.equal(await repoAccessToken(config, 2, fetch), 'token-258')
})
