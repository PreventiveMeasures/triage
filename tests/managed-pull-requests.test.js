import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseGithubIssueUrl, parseGithubPrUrl } from '../common/github-pr.ts'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { lookupFixes } from '../server-managed/github-pulls.ts'
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
const payload = (number, extra = {}) => ({ number, title: `Fix ${number}`, body: `Description ${number}`, state: 'open', merged: false, draft: false, base: { repo: { full_name: 'ExampleOrg/ExampleRepo' } }, ...extra })

const issuePayload = (number, extra = {}) => ({ number, title: `Issue ${number}`, body: `Issue description ${number}`, state: 'open', repository_url: 'https://api.github.com/repos/ExampleOrg/ExampleRepo', ...extra })
const repositoryRequest = url => /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+$/u.test(url)
const repositoryPayload = url => ({ id: url.endsWith('/OtherOrg/OtherRepo') ? 8 : 7, full_name: url.split('/repos/')[1], private: true, visibility: 'private' })
const responseFor = url => Response.json(repositoryRequest(url) ? repositoryPayload(url)
  : (url.includes('/issues/') ? issuePayload : payload)(Number(url.split('/').at(-1))))
// Metadata refresh tests use a successful, separate repository-access stub.
// The workspace tests below exercise access checks through the actual router.
const withRepositoryAccess = fetchMetadata => (url, options) => repositoryRequest(url) ? responseFor(url) : fetchMetadata(url, options)

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
  const lookup = async (urls, fetchImpl) => lookupFixes(config, db, await db.getTeamReportAccessSnapshot(stored.session.id, Date.now(), 'team'), urls, withRepositoryAccess(fetchImpl))
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

test('ordinary issue links fetch validated titles, descriptions and status from the issues API', async t => {
  const url = 'https://github.com/exampleorg/eXamplerEpo/issues/00123#issuecomment-1'
  assert.deepEqual(parseGithubIssueUrl(url), { repo: 'exampleorg/eXamplerEpo', number: 123 })
  assert.equal(parseGithubIssueUrl(link(123)), null)
  for (const invalid of ['https://github.com.evil.test/o/r/issues/1', 'https://user@github.com/o/r/issues/1',
    'https://github.com/o/r/issues/0', 'https://github.com/o/r/issues/9007199254740992',
    'https://github.com/o/r/issues/1/files', 'https://github.com/o/r/issues/%31']) assert.equal(parseGithubIssueUrl(invalid), null)
  const f = await fixture(t)
  const results = await f.lookup([url], (target, options) => {
    assert.equal(target, 'https://api.github.com/repos/ExampleOrg/ExampleRepo/issues/123')
    assert.equal(options.headers.authorization, 'Bearer alice-token')
    return Response.json(issuePayload(123, { state: 'closed' }))
  })
  assert.deepEqual(results, [{ url, title: 'Issue 123', description: 'Issue description 123', status: 'closed', stateReason: 'unknown' }])
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
  assert.deepEqual(Object.keys(results[0]).toSorted(), ['description', 'stateReason', 'status', 'title', 'url'])
})

test('team grants are required even for admins and are rechecked on each request before any token access', async t => {
  const f = await fixture(t)
  const noFetch = () => assert.fail('unauthorized URLs must not reach GitHub')
  t.mock.method(f.db, 'getUserTokens', () => assert.fail('unauthorized URLs must not access credentials'))
  await f.db.setUserRole(f.session.userId, 'admin')
  const result = await f.lookup(['https://github.com/OtherOrg/OtherRepo/pull/123', 'https://github.com/Unknown/Repo/pull/123', link(0)], noFetch)
  assert.deepEqual(result, [])
  await f.db.removeTeamMember('team', f.session.userId)
  assert.deepEqual(await f.lookup([link(123)], noFetch), [])
  assert.deepEqual(await f.lookup([], noFetch), [])
})

test('known malformed repository names cannot supply an upstream path', async t => {
  const f = await fixture(t)
  await f.db.selectRepo({ repoId: 7, fullName: 'ExampleOrg/ExampleRepo/../other', private: true, installationId: 99, defaultBranch: 'main', htmlUrl: '', addedBy: f.session.userId }, Date.now())
  assert.deepEqual(await f.lookup([link(123)], () => assert.fail('no upstream call')), [])
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
  assert.equal((await f.lookup([link(9)], () => { throw new Error('network') }))[0].error, 'unavailable')
})

