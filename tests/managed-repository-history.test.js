import assert from 'node:assert/strict'
import { test } from 'node:test'
import { COAUTHORS_READ } from '../server-managed/commit-coauthors.ts'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { historyPageStore } from '../server-managed/npm-kept.ts'
import { HISTORY_GLUED, historyFrom } from '../server-managed/repository-history.ts'
import { createSession } from '../server-managed/session.ts'

const config = { sessionCookieName: 'sid', cookieSecure: false, sessionTtlMs: 60_000 }
const repo = { repoId: 1, fullName: 'org/repo', private: false, installationId: null, defaultBranch: 'main', htmlUrl: '', addedBy: null }
const publicMetadata = { id: 1, full_name: 'org/repo', private: false, visibility: 'public', default_branch: 'main' }
const userTokens = { accessToken: 'login-token', refreshToken: null, expiresAt: null }
const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(char => char.repeat(40))

// A REST list-commits item, as GitHub answers one.
const restCommit = (sha, parents, message, login = 'octo') => ({
  sha, parents: parents.map(parent => ({ sha: parent })), author: login ? { login, id: 2 } : null,
  commit: { message, author: { name: `${login ?? 'someone'} name`, date: '2026-10-01T00:00:00Z' }, committer: { date: '2026-10-02T10:00:00Z' } },
})

// The GraphQL queries reading the history itself, not the pull requests
// squashed into it nor those open.
const historyQueries = asked => asked.filter(entry => entry.path === '/graphql' && !/pullRequest|PullRequests/u.test(entry.body.query))

// GitHub, as the reader and the history read it: `asked` the requests made.
function github(t, { graphql = null, full = false } = {}) {
  const asked = []
  t.mock.method(globalThis, 'fetch', (input, options = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    asked.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), method: options.method ?? 'GET', auth: options.headers?.authorization ?? null,
      body: options.body ? JSON.parse(options.body) : null })
    const path = url.pathname
    if (path === '/repos/org/repo') return Promise.resolve(Response.json(publicMetadata))
    if (path === '/repos/org/repo/commits/heads%2Fmain') return Promise.resolve(Response.json({ sha: a }))
    if (path === '/repos/org/repo/commits' && full) {
      return Promise.resolve(Response.json(Array.from({ length: 100 }, (_, index) => restCommit(index.toString(16).padStart(40, '0'), [], `Work ${index}`))))
    }
    if (path === '/repos/org/repo/commits') {
      return Promise.resolve(Response.json([restCommit(a, [b, c], 'Merge feature\n\nLonger body'), restCommit(b, [d], 'Main work', null), restCommit('short', [], 'not a commit')]))
    }
    if (path === '/repos/org/repo/branches') return Promise.resolve(Response.json([{ name: 'main', commit: { sha: a } }, { name: 'feature', commit: { sha: c } }, { name: 'odd', commit: {} }]))
    if (path === '/repos/org/repo/tags') return Promise.resolve(Response.json([{ name: 'v1', commit: { sha: d } }]))
    if (path === '/graphql' && graphql) return Promise.resolve(Response.json(graphql(JSON.parse(options.body))))
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
  return Object.assign(async (query, { method = 'GET' } = {}) => {
    const res = { status: 0, body: '', headers: {}, writeHead(status, headers) { this.status = status; this.headers = headers }, end(body) { this.body = body } }
    await handler({ method, url: `/api/admin/repositories/history?${new URLSearchParams(query)}`, headers: { cookie: session.setCookie.split(';')[0] } }, res)
    return { status: res.status, body: JSON.parse(res.body) }
  }, { db })
}

test('a revision\'s history reads a page of its commits, each with its parents, subject, author and time, and the branches and tags naming commits', async t => {
  const request = await fixture(t)
  const asked = github(t)
  const { status, body } = await request({ repoId: '1', ref: 'heads/main' })
  assert.equal(status, 200)
  // Its commits' parents not listed, c and d, are where it reads on.
  assert.deepEqual(body, {
    commit: a, path: '', page: 1, more: true,
    commits: [
      { sha: a, parents: [b, c], subject: 'Merge feature', authorName: 'octo name', authorLogin: 'octo', authorId: 2, coauthors: [], committedAt: Date.parse('2026-10-02T10:00:00Z') },
      { sha: b, parents: [d], subject: 'Main work', authorName: 'someone name', authorLogin: null, authorId: null, coauthors: [], committedAt: Date.parse('2026-10-02T10:00:00Z') },
    ],
    branches: [{ name: 'main', sha: a }, { name: 'feature', sha: c }], tags: [{ name: 'v1', sha: d }],
    users: {},
  })
  assert.deepEqual(asked.find(entry => entry.path === '/repos/org/repo/commits').query, { sha: a, per_page: '100', page: '1' })
  // A later page has no branches and tags to read again.
  const later = await request({ repoId: '1', ref: a, page: '2' })
  assert.equal(later.body.page, 2)
  assert.equal(later.body.branches, undefined)
  assert.deepEqual(asked.findLast(entry => entry.path === '/repos/org/repo/commits').query, { sha: a, per_page: '100', page: '2' })
  // On from the commits the client names, a page from each.
  const on = await request({ repoId: '1', ref: a, page: '2', from: `${c},${d}` })
  assert.deepEqual([on.body.page, on.body.more], [2, true])
  assert.deepEqual(asked.filter(entry => entry.path === '/repos/org/repo/commits').slice(-2).map(entry => entry.query.sha).toSorted(), [c, d])
})

