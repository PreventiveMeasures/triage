import assert from 'node:assert/strict'
import { test } from 'node:test'
import { namedAccounts } from '../common/managed/github-logins.ts'
import { COAUTHORS_READ } from '../server-managed/commit-coauthors.ts'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { historyPageStore, repositoryReadStore } from '../server-managed/npm-kept.ts'
import { historyFrom } from '../server-managed/repository-history.ts'
import { PULSE_YEAR_VERSION, StatsPending, YEAR_COMMITS, commitStats, periodStats, pulseSince, repositoryActivity, repositoryLines, repositoryStats, withLines, yearCommits }
  from '../server-managed/repository-pulse.ts'
import { createSession } from '../server-managed/session.ts'

const config = { sessionCookieName: 'sid', cookieSecure: false, sessionTtlMs: 60_000 }
const repo = { repoId: 1, fullName: 'org/repo', private: false, installationId: null, defaultBranch: 'main', htmlUrl: '', addedBy: null }
const publicMetadata = { id: 1, full_name: 'org/repo', private: false, visibility: 'public', default_branch: 'main' }
const userTokens = { accessToken: 'login-token', refreshToken: null, expiresAt: null }
const HOUR = 3_600_000
const DAY = 24 * HOUR
const WEEK = 7 * DAY

// A year's weeks as GitHub's statistics count them, in seconds: the oldest,
// the latest, and one before the year.
const [w0, w1, older] = [1_757_808_000, 1_757_808_000 + WEEK / 1000, 1_757_808_000 - 60 * WEEK / 1000]
const stats = {
  commit_activity: [{ week: w1, days: [0, 1, 2, 0, 0, 0, 0], total: 3 }, { week: w0, days: [1, 0, 0, 0, 0, 0, 0, 9], total: 1 }, { week: 'x' }],
  code_frequency: [[w0, 10, -4], [w1, 5, -1], [older, 100, -100]],
  contributors: [
    { author: { login: 'ada', id: 7 }, weeks: [{ w: older, a: 9, d: 9, c: 9 }, { w: w1, a: 3, d: 1, c: 2 }, { w: w0, a: 0, d: 0, c: 0 }] },
    { author: { login: 'grace' }, weeks: [{ w: w0, a: 1, d: 0, c: 5 }] },
    { author: null, weeks: [{ w: w0, a: 1, d: 0, c: 50 }] },
    { author: { login: 'not a login!' }, weeks: [{ w: w0, a: 1, d: 0, c: 50 }] },
    { author: { login: 'linus' }, weeks: [{ w: older, a: 1, d: 0, c: 50 }] },
  ],
  punch_card: [[0, 9, 4], [6, 23, 2], [7, 0, 9], [1, 24, 1], [2, 3, -1]],
}

// The default branch, `length` commits `step` apart (an hour) from `now`,
// each the parent of the one before, its lines and its author's time two
// hours east of UTC; its head the first.
const shaOf = at => at.toString(16).padStart(40, '0')
const chain = (length, now, step = HOUR) => Array.from({ length }, (_, at) => ({ oid: shaOf(at), message: `Commit ${at}`,
  committedDate: new Date(now - at * step).toISOString(), additions: at % 5, deletions: 1,
  author: { name: 'Ada', date: new Date(now - at * step + 2 * HOUR).toISOString().replace('Z', '+02:00'), user: { login: 'ada', databaseId: 7 } },
  parents: { nodes: at + 1 < length ? [{ oid: shaOf(at + 1) }] : [] } }))

