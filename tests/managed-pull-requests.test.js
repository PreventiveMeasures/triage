import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseGithubIssueUrl, parseGithubPrUrl } from '../common/github-pr.ts'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { lookupPullRequests } from '../server-managed/github-pulls.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { createSession, endSession, readSession } from '../server-managed/session.ts'

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
  const stored = await readSession(config, db, session.setCookie.split(';')[0], Date.now())
  const lookup = async (urls, fetchImpl) => lookupPullRequests(config, db, await db.getTeamReportAccessSnapshot(stored.session.id, Date.now(), 'team'), urls, fetchImpl)
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
  const result = await f.lookup(Array.from({ length: 64 }, (_, i) => link(i + 1)), async url => {
    maximum = Math.max(maximum, ++active)
    await new Promise(resolve => { setImmediate(resolve) })
    active--
    return Response.json(payload(Number(url.split('/').at(-1))))
  })
  assert.equal(result.length, 64)
  assert.equal(maximum, 4)
})

async function workspaceFixture(t) {
  const f = await fixture(t)
  const blobs = new Map()
  async function seed(id, data, { directory = 'src', visible = true } = {}) {
    const bytes = Buffer.from(JSON.stringify(data))
    blobs.set(id, bytes)
    await f.db.insertReport({ id, filename: `${id}.json`, repoId: 7, repoDirectory: directory, visible,
      byteSize: bytes.length, sha256: id, contentType: 'application/json', uploadedBy: f.session.userId,
      bundleId: null, bundleIntegrity: null }, Date.now())
  }
  await seed('main', { findings: [
    { id: 'own', file: 'src/a.js' }, { id: 'dependency', file: 'node_modules/other/x.js' },
    [{ id: 'row', file: 'src/row.js' }, { id: 'security-sibling', security: true }],
    { id: 'linked', file: 'src/linked.js' }, { id: 'foreign-repo', file: 'src/a.js' },
    { id: 'issue', file: 'src/a.js' }, { id: 'malformed', file: 'src/a.js' },
  ] })
  await seed('security', { type: 'security', findings: [{ id: 'secret' }, { id: 'downgraded', security: false }] })
  await seed('links', [[{ id: 'linked' }, { id: 'secret' }]])
  await seed('draft', { findings: [{ id: 'draft' }] }, { visible: false })
  await seed('outside', { findings: [{ id: 'outside' }] }, { directory: 'other' })
  const entries = ['own', 'dependency', 'row', 'linked', 'secret', 'downgraded', 'draft', 'outside'].map((id, i) => [id, { fix: link(i + 1) }])
  entries.push(['foreign-repo', { fix: 'https://github.com/OtherOrg/OtherRepo/pull/1' }], ['issue', { fix: 'https://github.com/ExampleOrg/ExampleRepo/issues/1' }], ['malformed', { fix: 'not a URL' }])
  await f.db.setTriageEntries(entries, f.session.userId, 'alice', Date.now())
  await f.db.createTeam('broad', 'Broad', Date.now())
  await f.db.setTeamRepo('broad', 7, 'src')
  await f.db.setTeamRepo('broad', 8, null)
  await f.db.setTeamMember('broad', f.session.userId, { dependencies: true, security: true })
  let pending
  const store = { get: id => Promise.resolve(blobs.get(id)) }
  const handler = createManagedRequestHandler({ config, db: f.db, reportStore: store,
    originGate: { isOriginAllowed: () => true }, isShuttingDown: () => false, track: job => { pending = job } })
  const send = async ({ path = '/api/teams/team/pull-requests', cookie = f.session.setCookie.split(';')[0], method = 'GET' } = {}) => {
    const req = { url: path, method, headers: { cookie }, [Symbol.asyncIterator]() { assert.fail('workspace PR requests must not read user input') } }
    const res = { writeHead(status, headers) { this.status = status; this.headers = headers }, end(text) { this.body = JSON.parse(text) } }
    handler(req, res); await pending
    return res
  }
  return { ...f, seed, send, store }
}

test('workspace GET derives only saved Fix PRs surviving the complete security/dependency filters', async t => {
  const calls = [], f = await workspaceFixture(t)
  t.mock.method(globalThis, 'fetch', url => {
    calls.push(url)
    return Response.json(payload(Number(url.split('/').at(-1))))
  })
  const response = await f.send({ path: `/api/teams/team/pull-requests?url=${encodeURIComponent(link(999))}` })
  assert.equal(response.status, 200)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.deepEqual(response.body.pullRequests, [
    { url: 'https://github.com/OtherOrg/OtherRepo/pull/1', error: 'forbidden' },
    { url: link(1), title: 'Fix 1', status: 'open' }, { url: link(6), title: 'Fix 6', status: 'open' },
  ])
  assert.deepEqual(calls.map(url => Number(url.split('/').at(-1))), [1, 6], 'hidden rows, linked security, dependencies, drafts and arbitrary input never reach GitHub')
  const broad = await f.send({ path: '/api/teams/broad/pull-requests' })
  assert.equal(broad.body.pullRequests.length, 7, 'another team gets its own permitted findings')
  for (const role of ['admin', 'manage']) {
    await f.db.setUserRole(f.session.userId, role)
    const whole = await f.send()
    assert.equal(whole.body.pullRequests.length, 8, `${role} retains the report filtering bypass`)
    assert.ok(!whole.body.pullRequests.some(row => row.url === link(8)), 'outside report paths stay excluded')
  }
})

