import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { HISTORY_GLUED, historyFrom } from '../server-managed/repository-history.ts'
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
      { sha: a, parents: [b, c], subject: 'Merge feature', authorName: 'octo name', authorLogin: 'octo', committedAt: Date.parse('2026-10-02T10:00:00Z') },
      { sha: b, parents: [d], subject: 'Main work', authorName: 'someone name', authorLogin: null, committedAt: Date.parse('2026-10-02T10:00:00Z') },
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

test('a commit by a user of the app names them as the app does', async t => {
  const request = await fixture(t)
  github(t)
  const { body } = await request({ repoId: '1', ref: 'heads/main' })
  assert.deepEqual(body.users, {}, 'octo is no user of the app')
  const db = request.db
  const octo = await createSession(config, db, { githubUserId: 2, login: 'Octo', name: 'Octo Cat', avatarUrl: null }, Date.now())
  await db.setUserRole(octo.userId, 'view')
  assert.deepEqual((await request({ repoId: '1', ref: 'heads/main' })).body.users, { octo: { id: octo.userId, login: 'Octo', name: 'Octo Cat' } })
})

test('with a token, a revision\'s commits are named by every branch All branches reads and the latest tags, not GitHub\'s first page of each by name', async t => {
  const graphql = ({ query, variables }) => ({ data: { repository: query.includes('refs/heads/')
    ? { defaultBranchRef: { name: 'main', target: { oid: a, committedDate: '2026-10-02T10:00:00Z' } },
      tags: { nodes: [{ name: 'v2', target: { __typename: 'Commit', oid: b } }] },
      branches: { pageInfo: { hasNextPage: variables.after === null, endCursor: 'p1' },
        nodes: variables.after === null ? [{ name: 'main', target: { oid: a, committedDate: null } }] : [{ name: 'zz-past-the-first-hundred', target: { oid: c, committedDate: null } }] } }
    : { b0: { history: { nodes: [{ oid: a, messageHeadline: 'Work', committedDate: '2026-10-02T10:00:00Z', author: { name: 'Ada', user: null }, parents: { nodes: [] } }] } } } } })
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
      { oid: a, messageHeadline: 'Merge feature', committedDate: '2026-10-02T10:00:00Z', author: { name: 'Octo', user: { login: 'octo' } }, parents: { nodes: [{ oid: b }, { oid: c }] } },
      { oid: b, messageHeadline: 'Main work', committedDate: '2026-10-01T10:00:00Z', author: { name: 'Octo', user: null }, parents: { nodes: [{ oid: d }] } },
    ] } },
    b1: { history: { pageInfo: { hasNextPage: true }, nodes: [
      { oid: c, messageHeadline: 'Feature', committedDate: '2026-10-01T12:00:00Z', author: null, parents: { nodes: [{ oid: d }] } },
      { oid: d, messageHeadline: 'Root', committedDate: '2020-01-01T00:00:00Z', author: null, parents: { nodes: [] } },
    ] } },
    b2: { history: { pageInfo: { hasNextPage: false }, nodes: [{ oid: d, messageHeadline: 'Root', committedDate: '2020-01-01T00:00:00Z', author: null, parents: { nodes: [] } }] } },
  }
  const graphql = ({ query, variables }) => ({ data: { repository: query.includes('refs/heads/')
    ? { defaultBranchRef: head('main', a, '2026-10-02T10:00:00Z'), ...heads[variables.after] } : histories } })
  const request = await fixture(t, { tokens: userTokens })
  const asked = github(t, { graphql })
  const { status, body } = await request({ repoId: '1', all: 'true' })
  assert.equal(status, 200)
  assert.deepEqual(body.commits.map(commit => commit.sha), [a, b, c, d])
  assert.deepEqual(body.branches.map(branch => branch.name), [...stale.map(ref => ref.name), 'feature', 'main'], 'every branch naming a commit listed')
  assert.deepEqual(body.tags, [{ name: 'v1', sha: d }, { name: 'v2', sha: c }, { name: 'light', sha: c }])
  assert.equal(body.defaultBranch, 'main')
  assert.equal(body.more, true, 'branches and older commits left out')
  const queries = asked.filter(entry => entry.path === '/graphql')
  assert.ok(queries.every(query => query.method === 'POST' && query.auth === 'Bearer login-token'))
  assert.deepEqual(queries.map(query => query.body.variables), [
    { owner: 'org', name: 'repo', after: null, tags: 100, first: true },
    { owner: 'org', name: 'repo', after: 'p2', tags: 100, first: false },
    // main, then the newest, feature, then 23 of the stale, all at one tip.
    { owner: 'org', name: 'repo', o0: a, o1: c, o2: d },
  ])
  assert.match(queries[2].body.query, /b2: object\(oid: \$o2\) \{ \.\.\. on Commit \{ history\(first: 100\)/u)
  // A tag's target, and those of as many as four annotated tags after it.
  assert.equal(queries[0].body.query.match(/target \{ __typename oid/gu).length, 5)
  // Asked again: its branches kept a while, each tip's page kept for good, nothing read of GitHub.
  assert.deepEqual((await request({ repoId: '1', all: 'true' })).body, body)
  assert.equal(asked.filter(entry => entry.path === '/graphql').length, 3)

  const anonymous = await fixture(t)
  assert.deepEqual(await anonymous({ repoId: '1', all: 'true' }), { status: 403, body: { error: 'github-token-required' } })
})

test('all branches names the branches it didn\'t read, newest first, and reads on from the commits a later page names, each commit once', async t => {
  const head = (name, oid, committedDate) => ({ name, target: { oid, committedDate } })
  // main and 24 others read; of those not, stale's tip isn't listed, older's is.
  const recent = Array.from({ length: 24 }, (_, index) => head(`recent-${index}`, a, '2026-10-01T00:00:00Z'))
  const branches = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [head('older', b, '2019-01-01T00:00:00Z'), ...recent, head('stale', c, '2020-01-01T00:00:00Z')] }
  const node = (oid, parents) => ({ oid, messageHeadline: `Commit ${oid[0]}`, committedDate: '2026-10-01T00:00:00Z', author: null, parents: { nodes: parents.map(parent => ({ oid: parent })) } })
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
    subject: item.messageHeadline, authorName: null, authorLogin: null, committedAt: Date.parse(item.committedDate) })), more: true, users: {} })
  const query = asked.findLast(entry => entry.path === '/graphql')
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