// GitHub, as the pulse reads it: each statistic answered by `answer`, the
// default branch's head and history from `commits` (as many as a hundred
// from each commit asked), and other GraphQL (the period's searches) by
// `graphql`; `asked` the statistics asked and the GraphQL bodies.
function github(t, { answer = kind => Response.json(stats[kind]), commits = [], graphql = () => ({ data: {} }) } = {}) {
  const asked = []
  t.mock.method(globalThis, 'fetch', (input, options = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    if (url.pathname === '/repos/org/repo') return Promise.resolve(Response.json(publicMetadata))
    if (url.pathname === '/graphql') {
      const body = JSON.parse(options.body)
      asked.push(body)
      if (body.query.includes('defaultBranchRef { target { oid } }')) {
        return Promise.resolve(Response.json({ data: { repository: { defaultBranchRef: commits.length > 0 ? { target: { oid: commits[0].oid } } : null } } }))
      }
      if (body.query.includes('history(first:')) {
        const tops = Object.entries(body.variables).filter(([name]) => /^o\d+$/u.test(name))
        return Promise.resolve(Response.json({ data: { repository: Object.fromEntries(tops.map(([name, top]) => {
          const from = commits.findIndex(commit => commit.oid === top)
          return [`b${name.slice(1)}`, from < 0 ? null : { history: { nodes: commits.slice(from, from + 100) } }]
        })) } }))
      }
      return Promise.resolve(Response.json(graphql(body)))
    }
    const kind = /^\/repos\/org\/repo\/stats\/(\w+)$/u.exec(url.pathname)?.[1]
    if (kind) {
      asked.push(kind)
      return Promise.resolve(answer(kind))
    }
    return Promise.resolve(Response.json({ message: 'Not Found' }, { status: 404 }))
  })
  return asked
}

// Pages kept in memory, by their tops.
const memoryPages = () => {
  const kept = new Map()
  return { kept, read: tops => Promise.resolve(new Map(tops.flatMap(top => kept.has(top) ? [[top, kept.get(top)]] : []))),
    write: (top, commits) => { kept.set(top, commits); return Promise.resolve() } }
}
const pages = () => memoryPages()
const graphQueries = asked => asked.filter(item => typeof item === 'object' && item.query.includes('history(first:')).length

test('a commit read with GraphQL tells the lines it adds and removes, and when its author made it in their own time zone', async t => {
  const now = Date.UTC(2026, 9, 15, 12)
  const commits = chain(3, now)
  commits[1].author.date = '2026-10-15T06:00:00-05:30'
  commits[2].author.date = '2026-10-15T06:00:00Z'
  github(t, { commits })
  const { commits: read } = await historyFrom('org/repo', 'token', [commits[0].oid], pages())
  assert.deepEqual(read.map(commit => [commit.additions, commit.deletions, commit.authoredAt, commit.authorZone]), [
    [0, 1, now, 120], [1, 1, Date.UTC(2026, 9, 15, 11, 30), -330], [2, 1, Date.UTC(2026, 9, 15, 6), 0]])
})

test('the year is read from the head on through the pages kept, those not kept a few queries of GitHub an answer, the rest by the next; past YEAR_COMMITS, too many', async t => {
  const now = Date.UTC(2026, 9, 15, 12)
  const asked = github(t, { commits: chain(1200, now, DAY) })
  const kept = pages()
  // 301 commits since, a day apart: four pages, the last as far as thirty
  // days before them.
  const short = await yearCommits('org/repo', 'token', shaOf(0), now - 300 * DAY, kept)
  assert.equal(short.complete, true)
  assert.equal(short.commits.length, 301)
  assert.equal(graphQueries(asked), 4)
  assert.equal((await yearCommits('org/repo', 'token', shaOf(0), now - 300 * DAY, kept)).complete, true)
  assert.equal(graphQueries(asked), 4, 'all of it kept')
  // 901 since: five queries an answer, the rest by the next, those read kept.
  const long = await yearCommits('org/repo', 'token', shaOf(0), now - 900 * DAY, kept)
  assert.deepEqual(long, { complete: false, read: 900, tooMany: false }, 'four kept, then five read')
  assert.equal(graphQueries(asked), 9)
  const rest = await yearCommits('org/repo', 'token', shaOf(0), now - 900 * DAY, kept)
  assert.deepEqual([rest.complete, rest.commits.length, graphQueries(asked)], [true, 901, 10])
  // A year past YEAR_COMMITS, its pages kept: too many to count.
  const many = memoryPages()
  const all = Array.from({ length: YEAR_COMMITS + 200 }, (_, at) => ({ sha: shaOf(at), parents: [shaOf(at + 1)], subject: '', authorName: null, authorLogin: null,
    committedAt: now - at * 60_000, additions: 0, deletions: 0, authoredAt: null, authorZone: null }))
  for (let from = 0; from < all.length; from += 100) many.kept.set(all[from].sha, all.slice(from, from + 100))
  t.mock.restoreAll()
  const none = github(t, { commits: [] })
  const counted = await yearCommits('org/repo', 'token', shaOf(0), 0, many)
  assert.deepEqual([counted.complete, counted.tooMany, counted.read > YEAR_COMMITS, graphQueries(none)], [false, true, true, 0])
})

