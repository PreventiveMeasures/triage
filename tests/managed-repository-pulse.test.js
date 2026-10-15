import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { StatsPending, pulseSince, repositoryActivity, repositoryStats } from '../server-managed/repository-pulse.ts'
import { createSession } from '../server-managed/session.ts'

const config = { sessionCookieName: 'sid', cookieSecure: false, sessionTtlMs: 60_000 }
const repo = { repoId: 1, fullName: 'org/repo', private: false, installationId: null, defaultBranch: 'main', htmlUrl: '', addedBy: null }
const publicMetadata = { id: 1, full_name: 'org/repo', private: false, visibility: 'public', default_branch: 'main' }
const userTokens = { accessToken: 'login-token', refreshToken: null, expiresAt: null }
const WEEK = 7 * 86_400

// A year's weeks as GitHub counts them, in seconds: the oldest, the latest,
// and one before the year.
const [w0, w1, older] = [1_757_808_000, 1_757_808_000 + WEEK, 1_757_808_000 - 60 * WEEK]
const stats = {
  commit_activity: [{ week: w1, days: [0, 1, 2, 0, 0, 0, 0], total: 3 }, { week: w0, days: [1, 0, 0, 0, 0, 0, 0, 9], total: 1 }, { week: 'x' }],
  code_frequency: [[w0, 10, -4], [w1, 5, -1], [older, 100, -100]],
  contributors: [
    { author: { login: 'ada' }, weeks: [{ w: older, a: 9, d: 9, c: 9 }, { w: w1, a: 3, d: 1, c: 2 }, { w: w0, a: 0, d: 0, c: 0 }] },
    { author: { login: 'grace' }, weeks: [{ w: w0, a: 1, d: 0, c: 5 }] },
    { author: null, weeks: [{ w: w0, a: 1, d: 0, c: 50 }] },
    { author: { login: 'not a login!' }, weeks: [{ w: w0, a: 1, d: 0, c: 50 }] },
    { author: { login: 'linus' }, weeks: [{ w: older, a: 1, d: 0, c: 50 }] },
  ],
  punch_card: [[0, 9, 4], [6, 23, 2], [7, 0, 9], [1, 24, 1], [2, 3, -1]],
}

// GitHub's statistics, each answered by `answer(kind, asked)` (`asked` how
// many times it was), and its GraphQL by `graphql`; `asked` the paths and
// GraphQL bodies asked.
function github(t, { answer = kind => Response.json(stats[kind]), graphql = () => ({ data: {} }) } = {}) {
  const asked = []
  const counts = new Map()
  t.mock.method(globalThis, 'fetch', (input, options = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    if (url.pathname === '/repos/org/repo') return Promise.resolve(Response.json(publicMetadata))
    if (url.pathname === '/graphql') {
      const body = JSON.parse(options.body)
      asked.push(body)
      return Promise.resolve(Response.json(graphql(body)))
    }
    const kind = /^\/repos\/org\/repo\/stats\/(\w+)$/u.exec(url.pathname)?.[1]
    if (kind) {
      asked.push(kind)
      counts.set(kind, (counts.get(kind) ?? 0) + 1)
      return Promise.resolve(answer(kind, counts.get(kind)))
    }
    return Promise.resolve(Response.json({ message: 'Not Found' }, { status: 404 }))
  })
  return asked
}

const pending = () => Response.json({}, { status: 202 })

test('the statistics: a week a row, the oldest first, with its commits each day and its lines; contributors within the year, the most commits first; commits by day and hour', async t => {
  github(t)
  const read = await repositoryStats('org/repo', 'token')
  assert.deepEqual(read.weeks, [
    { week: w0 * 1000, days: [1, 0, 0, 0, 0, 0, 0], commits: 1, additions: 10, deletions: 4 },
    { week: w1 * 1000, days: [0, 1, 2, 0, 0, 0, 0], commits: 3, additions: 5, deletions: 1 },
  ])
  assert.deepEqual(read.contributors, [{ login: 'grace', weeks: [[w0 * 1000, 5, 1, 0]] }, { login: 'ada', weeks: [[w1 * 1000, 2, 3, 1]] }],
    'those GitHub names no one for, or none it could, and their weeks before the year, left out')
  assert.equal(read.punch.length, 7)
  assert.ok(read.punch.every(day => day.length === 24))
  assert.deepEqual([read.punch[0][9], read.punch[6][23], read.punch[2][3]], [4, 2, 0])
  assert.equal(read.punch.flat().reduce((sum, value) => sum + value, 0), 6, 'a day or hour that is none left out')
  assert.equal(read.lines, true)
})