test('workspace metadata lookups have both a request cap and bounded concurrency', async t => {
  const f = await fixture(t)
  let active = 0, maximum = 0, requests = 0
  const result = await f.lookup(Array.from({ length: 256 }, (_, i) => link(i + 1)), async url => {
    requests++
    maximum = Math.max(maximum, ++active)
    await new Promise(resolve => { setImmediate(resolve) })
    active--
    return responseFor(url)
  })
  assert.equal(result.length, 256)
  assert.equal(maximum, 4)
  assert.equal(requests, 200)
  assert.ok(result.slice(0, 200).every(row => row.status === 'open'))
  assert.ok(result.slice(200).every(row => row.error === 'unavailable'))
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
  const send = async ({ path = '/api/teams/team/fixes', cookie = f.session.setCookie.split(';')[0], method = 'GET' } = {}) => {
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
    return responseFor(url)
  })
  const response = await f.send({ path: `/api/teams/team/fixes?url=${encodeURIComponent(link(999))}` })
  assert.equal(response.status, 200)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.deepEqual(response.body.fixes, [
    { url: 'https://github.com/ExampleOrg/ExampleRepo/issues/1', title: 'Issue 1', description: 'Issue description 1', status: 'open', stateReason: null },
    { url: link(1), title: 'Fix 1', description: 'Description 1', status: 'open', stateReason: null },
    { url: link(6), title: 'Fix 6', description: 'Description 6', status: 'open', stateReason: null },
  ])
  assert.equal(calls[0], 'https://api.github.com/repos/ExampleOrg/ExampleRepo', 'the viewer must pass the live repository-access check')
  assert.deepEqual(calls.slice(1).map(url => Number(url.split('/').at(-1))), [1, 1, 6], 'hidden rows, linked security, dependencies, drafts and arbitrary input never reach GitHub')
  const broad = await f.send({ path: '/api/teams/broad/fixes' })
  assert.equal(broad.body.fixes.length, 8, 'another team gets its own permitted findings')
  for (const role of ['admin', 'manage']) {
    await f.db.setUserRole(f.session.userId, role)
    const whole = await f.send()
    assert.equal(whole.body.fixes.length, 8, `${role} retains the report filtering bypass`)
    assert.ok(!whole.body.fixes.some(row => row.url === link(8)), 'outside report paths stay excluded')
  }
})

test('workspace PR reads require approved team membership; the arbitrary-input POST is removed', async t => {
  const f = await workspaceFixture(t)
  t.mock.method(globalThis, 'fetch', () => assert.fail('denied request reached GitHub'))
  assert.equal((await f.send({ cookie: '' })).status, 401)
  assert.equal((await f.send({ method: 'POST' })).status, 405)
  assert.equal((await f.send({ path: '/api/github/pull-requests', method: 'POST' })).status, 404)
  assert.equal((await f.send({ path: '/api/github/pull-requests' })).status, 404)
  assert.equal((await f.send({ path: '/api/teams/team/pull-requests' })).status, 404)
  assert.equal((await f.send({ path: '/api/teams/missing/fixes' })).status, 404)
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
      return url.includes('/oauth/') ? Response.json({ access_token: 'refreshed', expires_in: 3600 }) : responseFor(url)
    })
    const response = await f.send()
    assert.equal(response.status, change === 'role' ? 403 : change === 'logout' ? 401 : 404)
    assert.equal(response.body.fixes, undefined)
  })
}


test('a workspace with no eligible Fix PRs does not read credentials or contact GitHub', async t => {
  const f = await workspaceFixture(t)
  await f.db.setTriageEntries(['own', 'downgraded', 'foreign-repo', 'issue'].map(id => [id, null]), f.session.userId, 'alice', Date.now())
  t.mock.method(f.db, 'getUserTokens', () => assert.fail('hidden Fix links must not access credentials'))
  t.mock.method(globalThis, 'fetch', () => assert.fail('hidden Fix links must not reach GitHub'))
  const response = await f.send()
  assert.equal(response.status, 200)
  assert.deepEqual(response.body.fixes, [])
})

test('a whole workspace keeps all Fix URLs but caps the derived upstream lookup list', async t => {
  const f = await workspaceFixture(t)
  const findings = Array.from({ length: 256 }, (_, i) => ({ id: `extra-${i}`, file: 'src/many.js' }))
  await f.seed('many', { findings })
  await f.db.setTriageEntries(findings.map((finding, i) => [finding.id, { fix: link(100 + i) }]), f.session.userId, 'alice', Date.now())
  let requests = 0
  t.mock.method(globalThis, 'fetch', url => { requests++; return responseFor(url) })
  const response = await f.send()
  assert.equal(response.status, 200)
  assert.equal(response.body.fixes.length, 259)
  assert.equal(requests, 201, 'one repository-access check plus at most 200 metadata reads')
  assert.equal(response.body.fixes.filter(row => row.status === 'open').length, 200)
  assert.equal(response.body.fixes.find(row => row.url === link(355)).error, 'unavailable')
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
  t.mock.method(globalThis, 'fetch', responseFor)
  const response = await f.send()
  assert.equal(response.status, 404)
  assert.equal(response.body.fixes, undefined)
})


test('duplicate and forbidden Fix URLs do not consume the upstream request budget', async t => {
  const f = await fixture(t)
  const urls = ['https://github.com/OtherOrg/OtherRepo/pull/1', ...Array.from({ length: 250 }, (_, i) => `${link(1)}/files#diff-${i}`),
    ...Array.from({ length: 250 }, (_, i) => link(i + 1))]
  let requests = 0
  const result = await f.lookup(urls, url => { requests++; return responseFor(url) })
  assert.equal(requests, 200)
  assert.equal(result.length, 500, 'the foreign repository is never returned')
  assert.ok(result.slice(0, 450).every(row => row.status === 'open'))
  assert.ok(result.slice(450).every(row => row.error === 'unavailable'))
})