test('a commit by a user of the app names them as the app does, by their account\'s id', async t => {
  const request = await fixture(t)
  github(t)
  const { body } = await request({ repoId: '1', ref: 'heads/main' })
  assert.deepEqual(body.users, {}, 'octo is no user of the app')
  const db = request.db
  // One signed in as octo since renamed: another account's now.
  const former = await createSession(config, db, { githubUserId: 3, login: 'octo', name: 'Former Octo', avatarUrl: null }, Date.now())
  await db.setUserRole(former.userId, 'view')
  assert.deepEqual((await request({ repoId: '1', ref: 'heads/main' })).body.users, {}, 'not by the login GitHub names another account by')
  const octo = await createSession(config, db, { githubUserId: 2, login: 'Octo-Cat', name: 'Octo Cat', avatarUrl: null }, Date.now())
  await db.setUserRole(octo.userId, 'view')
  assert.deepEqual((await request({ repoId: '1', ref: 'heads/main' })).body.users, { octo: { id: octo.userId, login: 'Octo-Cat', name: 'Octo Cat' } },
    'by the account, whatever login they last signed in with')
})

test('with a token, a revision\'s commits are named by every branch All branches reads and the latest tags, not GitHub\'s first page of each by name', async t => {
  const graphql = ({ query, variables }) => ({ data: { repository: query.includes('refs/heads/')
    ? { defaultBranchRef: { name: 'main', target: { oid: a, committedDate: '2026-10-02T10:00:00Z' } },
      tags: { nodes: [{ name: 'v2', target: { __typename: 'Commit', oid: b } }] },
      branches: { pageInfo: { hasNextPage: variables.after === null, endCursor: 'p1' },
        nodes: variables.after === null ? [{ name: 'main', target: { oid: a, committedDate: null } }] : [{ name: 'zz-past-the-first-hundred', target: { oid: c, committedDate: null } }] } }
    : { b0: { history: { nodes: [{ oid: a, message: 'Work', committedDate: '2026-10-02T10:00:00Z', author: { name: 'Ada', user: null }, parents: { nodes: [] } }] } } } } })
  const request = await fixture(t, { tokens: userTokens })
  const asked = github(t, { graphql })
  const { body } = await request({ repoId: '1', ref: 'heads/main' })
  assert.deepEqual([body.branches, body.tags], [[{ name: 'main', sha: a }, { name: 'zz-past-the-first-hundred', sha: c }], [{ name: 'v2', sha: b }]])
  assert.equal(asked.some(entry => entry.path === '/repos/org/repo/branches' || entry.path === '/repos/org/repo/tags'), false)
})

test('a full page offers the next, but for the deepest page read', async t => {
  const request = await fixture(t)
  github(t, { full: true })
  assert.equal((await request({ repoId: '1', ref: a, page: '99' })).body.more, true)
  assert.equal((await request({ repoId: '1', ref: a, page: '100' })).body.more, false, 'page 101 is no page to read')
})

test('a directory\'s history lists the commits touching it, read only where the reader\'s grants reach all of it', async t => {
  const manager = await fixture(t, { role: 'manage' })
  const asked = github(t)
  assert.equal((await manager({ repoId: '1', ref: a, path: 'src/allowed' })).status, 200)
  assert.deepEqual(asked.find(entry => entry.path === '/repos/org/repo/commits').query, { sha: a, per_page: '100', page: '1', path: 'src/allowed' })
  for (const path of ['', 'src', 'src/other']) assert.deepEqual((await manager({ repoId: '1', ref: a, path })).body, { error: 'no-directory' }, path)
})