test('statistics GitHub is computing are asked again, a while later each time, then told pending; none for a repository with no commits; lines none past 10,000 commits', async t => {
  const waits = []
  const wait = ms => { waits.push(ms); return Promise.resolve() }
  let asked = github(t, { answer: (kind, times) => kind === 'punch_card' || times > 1 ? Response.json(stats[kind]) : pending() })
  const read = await repositoryStats('org/repo', 'token', fetch, wait)
  assert.equal(read.weeks.length, 2)
  assert.deepEqual(waits, [1500])
  assert.deepEqual(asked.toSorted(), ['code_frequency', 'code_frequency', 'commit_activity', 'commit_activity', 'contributors', 'contributors', 'punch_card'], 'those computed asked once')
  waits.length = 0
  t.mock.restoreAll()
  github(t, { answer: kind => kind === 'contributors' ? pending() : Response.json(stats[kind]) })
  await assert.rejects(repositoryStats('org/repo', 'token', fetch, wait), StatsPending)
  assert.deepEqual(waits, [1500, 3000])
  t.mock.restoreAll()
  asked = github(t, { answer: kind => new Response(null, { status: 204, headers: { 'x-kind': kind } }) })
  assert.deepEqual(await repositoryStats('org/repo', 'token', fetch, wait), { weeks: [], contributors: [], punch: Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0)), lines: true })
  t.mock.restoreAll()
  github(t, { answer: kind => kind === 'code_frequency' ? Response.json({ message: 'too many commits' }, { status: 422 }) : Response.json(stats[kind]) })
  const large = await repositoryStats('org/repo', 'token', fetch, wait)
  assert.equal(large.lines, false)
  assert.deepEqual(large.weeks.map(week => [week.additions, week.deletions]), [[null, null], [null, null]])
  t.mock.restoreAll()
  github(t, { answer: () => Response.json({ message: 'odd' }) })
  await assert.rejects(repositoryStats('org/repo', 'token', fetch, wait), { message: 'github-malformed' })
})

test('a period starts on the Sunday (UTC) that many weeks back, this week the last of them', () => {
  const thursday = Date.UTC(2026, 9, 15, 12)
  assert.equal(pulseSince(1, thursday), Date.UTC(2026, 9, 11))
  assert.equal(pulseSince(4, thursday), Date.UTC(2026, 8, 20))
  assert.equal(pulseSince(1, Date.UTC(2026, 9, 11)), Date.UTC(2026, 9, 11), 'a Sunday starts its own week')
})

test('the pull requests and issues of a period are searched by the day, and over the same days a period earlier; the latest listed first', async t => {
  const node = (number, more) => ({ number, title: ` Pull ${number} `, createdAt: '2026-10-01T00:00:00Z', author: { login: 'ada' }, ...more })
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
  assert.deepEqual(read.merged.items[0], { number: 5, title: 'Pull 5', author: 'ada', at: Date.UTC(2026, 9, 9), createdAt: Date.UTC(2026, 9, 1), kind: 'pulls', state: 'merged', draft: false })
  assert.deepEqual(read.opened.items[0], { number: 6, title: 'Pull 6', author: null, at: Date.UTC(2026, 9, 1), createdAt: Date.UTC(2026, 9, 1), kind: 'pulls', state: 'open', draft: true })
  assert.deepEqual(read.closed.items[0], { number: 3, title: 'Pull 3', author: 'ada', at: Date.UTC(2026, 9, 3), createdAt: Date.UTC(2026, 9, 1), kind: 'issues', state: 'closed',
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
  return async (query, { method = 'GET' } = {}) => {
    const res = { status: 0, body: '', headers: {}, writeHead(status, headers) { this.status = status; this.headers = headers }, end(body) { this.body = body } }
    await handler({ method, url: `/api/admin/repositories/pulse?${new URLSearchParams(query)}`, headers: { cookie: session.setCookie.split(';')[0] } }, res)
    return { status: res.status, body: JSON.parse(res.body) }
  }
}

// What `promise` settles to, the timers it waits on run at once.
async function settled(t, promise) {
  const settling = { done: false }
  promise.finally(() => { settling.done = true }).catch(() => {})
  while (!settling.done) {
    await setImmediate()
    t.mock.timers.tick(5000)
  }
  return promise
}

test('the pulse answers a period\'s pull requests and issues with the year\'s statistics, each kept on its own; statistics GitHub is computing told pending and kept not at all', async t => {
  const request = await fixture(t)
  let computed = false
  const asked = github(t, { answer: kind => computed ? Response.json(stats[kind]) : pending(), graphql: () => ({ data: { merged: { issueCount: 3, nodes: [] } } }) })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const first = await settled(t, request({ repoId: '1', weeks: '13' }))
  assert.equal(first.status, 200)
  assert.equal(first.body.weeks, 13)
  assert.equal(first.body.merged.count, 3)
  assert.deepEqual([first.body.stats, first.body.pending], [null, true])
  assert.equal(asked.filter(item => item === 'commit_activity').length, 3, 'asked three times')
  computed = true
  const second = await settled(t, request({ repoId: '1', weeks: '13' }))
  assert.deepEqual([second.body.stats.weeks.length, second.body.pending, second.body.merged.count], [2, false, 3])
  assert.equal(asked.filter(item => typeof item === 'object').length, 1, 'the period\'s pull requests and issues kept')
  const reads = asked.length
  const month = await request({ repoId: '1' })
  assert.deepEqual([month.body.weeks, month.body.stats.contributors.length], [4, 2], 'a month, unless asked otherwise, the statistics kept for it too')
  assert.equal(asked.length, reads + 1, 'its pull requests and issues alone read')
  await request({ repoId: '1', weeks: '13' })
  assert.equal(asked.length, reads + 1, 'all of it kept')
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

test('GitHub refusing the statistics refuses the pulse as it refused them', async t => {
  github(t, { answer: () => Response.json({ message: 'Not Found' }, { status: 404 }) })
  const request = await fixture(t)
  const answer = await request({ repoId: '1', weeks: '1' })
  assert.equal(answer.status, 404)
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
