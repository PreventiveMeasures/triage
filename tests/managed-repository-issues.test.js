import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
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
async function fixture(t, { role = 'admin', tokens = userTokens, serverless = false, tracked = [], retained = null } = {}) {
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
  const handler = createManagedRequestHandler({ config, db, originGate: { isOriginAllowed: () => true }, isShuttingDown: () => false, track(work) { tracked.push(work) },
    ...retained ? { waitUntil: work => { retained.push(work) } } : {} })
  // Another admin, with a GitHub token of their own.
  const other = await createSession(config, db, { githubUserId: 90_001, login: 'other', name: null, avatarUrl: null }, Date.now())
  await db.setUserRole(other.userId, 'admin')
  await db.setUserTokens(other.userId, { ...userTokens, accessToken: 'other-token' })
  return async (query, { method = 'GET', path = 'issues', as = session } = {}) => {
    const res = { status: 0, body: '', headers: {}, writeHead(status, headers) { this.status = status; this.headers = headers }, end(body) { this.body = body } }
    await handler({ method, url: `/api/admin/repositories/${path}?${new URLSearchParams(query)}`, headers: { cookie: (as === 'other' ? other : as).setCookie.split(';')[0] } }, res)
    return { status: res.status, body: JSON.parse(res.body) }
  }
}

// A cursor as GitHub gives one, base64url.
const cursor = 'Y3Vyc29yOnYyOpK0MjAyNi0xMC0xNVQwODozNToxN1rOrK_u7Q=='
const page = (nodes, { hasNextPage = false, endCursor = null, open = 3, closed = 40 } = {}) => ({ data: { repository: {
  open: { totalCount: open }, closed: { totalCount: closed }, page: { pageInfo: { hasNextPage, endCursor }, nodes },
} } })
const labels = (...names) => ({ totalCount: names.length + 1, nodes: names.map(name => ({ name, color: 'D73A4A' })) })

test('concurrent cold issues requests share the GitHub query and populate the persistent cache', async t => {
  const request = await fixture(t)
  const gate = Promise.withResolvers()
  const asked = github(t, async () => { await gate.promise; return page([{ number: 12, title: 'Shared read', state: 'OPEN' }]) })
  const reads = Array.from({ length: 6 }, () => request({ repoId: '1', kind: 'issues' }))
  await setImmediate()
  gate.resolve()
  const answers = await Promise.all(reads)
  assert.equal(asked.length, 1, 'one GraphQL query on a cold cache')
  assert.ok(answers.every(answer => answer.status === 200 && answer.body.items[0].title === 'Shared read'))
  await request({ repoId: '1', kind: 'issues' })
  assert.equal(asked.length, 1, 'the result still populates the persistent cache')
})