test('a commit dated before the year whose parent is dated in it, its clock behind, is read on from all the same', async t => {
  const now = Date.UTC(2026, 9, 15, 12)
  const commits = chain(300, now, DAY)
  // The last of the first page dated before the year, its parent, the first
  // of the next, in it.
  commits[100].committedDate = new Date(now - DAY).toISOString()
  github(t, { commits })
  const read = await yearCommits('org/repo', 'token', shaOf(0), now - 95 * DAY, pages())
  assert.equal(read.complete, true)
  assert.ok(read.commits.some(commit => commit.sha === shaOf(100)))
  assert.equal(read.commits.length, 97)
})

test('a year counted from its commits: a week a row from its first Sunday, merges left out; its lines; contributors by login, else name; hours in each author\'s own time zone', () => {
  const first = Date.UTC(2025, 9, 19)
  const commit = (sha, more) => ({ sha, parents: ['p'], subject: '', authorName: 'Ada', authorLogin: 'ada', authorId: 7, committedAt: first + DAY + 10 * HOUR, additions: 3, deletions: 1,
    authoredAt: first + DAY + 10 * HOUR, authorZone: 120, ...more })
  const read = commitStats([
    commit('a'),
    commit('merge', { parents: ['p', 'q'] }),
    commit('before', { committedAt: first - DAY }),
    commit('unnamed', { authorLogin: null, authorId: null, authorName: 'Alan Kay', committedAt: first + WEEK + 2 * DAY + 23 * HOUR, additions: 10, deletions: 0, authorZone: null }),
    commit('e', { committedAt: first + WEEK, additions: 1, deletions: 1 }),
    commit('undated', { committedAt: null }),
  ], first)
  assert.equal(read.weeks.length, 52)
  const none = [0, 0]
  const noAgents = [0, 0, 0, 0, 0, 0, 0]
  assert.deepEqual(read.weeks[0], { week: first, days: [0, 1, 0, 0, 0, 0, 0], commits: 1, additions: 3, deletions: 1, dayLines: [none, [3, 1], none, none, none, none, none],
    agentDays: noAgents })
  assert.deepEqual(read.weeks[1], { week: first + WEEK, days: [1, 0, 1, 0, 0, 0, 0], commits: 2, additions: 11, deletions: 1,
    dayLines: [[1, 1], none, [10, 0], none, none, none, none], agentDays: noAgents })
  assert.deepEqual(read.contributors, [
    { login: 'ada', id: 7, name: 'Ada', weeks: [[first, 1, 3, 1], [first + WEEK, 1, 1, 1]], days: [[first + DAY, 1, 3, 1], [first + WEEK, 1, 1, 1]] },
    { login: null, id: null, name: 'Alan Kay', weeks: [[first + WEEK, 1, 10, 0]], days: [[first + WEEK + 2 * DAY, 1, 10, 0]] },
  ])
  assert.equal(read.punch[1][12], 2, 'Ada\'s Monday 10:00 UTC and Sunday 10:00 UTC… two hours east')
  assert.equal(read.punch[2][23], 1, 'one whose author told no time zone, in UTC')
  assert.equal(read.lines, true)
})

