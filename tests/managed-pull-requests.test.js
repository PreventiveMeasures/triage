import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { MAX_PULL_REQUESTS, parseGithubIssueUrl, parseGithubPrUrl } from '../common/github-pr.ts'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { lookupPullRequests } from '../server-managed/github-pulls.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { createSession } from '../server-managed/session.ts'

const config = {
  port: 8765, host: '127.0.0.1', dbPath: ':memory:', debug: false,
  githubClientId: 'cid', githubClientSecret: 'secret',
  oauthCallbackUrl: 'http://127.0.0.1:8765/api/oauth/github/callback',
  cookieSecure: false, sessionCookieName: 'dvsid', sessionTtlMs: 3_600_000,
  maxReportBytes: 10_485_760, maxBundleBytes: 104_857_600,
}
const link = number => `https://github.com/exampleorg/eXamplerEpo/pull/${number}`
const payload = (number, extra = {}) => ({ number, title: `Fix ${number}`, state: 'open', merged: false, draft: false, base: { repo: { full_name: 'ExampleOrg/ExampleRepo' } }, ...extra })

async function fixture(t) {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const session = await createSession(config, db, { githubUserId: 1, login: 'alice', name: null, avatarUrl: null }, Date.now())
  await db.setUserRole(session.userId, 'view')
  await db.setUserTokens(session.userId, { accessToken: 'alice-token', refreshToken: null, expiresAt: null })
  for (const [repoId, fullName] of [[7, 'ExampleOrg/ExampleRepo'], [8, 'OtherOrg/OtherRepo']]) {
    await db.selectRepo({ repoId, fullName, private: true, installationId: 99, defaultBranch: 'main', htmlUrl: `https://github.com/${fullName}`, addedBy: session.userId }, Date.now())
  }
  await db.createTeam('team', 'Team', Date.now())
  await db.setTeamRepo('team', 7, 'src')
  await db.setTeamMember('team', session.userId, { dependencies: false, security: false })
  const lookup = (urls, fetchImpl) => lookupPullRequests(config, db, session.userId, urls, fetchImpl)
  return { db, session, lookup }
}

test('PR links require an exact GitHub URL and a positive safe integer', () => {
  assert.deepEqual(parseGithubPrUrl(link('000123') + '/files?x=1#diff-a'), { repo: 'exampleorg/eXamplerEpo', number: 123 })
  assert.equal(parseGithubPrUrl(link(Number.MAX_SAFE_INTEGER)).number, Number.MAX_SAFE_INTEGER)
  for (const number of [0, -1, 1.5, '1e3', 'Infinity', '9007199254740992', '%31', '123/../../issues/1']) assert.equal(parseGithubPrUrl(link(number)), null)
  for (const url of ['http://github.com/o/r/pull/1', 'https://github.com.evil.test/o/r/pull/1', 'https://github.com@evil.test/o/r/pull/1',
    'https://user@github.com/o/r/pull/1', 'https://github.com:443/o/r/pull/1', 'https://github.com/o/r/../r/pull/1',
    'https://github.com/o/%72/pull/1', 'https://github.com/o/r/issues/1', 'https://github.com/o/r/pull/1/unknown',
    'https://github.com/Kernel/r/pull/1', 'https://github.com/o/r/pull/1\n']) assert.equal(parseGithubPrUrl(url), null, url)
})

test('issue links are recognized for display without becoming PR lookup inputs', async t => {
  const url = 'https://github.com/exampleorg/eXamplerEpo/issues/00123#issuecomment-1'
  assert.deepEqual(parseGithubIssueUrl(url), { repo: 'exampleorg/eXamplerEpo', number: 123 })
  assert.equal(parseGithubIssueUrl(link(123)), null)
  for (const invalid of ['https://github.com.evil.test/o/r/issues/1', 'https://user@github.com/o/r/issues/1',
    'https://github.com/o/r/issues/0', 'https://github.com/o/r/issues/9007199254740992',
    'https://github.com/o/r/issues/1/files', 'https://github.com/o/r/issues/%31']) assert.equal(parseGithubIssueUrl(invalid), null)
  const f = await fixture(t)
  assert.equal((await f.lookup([url], () => assert.fail('issue links must not trigger PR API calls')))[0].error, 'invalid-url')
})