test('one deadline aborts pending GitHub reads and prevents further waves while retaining completed metadata', async t => {
  const f = await fixture(t)
  const controller = new AbortController()
  const timeout = t.mock.method(AbortSignal, 'timeout', ms => { assert.equal(ms, 10_000); return controller.signal })
  let requests = 0
  const result = await f.lookup(Array.from({ length: 256 }, (_, i) => link(i + 1)), (url, options) => {
    requests++
    options.signal.throwIfAborted()
    const number = Number(url.split('/').at(-1))
    if (number <= 4) return Response.json(payload(number))
    setImmediate(() => controller.abort(new DOMException('Deadline reached', 'TimeoutError')))
    return new Promise((resolve, reject) => { options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }) })
  })
  assert.equal(timeout.mock.callCount(), 1, 'all waves share one deadline')
  assert.equal(requests, 8, 'no more GitHub requests start after the shared timeout')
  assert.ok(result.slice(0, 4).every(row => row.status === 'open'))
  assert.ok(result.slice(4).every(row => row.error === 'unavailable'))
})

test('the shared upstream deadline also bounds OAuth token refresh', async t => {
  const f = await fixture(t)
  const controller = new AbortController()
  const timeout = t.mock.method(AbortSignal, 'timeout', ms => { assert.equal(ms, 10_000); return controller.signal })
  t.mock.method(console, 'warn', () => {})
  await f.db.setUserTokens(f.session.userId, { accessToken: 'expired', refreshToken: 'refresh', expiresAt: 1 })
  const requests = []
  const result = await f.lookup([link(1)], (url, options) => {
    requests.push([url, options.signal])
    if (!options.signal) return Promise.reject(new Error('missing deadline'))
    setImmediate(() => controller.abort(new DOMException('Deadline reached', 'TimeoutError')))
    return new Promise((resolve, reject) => { options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }) })
  })
  assert.equal(timeout.mock.callCount(), 1)
  assert.equal(requests.length, 1, 'an expired token cannot start PR reads after the refresh deadline')
  assert.equal(requests[0][0], 'https://github.com/login/oauth/access_token')
  assert.equal(requests[0][1], controller.signal)
  assert.equal(result[0].error, 'unavailable')
})

test('successful PR metadata is persisted, reused for one minute, refreshed, and retained on failures', async t => {
  const f = await fixture(t)
  let now = Date.now(), requests = 0
  t.mock.method(Date, 'now', () => now)
  const read = () => f.lookup([link(1)], () => { requests++; return Response.json(payload(1, { title: `Revision ${requests}` })) })
  assert.equal((await read())[0].title, 'Revision 1')
  assert.equal((await f.db.listGithubMetadata(['7:pull:1']))[0].description, 'Description 1')
  now += 59_999
  assert.equal((await read())[0].title, 'Revision 1')
  assert.equal(requests, 1)
  now++
  assert.equal((await read())[0].title, 'Revision 2')
  now += 60_000
  for (const fail of [() => { throw new Error('offline') }, () => new Response(null, { status: 429 }), () => new Response('bad json'), () => Response.json(payload(99))]) {
    const cached = (await f.lookup([link(1)], fail))[0]
    assert.equal(cached.title, 'Revision 2')
    assert.equal(cached.description, 'Description 1')
    assert.equal(cached.status, 'open')
  }
  await f.db.setUserTokens(f.session.userId, { accessToken: 'expired', refreshToken: null, expiresAt: 1 })
  assert.deepEqual(await f.lookup([link(1)], () => assert.fail('expired credentials')), [{ url: link(1), error: 'unavailable' }])
  assert.equal((await f.db.listGithubMetadata(['7:pull:1']))[0].fetchedAt, now - 60_000, 'failure neither evicts nor freshens cached data')
})

test('merged and closed entries stay cached after verifying the current viewer without refreshing metadata', async t => {
  const f = await fixture(t)
  await f.db.setGithubMetadata([
    { key: '7:pull:1', title: 'Merged', description: 'Permanent merged body', status: 'merged', fetchedAt: 1 },
    { key: '7:pull:2', title: 'Closed', description: null, status: 'closed', fetchedAt: 1 },
    { key: '7:issue:3', title: 'Closed issue', description: 'Done', status: 'closed', stateReason: 'completed', fetchedAt: 1 },
  ])
  const credentials = t.mock.method(f.db, 'getUserTokens')
  const result = await f.lookup([link(1), link(2), 'https://github.com/ExampleOrg/ExampleRepo/issues/3'], () => assert.fail('completed metadata must not be refreshed'))
  assert.equal(credentials.mock.callCount(), 1, 'cached content still requires this viewer\'s credentials')
  assert.deepEqual(result.map(row => row.status), ['merged', 'closed', 'closed'])
  assert.equal(result[0].description, 'Permanent merged body')
})