test('all branches reads the 25 most recently committed to, the default branch first, each commit once, a tag by the commit it tags, and with a token alone', async t => {
  // GitHub lists heads by name: 28 stale ones, the newest last; main, the
  // default branch, sorts past all those read.
  const head = (name, oid, committedDate) => ({ name, target: { oid, committedDate } })
  const stale = Array.from({ length: 28 }, (_, index) => head(`aa-old-${index}`, d, '2020-01-01T00:00:00Z'))
  const tag = (oid, target = null) => ({ __typename: target ? 'Tag' : 'Commit', oid, target })
  const heads = {
    null: { branches: { pageInfo: { hasNextPage: true, endCursor: 'p2' }, nodes: stale },
      tags: { nodes: [
        { name: 'v1', target: tag('e'.repeat(40), tag(d)) },
        // An annotated tag of an annotated tag; one of a tree, no commit.
        { name: 'v2', target: tag('1'.repeat(40), tag('2'.repeat(40), tag(c))) },
        { name: 'tree', target: tag('3'.repeat(40), { __typename: 'Tree', oid: '4'.repeat(40) }) },
        { name: 'light', target: tag(c) },
      ] } },
    p2: { branches: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [head('feature', c, '2026-10-01T12:00:00Z')] } },
  }
  const histories = {
    b0: { history: { pageInfo: { hasNextPage: false }, nodes: [
      { oid: a, message: 'Merge feature', committedDate: '2026-10-02T10:00:00Z', author: { name: 'Octo', user: { login: 'octo', databaseId: 2 } },
        parents: { nodes: [{ oid: b }, { oid: c }] } },
      // A GitHub App's bot's, named no user, by its noreply address.
      { oid: b, message: 'Main work', committedDate: '2026-10-01T10:00:00Z', author: { name: 'dependabot[bot]', email: '49699333+dependabot[bot]@users.noreply.github.com',
        user: null }, parents: { nodes: [{ oid: d }] } },
    ] } },
    b1: { history: { pageInfo: { hasNextPage: true }, nodes: [
      { oid: c, message: 'Feature', committedDate: '2026-10-01T12:00:00Z', author: null, parents: { nodes: [{ oid: d }] } },
      { oid: d, message: 'Root', committedDate: '2020-01-01T00:00:00Z', author: null, parents: { nodes: [] } },
    ] } },
    b2: { history: { pageInfo: { hasNextPage: false }, nodes: [{ oid: d, message: 'Root', committedDate: '2020-01-01T00:00:00Z', author: null, parents: { nodes: [] } }] } },
  }
  // Each commit's lines, as GitHub's GraphQL API tells them.
  for (const { history } of Object.values(histories)) for (const node of history.nodes) Object.assign(node, { additions: 1, deletions: 0 })
  const graphql = ({ query, variables }) => ({ data: { repository: query.includes('refs/heads/')
    ? { defaultBranchRef: head('main', a, '2026-10-02T10:00:00Z'), ...heads[variables.after] } : histories } })
  const request = await fixture(t, { tokens: userTokens })
  const asked = github(t, { graphql })
  const { status, body } = await request({ repoId: '1', all: 'true' })
  assert.equal(status, 200)
  assert.deepEqual(body.commits.map(commit => commit.sha), [a, b, c, d])
  assert.deepEqual(body.commits.map(commit => [commit.authorLogin, commit.authorId]), [['octo', 2], ['dependabot[bot]', 49699333], [null, null], [null, null]])
  assert.deepEqual(body.users, { 'dependabot[bot]': { agent: 'dependabot' } }, 'an agent as the app draws it')
  assert.deepEqual(body.branches.map(branch => branch.name), [...stale.map(ref => ref.name), 'feature', 'main'], 'every branch naming a commit listed')
  assert.deepEqual(body.tags, [{ name: 'v1', sha: d }, { name: 'v2', sha: c }, { name: 'light', sha: c }])
  assert.equal(body.defaultBranch, 'main')
  assert.equal(body.more, true, 'branches and older commits left out')
  assert.ok(asked.filter(entry => entry.path === '/graphql').every(query => query.method === 'POST' && query.auth === 'Bearer login-token'))
  const queries = historyQueries(asked)
  assert.deepEqual(queries.map(query => query.body.variables), [
    { owner: 'org', name: 'repo', after: null, tags: 100, first: true },
    { owner: 'org', name: 'repo', after: 'p2', tags: 100, first: false },
    // main, then the newest, feature, then 23 of the stale, all at one tip.
    { owner: 'org', name: 'repo', o0: a, o1: c, o2: d },
  ])
  assert.match(queries[2].body.query, /b2: object\(oid: \$o2\) \{ \.\.\. on Commit \{ history\(first: 100\)/u)
  assert.match(queries[2].body.query, /author \{ name email date user \{ login databaseId \} \}/u)
  // A tag's target, and those of as many as four annotated tags after it.
  assert.equal(queries[0].body.query.match(/target \{ __typename oid/gu).length, 5)
  // Asked again: its branches kept a while, each tip's page kept for good, nothing of the history read of GitHub.
  assert.deepEqual((await request({ repoId: '1', all: 'true' })).body, body)
  assert.equal(historyQueries(asked).length, 3)
  // Asked afresh, as the client asks where they miss the commit it shows:
  // its branches read now, unless they were just read; its tips' pages kept.
  const { retryIn, ...soon } = (await request({ repoId: '1', all: 'true', fresh: 'true' })).body
  assert.deepEqual(soon, body)
  assert.equal(historyQueries(asked).length, 3, 'read too lately to read again')
  assert.ok(retryIn > 0 && retryIn <= 10_000, 'when they may be read again said')
  const later = Date.now() + 30_000
  t.mock.method(Date, 'now', () => later)
  // Asked so by two at once, read once, both answered by it.
  const both = await Promise.all([request({ repoId: '1', all: 'true', fresh: 'true' }), request({ repoId: '1', all: 'true', fresh: 'true' })])
  assert.deepEqual(both.map(answer => answer.body), [body, body])
  assert.deepEqual(historyQueries(asked).slice(3).map(query => query.body.variables.after), [null, 'p2'], 'its branches read again, once, alone')

  const anonymous = await fixture(t)
  assert.deepEqual(await anonymous({ repoId: '1', all: 'true' }), { status: 403, body: { error: 'github-token-required' } })
})

test('the pull requests squashed into the history come with it, each with its own commits and its head as merged; a rebase, a commit no pull request merged, none', async t => {
  const [squash, rebased2, rebased1, tidy, direct, p1, p2, r1, r2, t1, open] = ['5', '6', '4', '3', '7', '8', '9', 'e', '2', '1', 'f'].map(char => char.repeat(40))
  const node = (oid, parents, message, committedDate = '2026-10-01T00:00:00Z') => ({ oid, message, committedDate, author: { name: 'Octo', date: committedDate, user: { login: 'octo' } },
    parents: { nodes: parents.map(parent => ({ oid: parent })) } })
  // main: a squash of #2; #3's two commits rebased onto it; #5's one commit
  // squashed, titled as that commit, as GitHub does by default; a commit
  // pushed to it, and the root. #2's branch reused since by #4, open.
  const history = [node(squash, [rebased2], 'Feature (#2)'), node(rebased2, [rebased1], 'Fix, part 2'), node(rebased1, [tidy], 'Fix, part 1'),
    node(tidy, [direct], 'Tidy up'), node(direct, [d], 'Direct'), node(d, [], 'Root')]
  const pullCommits = { 2: [node(p1, [d], 'Start'), node(p2, [p1], 'Finish')], 3: [node(r1, [d], 'Fix, part 1'), node(r2, [r1], 'Fix, part 2')],
    5: [node(t1, [d], 'Tidy up')] }
  const merges = { [squash]: 2, [rebased2]: 3, [tidy]: 5 }
  const graphql = ({ query, variables }) => ({ data: { repository: query.includes('refs/heads/')
    ? { defaultBranchRef: { name: 'main', target: { oid: squash, committedDate: '2026-10-01T00:00:00Z' } },
      branches: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ name: 'main', target: { oid: squash, committedDate: '2026-10-01T00:00:00Z' } },
        { name: 'feature', target: { oid: open, committedDate: '2026-10-02T00:00:00Z' } }] }, tags: { nodes: [] } }
    // The rebase's first commit was brought in by #3 too, its merge commit not.
    : query.includes('associatedPullRequests') ? Object.fromEntries(Object.entries(variables).flatMap(([key, oid]) => /^o\d+$/u.test(key) ? [[`c${key.slice(1)}`,
      { associatedPullRequests: { nodes: merges[oid] ? [{ number: merges[oid], mergeCommit: { oid } }] : oid === rebased1 ? [{ number: 3, mergeCommit: { oid: rebased2 } }] : [] } }]] : []))
    : query.includes('pullRequest(number') ? Object.fromEntries(Object.entries(variables).flatMap(([key, number]) => /^n\d+$/u.test(key) ? [[`p${key.slice(1)}`,
      { headRefOid: pullCommits[number].at(-1).oid, commits: { totalCount: pullCommits[number].length, nodes: pullCommits[number].map(commit => ({ commit })) } }]] : []))
    : query.includes('pullRequests(states: OPEN') ? { pullRequests: { nodes: [{ number: 4, headRefOid: open }, { number: 'x', headRefOid: open }] } }
    : Object.fromEntries(Object.entries(variables).flatMap(([key, oid]) => /^o\d+$/u.test(key) ? [[`b${key.slice(1)}`, { history: { pageInfo: { hasNextPage: false },
      nodes: oid === squash ? history : oid === open ? [node(open, [p2], 'Again'), ...pullCommits[2].toReversed(), history.at(-1)] : [] } }]] : [])) } })
  const request = await fixture(t, { tokens: userTokens })
  const asked = github(t, { graphql })
  const { status, body } = await request({ repoId: '1', all: 'true' })
  assert.equal(status, 200)
  const shown = commit => ({ sha: commit.oid, parents: commit.parents.nodes.map(parent => parent.oid), subject: commit.message, authorName: 'Octo', authorLogin: 'octo', authorId: null,
    coauthors: [], committedAt: Date.parse(commit.committedDate) })
  assert.deepEqual(body.pulls, [{ merge: squash, number: 2, head: p2, commits: pullCommits[2].map(shown), more: false },
    { merge: tidy, number: 5, head: t1, commits: pullCommits[5].map(shown), more: false }], 'a rebase, its commits copied onto main, none; one commit squashed, its title its commit\'s, as it was')
  assert.deepEqual(body.openPulls, [{ number: 4, sha: open }])
  const looked = asked.filter(entry => entry.path === '/graphql' && /pullRequest|PullRequests/u.test(entry.body.query)).length
  // Asked again: each commit's pull request kept, none looked up again.
  assert.deepEqual((await request({ repoId: '1', all: 'true' })).body, body)
  assert.equal(asked.filter(entry => entry.path === '/graphql' && /pullRequest|PullRequests/u.test(entry.body.query)).length, looked)
  // A directory's history is drawn in a line: none looked up.
  const before = asked.length
  await request({ repoId: '1', ref: 'heads/main', path: 'src/allowed' })
  assert.equal(asked.slice(before).some(entry => entry.path === '/graphql' && /PullRequests|pullRequest\(/u.test(entry.body.query)), false)
})

