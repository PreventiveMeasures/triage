import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { createSession } from '../server-managed/session.ts'

const config = { sessionCookieName: 'sid', cookieSecure: false, sessionTtlMs: 60_000 }
const repo = { repoId: 1, fullName: 'org/repo', private: false, installationId: null, defaultBranch: 'main', htmlUrl: '', addedBy: null }
const publicMetadata = { id: 1, full_name: 'org/repo', private: false, visibility: 'public', default_branch: 'main' }
const userTokens = { accessToken: 'login-token', refreshToken: null, expiresAt: null }

// GitHub, as the reader and the list read it: `asked` the GraphQL queries made.
function github(t, graphql) {
  const asked = []
  t.mock.method(globalThis, 'fetch', (input, options = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    if (url.pathname === '/repos/org/repo') return Promise.resolve(Response.json(publicMetadata))
    if (url.pathname === '/graphql') {
      const body = JSON.parse(options.body)
      asked.push({ ...body, auth: options.headers?.authorization ?? null })
      return Promise.resolve(Response.json(graphql(body)))
    }
    return Promise.resolve(Response.json({ message: 'Not Found' }, { status: 404 }))
  })
  return asked
}

async function fixture(t, { role = 'admin', tokens = userTokens } = {}) {
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
    await handler({ method, url: `/api/admin/repositories/issues?${new URLSearchParams(query)}`, headers: { cookie: session.setCookie.split(';')[0] } }, res)
    return { status: res.status, body: JSON.parse(res.body) }
  }
}

const page = (nodes, { hasNextPage = false, endCursor = null, open = 3, closed = 40 } = {}) => ({ data: { repository: {
  open: { totalCount: open }, closed: { totalCount: closed }, page: { pageInfo: { hasNextPage, endCursor }, nodes },
} } })
const labels = (...names) => ({ totalCount: names.length + 1, nodes: names.map(name => ({ name, color: 'D73A4A' })) })

