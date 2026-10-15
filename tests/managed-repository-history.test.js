import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { createSession } from '../server-managed/session.ts'

const config = { sessionCookieName: 'sid', cookieSecure: false, sessionTtlMs: 60_000 }
const repo = { repoId: 1, fullName: 'org/repo', private: false, installationId: null, defaultBranch: 'main', htmlUrl: '', addedBy: null }
const publicMetadata = { id: 1, full_name: 'org/repo', private: false, visibility: 'public', default_branch: 'main' }
const userTokens = { accessToken: 'login-token', refreshToken: null, expiresAt: null }
const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(char => char.repeat(40))

// A REST list-commits item, as GitHub answers one.
const restCommit = (sha, parents, message, login = 'octo') => ({
  sha, parents: parents.map(parent => ({ sha: parent })), author: login ? { login } : null,
  commit: { message, author: { name: `${login ?? 'someone'} name`, date: '2026-10-01T00:00:00Z' }, committer: { date: '2026-10-02T10:00:00Z' } },
})

// GitHub, as the reader and the history read it: `asked` the requests made.
function github(t, { graphql = null } = {}) {
  const asked = []
  t.mock.method(globalThis, 'fetch', (input, options = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    asked.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), method: options.method ?? 'GET', auth: options.headers?.authorization ?? null,
      body: options.body ? JSON.parse(options.body) : null })
    const path = url.pathname
    if (path === '/repos/org/repo') return Promise.resolve(Response.json(publicMetadata))
    if (path === '/repos/org/repo/commits/heads%2Fmain') return Promise.resolve(Response.json({ sha: a }))
    if (path === '/repos/org/repo/commits') {
      return Promise.resolve(Response.json([restCommit(a, [b, c], 'Merge feature\n\nLonger body'), restCommit(b, [d], 'Main work', null), restCommit('short', [], 'not a commit')]))
    }
    if (path === '/repos/org/repo/branches') return Promise.resolve(Response.json([{ name: 'main', commit: { sha: a } }, { name: 'feature', commit: { sha: c } }, { name: 'odd', commit: {} }]))
    if (path === '/repos/org/repo/tags') return Promise.resolve(Response.json([{ name: 'v1', commit: { sha: d } }]))
    if (path === '/graphql' && graphql) return Promise.resolve(Response.json(graphql))
    return Promise.resolve(Response.json({ message: 'Not Found' }, { status: 404 }))
  })
  return asked
}

async function fixture(t, { role = 'admin', tokens = null } = {}) {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const session = await createSession(config, db, { githubUserId: 1, login: 'manager', name: null, avatarUrl: null }, Date.now())
  await db.setUserRole(session.userId, role)
  await db.selectRepo(repo, Date.now())
  if (tokens) await db.setUserTokens(session.userId, tokens)
  await db.createTeam('team', 'Team', Date.now())
  await db.setTeamRepo('team', 1, 'src/allowed')
  await db.setTeamMember('team', session.userId, { dependencies: true, security: true })
  const handler = createManagedRequestHandler({ config, db, originGate: { isOriginAllowed: () => true }, isShuttingDown: () => false, track() {} })
  return async (query, { method = 'GET' } = {}) => {
    const res = { status: 0, body: '', headers: {}, writeHead(status, headers) { this.status = status; this.headers = headers }, end(body) { this.body = body } }
    await handler({ method, url: `/api/admin/repositories/history?${new URLSearchParams(query)}`, headers: { cookie: session.setCookie.split(';')[0] } }, res)
    return { status: res.status, body: JSON.parse(res.body) }
  }
}

test('a revision\'s history reads a page of its commits, each with its parents, subject, author and time, and the branches and tags naming commits', async t => {
  const request = await fixture(t)
  const asked = github(t)
  const { status, body } = await request({ repoId: '1', ref: 'heads/main' })
  assert.equal(status, 200)
  assert.deepEqual(body, {
    commit: a, path: '', page: 1, more: false,
    commits: [
      { sha: a, parents: [b, c], subject: 'Merge feature', authorName: 'octo name', authorLogin: 'octo', committedAt: Date.parse('2026-10-02T10:00:00Z') },
      { sha: b, parents: [d], subject: 'Main work', authorName: 'someone name', authorLogin: null, committedAt: Date.parse('2026-10-02T10:00:00Z') },
    ],
    branches: [{ name: 'main', sha: a }, { name: 'feature', sha: c }], tags: [{ name: 'v1', sha: d }],
  })
  assert.deepEqual(asked.find(entry => entry.path === '/repos/org/repo/commits').query, { sha: a, per_page: '100', page: '1' })
  // A later page has no branches and tags to read again.
  const later = await request({ repoId: '1', ref: a, page: '2' })
  assert.equal(later.body.page, 2)
  assert.equal(later.body.branches, undefined)
  assert.deepEqual(asked.findLast(entry => entry.path === '/repos/org/repo/commits').query, { sha: a, per_page: '100', page: '2' })
})