test('a rebase whose commits go on past those listed is told, and kept, once they are listed', async t => {
  const [rebased2, rebased1, r1, r2, root] = ['6', '4', 'e', '2', '1'].map(char => char.repeat(40))
  const node = (oid, parents, message) => ({ oid, message, committedDate: '2026-10-01T00:00:00Z', author: null, parents: { nodes: parents.map(parent => ({ oid: parent })) } })
  // #3's two commits rebased onto main, the first of them past the page read at first.
  let history = [node(rebased2, [rebased1], 'Fix, part 2')]
  const graphql = ({ query, variables }) => ({ data: { repository: query.includes('refs/heads/')
    ? { defaultBranchRef: { name: 'main', target: { oid: rebased2, committedDate: '2026-10-01T00:00:00Z' } }, branches: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
      tags: { nodes: [] } }
    : query.includes('associatedPullRequests') ? Object.fromEntries(Object.entries(variables).flatMap(([key]) => /^o\d+$/u.test(key) ? [[`c${key.slice(1)}`,
      { associatedPullRequests: { nodes: [{ number: 3, mergeCommit: { oid: rebased2 } }] } }]] : []))
    : query.includes('pullRequest(number') ? { p0: { headRefOid: r2, commits: { totalCount: 2, nodes: [node(r1, [root], 'Fix, part 1'), node(r2, [r1], 'Fix, part 2')].map(commit => ({ commit })) } } }
    : query.includes('pullRequests(states') ? { pullRequests: { nodes: [] } }
    : { b0: { history: { pageInfo: { hasNextPage: false }, nodes: history } } } } })
  const request = await fixture(t, { tokens: userTokens })
  const asked = github(t, { graphql })
  const lookups = () => asked.filter(entry => entry.path === '/graphql' && entry.body.query.includes('associatedPullRequests')).length
  assert.equal((await request({ repoId: '1', all: 'true' })).body.pulls, undefined)
  // Its first commit listed now, as gluing on kept pages lists it: looked up again, a rebase, none.
  history = [node(rebased2, [rebased1], 'Fix, part 2'), node(rebased1, [root], 'Fix, part 1'), node(root, [], 'Root')]
  const looked = lookups()
  const again = await request({ repoId: '1', ref: 'heads/main' })
  assert.equal(again.body.pulls, undefined)
  assert.equal(lookups(), looked + 1, 'not kept while it couldn\'t be told')
  await request({ repoId: '1', ref: 'heads/main' })
  assert.equal(lookups(), looked + 1, 'kept once told')
})