test('batch reads use the registered repo casing and only the numeric link ID, deduplicate, and return all four statuses', async t => {
  const f = await fixture(t)
  const requests = []
  const urls = [link('000123') + '/files?api=elsewhere#comment', link(123), link(124), link(125), link(126)]
  const results = await f.lookup(urls, (url, options) => {
    requests.push(url)
    assert.equal(options.headers.authorization, 'Bearer alice-token')
    assert.equal(options.redirect, 'error')
    assert.ok(options.signal instanceof AbortSignal)
    assert.match(url, /^https:\/\/api\.github\.com\/repos\/ExampleOrg\/ExampleRepo\/pulls\/\d+$/u)
    const number = Number(url.split('/').at(-1))
    return Response.json(payload(number, { draft: number === 124, state: number >= 125 ? 'closed' : 'open', merged: number === 126 }))
  })
  assert.equal(requests.length, 4)
  assert.equal(requests[0], 'https://api.github.com/repos/ExampleOrg/ExampleRepo/pulls/123')
  assert.deepEqual(results.map(result => result.status), ['open', 'open', 'draft', 'closed', 'merged'])
  assert.deepEqual(results.map(result => result.url), urls)
  assert.deepEqual(Object.keys(results[0]).toSorted(), ['status', 'title', 'url'])
})

test('team grants are required even for admins and are rechecked on each request before any token access', async t => {
  const f = await fixture(t)
  const noFetch = () => assert.fail('unauthorized URLs must not reach GitHub')
  t.mock.method(f.db, 'getUserTokens', () => assert.fail('unauthorized URLs must not access credentials'))
  await f.db.setUserRole(f.session.userId, 'admin')
  const result = await f.lookup(['https://github.com/OtherOrg/OtherRepo/pull/123', 'https://github.com/Unknown/Repo/pull/123', link(0)], noFetch)
  assert.deepEqual(result.map(row => row.error), ['forbidden', 'forbidden', 'invalid-url'])
  await f.db.removeTeamMember('team', f.session.userId)
  assert.equal((await f.lookup([link(123)], noFetch))[0].error, 'forbidden')
  assert.deepEqual(await f.lookup([], noFetch), [])
})

test('known malformed repository names cannot supply an upstream path', async t => {
  const f = await fixture(t)
  await f.db.selectRepo({ repoId: 7, fullName: 'ExampleOrg/ExampleRepo/../other', private: true, installationId: 99, defaultBranch: 'main', htmlUrl: '', addedBy: f.session.userId }, Date.now())
  assert.equal((await f.lookup([link(123)], () => assert.fail('no upstream call')))[0].error, 'forbidden')
})

test('missing or expired user credentials never fall back to the installed app; expiring tokens can refresh', async t => {
  const f = await fixture(t)
  await f.db.setUserTokens(f.session.userId, { accessToken: 'expired', refreshToken: null, expiresAt: 1 })
  assert.equal((await f.lookup([link(123)], () => assert.fail('no installation token fallback')))[0].error, 'unavailable')
  await f.db.setUserTokens(f.session.userId, { accessToken: 'expired', refreshToken: 'refresh-user', expiresAt: 1 })
  const calls = []
  const results = await f.lookup([link(123)], (url, options) => {
    calls.push(url)
    if (url === 'https://github.com/login/oauth/access_token') {
      assert.equal(JSON.parse(options.body).refresh_token, 'refresh-user')
      return Response.json({ access_token: 'refreshed-user', expires_in: 3600 })
    }
    assert.equal(options.headers.authorization, 'Bearer refreshed-user')
    return Response.json(payload(123))
  })
  assert.equal(results[0].title, 'Fix 123')
  assert.equal(calls.length, 2)
})