test('a year counts each day the commits an agent made or co-authored: one of GitHub\'s agents their author, by account, else by name, or any co-author an agent', () => {
  const first = Date.UTC(2025, 9, 19)
  const claude = { name: 'Claude', login: null, id: null, agent: 'claude' }
  const commit = (sha, more) => ({ sha, parents: ['p'], subject: '', authorName: 'Ada', authorLogin: 'ada', authorId: 7, committedAt: first + DAY, coauthors: [], ...more })
  const read = commitStats([
    commit('alone'),
    commit('with a person', { coauthors: [{ name: 'Grace', login: 'grace', id: 9 }] }),
    commit('with Claude', { coauthors: [{ name: 'Grace', login: 'grace', id: 9 }, claude] }),
    commit('by Claude', { authorLogin: 'claude', authorId: 81847, authorName: 'Claude', committedAt: first + 2 * DAY }),
    commit('another account of its login', { authorLogin: 'claude', authorId: 5, authorName: 'Claude', committedAt: first + 2 * DAY }),
    commit('by Cursor', { authorLogin: null, authorId: null, authorName: 'Cursor Agent', committedAt: first + WEEK }),
    commit('kept before co-authors were read', { coauthors: undefined, committedAt: first + WEEK }),
    commit('merge', { parents: ['p', 'q'], coauthors: [claude] }),
  ], first)
  assert.deepEqual(read.weeks.slice(0, 2).map(week => [week.days, week.agentDays]), [
    [[0, 3, 2, 0, 0, 0, 0], [0, 1, 1, 0, 0, 0, 0]], [[2, 0, 0, 0, 0, 0, 0], [1, 0, 0, 0, 0, 0, 0]]])
})

test('when a period\'s commits are made, where counted from them: its last weeks\' alone; else, as GitHub\'s statistics count it, the year\'s or more', () => {
  const first = Date.UTC(2025, 9, 19)
  const at = (sha, committedAt) => ({ sha, parents: ['p'], subject: '', authorName: 'Ada', authorLogin: 'ada', authorId: 7, committedAt, additions: 1, deletions: 0,
    authoredAt: committedAt, authorZone: 0 })
  // Mondays at 10:00: one in the year's first week, one four weeks from its
  // end, one in its last week.
  const read = commitStats([at('a', first + DAY + 10 * HOUR), at('b', first + 48 * WEEK + DAY + 10 * HOUR), at('c', first + 51 * WEEK + DAY + 10 * HOUR)], first)
  const monday = weeks => periodStats(read, weeks).punch[1][10]
  assert.deepEqual([monday(1), monday(4), monday(13), monday(52)], [1, 2, 2, 3])
  assert.deepEqual(Object.keys(periodStats(read, 4)).toSorted(), ['contributors', 'lines', 'periodPunch', 'punch', 'weeks'], 'the other periods\' not sent')
  assert.equal(periodStats(read, 4).periodPunch, true)
  const counted = { weeks: [], contributors: [], punch: read.punch, lines: null }
  assert.deepEqual(periodStats(counted, 4), { ...counted, periodPunch: false })
})

test('a year\'s contributors are its authors\' accounts, whatever they were renamed from: a login GitHub named two by, each apart; one\'s commits read before ids were, its one account\'s', () => {
  const first = Date.UTC(2025, 9, 19)
  const commit = (sha, authorLogin, authorId) => ({ sha, parents: ['p'], subject: '', authorName: null, authorLogin, authorId, committedAt: first + DAY, additions: 1, deletions: 0,
    authoredAt: null, authorZone: null })
  // Ada committed as ada-old before renaming, a commit of each read before
  // ids were; Linus as LINUS before a rename of its case alone; octo as
  // OCTO, one commit read before ids were.
  const read = commitStats([commit('a', 'octo', 2), commit('b', 'octo', 9), commit('c', 'octo', 9), commit('d', 'octo', undefined), commit('i', 'OCTO', undefined),
    commit('e', 'ada', null), commit('f', 'ada', 7), commit('g', 'ada-old', 7), commit('h', 'Ada-Old', null), commit('j', 'linus', 5), commit('k', 'LINUS', null)], first)
  assert.deepEqual(read.contributors.map(person => [person.login, person.id, person.weeks[0][1]]),
    [['ada', 7, 4], ['octo', 9, 2], ['octo', null, 2], ['linus', 5, 2], ['octo', 2, 1]],
    'one contributor by the login it committed as first listed; whose the commit with no id of a login named by two is, no telling')
  assert.deepEqual([...namedAccounts(read)], [['ada', 7], ['octo', 'ambiguous'], ['linus', 5]], 'such a login no one\'s')
})