test('a history is sent all the same where the pull requests squashed into it can\'t be read', async t => {
  const graphql = ({ query }) => query.includes('associatedPullRequests') || query.includes('pullRequests(') ? { errors: [{ type: 'FORBIDDEN' }] }
    : { data: { repository: query.includes('refs/heads/')
      ? { defaultBranchRef: { name: 'main', target: { oid: a, committedDate: '2026-10-01T00:00:00Z' } }, branches: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }, tags: { nodes: [] } }
      : { b0: { history: { pageInfo: { hasNextPage: false }, nodes: [{ oid: a, message: 'Only', committedDate: '2026-10-01T00:00:00Z', author: null, parents: { nodes: [{ oid: b }] } }] } } } } }
  const request = await fixture(t, { tokens: userTokens })
  github(t, { graphql })
  const { status, body } = await request({ repoId: '1', all: 'true' })
  assert.equal(status, 200)
  assert.deepEqual([body.commits.map(commit => commit.sha), body.pulls, body.openPulls], [[a], undefined, undefined])
})

test('all branches names the branches it didn\'t read, newest first, and reads on from the commits a later page names, each commit once', async t => {
  const head = (name, oid, committedDate) => ({ name, target: { oid, committedDate } })
  // main and 24 others read; of those not, stale's tip isn't listed, older's is.
  const recent = Array.from({ length: 24 }, (_, index) => head(`recent-${index}`, a, '2026-10-01T00:00:00Z'))
  const branches = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [head('older', b, '2019-01-01T00:00:00Z'), ...recent, head('stale', c, '2020-01-01T00:00:00Z')] }
  const node = (oid, parents) => ({ oid, message: `Commit ${oid[0]}`, committedDate: '2026-10-01T00:00:00Z', author: null, parents: { nodes: parents.map(parent => ({ oid: parent })) } })
  const graphql = ({ query, variables }) => ({ data: { repository: query.includes('refs/heads/')
    ? { defaultBranchRef: head('main', a, '2026-10-02T10:00:00Z'), branches, tags: { nodes: [] } }
    : variables.o0 === a ? { b0: { history: { pageInfo: { hasNextPage: false }, nodes: [node(a, [b]), node(b, [c])] } } }
    : { b0: { history: { pageInfo: { hasNextPage: true }, nodes: [node(c, [d]), node(d, [])] } }, b1: { history: { pageInfo: { hasNextPage: false }, nodes: [node(d, [])] } } } } })
  const request = await fixture(t, { tokens: userTokens })
  const asked = github(t, { graphql })
  const first = await request({ repoId: '1', all: 'true' })
  assert.deepEqual(first.body.unread, [{ name: 'stale', sha: c, at: Date.parse('2020-01-01T00:00:00Z') }])
  assert.equal(first.body.cut, false)
  assert.ok(first.body.branches.some(branch => branch.name === 'older'), 'a branch not read, its tip listed, names it')
  const later = await request({ repoId: '1', all: 'true', page: '2', from: `${c},${d},${c}` })
  assert.equal(later.status, 200)
  assert.deepEqual(later.body, { all: true, page: 2, commits: [node(c, [d]), node(d, [])].map(item => ({ sha: item.oid, parents: item.parents.nodes.map(parent => parent.oid),
    subject: item.message, authorName: null, authorLogin: null, authorId: null, coauthors: [], committedAt: Date.parse(item.committedDate) })), more: true, users: {} })
  const query = historyQueries(asked).at(-1)
  assert.deepEqual(query.body.variables, { owner: 'org', name: 'repo', o0: c, o1: d })
  assert.match(query.body.query, /b1: object\(oid: \$o1\) \{ \.\.\. on Commit \{ history\(first: 100\)/u)
  assert.equal((await request({ repoId: '1', all: 'true', page: '100', from: c })).body.more, false, 'page 101 is no page to read')
})

test('all branches says where branches past the fifty pages it lists are left out', async t => {
  const graphql = ({ query, variables }) => ({ data: { repository: query.includes('refs/heads/')
    ? { defaultBranchRef: { name: 'main', target: { oid: a, committedDate: '2026-10-02T10:00:00Z' } }, tags: { nodes: [] },
      branches: { pageInfo: { hasNextPage: true, endCursor: `p${variables.after ?? 0}+` }, nodes: [{ name: `b-${variables.after}`, target: { oid: a, committedDate: null } }] } }
    : { b0: { history: { pageInfo: { hasNextPage: false }, nodes: [] } } } } })
  const request = await fixture(t, { tokens: userTokens })
  const asked = github(t, { graphql })
  const { body } = await request({ repoId: '1', all: 'true' })
  assert.equal(body.cut, true)
  assert.equal(asked.filter(entry => entry.path === '/graphql' && entry.body.query.includes('refs/heads/')).length, 50)
})

test('a history that names no page, all branches of a directory, or reads on from what is no commit, is a bad request', async t => {
  const request = await fixture(t)
  github(t)
  const starts = count => Array.from({ length: count }, (_, index) => index.toString(16).padStart(40, '0')).join(',')
  for (const query of [{ repoId: '1', page: '0' }, { repoId: '1', page: '1.5' }, { repoId: '1', page: '101' }, { repoId: '1', all: 'true', path: 'src' },
    { repoId: '1', all: 'true', page: '2' }, { repoId: '1', all: 'true', from: a }, { repoId: '1', page: '1', from: a }, { repoId: '1', page: '2', path: 'src/allowed', from: a },
    { repoId: '1', all: 'true', page: '2', from: '' }, { repoId: '1', all: 'true', page: '2', from: `${a},main` }, { repoId: '1', all: 'true', page: '2', from: starts(26) }]) {
    assert.equal((await request(query)).status, 400, JSON.stringify(query))
  }
  assert.equal((await request({ repoId: '1' }, { method: 'POST' })).status, 405)
})

// A linear history of 300 commits, `chain(0)` the newest, as GitHub's REST
// list gives a page of it from any of them.
const chain = at => at.toString(16).padStart(40, '0')
function linear(t) {
  const read = []
  t.mock.method(globalThis, 'fetch', input => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    if (url.pathname === '/repos/org/repo') return Promise.resolve(Response.json(publicMetadata))
    if (url.pathname === '/repos/org/repo/branches' || url.pathname === '/repos/org/repo/tags') return Promise.resolve(Response.json([]))
    if (url.pathname === '/repos/org/repo/commits') {
      const top = Number.parseInt(url.searchParams.get('sha'), 16)
      read.push(top)
      return Promise.resolve(Response.json(Array.from({ length: Math.min(100, 300 - top) }, (_, index) => top + index)
        .map(at => restCommit(chain(at), at < 299 ? [chain(at + 1)] : [], `Work ${at}`))))
    }
    return Promise.resolve(Response.json({ message: 'Not Found' }, { status: 404 }))
  })
  return read
}