test('missing entries take priority, then oldest stale open/draft entries fill the 200-item queue', async t => {
  const f = await fixture(t), now = Date.now()
  const entries = [
    { key: '7:pull:1', title: 'Younger', description: 'Old younger body', status: 'open', fetchedAt: now - 70_000 },
    { key: '7:pull:2', title: 'Oldest', description: 'Oldest body', status: 'open', fetchedAt: now - 90_000 },
    { key: '7:pull:3', title: 'Draft', description: null, status: 'draft', fetchedAt: now - 80_000 },
    { key: '7:pull:4', title: 'Fresh', description: null, status: 'open', fetchedAt: now },
    { key: '7:pull:5', title: 'Merged', description: null, status: 'merged', fetchedAt: 1 },
    { key: '7:pull:6', title: 'Closed', description: null, status: 'closed', fetchedAt: 1 },
  ]
  await f.db.setGithubMetadata(entries)
  const calls = [], missing = Array.from({ length: 198 }, (_, i) => link(100 + i))
  const result = await f.lookup([link(1), link(2), link(3), link(4), link(5), link(6), ...missing], url => { calls.push(url); return responseFor(url) })
  assert.equal(calls.length, 200)
  assert.deepEqual(calls.slice(-2).map(url => Number(url.split('/').at(-1))), [2, 3], 'the oldest open and draft fill the spare slots')
  assert.equal(result[0].title, 'Younger', 'stale entries outside the refresh budget are still returned')
  assert.equal(result[0].description, 'Old younger body')
  assert.equal(result[1].title, 'Fix 2', 'successful refresh overrides the old cached value')
  assert.equal(result[2].title, 'Fix 3')
  assert.equal(result[3].title, 'Fresh')
  assert.equal(result[4].status, 'merged')
  assert.equal(result[5].status, 'closed')
  assert.ok(result.slice(6).every(row => row.status === 'open'))
})

test('large workspaces return all cached entries and progress through missing metadata across reads', async t => {
  const f = await fixture(t)
  await f.db.setGithubMetadata([{ key: '7:pull:1', title: 'Stale open', description: 'Fallback', status: 'open', fetchedAt: 1 }])
  const urls = Array.from({ length: 250 }, (_, i) => link(i + 1))
  let calls = 0
  const fetchMetadata = url => { calls++; return responseFor(url) }
  const first = await f.lookup(urls, fetchMetadata)
  assert.equal(first.length, 250)
  assert.equal(calls, 200)
  assert.equal(first[0].title, 'Stale open', 'missing records use the whole budget, but old open records are returned')
  assert.ok(first.slice(201).every(row => row.error === 'unavailable'))
  const second = await f.lookup(urls, fetchMetadata)
  assert.equal(calls, 250, '49 remaining misses and one stale open record; fresh cached entries use no budget')
  assert.ok(second.every(row => row.status === 'open'))
  assert.equal((await f.db.listGithubMetadata(Array.from({ length: 250 }, (_, i) => `7:pull:${i + 1}`))).length, 250, 'nothing is evicted to enforce the per-request limit')
})

test('shared cache reads require current user membership, team repos and visible Fix links', async t => {
  const f = await workspaceFixture(t)
  const cached = { title: 'Private merged metadata', description: 'Private body', status: 'merged', fetchedAt: 1 }
  await f.db.setGithubMetadata([{ key: '7:pull:5', ...cached }, { key: '8:pull:1', ...cached }])
  t.mock.method(globalThis, 'fetch', responseFor)
  const response = await f.send()
  assert.equal(response.status, 200)
  assert.ok(!response.body.fixes.some(row => row.url === link(5)), 'security-hidden metadata cannot leak from the cache')
  assert.ok(!response.body.fixes.some(row => row.url.includes('OtherOrg')), 'foreign-repository items are never returned, even when cached')
  const bob = await createSession(config, f.db, { githubUserId: 2, login: 'bob', name: null, avatarUrl: null }, Date.now())
  await f.db.setUserRole(bob.userId, 'view')
  const bobCookie = bob.setCookie.split(';')[0]
  assert.equal((await f.send({ path: '/api/teams/broad/fixes', cookie: bobCookie })).status, 404, 'an unrelated user cannot read cached metadata by guessing a team ID')
  await f.db.setTeamMember('team', bob.userId, { dependencies: false, security: false })
  const limited = await f.send({ cookie: bobCookie })
  assert.equal(limited.status, 200)
  assert.ok(!limited.body.fixes.some(row => row.url === link(5)), 'a member still cannot see cached security-hidden items')
  assert.ok(!limited.body.fixes.some(row => row.url.includes('OtherOrg')), 'another team granting the repo cannot widen this response')
  assert.ok(limited.body.fixes.every(row => row.error === 'unavailable'), 'team membership without GitHub credentials cannot disclose shared cache contents')
  await f.db.setUserTokens(bob.userId, { accessToken: 'bob-token', refreshToken: null, expiresAt: null })
  assert.equal((await f.send({ cookie: bobCookie })).body.fixes.find(row => row.url === link(1)).title, 'Fix 1', 'shared metadata is available after this viewer passes GitHub access checks')
  await f.db.setTeamMember('broad', bob.userId, { dependencies: true, security: true })
  const other = await f.send({ path: '/api/teams/broad/fixes', cookie: bob.setCookie.split(';')[0] })
  assert.equal(other.body.fixes.find(row => row.url === link(5)).title, cached.title, 'a currently authorized user shares existing cache records')
  await f.db.removeTeamMember('broad', bob.userId)
  assert.equal((await f.send({ path: '/api/teams/broad/fixes', cookie: bobCookie })).status, 404, 'revoked users cannot keep reading the shared cache')
})