test('a year past YEAR_COMMITS is GitHub\'s statistics, each asked once, together: any still computed, pending; lines apart, none past 10,000 commits', async t => {
  github(t)
  const read = await repositoryStats('org/repo', 'token')
  assert.deepEqual(read.weeks, [
    { week: w0 * 1000, days: [1, 0, 0, 0, 0, 0, 0], commits: 1, additions: null, deletions: null },
    { week: w1 * 1000, days: [0, 1, 2, 0, 0, 0, 0], commits: 3, additions: null, deletions: null },
  ])
  assert.deepEqual(read.contributors, [{ login: 'grace', id: null, name: null, weeks: [[w0 * 1000, 5, 0, 0]] },
    { login: 'ada', id: 7, name: null, weeks: [[w1 * 1000, 2, 0, 0]] }])
  assert.deepEqual([read.punch[0][9], read.punch[6][23], read.punch[2][3], read.lines], [4, 2, 0, null])
  const lines = await repositoryLines('org/repo', 'token', w0 * 1000)
  assert.deepEqual(lines, { weeks: [[w0 * 1000, 10, 4], [w1 * 1000, 5, 1]], contributors: [{ login: 'ada', weeks: [[w1 * 1000, 3, 1]] }, { login: 'grace', weeks: [[w0 * 1000, 1, 0]] }],
    lines: true })
  const merged = withLines(read, lines)
  assert.deepEqual([merged.weeks.map(week => [week.additions, week.deletions]), merged.contributors[1].weeks, merged.lines], [[[10, 4], [5, 1]], [[w1 * 1000, 2, 3, 1]], true])
  assert.deepEqual([withLines(read, null).lines, withLines(read, { weeks: [], contributors: [], lines: false }).lines], [null, false])
  t.mock.restoreAll()
  const asked = github(t, { answer: kind => kind === 'contributors' ? Response.json({}, { status: 202 }) : Response.json(stats[kind]) })
  await assert.rejects(repositoryStats('org/repo', 'token'), StatsPending)
  assert.deepEqual(asked.toSorted(), ['commit_activity', 'contributors', 'punch_card'], 'each asked once')
  t.mock.restoreAll()
  github(t, { answer: kind => kind === 'code_frequency' ? Response.json({ message: 'too many commits' }, { status: 422 }) : Response.json(stats[kind]) })
  assert.deepEqual(await repositoryLines('org/repo', 'token', 0), { weeks: [], contributors: [], lines: false })
  t.mock.restoreAll()
  github(t, { answer: () => new Response(null, { status: 204 }) })
  assert.deepEqual(await repositoryStats('org/repo', 'token'), { weeks: [], contributors: [], punch: Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0)), lines: null })
  t.mock.restoreAll()
  github(t, { answer: () => Response.json({ message: 'odd' }) })
  await assert.rejects(repositoryStats('org/repo', 'token'), { message: 'github-malformed' })
})

test('a period starts on the Sunday (UTC) that many weeks back, this week the last of them', () => {
  const thursday = Date.UTC(2026, 9, 15, 12)
  assert.equal(pulseSince(1, thursday), Date.UTC(2026, 9, 11))
  assert.equal(pulseSince(4, thursday), Date.UTC(2026, 8, 20))
  assert.equal(pulseSince(1, Date.UTC(2026, 9, 11)), Date.UTC(2026, 9, 11), 'a Sunday starts its own week')
})