test('a whole repository\'s history is kept a page from a commit at a time, by that commit, and where a commit read starts a page kept, that page glues on, and those after it', async t => {
  const request = await fixture(t)
  const read = linear(t)
  const listed = body => body.commits.map(commit => Number.parseInt(commit.sha, 16))
  const range = (from, to) => Array.from({ length: to - from }, (_, index) => from + index)
  // A revision 100 commits down, then on from where its first page stops.
  assert.deepEqual(listed((await request({ repoId: '1', ref: chain(100) })).body), range(100, 200))
  assert.deepEqual(listed((await request({ repoId: '1', ref: chain(100), page: '2', from: chain(200) })).body), range(200, 300))
  assert.deepEqual(read, [100, 200])
  // The branch moved on 100 commits: their page read, the pages kept below it glued on, all 300 at once.
  const moved = (await request({ repoId: '1', ref: chain(0) })).body
  assert.deepEqual([listed(moved), moved.more], [range(0, 300), false])
  assert.deepEqual(read, [100, 200, 0], 'one page read of GitHub')
  // Kept, the revision 100 down reads nothing of GitHub, its own page and the one after it glued.
  assert.deepEqual(listed((await request({ repoId: '1', ref: chain(100) })).body), range(100, 300))
  assert.deepEqual(read, [100, 200, 0])
  // A commit GitHub lists nothing from keeps no page: asked again, it is read again.
  await request({ repoId: '1', ref: chain(400) })
  await request({ repoId: '1', ref: chain(400) })
  assert.deepEqual(read.slice(-2), [400, 400])
  read.length = 3
  // One 50 down: its page read, listing commit 100 halfway, whose page kept glues on, and the one after it.
  assert.deepEqual(listed((await request({ repoId: '1', ref: chain(50) })).body), [...range(50, 150), ...range(150, 300)])
  assert.deepEqual(read, [100, 200, 0, 50])
})

test('gluing stops at as many commits as it goes to, looking up fifty tops at a time, however many pages are kept', async () => {
  // A linear history of 3000 commits, a page kept from every one of them.
  const commit = at => ({ sha: chain(at), parents: at < 2999 ? [chain(at + 1)] : [], subject: '', authorName: null, authorLogin: null, committedAt: null })
  const lookups = []
  const pages = {
    read: tops => {
      lookups.push(tops.length)
      return Promise.resolve(new Map(tops.map(top => [top, Array.from({ length: Math.min(100, 3000 - Number.parseInt(top, 16)) }, (_, index) => commit(Number.parseInt(top, 16) + index))])))
    },
    write: () => Promise.resolve(),
  }
  const { commits, more } = await historyFrom('org/repo', 'token', [chain(0)], pages, () => assert.fail('nothing read of GitHub'))
  assert.equal(commits.length, HISTORY_GLUED)
  assert.equal(more, true)
  assert.ok(lookups.slice(1).every(count => count <= 50), JSON.stringify(lookups))
})

