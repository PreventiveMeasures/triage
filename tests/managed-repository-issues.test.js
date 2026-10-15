import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { createSession } from '../server-managed/session.ts'

const baseConfig = { sessionCookieName: 'sid', cookieSecure: false, sessionTtlMs: 2 * 24 * 60 * 60_000 }
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
      return Promise.resolve(graphql(body)).then(data => Response.json(data))
    }
    return Promise.resolve(Response.json({ message: 'Not Found' }, { status: 404 }))
  })
  return asked
}

// The endpoint over a database of its own: `tracked` what it reads behind its
// answers, on a deployment `serverless` or not.
async function fixture(t, { role = 'admin', tokens = userTokens, serverless = false, tracked = [] } = {}) {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const config = { ...baseConfig, serverless }
  const session = await createSession(config, db, { githubUserId: 1, login: 'manager', name: null, avatarUrl: null }, Date.now())
  await db.setUserRole(session.userId, role)
  await db.selectRepo(repo, Date.now())
  if (tokens) await db.setUserTokens(session.userId, tokens)
  await db.createTeam('team', 'Team', Date.now())
  await db.setTeamRepo('team', 1, 'src/allowed')
  await db.setTeamMember('team', session.userId, { dependencies: true, security: true })
  const handler = createManagedRequestHandler({ config, db, originGate: { isOriginAllowed: () => true }, isShuttingDown: () => false, track(work) { tracked.push(work) } })
  return async (query, { method = 'GET', path = 'issues' } = {}) => {
    const res = { status: 0, body: '', headers: {}, writeHead(status, headers) { this.status = status; this.headers = headers }, end(body) { this.body = body } }
    await handler({ method, url: `/api/admin/repositories/${path}?${new URLSearchParams(query)}`, headers: { cookie: session.setCookie.split(';')[0] } }, res)
    return { status: res.status, body: JSON.parse(res.body) }
  }
}