test('a directory\'s history lists the commits touching it, read only where the reader\'s grants reach all of it', async t => {
  const manager = await fixture(t, { role: 'manage' })
  const asked = github(t)
  assert.equal((await manager({ repoId: '1', ref: a, path: 'src/allowed' })).status, 200)
  assert.deepEqual(asked.find(entry => entry.path === '/repos/org/repo/commits').query, { sha: a, per_page: '100', page: '1', path: 'src/allowed' })
  for (const path of ['', 'src', 'src/other']) assert.deepEqual((await manager({ repoId: '1', ref: a, path })).body, { error: 'no-directory' }, path)
})

test('all branches read at once, each commit once, an annotated tag by the commit it tags, and with a token alone', async t => {
  const graphql = { data: { repository: {
    defaultBranchRef: { name: 'main' },
    branches: { totalCount: 2, nodes: [
      { name: 'main', target: { oid: a, history: { pageInfo: { hasNextPage: false }, nodes: [
        { oid: a, messageHeadline: 'Merge feature', committedDate: '2026-10-02T10:00:00Z', author: { name: 'Octo', user: { login: 'octo' } }, parents: { nodes: [{ oid: b }, { oid: c }] } },
        { oid: b, messageHeadline: 'Main work', committedDate: '2026-10-01T10:00:00Z', author: { name: 'Octo', user: null }, parents: { nodes: [{ oid: d }] } },
      ] } } },
      { name: 'feature', target: { oid: c, history: { pageInfo: { hasNextPage: true }, nodes: [
        { oid: c, messageHeadline: 'Feature', committedDate: '2026-10-01T12:00:00Z', author: null, parents: { nodes: [{ oid: d }] } },
        { oid: d, messageHeadline: 'Root', committedDate: '2026-09-30T10:00:00Z', author: null, parents: { nodes: [] } },
      ] } } },
    ] },
    tags: { nodes: [{ name: 'v1', target: { oid: 'e'.repeat(40), target: { oid: d } } }, { name: 'light', target: { oid: c } }] },
  } } }
  const request = await fixture(t, { tokens: userTokens })
  const asked = github(t, { graphql })
  const { status, body } = await request({ repoId: '1', all: 'true' })
  assert.equal(status, 200)
  assert.deepEqual(body.commits.map(commit => commit.sha), [a, b, c, d])
  assert.deepEqual(body.branches, [{ name: 'main', sha: a }, { name: 'feature', sha: c }])
  assert.deepEqual(body.tags, [{ name: 'v1', sha: d }, { name: 'light', sha: c }])
  assert.equal(body.defaultBranch, 'main')
  assert.equal(body.more, true, 'a branch with older commits leaves some out')
  const query = asked.find(entry => entry.path === '/graphql')
  assert.equal(query.method, 'POST')
  assert.equal(query.auth, 'Bearer login-token')
  assert.deepEqual(query.body.variables, { owner: 'org', name: 'repo', branches: 25, depth: 100, tags: 100 })

  const anonymous = await fixture(t)
  assert.deepEqual(await anonymous({ repoId: '1', all: 'true' }), { status: 403, body: { error: 'github-token-required' } })
})

test('a history that names no page, or all branches of a directory, is a bad request', async t => {
  const request = await fixture(t)
  github(t)
  for (const query of [{ repoId: '1', page: '0' }, { repoId: '1', page: '1.5' }, { repoId: '1', page: '101' }, { repoId: '1', all: 'true', path: 'src' },
    { repoId: '1', all: 'true', page: '2' }]) {
    assert.equal((await request(query)).status, 400, JSON.stringify(query))
  }
  assert.equal((await request({ repoId: '1' }, { method: 'POST' })).status, 405)
})