test('partial failures, redirects, wrong upstream identity, and malformed responses stay unavailable', async t => {
  const f = await fixture(t)
  const responses = [Response.json(payload(1)), new Response(null, { status: 302, headers: { location: 'https://elsewhere.test' } }),
    new Response(null, { status: 404 }), new Response(null, { status: 403 }), new Response(null, { status: 429 }),
    Response.json(payload(99)), Response.json(payload(7, { base: { repo: { full_name: 'different/repo' } } })), new Response('not-json')]
  const result = await f.lookup(responses.map((_, i) => link(i + 1)), url => responses[Number(url.split('/').at(-1)) - 1])
  assert.equal(result[0].status, 'open')
  assert.ok(result.slice(1).every(row => row.error === 'unavailable'))
  assert.equal((await f.lookup([link(1)], () => { throw new Error('network') }))[0].error, 'unavailable')
})

test('upstream concurrency is bounded for a full batch', async t => {
  const f = await fixture(t)
  let active = 0, maximum = 0
  const result = await f.lookup(Array.from({ length: MAX_PULL_REQUESTS }, (_, i) => link(i + 1)), async url => {
    maximum = Math.max(maximum, ++active)
    await new Promise(resolve => { setImmediate(resolve) })
    active--
    return Response.json(payload(Number(url.split('/').at(-1))))
  })
  assert.equal(result.length, MAX_PULL_REQUESTS)
  assert.equal(maximum, 4)
})

test('HTTP batch endpoint authenticates, checks CSRF/origin, bounds input, and returns per-item results without caching', async t => {
  const f = await fixture(t)
  let allowedOrigin = true, githubCalls = 0, pending
  t.mock.method(globalThis, 'fetch', () => { githubCalls++; return Response.json(payload(123)) })
  const handler = createManagedRequestHandler({
    config, db: f.db, originGate: { isOriginAllowed: () => allowedOrigin },
    isShuttingDown: () => false, track: promise => { pending = promise },
  })
  const send = async (body, { cookie = f.session.setCookie.split(';')[0], csrf = f.session.csrfToken, method = 'POST', raw } = {}) => {
    const req = Readable.from([Buffer.from(raw ?? JSON.stringify(body))])
    req.method = method; req.url = '/api/github/pull-requests'
    req.headers = { cookie, 'x-csrf-token': csrf }
    const res = { writeHead(status, headers) { this.status = status; this.headers = headers }, end(text) { this.body = JSON.parse(text) } }
    handler(req, res)
    await pending
    return res
  }
  assert.equal((await send({ urls: [link(123)] }, { cookie: '' })).status, 401)
  assert.equal((await send({ urls: [link(123)] }, { csrf: '' })).status, 403)
  allowedOrigin = false
  assert.equal((await send({ urls: [link(123)] })).status, 403)
  allowedOrigin = true
  assert.equal((await send({}, { method: 'GET' })).status, 405)
  for (const body of [null, {}, { urls: link(123) }, { urls: [123] }, { urls: ['x'.repeat(2049)] }, { urls: Array.from({ length: 51 }, () => link(123)) }]) assert.equal((await send(body)).status, 400)
  assert.equal((await send({}, { raw: '{bad' })).status, 400)
  assert.equal(githubCalls, 0)
  const response = await send({ urls: [link(123), 'https://github.com/OtherOrg/OtherRepo/pull/1', 'invalid'] })
  assert.equal(response.status, 200)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.deepEqual(response.body.pullRequests, [
    { url: link(123), title: 'Fix 123', status: 'open' },
    { url: 'https://github.com/OtherOrg/OtherRepo/pull/1', error: 'forbidden' }, { url: 'invalid', error: 'invalid-url' },
  ])
  assert.equal(githubCalls, 1)
})