// A cursor as GitHub gives one, base64url.
const cursor = 'Y3Vyc29yOnYyOpK0MjAyNi0xMC0xNVQwODozNToxN1rOrK_u7Q=='
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
  ], { hasNextPage: true, endCursor: cursor }))
  const { status, body } = await request({ repoId: '1', kind: 'issues' })
  assert.equal(status, 200)
  assert.deepEqual(body, {
    kind: 'issues', state: 'open', counts: { open: 3, closed: 40 }, more: true, after: cursor,
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
  await request({ repoId: '1', kind: 'issues', state: 'closed', after: cursor })
  assert.deepEqual(asked[1].variables, { owner: 'org', name: 'repo', after: cursor })
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
  const listed = await (await fixture(t))({ repoId: '1', kind: 'pulls' })
  assert.equal(listed.status, 200)
  assert.deepEqual(listed.body.items.map(item => [item.number, item.checks]), [[2, null]])
  errors = [refused(['repository', 'page'])]
  assert.deepEqual(await (await fixture(t))({ repoId: '1', kind: 'pulls' }), { status: 502, body: { error: 'github-status-403' } })
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

test('a page read is kept for every reader: answered as kept a while, then at once as it is read again behind it; serverless, read again first', async t => {
  let title = 'Kept'
  // GitHub's answers, held till released where `held` is.
  let held = null
  const asked = github(t, () => {
    const listed = page([{ number: 2, title, state: 'OPEN', stateReason: null, createdAt: null, updatedAt: null, closedAt: null, author: null,
      comments: { totalCount: 0 }, labels: labels() }])
    return held ? held.promise.then(() => listed) : listed
  })
  const tracked = []
  const request = await fixture(t, { tracked })
  const titled = async query => (await request(query)).body.items[0].title
  assert.equal(await titled({ repoId: '1', kind: 'issues' }), 'Kept')
  title = 'Changed'
  assert.equal(await titled({ repoId: '1', kind: 'issues' }), 'Kept', 'a minute on, as kept')
  assert.equal(asked.length, 1)
  assert.equal(await titled({ repoId: '1', kind: 'issues', state: 'closed' }), 'Changed', 'another list, its own')
  // Past two minutes: the kept answer at once, read again behind it, once.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 3 * 60_000 })
  held = Promise.withResolvers()
  assert.deepEqual([await titled({ repoId: '1', kind: 'issues' }), await titled({ repoId: '1', kind: 'issues' })], ['Kept', 'Kept'])
  assert.equal(asked.length, 3, 'read again once while it is read')
  held.resolve()
  held = null
  await Promise.all(tracked)
  assert.equal(await titled({ repoId: '1', kind: 'issues' }), 'Changed', 'the next to ask has what was read behind it')
  // A day on, kept but not yet removed, it is read again before it is answered.
  title = 'A day on'
  t.mock.timers.setTime(Date.now() + 24 * 60 * 60_000 + 60_000)
  assert.equal(await titled({ repoId: '1', kind: 'issues' }), 'A day on')
  // Serverless, where nothing outlives an answer: read again before it.
  const first = await fixture(t, { serverless: true, tracked })
  title = 'Before'
  await first({ repoId: '1', kind: 'pulls' })
  title = 'After'
  t.mock.timers.setTime(Date.now() + 3 * 60_000)
  assert.equal((await first({ repoId: '1', kind: 'pulls' })).body.items[0].title, 'After')
})

test('an item is one issue or pull request as its popup shows it: as its tile, with its description\'s Markdown and what it closes or what closes it', async t => {
  const common = { createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', closedAt: '2026-10-02T00:00:00Z', comments: { totalCount: 2 }, labels: labels('bug') }
  const items = {
    7: { __typename: 'PullRequest', ...common, number: 7, title: 'Fix the chips', pullState: 'MERGED', isDraft: false, mergedAt: '2026-10-02T00:00:00Z', reviewDecision: 'APPROVED',
      additions: 30, deletions: 4, headRefName: 'claude/fix-chips', baseRefName: 'main', body: '\n \n    npm test\n\nFixes #3.\n\nhttps://claude.ai/code/session_X  \n', changedFiles: 2,
      commits: { totalCount: 4, nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] }, mergedBy: { login: 'ada' }, author: { login: 'grace' },
      closingIssuesReferences: { nodes: [{ number: 3, title: 'Chips unreadable', issueState: 'CLOSED', stateReason: 'COMPLETED' }, null] } },
    3: { __typename: 'Issue', ...common, number: 3, title: 'Chips unreadable', issueState: 'CLOSED', stateReason: 'COMPLETED', body: 'x'.repeat(30_000), author: null,
      closedByPullRequestsReferences: { totalCount: 12, nodes: [{ number: 7, title: 'Fix the chips', pullState: 'MERGED', isDraft: false }, { number: 'x' }] } },
  }
  const asked = github(t, ({ variables }) => ({ data: { repository: { item: items[variables.number] ?? null } } }))
  const request = await fixture(t)
  const item = number => request({ repoId: '1', number }, { path: 'item' })
  const pull = await item('7')
  assert.equal(pull.status, 200)
  assert.deepEqual(pull.body, { kind: 'pulls', number: 7, title: 'Fix the chips', author: 'grace', createdAt: Date.parse(common.createdAt), updatedAt: Date.parse(common.updatedAt),
    closedAt: Date.parse(common.closedAt), comments: 2, labels: [{ name: 'bug', color: 'd73a4a' }], moreLabels: 1, state: 'merged', draft: false,
    mergedAt: Date.parse('2026-10-02T00:00:00Z'), review: 'approved', checks: 'success', additions: 30, deletions: 4, head: 'claude/fix-chips', base: 'main',
    body: '    npm test\n\nFixes #3.\n\nhttps://claude.ai/code/session_X', bodyShortened: false, moreLinked: 0, closes: [{ number: 3, title: 'Chips unreadable', state: 'closed', reason: 'completed' }],
    commits: 4, files: 2, mergedBy: 'ada' })
  const issue = await item('3')
  // A description too long shortened, and the linked past those named counted, each said so.
  assert.deepEqual([issue.body.kind, issue.body.state, issue.body.reason, issue.body.body.length, issue.body.bodyShortened, issue.body.closedBy, issue.body.moreLinked],
    ['issues', 'closed', 'completed', 20_000, true, [{ number: 7, title: 'Fix the chips', state: 'merged', draft: false }], 11])
  assert.deepEqual(asked[0].variables, { owner: 'org', name: 'repo', number: 7 })
  // Each type's state named apart, as GitHub's GraphQL requires of an issue's and a pull request's.
  assert.match(asked[0].query, /issueState: state[^]*pullState: state/u)
  assert.deepEqual(await item('9'), { status: 404, body: { error: 'github-not-found' } })
  for (const number of ['0', '-1', '1.5', 'x', '', '2147483648']) assert.equal((await item(number)).status, 400, number)
})