test('issues read a page of those open, the most recently updated first, each as a tile shows it, with how many are open and closed', async t => {
  const request = await fixture(t)
  const asked = github(t, () => page([
    { number: 12, title: 'Treemap labels overlap', state: 'OPEN', stateReason: null, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', closedAt: null,
      author: { login: 'octo', databaseId: 2 }, comments: { totalCount: 4 }, labels: labels('bug', 'ui') },
    { number: 9, title: 'Wontfix', state: 'CLOSED', stateReason: 'NOT_PLANNED', createdAt: null, updatedAt: null, closedAt: '2026-10-03T00:00:00Z',
      author: null, comments: { totalCount: 0 }, labels: { totalCount: 0, nodes: [{ name: ' ', color: 'zzz' }] } },
    { number: 'x', title: 'not an issue' }, null,
  ], { hasNextPage: true, endCursor: cursor }))
  const before = Date.now()
  const { status, body: { readAt, ...body } } = await request({ repoId: '1', kind: 'issues' })
  assert.equal(status, 200)
  assert.ok(readAt >= before && readAt <= Date.now(), 'when it was read from GitHub')
  assert.deepEqual(body, {
    kind: 'issues', state: 'open', counts: { open: 3, closed: 40 }, more: true, after: cursor,
    items: [
      { number: 12, title: 'Treemap labels overlap', author: 'octo', authorId: 2, createdAt: Date.parse('2026-10-01T00:00:00Z'), updatedAt: Date.parse('2026-10-02T00:00:00Z'), closedAt: null,
        comments: 4, labels: [{ name: 'bug', color: 'd73a4a' }, { name: 'ui', color: 'd73a4a' }], moreLabels: 1, state: 'open', reason: null },
      { number: 9, title: 'Wontfix', author: null, authorId: null, createdAt: null, updatedAt: null, closedAt: Date.parse('2026-10-03T00:00:00Z'), comments: 0, labels: [], moreLabels: 0,
        state: 'closed', reason: 'not-planned' },
    ],
    users: {},
  })
  assert.equal(asked[0].auth, 'Bearer login-token')
  assert.deepEqual(asked[0].variables, { owner: 'org', name: 'repo', after: null })
  assert.match(asked[0].query, /page: issues\(states: \[OPEN\], first: 50, after: \$after, orderBy: \{ field: UPDATED_AT, direction: DESC \}\)/u)
  assert.match(asked[0].query, /author \{ login \.\.\. on User \{ databaseId \} \.\.\. on Bot \{ databaseId \} \}/u, 'a user\'s account id, or a bot\'s')
  // Answered again as it was kept, said read when it was, which a reader holding a later read of one of its items can tell is older.
  const again = await request({ repoId: '1', kind: 'issues' })
  assert.equal(asked.length, 1)
  assert.equal(again.body.readAt, readAt)
  // Closed, on from a cursor.
  await request({ repoId: '1', kind: 'issues', state: 'closed', after: cursor })
  assert.deepEqual(asked[1].variables, { owner: 'org', name: 'repo', after: cursor })
  assert.match(asked[1].query, /page: issues\(states: \[CLOSED\]/u)
})

test('pull requests name their branches, size, review and checks, a merged one apart from one closed, and those closed include those merged', async t => {
  const request = await fixture(t)
  const pull = (number, more) => ({ number, title: `Pull ${number}`, createdAt: null, updatedAt: null, closedAt: null, mergedAt: null, author: { login: 'dependabot', databaseId: 49699333 },
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
  assert.deepEqual(body.users, { dependabot: { agent: 'dependabot' } }, 'Dependabot\'s as the app draws it')
  assert.match(asked[0].query, /closed: pullRequests\(states: \[CLOSED, MERGED\]\) \{ totalCount \}/u)
  assert.match(asked[0].query, /page: pullRequests\(states: \[CLOSED, MERGED\], first: 50/u)
  assert.doesNotMatch(asked[0].query, /latestReviews|reviewThreads/u, 'those closed read without their reviews')
  assert.equal('reviews' in body.items[0], false)
})

test('open pull requests are read with their reviews: each reviewer\'s latest, those requested, their threads and Codex\'s summary; and their commits, never told', async t => {
  const request = await fixture(t)
  const head = 'd'.repeat(40)
  const codex = { login: 'chatgpt-codex-connector', databaseId: 199175422 }
  const asked = github(t, () => page([{ number: 8, title: 'Pull 8', state: 'OPEN', author: { login: 'grace', databaseId: 6 }, comments: { totalCount: 1 }, labels: labels(),
    isDraft: false, additions: 1, deletions: 1, headRefName: 'feature/y', baseRefName: 'main', commits: { nodes: [] }, baseRefOid: 'e'.repeat(40), headRefOid: head,
    latestReviews: { nodes: [{ author: { login: 'grace', databaseId: 6 }, state: 'COMMENTED', submittedAt: null, commit: { oid: head } }] },
    reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'ada', databaseId: 5 } }] },
    reviewThreads: { totalCount: 1, nodes: [{ isResolved: false, isOutdated: false, comments: { nodes: [{ author: codex,
      body: '**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Paginate**' }] } }] },
    firstComments: { nodes: [{ author: codex, updatedAt: '2026-10-16T05:00:00Z',
      body: `<!-- codex-review-state:v1 ${JSON.stringify({ code_review: { commit_sha: head, status: 'completed' }, security_review: { commit_sha: head, status: 'completed' } })} -->` }] },
    lastComments: { nodes: [] } }]))
  const { body } = await request({ repoId: '1', kind: 'pulls', state: 'open' })
  assert.deepEqual(body.items[0].reviews, { head, reviewers: [{ login: 'ada', id: 5, state: null, requested: true, commit: null, at: null }], moreReviews: 0, moreRequests: 0,
    threads: { open: 1, resolved: 0, more: false, severity: 'p1' },
    codex: { login: 'chatgpt-codex-connector', id: 199175422, code: { commit: head, status: 'done' }, security: { commit: head, status: 'done' }, requested: false, failed: false } },
    'the author\'s own reply aside')
  assert.deepEqual(body.users['chatgpt-codex-connector'], { agent: 'codex' }, 'Codex, by its summary\'s account')
  assert.deepEqual(body.users.ada, undefined, 'a reviewer the app does not know is no user')
  assert.match(asked[0].query, /page: pullRequests\(states: \[OPEN\][^]*headRefOid[^]*latestReviews[^]*reviewThreads\(last: 50\)/u)
  assert.match(asked[0].query, /baseRefOid headRefOid/u, 'their commits, by which what their lockfiles add is read')
  assert.deepEqual([Object.hasOwn(body, 'commits'), Object.keys(body.items[0]).filter(key => /commit|oid/iu.test(key))], [false, []], 'never told')
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

test('a list GitHub rejects unread, refuses for a scope its token lacks, or takes too long to read, says which, in GitHub\'s words logged', async t => {
  const warned = t.mock.method(console, 'warn', () => {})
  // As GitHub rejects a query naming a type its API doesn't know: no type of
  // error, no data.
  let answer = { errors: [{ path: ['query', 'repository', 'page', 'nodes', 'reviewRequests', 'nodes', 'requestedReviewer', '... on EnterpriseTeam'],
    extensions: { code: 'undefinedType', typeName: 'EnterpriseTeam' }, locations: [{ line: 12, column: 9 }], message: 'No such type EnterpriseTeam, so it can\'t be a fragment condition' }] }
  github(t, () => answer)
  const request = await fixture(t)
  assert.deepEqual(await request({ repoId: '1', kind: 'pulls' }), { status: 502, body: { error: 'github-malformed' } })
  assert.match(warned.mock.calls[0].arguments.join(' '), /No such type EnterpriseTeam/u)
  answer = { data: null, errors: [{ message: 'Something went wrong while executing your query. This may be the result of a timeout, or it could be a GitHub bug.' }] }
  assert.deepEqual(await request({ repoId: '1', kind: 'issues' }), { status: 502, body: { error: 'github-timeout' } })
  assert.equal(warned.mock.callCount(), 2)
  // A field a token lacks the scope for, refused as a field a GitHub App
  // lacks the permission for is.
  answer = { errors: [{ type: 'INSUFFICIENT_SCOPES', locations: [{ line: 9, column: 5 }], message: 'Your token has not been granted the required scopes to execute this query. '
    + 'The \'slug\' field requires one of the following scopes: [\'read:org\', \'read:discussion\'], but your token has only been granted the: [\'\'] scopes.' }] }
  assert.deepEqual(await request({ repoId: '1', kind: 'issues', state: 'closed' }), { status: 502, body: { error: 'github-status-403' } })
  assert.match(warned.mock.calls[2].arguments.join(' '), /The 'slug' field requires/u, 'logged in GitHub\'s words')
  // Errors GitHub names, read past or not, aren't.
  answer = { ...page([]), errors: [{ type: 'FORBIDDEN', path: ['repository', 'page', 'nodes', 0, 'commits', 'nodes', 0, 'commit', 'statusCheckRollup'] }] }
  assert.equal((await request({ repoId: '1', kind: 'pulls', state: 'closed' })).status, 200)
  assert.equal(warned.mock.callCount(), 3)
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

test('a page read is kept for every reader: answered as kept a while, then at once as it is read again behind it, serverless too', async t => {
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
  // Serverless, the read behind it kept alive by the function's waitUntil.
  const retained = []
  const first = await fixture(t, { serverless: true, tracked, retained })
  title = 'Before'
  await first({ repoId: '1', kind: 'pulls' })
  const asking = asked.length
  await Promise.all(retained)
  assert.equal(asked.length, asking, 'nothing read behind a fresh answer: its write\'s prune alone retained')
  const answered = retained.length
  title = 'After'
  t.mock.timers.setTime(Date.now() + 3 * 60_000)
  assert.equal((await first({ repoId: '1', kind: 'pulls' })).body.items[0].title, 'Before', 'answered as kept at once')
  assert.equal(retained.length, answered + 1, 'the read behind it retained')
  await Promise.all(retained)
  assert.equal((await first({ repoId: '1', kind: 'pulls' })).body.items[0].title, 'After', 'the next to ask has what was read behind it')
})

test('a page none kept asked for by several readers at once is read once, with the first one\'s token, each answered by that read; once it is, the next asks again', async t => {
  let held = Promise.withResolvers()
  const asked = github(t, () => held.promise.then(() => page([{ number: 2, title: 'Shared', state: 'OPEN', stateReason: null, createdAt: null, updatedAt: null, closedAt: null,
    author: null, comments: { totalCount: 0 }, labels: labels() }])))
  const request = await fixture(t)
  const answers = Promise.all([request({ repoId: '1', kind: 'issues' }), request({ repoId: '1', kind: 'issues' }, { as: 'other' }), request({ repoId: '1', kind: 'pulls' })])
  while (asked.length < 2) await setImmediate()
  for (let turn = 0; turn < 50; turn++) await setImmediate()
  assert.equal(asked.length, 2, 'the issues read once, the pull requests their own')
  assert.ok(asked.every(({ auth }) => auth === 'Bearer login-token'))
  held.resolve()
  const [first, second] = await answers
  assert.deepEqual([first.body.items[0].title, second.body.items[0].title, first.body.readAt], ['Shared', 'Shared', second.body.readAt])
  held = Promise.withResolvers()
  held.resolve()
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 25 * 60 * 60_000 })
  await request({ repoId: '1', kind: 'issues' })
  assert.equal(asked.length, 3, 'a day on, read again')
})

test('an item is one issue or pull request as its popup shows it: as its tile, with its description\'s Markdown and what it closes or what closes it', async t => {
  const common = { createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', closedAt: '2026-10-02T00:00:00Z', comments: { totalCount: 2 }, labels: labels('bug') }
  const items = {
    7: { __typename: 'PullRequest', ...common, number: 7, title: 'Fix the chips', pullState: 'MERGED', isDraft: false, mergedAt: '2026-10-02T00:00:00Z', reviewDecision: 'APPROVED',
      additions: 30, deletions: 4, headRefName: 'claude/fix-chips', baseRefName: 'main', body: '\n \n    npm test\n\nFixes #3.\n\nhttps://claude.ai/code/session_X  \n', changedFiles: 2,
      commits: { totalCount: 4, nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] }, mergedBy: { login: 'ada', databaseId: 5 }, author: { login: 'grace', databaseId: 6 },
      closingIssuesReferences: { nodes: [{ number: 3, title: 'Chips unreadable', issueState: 'CLOSED', stateReason: 'COMPLETED' }, null] },
      headRefOid: 'c'.repeat(40), latestReviews: { nodes: [{ author: { login: 'ada', databaseId: 5 }, state: 'APPROVED', submittedAt: '2026-10-02T00:00:00Z', commit: { oid: 'c'.repeat(40) } }] },
      reviewThreads: { totalCount: 1, nodes: [{ isResolved: false, isOutdated: false, path: 'ui/chips.js', line: 3,
        comments: { nodes: [{ author: { login: 'ada', databaseId: 5 }, body: 'Darker?', url: 'https://github.com/org/repo/pull/7#discussion_r1' }] } }] } },
    3: { __typename: 'Issue', ...common, number: 3, title: 'Chips unreadable', issueState: 'CLOSED', stateReason: 'COMPLETED', body: 'x'.repeat(30_000), author: null,
      closedByPullRequestsReferences: { totalCount: 12, nodes: [{ number: 7, title: 'Fix the chips', pullState: 'MERGED', isDraft: false }, { number: 'x' }] } },
  }
  const asked = github(t, ({ variables }) => ({ data: { repository: { item: items[variables.number] ?? null } } }))
  const request = await fixture(t)
  const item = number => request({ repoId: '1', number }, { path: 'item' })
  const before = Date.now()
  const { status, body: { readAt, ...body } } = await item('7')
  const pull = { status, body }
  assert.equal(pull.status, 200)
  assert.ok(readAt >= before && readAt <= Date.now(), 'when it was read from GitHub')
  assert.deepEqual(pull.body, { kind: 'pulls', number: 7, title: 'Fix the chips', author: 'grace', authorId: 6, createdAt: Date.parse(common.createdAt), updatedAt: Date.parse(common.updatedAt),
    closedAt: Date.parse(common.closedAt), comments: 2, labels: [{ name: 'bug', color: 'd73a4a' }], moreLabels: 1, state: 'merged', draft: false,
    mergedAt: Date.parse('2026-10-02T00:00:00Z'), review: 'approved', checks: 'success', additions: 30, deletions: 4, head: 'claude/fix-chips', base: 'main',
    body: '    npm test\n\nFixes #3.\n\nhttps://claude.ai/code/session_X', bodyShortened: false, moreLinked: 0, closes: [{ number: 3, title: 'Chips unreadable', state: 'closed', reason: 'completed' }],
    commits: 4, files: 2, mergedBy: 'ada', mergedById: 5, reviews: { head: 'c'.repeat(40), codex: null,
      reviewers: [{ login: 'ada', id: 5, state: 'approved', requested: false, commit: 'c'.repeat(40), at: Date.parse('2026-10-02T00:00:00Z') }], moreReviews: 0, moreRequests: 0,
      threads: { open: 1, resolved: 0, more: false, severity: null,
        list: [{ severity: null, title: 'Darker?', path: 'ui/chips.js', line: 3, outdated: false, author: 'ada', authorId: 5, url: 'https://github.com/org/repo/pull/7#discussion_r1' }] } },
    users: {} })
  const issue = await item('3')
  // A description too long shortened, and the linked past those named counted, each said so.
  assert.deepEqual([issue.body.kind, issue.body.state, issue.body.reason, issue.body.body.length, issue.body.bodyShortened, issue.body.closedBy, issue.body.moreLinked],
    ['issues', 'closed', 'completed', 20_000, true, [{ number: 7, title: 'Fix the chips', state: 'merged', draft: false }], 11])
  assert.deepEqual(asked[0].variables, { owner: 'org', name: 'repo', number: 7 })
  // Each type's state named apart, as GitHub's GraphQL requires of an issue's and a pull request's.
  assert.match(asked[0].query, /issueState: state[^]*pullState: state/u)
  assert.match(asked[0].query, /reviewThreads\(last: 100\) \{ totalCount nodes \{ isResolved isOutdated path line originalLine/u, 'its threads, each where it is')
  assert.deepEqual(await item('9'), { status: 404, body: { error: 'github-not-found' } })
  for (const number of ['0', '-1', '1.5', 'x', '', '2147483648']) assert.equal((await item(number)).status, 400, number)
})

test('a kept page GitHub refuses to read again is no longer kept: the next to ask is refused as GitHub refused it', async t => {
  let refused = false
  const asked = github(t, () => refused ? { data: null, errors: [{ type: 'FORBIDDEN', path: ['repository', 'page'], message: 'Resource not accessible by integration' }] }
    : page([{ number: 2, title: 'Kept', state: 'OPEN', stateReason: null, createdAt: null, updatedAt: null, closedAt: null, author: null, comments: { totalCount: 0 }, labels: labels() }]))
  const tracked = []
  const request = await fixture(t, { tracked })
  assert.equal((await request({ repoId: '1', kind: 'issues' })).status, 200)
  // The App's Issues permission withdrawn: kept, it is answered once more as it is read again, refused.
  refused = true
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 3 * 60_000 })
  assert.equal((await request({ repoId: '1', kind: 'issues' })).body.items[0].title, 'Kept')
  await Promise.allSettled(tracked)
  assert.equal(asked.length, 2)
  assert.deepEqual(await request({ repoId: '1', kind: 'issues' }), { status: 502, body: { error: 'github-status-403' } })
  // Read again once GitHub allows it, it is kept again.
  refused = false
  t.mock.timers.setTime(Date.now() + 60_000)
  assert.equal((await request({ repoId: '1', kind: 'issues' })).status, 200)
})