test('shared metadata requires each team member\'s live GitHub access, including admins', async t => {
  for (const role of ['view', 'admin']) {
    await t.test(role, async child => {
      const calls = [], f = await workspaceFixture(child), permitted = new Set(['Bearer alice-token'])
      child.mock.method(globalThis, 'fetch', (url, options) => {
        calls.push({ url, authorization: options.headers.authorization })
        assert.equal(options.redirect, 'error')
        assert.ok(options.signal instanceof AbortSignal)
        if (repositoryRequest(url)) return permitted.has(options.headers.authorization) ? responseFor(url) : new Response(null, { status: 404 })
        assert.ok(permitted.has(options.headers.authorization), 'metadata must use a verified viewer\'s token')
        const number = Number(url.split('/').at(-1))
        return Response.json((url.includes('/issues/') ? issuePayload : payload)(number,
          { title: 'Private title', body: 'Private body', state: 'closed', merged: true, state_reason: 'completed' }))
      })
      assert.ok((await f.send()).body.fixes.every(row => row.title === 'Private title'))
      const cached = (await f.db.listGithubMetadata(['7:pull:1']))[0]
      const bob = await createSession(config, f.db, { githubUserId: 2, login: 'bob', name: null, avatarUrl: null }, Date.now())
      await f.db.setUserRole(bob.userId, role)
      await f.db.setTeamMember('team', bob.userId, { dependencies: false, security: false })
      const cookie = bob.setCookie.split(';')[0]
      calls.length = 0
      const missingCredentials = await f.send({ cookie })
      assert.ok(missingCredentials.body.fixes.length > 0)
      assert.ok(missingCredentials.body.fixes.every(row => row.error === 'unavailable'))
      assert.equal(calls.length, 0, 'another member\'s token must not be substituted')
      await f.db.setUserTokens(bob.userId, { accessToken: 'bob-token', refreshToken: null, expiresAt: null })
      const denied = await f.send({ cookie })
      assert.ok(denied.body.fixes.every(row => row.error === 'unavailable'))
      assert.ok(!JSON.stringify(denied.body).includes('Private'), 'cached titles and descriptions must not leak')
      assert.deepEqual(calls, [{ url: 'https://api.github.com/repos/ExampleOrg/ExampleRepo', authorization: 'Bearer bob-token' }])
      permitted.add('Bearer bob-token')
      const allowed = await f.send({ cookie })
      assert.equal(allowed.body.fixes.find(row => row.url === link(1)).description, 'Private body')
      assert.equal((await f.db.listGithubMetadata(['7:pull:1']))[0].fetchedAt, cached.fetchedAt, 'authorized readers reuse completed metadata')
      permitted.delete('Bearer bob-token')
      const revoked = await f.send({ cookie })
      assert.ok(revoked.body.fixes.every(row => row.error === 'unavailable'), 'revoked GitHub access cannot reuse the previous request\'s authorization')
      assert.deepEqual((await f.db.listGithubMetadata(['7:pull:1']))[0], cached, 'denied viewers do not evict the shared cache')
    })
  }
})

test('GitHub access is verified separately for each cached repository', async t => {
  const f = await workspaceFixture(t)
  const cached = { title: 'Private title', description: 'Private body', status: 'merged', fetchedAt: 1 }
  await f.db.setGithubMetadata([{ key: '7:pull:1', ...cached }, { key: '8:pull:1', ...cached }])
  const calls = []
  t.mock.method(globalThis, 'fetch', (url, options) => {
    calls.push(url)
    assert.equal(options.headers.authorization, 'Bearer alice-token')
    assert.ok(repositoryRequest(url), 'unverified repositories cannot trigger metadata reads')
    return url.endsWith('/OtherOrg/OtherRepo') ? responseFor(url) : new Response(null, { status: 403 })
  })
  const res = await f.send({ path: '/api/teams/broad/fixes' })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.fixes.filter(row => row.title), [{ url: 'https://github.com/OtherOrg/OtherRepo/pull/1',
    title: cached.title, description: cached.description, status: 'merged', stateReason: null }])
  assert.ok(res.body.fixes.filter(row => row.url !== 'https://github.com/OtherOrg/OtherRepo/pull/1').every(row => row.error === 'unavailable'))
  assert.deepEqual(calls.toSorted(), ['https://api.github.com/repos/ExampleOrg/ExampleRepo', 'https://api.github.com/repos/OtherOrg/OtherRepo'])
})