test('workspace PR reads require approved team membership; the arbitrary-input POST is removed', async t => {
  const f = await workspaceFixture(t)
  t.mock.method(globalThis, 'fetch', () => assert.fail('denied request reached GitHub'))
  assert.equal((await f.send({ cookie: '' })).status, 401)
  assert.equal((await f.send({ method: 'POST' })).status, 405)
  assert.equal((await f.send({ path: '/api/github/pull-requests', method: 'POST' })).status, 404)
  assert.equal((await f.send({ path: '/api/teams/missing/pull-requests' })).status, 404)
  await f.db.setUserRole(f.session.userId, 'none')
  assert.equal((await f.send()).status, 403)
  await f.db.setUserRole(f.session.userId, 'admin')
  await f.db.removeTeamMember('team', f.session.userId)
  assert.equal((await f.send()).status, 404, 'admins also need this workspace membership')
})

for (const change of ['membership', 'repository', 'repository-without-reports', 'team', 'security', 'links', 'publication', 'fix', 'role', 'logout', 'refresh']) {
  test(`workspace PR metadata is discarded when ${change} changes during upstream reads`, async t => {
    const f = await workspaceFixture(t)
    await f.db.setTeamMember('team', f.session.userId, { dependencies: true, security: true })
    if (change === 'repository-without-reports') await f.db.setTeamRepo('team', 8, null)
    if (change === 'refresh') await f.db.setUserTokens(f.session.userId, { accessToken: 'expired', refreshToken: 'refresh', expiresAt: 1 })
    let changed = false
    t.mock.method(globalThis, 'fetch', async url => {
      if (!changed) {
        changed = true
        if (change === 'membership' || change === 'refresh') await f.db.removeTeamMember('team', f.session.userId)
        if (change === 'repository') await f.db.removeTeamRepo('team', 7)
        if (change === 'repository-without-reports') await f.db.removeTeamRepo('team', 8)
        if (change === 'logout') await endSession(config, f.db, f.session.setCookie.split(';')[0])
        if (change === 'team') await f.db.deleteTeam('team')
        if (change === 'security') await f.db.setTeamMember('team', f.session.userId, { dependencies: true, security: false })
        if (change === 'links') await f.seed('new-links', [[{ id: 'own' }, { id: 'secret' }]])
        if (change === 'publication') await f.db.setReportVisible('main', false)
        if (change === 'fix') await f.db.setTriageEntries([['own', { fix: link(999) }]], f.session.userId, 'alice', Date.now())
        if (change === 'role') await f.db.setUserRole(f.session.userId, 'none')
      }
      return url.includes('/oauth/') ? Response.json({ access_token: 'refreshed', expires_in: 3600 }) : Response.json(payload(Number(url.split('/').at(-1))))
    })
    const response = await f.send()
    assert.equal(response.status, change === 'role' ? 403 : change === 'logout' ? 401 : 404)
    assert.equal(response.body.pullRequests, undefined)
  })
}


test('a workspace with no eligible Fix PRs does not read credentials or contact GitHub', async t => {
  const f = await workspaceFixture(t)
  await f.db.setTriageEntries(['own', 'downgraded', 'foreign-repo'].map(id => [id, null]), f.session.userId, 'alice', Date.now())
  t.mock.method(f.db, 'getUserTokens', () => assert.fail('hidden Fix links must not access credentials'))
  t.mock.method(globalThis, 'fetch', () => assert.fail('hidden Fix links must not reach GitHub'))
  const response = await f.send()
  assert.equal(response.status, 200)
  assert.deepEqual(response.body.pullRequests, [])
})

test('a whole workspace returns more than the old 50-link batch limit without accepting client URLs', async t => {
  const f = await workspaceFixture(t)
  const findings = Array.from({ length: 64 }, (_, i) => ({ id: `extra-${i}`, file: 'src/many.js' }))
  await f.seed('many', { findings })
  await f.db.setTriageEntries(findings.map((finding, i) => [finding.id, { fix: link(100 + i) }]), f.session.userId, 'alice', Date.now())
  let requests = 0
  t.mock.method(globalThis, 'fetch', url => { requests++; return Response.json(payload(Number(url.split('/').at(-1)))) })
  const response = await f.send()
  assert.equal(response.status, 200)
  assert.equal(response.body.pullRequests.length, 67)
  assert.equal(requests, 66)
  assert.equal(response.body.pullRequests.find(row => row.url === link(163)).title, 'Fix 163')
})

test('a cold report read rechecks workspace access before contacting GitHub', async t => {
  const f = await workspaceFixture(t)
  const get = f.store.get
  t.mock.method(f.store, 'get', async id => {
    await f.db.removeTeamMember('team', f.session.userId)
    return get(id)
  })
  t.mock.method(globalThis, 'fetch', () => assert.fail('revoked workspace must not reach GitHub'))
  assert.equal((await f.send()).status, 404)
})


test('access is rechecked after the final persisted Fix read', async t => {
  const f = await workspaceFixture(t)
  const listTriage = f.db.listTriage
  let reads = 0
  t.mock.method(f.db, 'listTriage', async ids => {
    const entries = await listTriage(ids)
    if (++reads === 2) await f.db.removeTeamMember('team', f.session.userId)
    return entries
  })
  t.mock.method(globalThis, 'fetch', url => Response.json(payload(Number(url.split('/').at(-1)))))
  const response = await f.send()
  assert.equal(response.status, 404)
  assert.equal(response.body.pullRequests, undefined)
})