test('the pull requests and issues of a period are searched by the day, and over the same days a period earlier; the latest listed first', async t => {
  const node = (number, more) => ({ number, title: ` Pull ${number} `, createdAt: '2026-10-01T00:00:00Z', author: { login: 'ada', databaseId: 7 }, ...more })
  const asked = github(t, { graphql: () => ({ data: {
    merged: { issueCount: 12, nodes: [node(4, { pullState: 'MERGED', isDraft: false, mergedAt: '2026-10-02T00:00:00Z' }),
      node(5, { pullState: 'MERGED', isDraft: false, mergedAt: '2026-10-09T00:00:00Z' }), null, node(-1, { pullState: 'MERGED' })] },
    mergedBefore: { issueCount: 8 },
    opened: { issueCount: 1, nodes: [node(6, { pullState: 'OPEN', isDraft: true, author: null })] },
    closed: { issueCount: 2, nodes: [node(3, { issueState: 'CLOSED', stateReason: 'NOT_PLANNED', closedAt: '2026-10-03T00:00:00Z' })] },
    created: { issueCount: 'x' },
  } }) })
  const read = await repositoryActivity('org/repo', 'token', 4, Date.UTC(2026, 9, 15, 12))
  assert.match(asked[0].query, /merged: search\(type: ISSUE, query: \$merged, first: 50\) \{\s*issueCount nodes/u, 'merged searched wide, GitHub sorting by no merge')
  assert.match(asked[0].query, /opened: search\(type: ISSUE, query: \$opened, first: 10\)/u)
  assert.match(asked[0].query, /closed: search\(type: ISSUE, query: \$closed, first: 50\)/u)
  assert.match(asked[0].query, /mergedBefore: search\(type: ISSUE, query: \$mergedBefore, first: 1\) \{\s*issueCount\s*\}/u, 'counted alone')
  assert.deepEqual(asked[0].variables, {
    merged: 'repo:org/repo is:pr is:merged merged:>=2026-09-20 sort:updated-desc', mergedBefore: 'repo:org/repo is:pr is:merged merged:2026-08-23..2026-09-17 sort:updated-desc',
    opened: 'repo:org/repo is:pr created:>=2026-09-20 sort:created-desc', openedBefore: 'repo:org/repo is:pr created:2026-08-23..2026-09-17 sort:created-desc',
    closed: 'repo:org/repo is:issue is:closed closed:>=2026-09-20 sort:updated-desc', closedBefore: 'repo:org/repo is:issue is:closed closed:2026-08-23..2026-09-17 sort:updated-desc',
    created: 'repo:org/repo is:issue created:>=2026-09-20 sort:created-desc', createdBefore: 'repo:org/repo is:issue created:2026-08-23..2026-09-17 sort:created-desc',
  })
  assert.deepEqual([read.since, read.previousSince], [Date.UTC(2026, 8, 20), Date.UTC(2026, 7, 23)])
  assert.deepEqual([read.merged.count, read.merged.previous, read.created.count, read.created.previous], [12, 8, 0, 0])
  assert.deepEqual(read.merged.items.map(item => item.number), [5, 4], 'the latest merged first, those not one left out')
  assert.deepEqual(read.merged.items[0], { number: 5, title: 'Pull 5', author: 'ada', authorId: 7, at: Date.UTC(2026, 9, 9), createdAt: Date.UTC(2026, 9, 1), kind: 'pulls', state: 'merged', draft: false })
  assert.deepEqual(read.opened.items[0], { number: 6, title: 'Pull 6', author: null, authorId: null, at: Date.UTC(2026, 9, 1), createdAt: Date.UTC(2026, 9, 1), kind: 'pulls', state: 'open', draft: true })
  assert.deepEqual(read.closed.items[0], { number: 3, title: 'Pull 3', author: 'ada', authorId: 7, at: Date.UTC(2026, 9, 3), createdAt: Date.UTC(2026, 9, 1), kind: 'issues', state: 'closed',
    reason: 'not-planned' })
})

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
  const request = async (query, { method = 'GET' } = {}) => {
    const res = { status: 0, body: '', headers: {}, writeHead(status, headers) { this.status = status; this.headers = headers }, end(body) { this.body = body } }
    await handler({ method, url: `/api/admin/repositories/pulse?${new URLSearchParams(query)}`, headers: { cookie: session.setCookie.split(';')[0] } }, res)
    return { status: res.status, body: JSON.parse(res.body) }
  }
  return Object.assign(request, { db })
}