test('failed or untrusted GitHub repository checks cannot fall back to private cached metadata', async t => {
  const failures = [
    ...[401, 403, 404, 429, 503].map(status => [String(status), () => new Response(null, { status })]),
    ['redirect', () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.test' } })],
    ['network', () => { throw new Error('offline') }], ['malformed JSON', () => new Response('not JSON')],
    ['wrong repository ID', () => Response.json({ id: 8, full_name: 'ExampleOrg/ExampleRepo' })],
    ['wrong repository name', () => Response.json({ id: 7, full_name: 'OtherOrg/OtherRepo' })],
    ['missing identity', () => Response.json({})],
  ]
  for (const [label, fail] of failures) {
    await t.test(label, async child => {
      const f = await workspaceFixture(child)
      await f.db.setGithubMetadata(['7:pull:1', '7:pull:6', '7:issue:1'].map(key => ({ key,
        title: 'Private title', description: 'Private body', status: key.includes(':issue:') ? 'closed' : 'merged', stateReason: 'completed', fetchedAt: 1 })))
      const cacheRead = child.mock.method(f.db, 'listGithubMetadata')
      child.mock.method(globalThis, 'fetch', (url, options) => {
        assert.equal(url, 'https://api.github.com/repos/ExampleOrg/ExampleRepo')
        assert.equal(options.headers.authorization, 'Bearer alice-token')
        assert.equal(options.redirect, 'error')
        return fail()
      })
      const res = await f.send()
      assert.equal(res.status, 200)
      assert.ok(res.body.fixes.every(row => row.error === 'unavailable'))
      assert.ok(cacheRead.mock.calls.every(call => call.arguments[0].length === 0), 'denied repository cache keys are never read')
      assert.equal((await f.db.listGithubMetadata(['7:pull:1']))[0].description, 'Private body', 'failed authorization preserves the stored cache')
    })
  }
})

test('refreshed credentials still need live GitHub access to cached metadata', async t => {
  const f = await workspaceFixture(t)
  await f.db.setGithubMetadata([{ key: '7:pull:1', title: 'Private title', description: 'Private body', status: 'merged', fetchedAt: 1 }])
  await f.db.setUserTokens(f.session.userId, { accessToken: 'expired', refreshToken: 'refresh', expiresAt: 1 })
  const signals = []
  t.mock.method(globalThis, 'fetch', (url, options) => {
    signals.push(options.signal)
    if (url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'refreshed-user', expires_in: 3600 })
    assert.equal(url, 'https://api.github.com/repos/ExampleOrg/ExampleRepo')
    assert.equal(options.headers.authorization, 'Bearer refreshed-user')
    return new Response(null, { status: 403 })
  })
  assert.ok((await f.send()).body.fixes.every(row => row.error === 'unavailable'))
  assert.equal(signals.length, 2)
  assert.equal(signals[0], signals[1], 'token refresh and authorization share the same deadline')
})

test('a timed-out repository access check cannot release cached metadata or start refreshes', async t => {
  const f = await workspaceFixture(t)
  await f.db.setGithubMetadata([{ key: '7:pull:1', title: 'Private title', description: 'Private body', status: 'open', fetchedAt: 1 }])
  const controller = new AbortController()
  const timeout = t.mock.method(AbortSignal, 'timeout', ms => { assert.equal(ms, 10_000); return controller.signal })
  const upstream = t.mock.method(globalThis, 'fetch', (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/ExampleOrg/ExampleRepo')
    setImmediate(() => controller.abort(new DOMException('Deadline reached', 'TimeoutError')))
    return new Promise((resolve, reject) => { options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }) })
  })
  assert.ok((await f.send()).body.fixes.every(row => row.error === 'unavailable'))
  assert.equal(timeout.mock.callCount(), 1)
  assert.equal(upstream.mock.callCount(), 1)
  const cached = (await f.db.listGithubMetadata(['7:pull:1']))[0]
  assert.equal(cached.fetchedAt, 1)
  assert.equal(cached.attemptedAt, null, 'an authorization failure is not a metadata refresh attempt')
})

test('repository authorization checks have a request cap and bounded concurrency even with a populated cache', async () => {
  const repositories = Array.from({ length: 205 }, (_, i) => ({ repoId: i + 1, github: `Org/Repo${i + 1}`, path: null }))
  const urls = repositories.map(repo => `https://github.com/${repo.github}/pull/1`)
  const db = {
    getUserTokens: () => Promise.resolve({ accessToken: 'viewer-token', refreshToken: null, expiresAt: null }),
    listGithubMetadata: keys => Promise.resolve(keys.map(key => ({ key, title: 'Cached', description: 'Private body', status: 'merged', stateReason: null, fetchedAt: 1, attemptedAt: null }))),
  }
  let active = 0, calls = 0, maximum = 0
  const results = await lookupFixes(config, db, { user: { id: 'viewer' }, repositories }, urls, async (url, options) => {
    assert.equal(options.headers.authorization, 'Bearer viewer-token')
    assert.equal(options.redirect, 'error')
    calls++
    maximum = Math.max(maximum, ++active)
    await new Promise(resolve => { setImmediate(resolve) })
    active--
    const fullName = url.split('/repos/')[1]
    return Response.json({ id: Number(fullName.split('Repo')[1]), full_name: fullName })
  })
  assert.equal(calls, 200)
  assert.equal(maximum, 4)
  assert.equal(results.length, 205)
  assert.ok(results.slice(0, 200).every(row => row.description === 'Private body'))
  assert.ok(results.slice(200).every(row => row.error === 'unavailable'), 'cache hits beyond the access-check budget are not authorized')
})