test('gluing reads the pages at parents not listed first, those at commits listed only where none of those is kept, each in one read', async () => {
  // A linear history of 3000 commits, a page kept from every one of them but
  // the 149th, 249th, …: the parent the first page from the 49th leaves
  // unlisted has none, a commit listed's going on past it instead.
  const commit = at => ({ sha: chain(at), parents: at < 2999 ? [chain(at + 1)] : [], subject: '', authorName: null, authorLogin: null, committedAt: null })
  const pageAt = top => Array.from({ length: Math.min(100, 3000 - Number.parseInt(top, 16)) }, (_, index) => commit(Number.parseInt(top, 16) + index))
  const kept = top => Number.parseInt(top, 16) === 49 || Number.parseInt(top, 16) % 100 !== 49
  const firsts = [], reads = [], started = []
  const pages = {
    // Where it starts alone, all of them at once.
    read: tops => { started.push(tops); return Promise.resolve(new Map(tops.filter(kept).map(top => [top, pageAt(top)]))) },
    readFirst: (first, then) => {
      const hit = first.some(kept)
      const answered = (hit ? first : then).filter(kept)
      reads.push(answered.length)
      firsts.push(hit)
      return Promise.resolve({ first: hit, pages: new Map(answered.map(top => [top, pageAt(top)])) })
    },
    write: () => Promise.resolve(),
  }
  const { commits } = await historyFrom('org/repo', 'token', [chain(49)], pages, () => assert.fail('nothing read of GitHub'))
  assert.deepEqual(started, [[chain(49)]])
  assert.equal(commits.length, HISTORY_GLUED)
  assert.deepEqual(commits.map(listed => Number.parseInt(listed.sha, 16)), Array.from({ length: HISTORY_GLUED }, (_, at) => at + 49), 'each once, in the history\'s order')
  assert.ok(reads.length <= 21, JSON.stringify(reads))
  assert.equal(firsts[0], false, 'its parent has no page: those at commits listed read')
  assert.ok(firsts.slice(1).every(Boolean), 'then the parents\' alone')
  // Fifty pages at commits listed once, a page at a parent a read after: not
  // a page at every commit listed, as many as are kept.
  assert.ok(reads.reduce((sum, count) => sum + count, 0) < 100, `pages read: ${JSON.stringify(reads)}`)
})

test('a commit\'s co-authors: its trailers\' (GitHub\'s GraphQL API\'s by the accounts it knows them by), then the agents its message marks, each once, the author none', async () => {
  const pages = { read: () => Promise.resolve(new Map()), write: () => Promise.resolve() }
  // GitHub's REST API: its trailers' names and no-reply addresses; Claude once, by its trailer and its line.
  const rest = () => Promise.resolve(Response.json([restCommit(a, [], 'Work\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\n'
    + 'Co-authored-by: Grace <12+grace@users.noreply.github.com>\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nco-authored-by: octo name <octo@example.com>')]))
  const [listed] = (await historyFrom('org/repo', null, [a], pages, rest)).commits
  assert.equal(listed.subject, 'Work')
  assert.deepEqual(listed.coauthors, [{ name: 'Grace', login: 'grace', id: 12 }, { name: 'Claude Opus 5.5', login: null, id: null, agent: 'claude' }])
  // Its GraphQL API: its authors past the first, as GitHub knows them, and its whole message.
  const asked = []
  const node = { oid: a, message: 'Work\n\nhttps://chatgpt.com/codex/tasks/task_e_abcdef12\nCo-authored-by: Cursor Agent <cursoragent@cursor.com>', committedDate: '2026-10-01T00:00:00Z',
    author: { name: 'Octo', email: 'octo@example.com', user: { login: 'octo', databaseId: 2 } }, parents: { nodes: [] },
    authors: { nodes: [{ name: 'Octo', email: 'octo@example.com', user: { login: 'octo', databaseId: 2 } }, { name: 'Claude', email: 'noreply@anthropic.com', user: { login: 'claude', databaseId: 81847 } },
      { name: 'Cursor Agent', email: 'cursoragent@cursor.com', user: null }] } }
  const graph = (input, options) => {
    asked.push(JSON.parse(options.body).query)
    return Promise.resolve(Response.json({ data: { repository: { b0: { history: { pageInfo: { hasNextPage: false }, nodes: [node] } } } } }))
  }
  const [read] = (await historyFrom('org/repo', 'token', [a], pages, graph)).commits
  assert.match(asked[0], /\bmessage\b[^]*authors\(first: 4\) \{ nodes \{ name email user \{ login databaseId \} \} \}/u)
  assert.deepEqual(read.coauthors, [{ name: 'Claude', login: 'claude', id: 81847, agent: 'claude' }, { name: 'Cursor Agent', login: null, id: null, agent: 'cursor' },
    { name: 'Codex', login: null, id: null, agent: 'codex' }], 'Codex by its task\'s link')
})

test('pages kept before their commits\' co-authors were read are read again, then kept', async t => {
  const request = await fixture(t)
  const read = linear(t)
  await request({ repoId: '1', ref: chain(100) })
  assert.deepEqual(read, [100])
  const store = historyPageStore(request.db)
  const key = `1\0${COAUTHORS_READ}\0${chain(100)}`
  const kept = (await store.readMany([key])).get(key).value
  assert.ok(kept.every(commit => Array.isArray(commit.coauthors)))
  await store.write(key, kept.map(({ coauthors: _coauthors, ...commit }) => commit), Date.now())
  await request({ repoId: '1', ref: chain(100) })
  await request({ repoId: '1', ref: chain(100) })
  assert.deepEqual(read, [100, 100], 'read again once')
})

test('pages kept as co-authors were read by rules since changed (Codex not yet known by its address) are read again', async t => {
  const read = linear(t)
  const first = await fixture(t)
  await first({ repoId: '1', ref: chain(100) })
  const key = `1\0${COAUTHORS_READ}\0${chain(100)}`
  const kept = (await historyPageStore(first.db).readMany([key])).get(key).value
  const request = await fixture(t)
  for (const older of [`1\0${chain(100)}`, `1\0${COAUTHORS_READ - 1}\0${chain(100)}`]) await historyPageStore(request.db).write(older, kept, Date.now())
  await request({ repoId: '1', ref: chain(100) })
  assert.deepEqual(read, [100, 100], 'those kept by older rules not sent')
})