test('issues read a page of those open, the most recently updated first, each as a tile shows it, with how many are open and closed', async t => {
  const request = await fixture(t)
  const asked = github(t, () => page([
    { number: 12, title: 'Treemap labels overlap', state: 'OPEN', stateReason: null, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', closedAt: null,
      author: { login: 'octo' }, comments: { totalCount: 4 }, labels: labels('bug', 'ui') },
    { number: 9, title: 'Wontfix', state: 'CLOSED', stateReason: 'NOT_PLANNED', createdAt: null, updatedAt: null, closedAt: '2026-10-03T00:00:00Z',
      author: null, comments: { totalCount: 0 }, labels: { totalCount: 0, nodes: [{ name: ' ', color: 'zzz' }] } },
    { number: 'x', title: 'not an issue' }, null,
  ], { hasNextPage: true, endCursor: 'Y3Vyc29yOjEy' }))
  const { status, body } = await request({ repoId: '1', kind: 'issues' })
  assert.equal(status, 200)
  assert.deepEqual(body, {
    kind: 'issues', state: 'open', counts: { open: 3, closed: 40 }, more: true, after: 'Y3Vyc29yOjEy',
    items: [
      { number: 12, title: 'Treemap labels overlap', author: 'octo', createdAt: Date.parse('2026-10-01T00:00:00Z'), updatedAt: Date.parse('2026-10-02T00:00:00Z'), closedAt: null,
        comments: 4, labels: [{ name: 'bug', color: 'd73a4a' }, { name: 'ui', color: 'd73a4a' }], moreLabels: 1, state: 'open', reason: null },
      { number: 9, title: 'Wontfix', author: null, createdAt: null, updatedAt: null, closedAt: Date.parse('2026-10-03T00:00:00Z'), comments: 0, labels: [], moreLabels: 0,
        state: 'closed', reason: 'not-planned' },
    ],
  })
  assert.equal(asked[0].auth, 'Bearer login-token')
  assert.deepEqual(asked[0].variables, { owner: 'org', name: 'repo', after: null })
  assert.match(asked[0].query, /page: issues\(states: \[OPEN\], first: 50, after: \$after, orderBy: \{ field: UPDATED_AT, direction: DESC \}\)/u)
  // Closed, on from a cursor.
  await request({ repoId: '1', kind: 'issues', state: 'closed', after: 'Y3Vyc29yOjEy' })
  assert.deepEqual(asked[1].variables, { owner: 'org', name: 'repo', after: 'Y3Vyc29yOjEy' })
  assert.match(asked[1].query, /page: issues\(states: \[CLOSED\]/u)
})

test('pull requests name their branches, size, review and checks, a merged one apart from one closed, and those closed include those merged', async t => {
  const request = await fixture(t)
  const pull = (number, more) => ({ number, title: `Pull ${number}`, createdAt: null, updatedAt: null, closedAt: null, mergedAt: null, author: { login: 'dependabot' },
    comments: { totalCount: 1 }, labels: labels(), isDraft: false, additions: 12, deletions: 3, headRefName: 'feature/x', baseRefName: 'main', ...more })
  const asked = github(t, () => page([
    pull(5, { state: 'OPEN', isDraft: true, reviewDecision: 'CHANGES_REQUESTED', commits: { nodes: [{ commit: { statusCheckRollup: { state: 'ERROR' } } }] } }),
    pull(4, { state: 'MERGED', mergedAt: '2026-10-04T00:00:00Z', reviewDecision: 'APPROVED', commits: { nodes: [{ commit: { statusCheckRollup: null } }] } }),
    pull(3, { state: 'CLOSED', reviewDecision: null, commits: { nodes: [] } }),
  ], { hasNextPage: true, endCursor: 'not a cursor!' }))
  const { body } = await request({ repoId: '1', kind: 'pulls', state: 'closed' })
  assert.deepEqual(body.items.map(({ number, state, draft, review, checks, mergedAt, head, base, additions, deletions }) =>
    [number, state, draft, review, checks, mergedAt, head, base, additions, deletions]), [
    [5, 'open', true, 'changes', 'failure', null, 'feature/x', 'main', 12, 3],
    [4, 'merged', false, 'approved', null, Date.parse('2026-10-04T00:00:00Z'), 'feature/x', 'main', 12, 3],
    [3, 'closed', false, null, null, null, 'feature/x', 'main', 12, 3],
  ])
  assert.deepEqual([body.more, body.after], [false, null], 'a cursor that isn\'t one reads nothing on')
  assert.match(asked[0].query, /closed: pullRequests\(states: \[CLOSED, MERGED\]\) \{ totalCount \}/u)
  assert.match(asked[0].query, /page: pullRequests\(states: \[CLOSED, MERGED\], first: 50/u)
})

test('issues are read only with a token, by a reader whose grants reach the whole repository, and of a repository GitHub has', async t => {
  github(t, () => ({ data: { repository: null } }))
  assert.deepEqual(await (await fixture(t, { tokens: null }))({ repoId: '1', kind: 'issues' }), { status: 403, body: { error: 'github-token-required' } })
  assert.deepEqual(await (await fixture(t, { role: 'manage' }))({ repoId: '1', kind: 'pulls' }), { status: 404, body: { error: 'no-directory' } })
  assert.deepEqual(await (await fixture(t))({ repoId: '2', kind: 'pulls' }), { status: 404, body: { error: 'no-repository' } })
  assert.deepEqual(await (await fixture(t))({ repoId: '1', kind: 'pulls' }), { status: 404, body: { error: 'github-not-found' } })
})

test('a GitHub App refused a pull request\'s checks lists it without them; refused the list, it says so', async t => {
  const refused = path => ({ type: 'FORBIDDEN', path, message: 'Resource not accessible by integration' })
  let errors = [refused(['repository', 'page', 'nodes', 0, 'commits', 'nodes', 0, 'commit', 'statusCheckRollup'])]
  github(t, () => ({ ...page([{ number: 2, title: 'Pull', state: 'OPEN', isDraft: false, labels: labels(), commits: { nodes: [{ commit: { statusCheckRollup: null } }] } }]), errors }))
  const request = await fixture(t)
  const listed = await request({ repoId: '1', kind: 'pulls' })
  assert.equal(listed.status, 200)
  assert.deepEqual(listed.body.items.map(item => [item.number, item.checks]), [[2, null]])
  errors = [refused(['repository', 'page'])]
  assert.deepEqual(await request({ repoId: '1', kind: 'pulls' }), { status: 502, body: { error: 'github-status-403' } })
})

test('a list that names no kind or state, or a cursor that isn\'t one, is a bad request', async t => {
  const request = await fixture(t)
  github(t, () => page([]))
  for (const query of [{ repoId: '1' }, { repoId: '1', kind: 'commits' }, { repoId: '0', kind: 'issues' }, { repoId: '1', kind: 'issues', state: 'all' },
    { repoId: '1', kind: 'issues', after: '' }, { repoId: '1', kind: 'issues', after: 'a b' }, { repoId: '1', kind: 'issues', after: 'a'.repeat(257) }]) {
    assert.equal((await request(query)).status, 400, JSON.stringify(query))
  }
  assert.equal((await request({ repoId: '1', kind: 'issues' }, { method: 'POST' })).status, 405)
})