test('issue metadata preserves descriptions, refreshes open issues and rejects wrong identities or PR issue aliases', async t => {
  const f = await fixture(t)
  const url = 'https://github.com/ExampleOrg/ExampleRepo/issues/1'
  await f.db.setGithubMetadata([{ key: '7:issue:1', title: 'Old issue', description: 'Old description', status: 'open', fetchedAt: 1 }])
  for (const body of [issuePayload(99), issuePayload(1, { repository_url: 'https://api.github.com/repos/Other/Repo' }),
    issuePayload(1, { pull_request: {} }), issuePayload(1, { body: {} })]) {
    assert.equal((await f.lookup([url], () => Response.json(body)))[0].title, 'Old issue')
  }
  const result = await f.lookup([url], () => Response.json(issuePayload(1, { state: 'closed', body: 'Resolved issue description' })))
  assert.equal(result[0].status, 'closed')
  assert.equal(result[0].description, 'Resolved issue description')
  assert.equal((await f.db.listGithubMetadata(['7:issue:1']))[0].description, 'Resolved issue description')
})

test('issue closure reasons survive the API and cache; unknown reasons never imply completion', async t => {
  const f = await fixture(t)
  const reasons = ['completed', 'not_planned', 'duplicate', null, undefined, 'reopened', 'future_reason', {}]
  const urls = reasons.map((_, i) => `https://github.com/ExampleOrg/ExampleRepo/issues/${i + 1}`)
  const results = await f.lookup(urls, url => {
    const number = Number(url.split('/').at(-1))
    return Response.json(issuePayload(number, { state: 'closed', state_reason: reasons[number - 1] }))
  })
  assert.deepEqual(results.map(row => row.stateReason), ['completed', 'not_planned', 'duplicate', ...Array.from({ length: 5 }, () => 'unknown')])
  assert.deepEqual(await f.lookup(urls, () => assert.fail('a successfully checked closed issue is permanent')), results)
  const [open, pull] = await f.lookup(['https://github.com/ExampleOrg/ExampleRepo/issues/99', link(99)], url =>
    Response.json((url.includes('/issues/') ? issuePayload : payload)(99, { state_reason: 'completed' })))
  assert.equal(open.stateReason, null, 'open/reopened issues cannot carry a stale completed reason')
  assert.equal(pull.stateReason, null, 'PR state is based on merged/state/draft, never issue closure reasons')
})

test('legacy closed issues backfill within the authorized 200-item queue and retain cached data on failure', async t => {
  const f = await fixture(t)
  const urls = Array.from({ length: 201 }, (_, i) => `https://github.com/ExampleOrg/ExampleRepo/issues/${i + 1}`)
  await f.db.setGithubMetadata(urls.map((_, i) => ({ key: `7:issue:${i + 1}`, title: 'Legacy', description: 'Cached body', status: 'closed', stateReason: null, fetchedAt: i + 1 })))
  const calls = []
  const failed = await f.lookup([link(999), ...urls], url => {
    calls.push(url)
    return new Response(null, { status: 503 })
  })
  assert.equal(calls.length, 200)
  assert.ok(calls[0].endsWith('/pulls/999'), 'missing entries still take priority over legacy cached issues')
  assert.ok(calls.at(-1).endsWith('/issues/199'), 'older cached issues are backfilled first')
  assert.ok(failed.slice(1).every(row => row.title === 'Legacy' && row.stateReason === null), 'failures and the cap preserve existing metadata')
  let refreshed = 0
  const refresh = url => {
    refreshed++
    const number = Number(url.split('/').at(-1))
    return Response.json(issuePayload(number, { state: 'closed', state_reason: number === 1 ? 'duplicate' : null }))
  }
  const first = await f.lookup(urls, refresh)
  assert.equal(refreshed, 200)
  assert.equal(first[0].stateReason, 'duplicate')
  assert.equal(first[199].stateReason, 'unknown')
  assert.equal(first[200].stateReason, 'unknown', 'issues skipped by the failed first batch get priority')
  assert.equal(first[198].stateReason, null, 'the newest failed attempt waits when the cap is full')
  await f.lookup(urls, refresh)
  assert.equal(refreshed, 201, 'only the remaining legacy entry is fetched on the next request')
  await f.lookup(urls, () => assert.fail('even unknown reasons finish backfill'))
  await f.db.setGithubMetadata([{ key: '8:issue:1', title: 'Private legacy issue', description: 'Secret', status: 'closed', stateReason: null, fetchedAt: 1 }])
  assert.deepEqual(await f.lookup(['https://github.com/OtherOrg/OtherRepo/issues/1'], () => assert.fail('unrelated repositories cannot trigger backfill')), [])
})