test('with a token, pages kept as GitHub\'s REST API listed them, which tell no co-author\'s account, are read again with GraphQL', async t => {
  const graphql = ({ query }) => ({ data: { repository: query.includes('refs/heads/')
    ? { defaultBranchRef: { name: 'main', target: { oid: a, committedDate: null } }, tags: { nodes: [] },
      branches: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ name: 'main', target: { oid: a, committedDate: null } }] } }
    : { b0: { history: { nodes: [{ oid: a, message: 'Work\n\nCo-authored-by: Mona <mona@example.com>', committedDate: '2026-10-02T10:00:00Z', additions: 1, deletions: 0,
      author: { name: 'Ada', user: null }, authors: { nodes: [{ name: 'Ada', user: null }, { name: 'Mona', email: 'mona@example.com', user: { login: 'mona', databaseId: 3 } }] },
      parents: { nodes: [] } }] } } } } })
  const request = await fixture(t, { tokens: userTokens })
  const asked = github(t, { graphql })
  await historyPageStore(request.db).write(`1\0${COAUTHORS_READ}\0${a}`, [{ sha: a, parents: [], subject: 'Work', authorName: 'Ada', authorLogin: null, authorId: null,
    coauthors: [{ name: 'Mona', login: null, id: null }], committedAt: 1, additions: null, deletions: null, authoredAt: null, authorZone: null }], Date.now())
  const { body } = await request({ repoId: '1', ref: 'heads/main' })
  assert.deepEqual(body.commits[0].coauthors, [{ name: 'Mona', login: 'mona', id: 3 }], 'by the account GitHub knows her address by')
  await request({ repoId: '1', ref: 'heads/main' })
  assert.equal(historyQueries(asked).filter(entry => !entry.body.query.includes('refs/heads/')).length, 1, 'read again once, then kept')
})

test('pages kept at parents but none readable leave those at commits listed read in the same round, gluing as far all the same', async () => {
  // A linear history of 3000 commits, a page kept from every one of them, those at
  // the parents a page leaves unlisted unreadable (as REST-listed pages are to
  // a reader with GraphQL): kept, so the parents' are answered, but none told.
  const commit = at => ({ sha: chain(at), parents: at < 2999 ? [chain(at + 1)] : [], subject: '', authorName: null, authorLogin: null, committedAt: null })
  const pageAt = top => Array.from({ length: Math.min(100, 3000 - Number.parseInt(top, 16)) }, (_, index) => commit(Number.parseInt(top, 16) + index))
  let rounds = 0
  const pages = {
    read: tops => Promise.resolve(new Map(tops.map(top => [top, pageAt(top)]))),
    readFirst: (first, then) => {
      rounds++
      return Promise.resolve(first.length > 0 ? { first: true, pages: new Map() } : { first: false, pages: new Map(then.map(top => [top, pageAt(top)])) })
    },
    write: () => Promise.resolve(),
  }
  const { commits } = await historyFrom('org/repo', 'token', [chain(0)], pages, () => assert.fail('nothing read of GitHub'))
  assert.equal(commits.length, HISTORY_GLUED, 'no round spent on the unreadable alone')
  assert.ok(rounds <= 20, String(rounds))
})

test('a line whose parent has no page readable goes on by a page at a commit listed, though another line\'s parents keep giving pages', async () => {
  // Two lines, a of 3000 commits and b of 300, merged at the top (`top`). A
  // page is kept from every commit of each, but b's third's is unreadable (as
  // a REST page is to a reader with GraphQL): b goes on past it only by the
  // page at its second, listed, while a's parents keep answering, as far as
  // gluing goes.
  const id = (line, at) => (line * 1_000_000 + at).toString(16).padStart(40, '0')
  const top = 'e'.repeat(40)
  const end = line => line === 1 ? 3000 : 300
  const node = (line, at) => ({ sha: id(line, at), parents: at < end(line) ? [id(line, at + 1)] : [], subject: '', authorName: null, authorLogin: null, committedAt: null })
  const at = sha => ({ line: Math.floor(Number.parseInt(sha, 16) / 1_000_000), at: Number.parseInt(sha, 16) % 1_000_000 })
  const pageAt = sha => sha === top ? [{ ...node(0, 0), sha: top, parents: [id(1, 1), id(2, 1)] }, node(1, 1), node(2, 1), node(2, 2)]
    : Array.from({ length: Math.min(100, end(at(sha).line) + 1 - at(sha).at) }, (_, index) => node(at(sha).line, at(sha).at + index))
  const readable = sha => sha !== id(2, 3)
  const answer = tops => new Map(tops.filter(readable).map(sha => [sha, pageAt(sha)]))
  const pages = {
    read: tops => Promise.resolve(answer(tops)),
    readFirst: (first, then) => Promise.resolve(first.length > 0 ? { first: true, pages: answer(first) } : { first: false, pages: answer(then) }),
    write: () => Promise.resolve(),
  }
  const { commits } = await historyFrom('org/repo', 'token', [top], pages, () => assert.fail('nothing read of GitHub'))
  const listed = new Set(commits.map(commit => commit.sha))
  assert.equal(listed.size, HISTORY_GLUED)
  assert.ok(Array.from({ length: 300 }, (_, index) => id(2, index + 1)).every(sha => listed.has(sha)), 'b whole, beside a as far as gluing goes')
})