test('the pulse counts the year from the default branch\'s commits as Commits keeps them, read a few queries an answer, kept by its head; the period\'s pull requests and issues apart', async t => {
  const request = await fixture(t)
  const asked = github(t, { commits: chain(700, Date.now()), graphql: () => ({ data: { merged: { issueCount: 3, nodes: [] } } }) })
  const first = await request({ repoId: '1', weeks: '13' })
  assert.equal(first.status, 200)
  assert.deepEqual([first.body.weeks, first.body.merged.count, first.body.stats, first.body.reading, first.body.pending], [13, 3, null, 500, false], 'five pages read')
  assert.equal(asked.filter(item => typeof item === 'string').length, 0, 'none of GitHub\'s statistics asked')
  const second = await request({ repoId: '1', weeks: '13' })
  assert.equal(second.body.reading, null)
  assert.equal(second.body.stats.weeks.length, 52)
  assert.equal(second.body.stats.weeks.reduce((sum, week) => sum + week.commits, 0), 700)
  assert.equal(second.body.stats.weeks.reduce((sum, week) => sum + week.additions, 0), 1400, 'its lines, as each commit tells them')
  assert.deepEqual(second.body.stats.contributors.map(person => [person.login, person.id, person.name]), [['ada', 7, 'Ada']])
  assert.equal(second.body.stats.lines, true)
  assert.equal(graphQueries(asked), 7, 'the rest read, those kept not again')
  const reads = asked.length
  const month = await request({ repoId: '1' })
  assert.equal(month.body.stats.weeks.length, 52, 'the year kept by its head, for every period')
  assert.equal(asked.length, reads + 1, 'the month\'s pull requests and issues alone read')
  // When each period's commits are made, its own, the others' not sent.
  const made = body => body.stats.punch.flat().reduce((sum, count) => sum + count, 0)
  const last = (body, weeks) => body.stats.weeks.slice(-weeks).reduce((sum, week) => sum + week.commits, 0)
  assert.deepEqual([made(month.body), made(second.body)], [last(month.body, 4), last(second.body, 13)])
  assert.deepEqual([month.body.stats.periodPunch, 'punches' in month.body.stats], [true, false])
})

test('a head moved on, its year read anew, the year last counted answered meanwhile', async t => {
  const request = await fixture(t)
  const all = chain(1300, Date.now())
  const commits = all.slice(600)
  github(t, { commits })
  const total = body => body.stats.weeks.reduce((sum, week) => sum + week.commits, 0)
  await request({ repoId: '1' })
  assert.equal(total((await request({ repoId: '1' })).body), 700)
  commits.unshift(...all.slice(0, 600))
  await repositoryReadStore(request.db).write('1\0pulse-head', { sha: all[0].oid }, Date.now())
  const moved = await request({ repoId: '1', weeks: '1' })
  assert.deepEqual([moved.body.reading, total(moved.body)], [500, 700], 'five pages read, the year as it was')
  const counted = await request({ repoId: '1', weeks: '1' })
  assert.deepEqual([counted.body.reading, total(counted.body)], [null, 1300])
})

test('a head moved on past YEAR_COMMITS, GitHub still computing its statistics, the year last counted answered meanwhile', async t => {
  const request = await fixture(t)
  github(t, { commits: chain(700, Date.now()), answer: () => Response.json({}, { status: 202 }) })
  const total = body => body.stats.weeks.reduce((sum, week) => sum + week.commits, 0)
  await request({ repoId: '1' })
  assert.equal(total((await request({ repoId: '1' })).body), 700)
  const head = 'f'.repeat(40)
  const store = repositoryReadStore(request.db)
  await store.write('1\0pulse-head', { sha: head }, Date.now())
  await store.write(`1\0pulse-year\0${PULSE_YEAR_VERSION}\0${head}\0${pulseSince(52, Date.now())}`, { tooMany: true }, Date.now())
  const moved = await request({ repoId: '1' })
  assert.deepEqual([moved.body.pending, moved.body.reading, total(moved.body)], [true, null, 700])
})