test('failed legacy backfills rotate behind later issues and stale open/draft fixes', async t => {
  const f = await fixture(t)
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const urls = Array.from({ length: 201 }, (_, i) => `https://github.com/ExampleOrg/ExampleRepo/issues/${i + 1}`)
  const legacy = urls.map((_, i) => ({ key: `7:issue:${i + 1}`, title: 'Legacy', description: 'Cached body', status: 'closed', stateReason: null, fetchedAt: i + 1 }))
  await f.db.setGithubMetadata([...legacy,
    { key: '7:pull:202', title: 'Old open', description: null, status: 'open', fetchedAt: 202 },
    { key: '7:pull:203', title: 'Old draft', description: null, status: 'draft', fetchedAt: 203 },
  ])
  const all = [...urls, link(202), link(203)]
  const first = await f.lookup(all, () => new Response(null, { status: 404 }))
  assert.ok(first.slice(0, 201).every(row => row.title === 'Legacy' && row.stateReason === null))
  const pending = await f.db.listGithubMetadata(['7:issue:200', '7:issue:201', '7:pull:202'])
  assert.equal(pending.find(row => row.key === '7:issue:200').attemptedAt, now)
  assert.ok(pending.filter(row => row.key !== '7:issue:200').every(row => row.attemptedAt === null), 'the queue cap does not mark unattempted entries')
  now += 60_000
  const calls = []
  const second = await f.lookup(all, url => {
    calls.push(url)
    const number = Number(url.split('/').at(-1))
    if (number <= 200) return new Response(null, { status: 404 })
    return Response.json(number === 201 ? issuePayload(number, { state: 'closed', state_reason: 'completed' })
      : payload(number, { state: 'closed', merged: true }))
  })
  assert.equal(calls.length, 200)
  assert.deepEqual(calls.slice(0, 3).map(url => Number(url.split('/').at(-1))), [201, 202, 203], 'previous failures cannot take every slot again')
  assert.equal(second[200].stateReason, 'completed')
  assert.deepEqual(second.slice(201).map(row => row.status), ['merged', 'merged'])
  assert.ok(second.slice(0, 200).every(row => row.title === 'Legacy' && row.stateReason === null))
  assert.equal((await f.db.listGithubMetadata(['7:issue:1']))[0].fetchedAt, 1, 'failed attempts do not freshen the successful cache read')
})

test('missing credentials and the shared deadline do not rotate cached jobs that never start', async t => {
  const f = await fixture(t)
  const entries = Array.from({ length: 8 }, (_, i) => ({ key: `7:pull:${i + 1}`, title: 'Cached', description: null, status: 'open', fetchedAt: 1 }))
  await f.db.setGithubMetadata(entries)
  await f.db.setUserTokens(f.session.userId, { accessToken: 'expired', refreshToken: null, expiresAt: 1 })
  await f.lookup(entries.map((_, i) => link(i + 1)), () => assert.fail('no token, no attempts'))
  assert.ok((await f.db.listGithubMetadata(entries.map(row => row.key))).every(row => row.attemptedAt === null))
  await f.db.setUserTokens(f.session.userId, { accessToken: 'valid', refreshToken: null, expiresAt: null })
  const controller = new AbortController()
  t.mock.method(AbortSignal, 'timeout', () => controller.signal)
  let calls = 0
  await f.lookup(entries.map((_, i) => link(i + 1)), () => {
    calls++
    controller.abort()
    return new Response(null, { status: 404 })
  })
  assert.equal(calls, 1)
  const attempted = await f.db.listGithubMetadata(entries.map(row => row.key))
  assert.ok(attempted.find(row => row.key === '7:pull:1').attemptedAt > 1)
  assert.ok(attempted.filter(row => row.key !== '7:pull:1').every(row => row.attemptedAt === null))
  assert.ok(attempted.every(row => row.fetchedAt === 1 && row.title === 'Cached'))
})

for (const change of ['membership', 'repo', 'security']) {
  test(`a shared cache hit is discarded if ${change} changes while cached metadata is read`, async t => {
    const f = await workspaceFixture(t)
    await f.db.setTeamMember('team', f.session.userId, { dependencies: true, security: true })
    t.mock.method(globalThis, 'fetch', responseFor)
    assert.equal((await f.send()).status, 200)
    const list = f.db.listGithubMetadata
    t.mock.method(f.db, 'listGithubMetadata', async keys => {
      const entries = await list(keys)
      if (change === 'membership') await f.db.removeTeamMember('team', f.session.userId)
      if (change === 'repo') await f.db.removeTeamRepo('team', 7)
      if (change === 'security') await f.db.setTeamMember('team', f.session.userId, { dependencies: true, security: false })
      return entries
    })
    t.mock.method(globalThis, 'fetch', withRepositoryAccess(() => assert.fail('a fresh cache hit must not refresh metadata')))
    const response = await f.send()
    assert.equal(response.status, 404)
    assert.equal(response.body.fixes, undefined)
  })
}