test('pages kept without lines, as GitHub\'s REST API lists them, are read again for the pulse', async t => {
  const request = await fixture(t)
  const commits = chain(50, Date.now())
  const asked = github(t, { commits })
  const page = commits.map(node => ({ sha: node.oid, parents: node.parents.nodes.map(parent => parent.oid), subject: node.message, authorName: 'Ada', authorLogin: 'ada',
    coauthors: [], committedAt: Date.parse(node.committedDate), additions: null, deletions: null, authoredAt: null, authorZone: null }))
  await historyPageStore(request.db).write(`1\0${COAUTHORS_READ}\0${commits[0].oid}`, page, Date.now())
  const answer = await request({ repoId: '1', weeks: '4' })
  assert.equal(graphQueries(asked), 1, 'read again with its lines')
  assert.equal(answer.body.stats.weeks.reduce((sum, week) => sum + week.additions, 0), 100)
})

test('a repository with no commits counts none', async t => {
  const request = await fixture(t)
  github(t, { commits: [] })
  const answer = await request({ repoId: '1', weeks: '4' })
  assert.deepEqual([answer.body.stats.weeks.length, answer.body.stats.weeks.every(week => week.commits === 0), answer.body.reading], [52, true, null])
})

test('the pulse is read only with a token by a reader whose grants reach the whole repository, of a week, a month, a quarter or a year', async t => {
  github(t)
  assert.deepEqual(await (await fixture(t, { tokens: null }))({ repoId: '1' }), { status: 403, body: { error: 'github-token-required' } })
  assert.deepEqual(await (await fixture(t, { role: 'manage' }))({ repoId: '1' }), { status: 404, body: { error: 'no-directory' } })
  const request = await fixture(t)
  for (const query of [{ repoId: '0' }, { repoId: '1', weeks: '2' }, { repoId: '1', weeks: '' }, { repoId: '1', weeks: 'x' }]) {
    assert.equal((await request(query)).status, 400, JSON.stringify(query))
  }
  assert.equal((await request({ repoId: '1' }, { method: 'POST' })).status, 405)
})

test('GitHub refusing the default branch refuses the pulse as it refused it', async t => {
  github(t, { graphql: () => ({ errors: [{ type: 'NOT_FOUND' }] }) })
  t.mock.restoreAll()
  t.mock.method(globalThis, 'fetch', input => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    if (url.pathname === '/repos/org/repo') return Promise.resolve(Response.json(publicMetadata))
    return Promise.resolve(Response.json({ errors: [{ type: 'NOT_FOUND' }] }))
  })
  const request = await fixture(t)
  assert.equal((await request({ repoId: '1', weeks: '1' })).status, 404)
})

test('the latest merged are listed of those most recently updated, one merged long ago but updated since giving way to those merged later', async t => {
  const merged = day => ({ number: day, title: `Pull ${day}`, pullState: 'MERGED', isDraft: false, createdAt: '2026-09-20T00:00:00Z', author: { login: 'ada' },
    mergedAt: `2026-10-${String(day).padStart(2, '0')}T00:00:00Z` })
  // As GitHub answers them, by when each was last updated: the first merged
  // on the 1st, a comment on it since.
  github(t, { graphql: () => ({ data: { merged: { issueCount: 12, nodes: [merged(1), ...Array.from({ length: 11 }, (_, at) => merged(12 - at))] } } }) })
  const read = await repositoryActivity('org/repo', 'token', 4, Date.UTC(2026, 9, 15, 12))
  assert.deepEqual(read.merged.items.map(item => item.number), [12, 11, 10, 9, 8, 7, 6, 5, 4, 3])
})
