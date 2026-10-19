import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { namedAccounts } from '../common/managed/github-logins.ts'
import { COAUTHORS_READ } from '../server-managed/commit-coauthors.ts'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { historyPageStore, issueListStore, pullListStore, repositoryReadStore } from '../server-managed/npm-kept.ts'
import { AGENTS_READ_VERSION } from '../server-managed/repository-agents.ts'
import { historyFrom } from '../server-managed/repository-history.ts'
import { PULSE_YEAR_VERSION, StatsPending, YEAR_COMMITS, commitStats, periodStats, pulseSince, repositoryActivity, repositoryLines, repositoryStats, withLines, yearCommits }
  from '../server-managed/repository-pulse.ts'
import { createSession } from '../server-managed/session.ts'
import { agentCommits, agentMerges, directCommits, sameMerges } from '../server-managed/agent-merges.ts'
import { ISSUES_LIST_READ_VERSION, PULLS_READ_VERSION, readPulls } from '../server-managed/repository-pulls.ts'
import { releaseChanges, releaseCommits } from '../server-managed/release-commits.ts'

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
// from each commit asked), each commit's files by `files` (its paths, by
// its id), and other GraphQL (the period's searches) by `graphql`; `asked`
// the statistics and files asked and the GraphQL bodies.
function github(t, { answer = kind => Response.json(stats[kind]), commits = [], graphql = () => ({ data: {} }), files = {} } = {}) {
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
    // A commit's files, as Replay reads them.
    const changed = files[/^\/repos\/org\/repo\/commits\/([a-f\d]{40})$/u.exec(url.pathname)?.[1]]
    if (changed) {
      asked.push(`files ${url.pathname.slice(-40)}`)
      return Promise.resolve(Response.json({ files: changed.map(filename => ({ filename, status: 'modified' })) }))
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
const PULLS_LISTED = 'pullRequests(first: $first, after: $after'
const mergedQueries = asked => asked.filter(item => typeof item === 'object' && item.query.includes(PULLS_LISTED)).length
// Each pull request's number: its own, else one of its merge commit's.
const numbers = new Map()
const numbered = pull => pull.number === undefined
  ? { ...pull, number: numbers.get(pull.mergeCommit?.oid) ?? numbers.set(pull.mergeCommit?.oid, numbers.size + 1).get(pull.mergeCommit?.oid) } : pull
// The pull requests, the most recently updated first, as GitHub lists them
// as many a page as asked from the cursor asked (a position here); else
// `other` answers.
const mergedPulls = (pulls, other = () => ({ data: {} })) => body => {
  if (!body.query.includes(PULLS_LISTED)) return other(body)
  const [from, size] = [Number(body.variables.after ?? 0), body.variables.first]
  return { data: { repository: { pullRequests: { pageInfo: { hasNextPage: from + size < pulls.length, endCursor: String(from + size) },
    nodes: pulls.slice(from, from + size).map(numbered) } } } }
}
// The pull requests read on from those `kept` (repository-pulls.ts
// readPulls), as far back as `need`, and what those merged since `since`
// brought (agentMerges).
const readMerges = async (since, kept = null, need = since) => {
  const list = await readPulls('org/repo', 'token', since, kept?.list ?? null, globalThis.fetch, need)
  return { ...agentMerges(list, since), list }
}

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
  // Those it was read on past, the four between them among them: the branch
  // followed through them, the commit beneath pushed directly.
  assert.deepEqual([96, 97, 98, 99].map(at => read.passed.some(commit => commit.sha === shaOf(at))), [true, true, true, true])
  assert.ok(read.passed.every(commit => commit.committedAt < now - 95 * DAY && commit.committedAt >= now - 125 * DAY))
  const none = { merges: [], rebases: [], through: 0, next: null, pulls: [], pullRebases: [] }
  assert.equal(directCommits(none, read.commits, shaOf(0)).has(shaOf(100)), false)
  assert.equal(directCommits(none, [...read.commits, ...read.passed], shaOf(0)).has(shaOf(100)), true)
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
    agentDays: noAgents, releaseDays: noAgents, directDays: noAgents })
  assert.deepEqual(read.weeks[1], { week: first + WEEK, days: [1, 0, 1, 0, 0, 0, 0], commits: 2, additions: 11, deletions: 1,
    dayLines: [[1, 1], none, [10, 0], none, none, none, none], agentDays: noAgents, releaseDays: noAgents, directDays: noAgents })
  assert.deepEqual(read.contributors, [
    { login: 'ada', id: 7, name: 'Ada', weeks: [[first, 1, 3, 1], [first + WEEK, 1, 1, 1]], days: [[first + DAY, 1, 3, 1, 0, 0, 0], [first + WEEK, 1, 1, 1, 0, 0, 0]] },
    { login: null, id: null, name: 'Alan Kay', weeks: [[first + WEEK, 1, 10, 0]], days: [[first + WEEK + 2 * DAY, 1, 10, 0, 0, 0, 0]] },
  ])
  assert.deepEqual(read.directCommits, [], 'none told pushed directly')
  assert.equal(read.punch[1][12], 2, 'Ada\'s Monday 10:00 UTC and Sunday 10:00 UTC… two hours east')
  assert.equal(read.punch[2][23], 1, 'one whose author told no time zone, in UTC')
  assert.equal(read.lines, true)
})

test('a year counts each day the commits an agent made or co-authored: one of GitHub\'s agents their author, by account, else by name, or any co-author an agent', () => {
  const first = Date.UTC(2025, 9, 19)
  const grace = { name: 'Grace', email: null, login: 'grace', id: 9 }
  const commit = (sha, more) => ({ sha, parents: ['p'], subject: '', authorName: 'Ada', authorLogin: 'ada', authorId: 7, committedAt: first + DAY, named: [], ...more })
  const read = commitStats([
    commit('alone'),
    commit('with a person', { named: [grace] }),
    commit('with Claude', { named: [grace], markedBy: ['claude'] }),
    commit('by Claude', { authorLogin: 'claude', authorId: 81847, authorName: 'Claude', committedAt: first + 2 * DAY }),
    commit('another account of its login', { authorLogin: 'claude', authorId: 5, authorName: 'Claude', committedAt: first + 2 * DAY }),
    commit('by Cursor', { authorLogin: null, authorId: null, authorName: 'Cursor Agent', committedAt: first + WEEK }),
    commit('kept before co-authors were read', { named: undefined, committedAt: first + WEEK }),
    commit('merge', { parents: ['p', 'q'], markedBy: ['claude'] }),
  ], first)
  assert.deepEqual(read.weeks.slice(0, 2).map(week => [week.days, week.agentDays]), [
    [[0, 3, 2, 0, 0, 0, 0], [0, 1, 1, 0, 0, 0, 0]], [[2, 0, 0, 0, 0, 0, 0], [1, 0, 0, 0, 0, 0, 0]]])
  assert.deepEqual(read.contributors.find(person => person.login === 'ada').days.map(([at, commits, , , agents]) => [at, commits, agents]),
    [[first + DAY, 3, 1], [first + WEEK, 1, 0]], 'each contributor\'s days, those with agents too')
})

test('the agents\' pull requests merged in the year: by their branches, the most recently updated read first, a few queries an answer, on from what was read', async t => {
  const since = Date.UTC(2025, 9, 19)
  // Twelve hours apart, the 600th updated as the year starts, each merged an hour before.
  const pull = (at, updated = since + (600 - at) * 12 * HOUR) => ({ updatedAt: new Date(updated).toISOString(), mergedAt: new Date(updated - HOUR).toISOString(),
    headRefName: [`codex/${at}`, `feature/${at}`, `claude/${at}`, `dependabot/npm/${at}`][at % 4], mergeCommit: { oid: shaOf(at + 1) } })
  const pulls = Array.from({ length: 650 }, (_, at) => pull(at))
  const asked = github(t, { graphql: mergedPulls(pulls) })
  const read = await readMerges(since, null)
  assert.equal(mergedQueries(asked), 5)
  assert.deepEqual([read.through, read.next], [null, { after: '500', from: since + 600 * 12 * HOUR, stop: since, read: 500, to: since + 101 * 12 * HOUR }],
    'five pages, the rest left, how far back they are read')
  const whole = await readMerges(since, read)
  assert.equal(mergedQueries(asked), 7, 'on till one updated before the year')
  assert.deepEqual([whole.through, whole.next], [since + 600 * 12 * HOUR, null])
  const agents = Array.from({ length: 600 }, (_, at) => at).filter(at => at % 4 !== 1)
  assert.deepEqual(whole.merges.map(([sha]) => sha).toSorted(), agents.map(at => shaOf(at + 1)).toSorted(), 'those of agents\' branches merged in the year')
  // One merged since, read alone, from the newest on to the newest read before.
  pulls.unshift({ ...pull(1000, since + 700 * 12 * HOUR), headRefName: 'codex/new' })
  const again = await readMerges(since, whole)
  assert.deepEqual([mergedQueries(asked), asked.at(-1).variables.first], [8, 10], 'those updated since the newest read, ten a page first')
  assert.deepEqual([again.through, again.merges.length, again.merges.some(([sha]) => sha === shaOf(1001))], [since + 700 * 12 * HOUR, agents.length + 1, true])
  // A year begun since, those merged before it left out.
  const later = await readMerges(since + 300 * 12 * HOUR, again)
  assert.ok(later.merges.every(([, at]) => at >= since + 300 * 12 * HOUR))
  // Those merged since a time asked read whole, no page past it: finished
  // so far back, those updated since read by the next as ever.
  const recent = await readMerges(since, null, since + 550 * 12 * HOUR)
  assert.equal(mergedQueries(asked), 10, 'a page')
  assert.deepEqual([recent.next, recent.through, recent.reach], [null, since + 700 * 12 * HOUR, since + 502 * 12 * HOUR],
    'as far back as the page\'s oldest, the one merged since atop it')
  pulls.unshift({ ...pull(1001, since + 710 * 12 * HOUR), headRefName: 'claude/newer' })
  const newer = await readMerges(since, recent, since + 550 * 12 * HOUR)
  assert.equal(mergedQueries(asked), 11)
  assert.deepEqual([newer.through, newer.reach, newer.merges.some(([sha]) => sha === shaOf(1002))], [since + 710 * 12 * HOUR, since + 502 * 12 * HOUR, true])
  // Further back than they reached: read again from the newest on, as far as asked.
  const further = await readMerges(since, newer, since + 450 * 12 * HOUR)
  assert.equal(mergedQueries(asked), 13)
  assert.deepEqual([further.next, further.through, further.reach], [null, since + 710 * 12 * HOUR, since + 403 * 12 * HOUR])
  // Those merged since read a few queries an answer, how far back those
  // before reached kept through them, then the year whole.
  pulls.unshift(...Array.from({ length: 550 }, (_, at) => ({ ...pull(2000 + at, since + (1300 - at) * 12 * HOUR), headRefName: `claude/many-${at}` })))
  const many = await readMerges(since, further, since + 450 * 12 * HOUR)
  assert.deepEqual([many.next?.read, many.reach], [410, since + 403 * 12 * HOUR], 'ten first, as few are mostly updated since, then a hundred a page')
  const caught = await readMerges(since, many, since + 450 * 12 * HOUR)
  assert.deepEqual([caught.next, caught.through, caught.reach], [null, since + 1300 * 12 * HOUR, since + 403 * 12 * HOUR])
  let year = caught
  do year = await readMerges(since, year); while (year.next)
  assert.equal('reach' in year, false, 'every one since the year\'s start read, from the newest on again')
})

test('every pull request the repository has, read once its last is, and as the newest are read again; no longer once one is forgotten, updated before a year begun since', async t => {
  const since = Date.UTC(2025, 9, 19)
  const pull = (merge, day) => ({ updatedAt: new Date(since + day * DAY).toISOString(), mergedAt: new Date(since + day * DAY).toISOString(), headRefName: 'fix/x',
    labels: { nodes: [] }, mergeCommit: { oid: shaOf(merge), parents: { totalCount: 1 } }, commits: { nodes: [] } })
  const pulls = [pull(1, 3), pull(2, 1)]
  github(t, { graphql: mergedPulls(pulls) })
  const read = await readPulls('org/repo', 'token', since, null)
  assert.deepEqual([read.all, read.rows.length], [true, 2])
  pulls.unshift(pull(3, 4))
  const again = await readPulls('org/repo', 'token', since, read)
  assert.deepEqual([again.all, again.rows.length, again.through], [true, 3, since + 4 * DAY])
  const later = await readPulls('org/repo', 'token', since + 2 * DAY, again)
  assert.deepEqual(['all' in later, later.rows.length], [false, 2])
})

test('a pull request labelled for an agent is an agent\'s, whatever its branch; one labelled for none, not', async t => {
  const since = Date.UTC(2025, 9, 19)
  const when = new Date(since + DAY).toISOString()
  const pull = (merge, branch, labels) => ({ updatedAt: when, mergedAt: when, headRefName: branch, labels: { nodes: labels.map(name => ({ name })) },
    mergeCommit: { oid: shaOf(merge), parents: { totalCount: 1 } }, commits: { nodes: [] } })
  const queries = []
  const pulls = mergedPulls([pull(1, 'fix/review', ['bug', 'codex']), pull(2, 'ui/tabs', ['Agent: Claude']), pull(3, 'perf/reads', ['cursor']),
    pull(4, 'fix/by-hand', ['bug', 'agent:', 'codex-ish']), pull(5, 'feat/none', [])])
  github(t, { graphql: body => { queries.push(body.query); return pulls(body) } })
  const read = await readMerges(since, null)
  assert.deepEqual(read.merges.map(([sha]) => sha).toSorted(), [1, 2, 3].map(shaOf).toSorted())
  assert.match(queries[0], /labels\(first: 100\) \{ nodes \{ name \} \}/u, 'as many of each one\'s labels as GitHub gives a page')
  assert.deepEqual(read.pulls.map(([sha]) => sha).toSorted(), [1, 2, 3, 4, 5].map(shaOf).toSorted(), 'every pull request\'s merge kept, an agent\'s or not')
})

test('a pull request an account agents work as opened is an agent\'s, whatever its branch and labels', async t => {
  const since = Date.UTC(2025, 9, 19)
  const when = new Date(since + DAY).toISOString()
  const pull = (merge, author) => ({ updatedAt: when, mergedAt: when, headRefName: 'fix/review', author, labels: { nodes: [] },
    mergeCommit: { oid: shaOf(merge), parents: { totalCount: 1 } }, commits: { nodes: [] } })
  const queries = []
  const pulls = mergedPulls([pull(1, { login: 'ChristopherTuring', databaseId: 188797125 }), pull(2, { login: 'christopherturing' }),
    pull(3, { login: 'ChristopherTuring', databaseId: 7 }), pull(4, { login: 'ada', databaseId: 8 }), pull(5, null)])
  github(t, { graphql: body => { queries.push(body.query); return pulls(body) } })
  const read = await readMerges(since, null)
  assert.deepEqual(read.merges.map(([sha]) => sha).toSorted(), [1, 2].map(shaOf).toSorted(), 'by its id, else its login; another account by the login, not')
  assert.match(queries[0], /author \{ __typename login \.\.\. on User \{ databaseId \}/u)
})

test('a pull request a bot opened is an agent\'s, whichever GitHub App\'s, whatever its branch and labels', async t => {
  const since = Date.UTC(2025, 9, 19)
  const when = new Date(since + DAY).toISOString()
  const pull = (merge, author) => ({ updatedAt: when, mergedAt: when, headRefName: 'renovate/lodash-4.x', author, labels: { nodes: [] },
    mergeCommit: { oid: shaOf(merge), parents: { totalCount: 1 } }, commits: { nodes: [] } })
  const queries = []
  const pulls = mergedPulls([pull(1, { __typename: 'Bot', login: 'renovate' }), pull(2, { __typename: 'User', login: 'renovate', databaseId: 8 })])
  github(t, { graphql: body => { queries.push(body.query); return pulls(body) } })
  const read = await readMerges(since, null)
  assert.deepEqual(read.merges.map(([sha]) => sha), [shaOf(1)], 'by its type, a user of the same login not')
})

test('every pull request merged kept with its number, for the Commits tab to tell those squashed by', async t => {
  const since = Date.UTC(2025, 9, 19)
  const when = new Date(since + DAY).toISOString()
  github(t, { graphql: mergedPulls([{ number: 7, updatedAt: when, mergedAt: when, headRefName: 'fix/x', labels: { nodes: [] },
    mergeCommit: { oid: shaOf(1), parents: { totalCount: 1 } }, commits: { nodes: [] } }]) })
  const read = await readMerges(since)
  assert.deepEqual(read.pulls, [[shaOf(1), since + DAY, 7]])
})

test('a pull request whose agent\'s label is taken off is read again, none of what it brought an agent\'s', async t => {
  const since = Date.UTC(2025, 9, 19)
  const [merged, later] = [new Date(since + DAY).toISOString(), new Date(since + 2 * DAY).toISOString()]
  const pull = (merge, labels, own = [], parents = 1, updatedAt = merged) => ({ updatedAt, mergedAt: merged, headRefName: 'fix/review',
    labels: { nodes: labels.map(name => ({ name })) }, mergeCommit: { oid: shaOf(merge), parents: { totalCount: parents } },
    commits: { nodes: own.map(oid => ({ commit: { oid: shaOf(oid), messageHeadline: `Commit ${oid}`, changedFilesIfAvailable: 1 } })) } })
  const pulls = [pull(1, ['codex'], [2, 3], 2), pull(4, ['codex'], [5, 6]), pull(7, ['codex'])]
  github(t, { graphql: mergedPulls(pulls) })
  const first = await readMerges(since, null)
  assert.deepEqual([first.merges.map(([sha]) => sha).toSorted(), first.rebases.map(([sha]) => sha)], [[1, 2, 3, 4, 7].map(shaOf).toSorted(), [shaOf(4)]])
  pulls.splice(0, pulls.length, pull(1, ['bug'], [2, 3], 2, later), pull(4, [], [5, 6], 1, later), pull(7, ['codex']))
  const second = await readMerges(since, first)
  assert.deepEqual([second.merges.map(([sha]) => sha), second.rebases], [[shaOf(7)], []])
})

test('a commit releases the repository where it changes no code: a package.json, and beside it only lockfiles and changelogs in Markdown', () => {
  const changes = (...files) => ({ files: files.map(file => Array.isArray(file) ? file : [file, 'M']), more: false })
  assert.ok(releaseChanges(changes('package.json')))
  assert.ok(releaseChanges(changes('package.json', 'package-lock.json', 'CHANGELOG.md')))
  assert.ok(releaseChanges(changes('packages/a/package.json', 'packages/a/CHANGELOG.md', 'pnpm-lock.yaml', 'yarn.lock', ['.changeset/brave-cats.md', 'D'])),
    'a monorepo\'s, its changesets consumed')
  assert.ok(releaseChanges(changes('package.json', 'History.md', 'docs/changelog-2026.markdown', ['docs/CHANGELOG.md', 'R', 'CHANGELOG.md'])))
  assert.ok(!releaseChanges(changes('CHANGELOG.md', 'package-lock.json')), 'no package.json')
  assert.ok(!releaseChanges(changes('package.json', 'src/index.js')), 'code')
  assert.ok(!releaseChanges(changes('package.json', 'README.md')), 'a Markdown file no changelog')
  assert.ok(!releaseChanges(changes('package.json', ['CHANGELOG.md', 'R', 'src/index.js'])), 'one renamed from code')
  assert.ok(!releaseChanges({ ...changes('package.json'), more: true }), 'its files not all listed')
  assert.ok(!releaseChanges(changes()))
})

test('the commits that release a repository: those its tags name since the year began, through annotated tags, whose changes are a release\'s, each read once', async t => {
  const since = Date.UTC(2025, 9, 19)
  const commit = (at, day) => ({ __typename: 'Commit', oid: shaOf(at), committedDate: new Date(since + day * DAY).toISOString() })
  const annotated = target => ({ __typename: 'Tag', oid: shaOf(900), target: { __typename: 'Tag', oid: shaOf(901), target } })
  // The latest commits' first: the 4th's before the year began, those past it unread.
  const refs = [{ target: commit(1, 5) }, { target: annotated(commit(2, 4)) }, { target: commit(3, 3) }, { target: { __typename: 'Tree', oid: shaOf(902) } }, null,
    { target: commit(4, -1) }, { target: commit(5, -2) }]
  const asked = github(t, { graphql: body => body.query.includes('refs/tags/')
    ? { data: { repository: { refs: { pageInfo: { hasNextPage: true, endCursor: 'next' }, nodes: refs } } } } : { data: {} },
  files: { [shaOf(1)]: ['package.json', 'CHANGELOG.md'], [shaOf(2)]: ['package.json', 'package-lock.json'], [shaOf(3)]: ['package.json', 'src/index.js'], [shaOf(4)]: ['package.json'] } })
  const store = new Map()
  const kept = { read: shas => Promise.resolve(new Map(shas.flatMap(sha => store.has(sha) ? [[sha, store.get(sha)]] : []))),
    write: (sha, changes) => { store.set(sha, changes); return Promise.resolve() } }
  assert.deepEqual(await releaseCommits('org/repo', 'token', since, kept), [shaOf(1), shaOf(2)].toSorted())
  assert.equal(asked.filter(item => typeof item === 'object').length, 1, 'no page past the year read')
  assert.deepEqual(asked.filter(item => typeof item === 'string').toSorted(), [1, 2, 3].map(at => `files ${shaOf(at)}`).toSorted())
  assert.deepEqual(await releaseCommits('org/repo', 'token', since, kept), [shaOf(1), shaOf(2)].toSorted())
  assert.equal(asked.filter(item => typeof item === 'string').length, 3, 'their files kept')
})

test('the commits pushed to the branch directly: on its first parents from the head, none a merge, none a pull request brought, squashed, merged or rebased', () => {
  const commit = (sha, parents, subject = sha) => ({ sha, parents, subject, authorName: 'Ada', authorLogin: 'ada', authorId: 7, committedAt: 1, named: [] })
  // The head pushed; a squash; a merge, its side's commit merged; two commits
  // rebased; one pushed; the first.
  const commits = [commit('head', ['squash']), commit('squash', ['merge']), commit('merge', ['two', 'side']), commit('side', ['old']), commit('two', ['one'], 'Two'),
    commit('one', ['pushed'], 'One'), commit('pushed', ['first']), commit('first', [])]
  const read = { merges: [], rebases: [], through: 0, next: null, pulls: [['squash', 1], ['merge', 1], ['two', 1]], pullRebases: [['two', 1, ['One', 'Two']]] }
  assert.deepEqual([...directCommits(read, commits, 'head')].toSorted(), ['first', 'head', 'pushed'])
  assert.deepEqual([...directCommits({ ...read, pulls: undefined, pullRebases: undefined }, commits, 'head')].toSorted(), ['first', 'head', 'one', 'pushed', 'squash', 'two'],
    'none read, every one on its first parents but the merge')
})

test('a pull request rebased of more commits than its latest read: how many more kept, as many commits below its copies its own, not pushed directly', async t => {
  const since = Date.UTC(2025, 9, 19)
  const when = new Date(since + DAY).toISOString()
  const own = ['Two', 'Three'].map((subject, at) => ({ commit: { oid: shaOf(at + 10), messageHeadline: subject, changedFilesIfAvailable: 1 } }))
  github(t, { graphql: mergedPulls([{ updatedAt: when, mergedAt: when, headRefName: 'fix/large', labels: { nodes: [] },
    mergeCommit: { oid: shaOf(3), parents: { totalCount: 1 } }, commits: { totalCount: 4, nodes: own } }]) })
  const read = await readMerges(since, null)
  assert.deepEqual(read.pullRebases, [[shaOf(3), since + DAY, ['Two', 'Three'], 2]])
  const commit = (sha, parents, subject, committedAt = since + DAY) => ({ sha, parents, subject, authorName: 'Ada', authorLogin: 'ada', authorId: 7, committedAt, named: [] })
  // Its four commits copied onto the branch, as it was merged, over one
  // pushed directly a while before.
  const commits = [commit(shaOf(3), [shaOf(2)], 'Three'), commit(shaOf(2), [shaOf(1)], 'Two'), commit(shaOf(1), [shaOf(0)], 'One'), commit(shaOf(0), ['pushed'], 'Zero'),
    commit('pushed', ['first'], 'Pushed', since + HOUR), commit('first', [], 'First', since)]
  assert.deepEqual([...directCommits(read, commits, shaOf(3))].toSorted(), ['first', 'pushed'])
  // One of the two unread empty, left out by the rebase: none past its copies taken for it.
  const dropped = [...commits.slice(0, 3), commit(shaOf(1), ['pushed'], 'One'), ...commits.slice(4)]
  assert.deepEqual([...directCommits(read, dropped, shaOf(3))].toSorted(), ['first', 'pushed'], 'the one pushed before it not its own')
})

test('a year counts the commits pushed to the branch directly each day, each contributor\'s too, the latest listed; a period, its own alone', () => {
  const first = Date.UTC(2025, 9, 19)
  const commit = (sha, at, more) => ({ sha, parents: ['p'], subject: `Commit ${sha}`, authorName: 'Ada', authorLogin: 'ada', authorId: 7, committedAt: first + at, named: [],
    ...more })
  const read = commitStats([commit('a', DAY), commit('b', DAY + HOUR, { authorLogin: null, authorId: null, authorName: 'Alan Kay' }), commit('c', 50 * WEEK + DAY)], first,
    new Set(), new Set(), new Set(['b', 'c']))
  assert.deepEqual([read.weeks[0].directDays[1], read.weeks[50].directDays[1]], [1, 1])
  assert.deepEqual(read.contributors.map(person => person.days.map(row => row[6])), [[0, 1], [1]])
  assert.deepEqual(read.directCommits, [{ sha: 'c', at: first + 50 * WEEK + DAY, subject: 'Commit c', login: 'ada', id: 7, name: 'Ada', kind: 'without' },
    { sha: 'b', at: first + DAY + HOUR, subject: 'Commit b', login: null, id: null, name: 'Alan Kay', kind: 'without' }], 'the latest first')
  assert.deepEqual(periodStats(read, 4).directCommits.map(item => item.sha), ['c'])
  assert.deepEqual(periodStats(read, 52).directCommits.map(item => item.sha), ['c', 'b'])
})

test('a commit pushed directly is listed as the contributor its author\'s commits are counted as: a login\'s read before ids were, its one account\'s', () => {
  const first = Date.UTC(2025, 9, 19)
  const commit = (sha, authorId) => ({ sha, parents: ['p'], subject: sha, authorName: 'Ada', authorLogin: 'ada', authorId, committedAt: first + DAY, named: [] })
  const read = commitStats([commit('old', undefined), commit('new', 7)], first, new Set(), new Set(), new Set(['old', 'new']))
  assert.deepEqual(read.contributors.map(person => [person.login, person.id]), [['ada', 7]])
  assert.deepEqual(read.directCommits.map(item => [item.sha, item.login, item.id]).toSorted(), [['new', 'ada', 7], ['old', 'ada', 7]])
})

test('a year counts a commit an account agents work as pushed directly with agents; theirs a pull request\'s or a merge\'s side, as anyone\'s', () => {
  const first = Date.UTC(2025, 9, 19)
  const commit = (sha, authorLogin, authorId) => ({ sha, parents: ['p'], subject: '', authorName: 'Christopher Turing', authorLogin, authorId, committedAt: first + DAY,
    named: [] })
  const read = commitStats([commit('pushed', 'ChristopherTuring', 188797125), commit('by login', 'ChristopherTuring', null), commit('side', 'ChristopherTuring', 188797125),
    commit('by hand', 'ada', 7)], first, new Set(), new Set(), new Set(['pushed', 'by login', 'by hand']))
  assert.deepEqual([read.weeks[0].days[1], read.weeks[0].agentDays[1], read.weeks[0].directDays[1]], [4, 2, 3])
  assert.deepEqual(read.contributors.map(person => [person.login, person.days[0][4]]), [['ChristopherTuring', 2], ['ada', 0]])
  assert.deepEqual(read.directCommits.map(item => [item.sha, item.kind]).toSorted(), [['by hand', 'without'], ['by login', 'agent'], ['pushed', 'agent']])
})

test('a year counts a commit Neo\'s account made with agents, by its id whatever its login; its GitHub App\'s id no account of its', () => {
  const first = Date.UTC(2025, 9, 19)
  const commit = (sha, authorLogin, authorId) => ({ sha, parents: ['p'], subject: '', authorName: authorLogin, authorLogin, authorId, committedAt: first + DAY, named: [] })
  const read = commitStats([commit('neo', 'any-login[bot]', 274065190), commit('someone', 'someone', 3115942)], first)
  assert.deepEqual([read.weeks[0].days[1], read.weeks[0].agentDays[1]], [2, 1])
})

test('a year counts any bot\'s commits with agents, whichever GitHub App\'s: its author\'s, by login, else name, or a co-author\'s', () => {
  const first = Date.UTC(2025, 9, 19)
  const commit = (sha, more) => ({ sha, parents: ['p'], subject: '', authorName: 'Ada', authorLogin: 'ada', authorId: 7, committedAt: first + DAY, named: [], ...more })
  const read = commitStats([commit('renovate', { authorName: 'renovate[bot]', authorLogin: 'renovate[bot]', authorId: 29139614 }),
    commit('named', { authorName: 'pre-commit-ci[bot]', authorLogin: null, authorId: null }),
    commit('with a bot', { named: [{ name: 'Release Bot', email: null, login: 'release-please[bot]', id: 55107282 }] }), commit('alone'),
    commit('a name', { authorName: 'Robot', authorLogin: null, authorId: null })], first)
  assert.deepEqual([read.weeks[0].days[1], read.weeks[0].agentDays[1]], [5, 3])
})

test('a year counts a workflow\'s commits with agents by the names workflows are commonly given, GitHub naming no account for them; a person\'s account of that login, theirs', () => {
  const first = Date.UTC(2025, 9, 19)
  const commit = (sha, authorName, authorLogin = null, authorId = null) => ({ sha, parents: ['p'], subject: '', authorName, authorLogin, authorId, committedAt: first + DAY,
    named: [] })
  const read = commitStats([commit('lowercase', 'github-actions'), commit('titled', 'GitHub Action'), commit('a person', 'github-actions', 'github-actions', 7)], first)
  assert.deepEqual([read.weeks[0].days[1], read.weeks[0].agentDays[1]], [3, 2])
})

test('a year counts the commits that release the repository apart, none of them with agents whoever made them', () => {
  const first = Date.UTC(2025, 9, 19)
  const claude = { markedBy: ['claude'] }
  const commit = (sha, more) => ({ sha, parents: ['p'], subject: '', authorName: 'Ada', authorLogin: 'ada', authorId: 7, committedAt: first + DAY, named: [], ...more })
  const read = commitStats([commit('release', claude), commit('with Claude', claude), commit('alone')], first, new Set(['release']),
    new Set(['release']))
  assert.deepEqual([read.weeks[0].days[1], read.weeks[0].agentDays[1], read.weeks[0].releaseDays[1]], [3, 1, 1])
  assert.deepEqual(read.contributors[0].days, [[first + DAY, 3, 0, 0, 1, 1, 0]])
  // Each pushed directly listed as what it is, a release before one with agents.
  const pushed = commitStats([commit('release', claude), commit('with Claude', claude), commit('alone')], first, new Set(['release']),
    new Set(['release']), new Set(['release', 'with Claude', 'alone']))
  assert.deepEqual(pushed.directCommits.map(item => [item.sha, item.kind]).toSorted(), [['alone', 'without'], ['release', 'release'], ['with Claude', 'agent']])
})

test('a commit tagged a release after its year was counted, the head where it was: read again once what was read is no longer fresh, the year counted again, the release apart', async t => {
  const request = await fixture(t)
  const commits = chain(50, Date.now())
  const tags = []
  github(t, { commits, graphql: body => body.query.includes('refs/tags/') ? { data: { repository: { refs: { pageInfo: { hasNextPage: false }, nodes: tags } } } } : { data: {} },
    files: { [commits[3].oid]: ['package.json', 'CHANGELOG.md'], [commits[4].oid]: ['package.json', 'src/index.js'] } })
  const releases = async () => (await request({ repoId: '1' })).body.stats.weeks.flatMap(week => week.releaseDays).reduce((sum, count) => sum + count, 0)
  const store = repositoryReadStore(request.db)
  const key = `1\0pulse-merges\0${PULSE_YEAR_VERSION}`
  const age = async () => {
    const { value } = await store.read(key)
    await store.remove(key)
    await store.write(key, value, Date.now() - 3 * 60_000)
  }
  assert.equal(await releases(), 0)
  tags.push(...[3, 4].map(at => ({ target: { __typename: 'Commit', oid: commits[at].oid, committedDate: commits[at].committedDate } })))
  assert.equal(await releases(), 0, 'what was read fresh, not read again')
  await age()
  await releases()
  await request.settled()
  assert.equal(await releases(), 1, 'the tagged commit changing no code a release; the other, changing code, not')
})

test('an agent\'s pull request merged with a merge commit brings its own commits, the merge itself counting none; one squashed, its merge commit alone', async t => {
  const since = Date.UTC(2025, 9, 19)
  const when = new Date(since + DAY).toISOString()
  const pull = (branch, merge, parents, own) => ({ updatedAt: when, mergedAt: when, headRefName: branch, mergeCommit: { oid: shaOf(merge), parents: { totalCount: parents } },
    commits: { nodes: own.map(oid => ({ commit: { oid: shaOf(oid) } })) } })
  github(t, { graphql: mergedPulls([pull('codex/merged', 1, 2, [2, 3]), pull('codex/squashed', 4, 1, [5]), pull('feature/merged', 6, 2, [7])]) })
  const read = await readMerges(since, null)
  assert.deepEqual(read.merges.map(([sha]) => sha).toSorted(), [1, 2, 3, 4].map(shaOf).toSorted())
  const commit = (at, parents = ['p']) => ({ sha: shaOf(at), parents, subject: '', authorName: 'Ada', authorLogin: 'ada', authorId: 7, committedAt: since + DAY, named: [] })
  const counted = commitStats([commit(1, ['p', 'q']), commit(2), commit(3), commit(7)], since, new Set(read.merges.map(([sha]) => sha)))
  assert.deepEqual([counted.weeks[0].days[1], counted.weeks[0].agentDays[1]], [3, 2], 'the merge itself left out')
})

test('an agent\'s pull request rebased brings its commits\' copies, told by their subjects from its last back, its commits the rebase left out (empty ones, and one GitHub counted no files of) passed over; one squashed, its own commit alone', async t => {
  const since = Date.UTC(2025, 9, 19)
  const when = new Date(since + DAY).toISOString()
  const pull = (merge, headlines) => ({ updatedAt: when, mergedAt: when, headRefName: 'codex/work', mergeCommit: { oid: shaOf(merge), parents: { totalCount: 1 } },
    commits: { nodes: headlines.map((messageHeadline, at) => ({ commit: { oid: shaOf(merge * 100 + at), messageHeadline,
      changedFilesIfAvailable: { 'Retrigger CI': 0, 'Retrigger CI again': null }[messageHeadline] ?? 1 } })) } })
  github(t, { graphql: mergedPulls([pull(10, ['First', 'Retrigger CI', 'Retrigger CI again', 'Second', `${'Third, its subject long '.repeat(3)}…`]),
    pull(30, ['One', 'Two'])]) })
  const read = await readMerges(since, null)
  assert.deepEqual(read.rebases.map(([sha, , subjects]) => [sha, subjects.length]).toSorted(([a], [b]) => a.localeCompare(b)), [[shaOf(10), 4], [shaOf(30), 2]],
    'one GitHub counted no files of left out')
  // The default branch, newest first: the rebase's copies, then one of
  // another's of the same subject; the squash merge, titled as its pull
  // request, over a commit of its last commit's subject.
  const line = [[10, 'Third, its subject long Third, its subject long Third, its subject long and longer'], [11, 'Second'], [12, 'First'], [13, 'First'],
    [30, 'Work (#5)'], [31, 'One']]
  const commits = line.map(([at, subject], index) => ({ sha: shaOf(at), parents: [shaOf(line[index + 1]?.[0] ?? 99)], subject }))
  assert.deepEqual([...agentCommits(read, commits)].toSorted(), [10, 11, 12, 30].map(shaOf).toSorted())
})

test('a year counts the commits merged from an agent\'s pull request with agents, their messages marking none; the pull requests merged read a few queries an answer', async t => {
  const request = await fixture(t)
  const commits = chain(50, Date.now())
  const now = new Date().toISOString()
  // Codex's, as it commits as whoever ran it; then many more, merged before the year.
  const pulls = [{ updatedAt: now, mergedAt: now, headRefName: 'codex/fix', mergeCommit: { oid: commits[3].oid } },
    ...Array.from({ length: 600 }, (_, at) => ({ updatedAt: now, mergedAt: '2020-01-01T00:00:00Z', headRefName: 'codex/old', mergeCommit: { oid: shaOf(at + 10_000) } }))]
  github(t, { commits, graphql: mergedPulls(pulls) })
  const first = await request({ repoId: '1' })
  assert.deepEqual([first.body.stats, first.body.reading, first.body.pulls], [null, null, 500])
  const second = await request({ repoId: '1' })
  assert.equal(second.body.pulls, null)
  assert.deepEqual([second.body.stats.weeks.reduce((sum, week) => sum + week.commits, 0), second.body.stats.weeks.flatMap(week => week.agentDays).reduce((sum, count) => sum + count, 0)],
    [50, 1])
})

test('the pull requests kept as the Agents tab read them are the Pulse\'s: fresh, none read again, those merged telling whose its year\'s commits are', async t => {
  const request = await fixture(t)
  const commits = chain(50, Date.now())
  const asked = github(t, { commits, graphql: mergedPulls([]) })
  const now = Date.now()
  const row = (number, merged) => ({ number, title: `Pull ${number}`, state: 'merged', draft: false, author: null, authorId: null, createdAt: null, updatedAt: now,
    head: null, fork: null, additions: 0, deletions: 0, commits: 1, closes: [], signals: { sessions: [], tasks: [], claude: false, codex: false, agents: [] }, merged })
  await pullListStore(request.db).write(`1\0${PULLS_READ_VERSION}\0${AGENTS_READ_VERSION}\0${PULSE_YEAR_VERSION}`, { rows: [
    row(7, { sha: commits[3].oid, at: now, agent: true }), row(6, { sha: commits[4].oid, at: now, agent: false })], since: pulseSince(52, now), through: now, next: null },
  Date.now())
  const { body } = await request({ repoId: '1' })
  assert.equal(body.stats.weeks.flatMap(week => week.agentDays).reduce((sum, count) => sum + count, 0), 1)
  assert.equal(mergedQueries(asked), 0)
})

test('a period\'s pull requests and issues told of those the tabs keep, read for the year, and the head of the branches Commits read, none searched for; a year\'s searched for', async t => {
  const request = await fixture(t)
  const commits = chain(50, Date.now())
  const asked = github(t, { commits, graphql: body => ({ data: body.query.includes('search(') ? { merged: { issueCount: 99, nodes: [] } } : {} }) })
  const now = Date.now()
  const yesterday = now - DAY
  const day = new Date(yesterday).toISOString().slice(0, 10)
  const since = pulseSince(52, now)
  await pullListStore(request.db).write(`1\0${PULLS_READ_VERSION}\0${AGENTS_READ_VERSION}\0${PULSE_YEAR_VERSION}`, { rows: [{ number: 7, title: 'Pull 7',
    state: 'merged', draft: false, author: 'ada', authorId: 7, createdAt: yesterday, updatedAt: yesterday, head: null, fork: null, additions: 0, deletions: 0, commits: 1,
    closes: [], signals: { sessions: [], tasks: [], claude: false, codex: false, agents: [] }, merged: { sha: commits[3].oid, at: yesterday, agent: false } }],
  // Read as far back as ten weeks ago, as a quarter needed.
  since, through: yesterday, reach: now - 10 * WEEK, next: null }, Date.now())
  await issueListStore(request.db).write(`1\0${ISSUES_LIST_READ_VERSION}`, { rows: [{ number: 8, title: 'Issue 8', state: 'closed', author: 'grace', authorId: 9,
    createdAt: yesterday - DAY, updatedAt: yesterday, closedAt: yesterday, reason: 'completed' }], since, through: yesterday, next: null }, Date.now())
  // The branches as Commits read them a moment ago, the default branch's head among them.
  await repositoryReadStore(request.db).write('1\0heads', { heads: [{ name: 'main', sha: commits[0].oid, at: now }], defaultBranch: 'main', tags: [], cut: false },
    Date.now())
  const month = await request({ repoId: '1' })
  assert.deepEqual([month.body.merged.count, month.body.merged.items.map(item => item.number), month.body.closed.count, month.body.closed.items[0].reason],
    [1, [7], 1, 'completed'])
  const narrowed = await request({ repoId: '1', weeks: '4', from: day, to: day, authors: 'ADA' }, { path: 'pulse/items' })
  assert.deepEqual([narrowed.body.merged.count, narrowed.body.closed.count], [1, 0], 'its contributor\'s alone')
  const searched = () => asked.filter(item => typeof item === 'object' && item.query.includes('search('))
  assert.equal(searched().length, 0, 'none searched for')
  assert.equal(asked.filter(item => typeof item === 'object' && item.query.includes('defaultBranchRef { target { oid } }')).length, 0, 'the head not read again')
  // Narrowed to a day further back than those kept were read: searched for.
  const back = await request({ repoId: '1', weeks: '4', from: new Date(now - 20 * WEEK).toISOString().slice(0, 10) }, { path: 'pulse/items' })
  assert.deepEqual([back.body.merged.count, searched().length], [99, 1])
  const year = await request({ repoId: '1', weeks: '52' })
  assert.deepEqual([year.body.merged.count, searched().length], [99, 2], 'the year before past those kept: searched for')
})

test('a pull request labelled for an agent, or no longer, after its year was counted: the merged pull requests read again once those read are no longer fresh, the year counted again where what they bring changed', async t => {
  const request = await fixture(t)
  const commits = chain(50, Date.now())
  const at = Date.now()
  const pull = (updated, labels) => ({ updatedAt: new Date(at + updated).toISOString(), mergedAt: new Date(at).toISOString(), headRefName: 'fix/review',
    labels: { nodes: labels.map(name => ({ name })) }, mergeCommit: { oid: commits[3].oid } })
  const pulls = [pull(0, [])]
  const asked = github(t, { commits, graphql: mergedPulls(pulls) })
  const agents = async () => (await request({ repoId: '1' })).body.stats.weeks.flatMap(week => week.agentDays).reduce((sum, count) => sum + count, 0)
  const store = repositoryReadStore(request.db)
  const mergesKey = `1\0pulse-merges\0${PULSE_YEAR_VERSION}`
  const lists = pullListStore(request.db)
  const listKey = `1\0${PULLS_READ_VERSION}\0${AGENTS_READ_VERSION}\0${PULSE_YEAR_VERSION}`
  // What the merged pull requests tell, and the pull requests, read three
  // minutes ago, no longer fresh: what was kept removed first, the store
  // keeping none older over it.
  const age = async () => {
    for (const [kept, key] of [[store, mergesKey], [lists, listKey]]) {
      const { value } = await kept.read(key)
      await kept.remove(key)
      await kept.write(key, value, Date.now() - 3 * 60_000)
    }
  }
  assert.equal(await agents(), 0)
  pulls[0] = pull(1000, ['codex'])
  const before = mergedQueries(asked)
  assert.equal(await agents(), 0, 'those read fresh, not read again')
  assert.equal(mergedQueries(asked), before)
  await age()
  assert.equal(await agents(), 0, 'the year as kept answered while they are read again behind it')
  await request.settled()
  assert.equal(mergedQueries(asked), before + 1)
  assert.equal(await agents(), 1, 'labelled, its commit with agents, the head where it was')
  pulls[0] = pull(2000, [])
  await age()
  await agents()
  await request.settled()
  assert.equal(await agents(), 0, 'its label taken off, none')
  const recounted = (await store.read(`1\0pulse-year-last`)).at
  await age()
  await agents()
  await request.settled()
  assert.equal(await agents(), 0)
  assert.equal((await store.read(`1\0pulse-year-last`)).at, recounted, 'read again, nothing changed, not counted again')
})

test('two reads of the pull requests merged bring the same commits, the agents\' and every one\'s, whatever order each read them in', () => {
  const read = (merges, rebases = [], pulls = merges, pullRebases = rebases) => ({ merges, rebases, through: 1, next: null, pulls, pullRebases })
  assert.ok(sameMerges(read([['a', 1], ['b', 2]], [['c', 3, ['x', 'y']]]), read([['b', 2], ['a', 1]], [['c', 3, ['x', 'y']]])))
  assert.ok(!sameMerges(read([['a', 1]]), read([['a', 1], ['b', 2]])))
  assert.ok(!sameMerges(read([], [['c', 3, ['x', 'y']]]), read([], [['c', 3, ['x']]])))
  // Another's pull request merged, or rebased, the agents' alike: its commits
  // no longer pushed directly.
  assert.ok(!sameMerges(read([['a', 1]]), read([['a', 1]], [], [['a', 1], ['d', 4]])))
  assert.ok(!sameMerges(read([['a', 1]]), read([['a', 1]], [], [['a', 1]], [['e', 5, ['z', 'w']]])))
  assert.ok(sameMerges(read([['a', 1]], [], [['a', 1], ['d', 4]]), read([['a', 1]], [], [['d', 4], ['a', 1]])))
  assert.ok(!sameMerges({ merges: [], rebases: [], through: 1, next: null }, read([], [], [['d', 4]])), 'kept before every one\'s were read')
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
  assert.deepEqual(Object.keys(periodStats(read, 4)).toSorted(), ['contributors', 'directCommits', 'lines', 'periodPunch', 'punch', 'weeks'], 'the other periods\' not sent')
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

for (const status of [200, 202, 204, 422]) {
  test(`Pulse stats and lines share contributors, including GitHub status ${status}`, async () => {
    const asked = []
    let responseStatus = status
    const fetch = async url => {
      const kind = new URL(url).pathname.split('/').at(-1)
      asked.push(kind)
      await setImmediate()
      return responseStatus === 204 ? new Response(null, { status: 204 })
        : Response.json(responseStatus === 200 ? stats[kind] : {}, { status: responseStatus })
    }
    const results = await Promise.allSettled([repositoryStats('org/repo', 'token', fetch), repositoryLines('org/repo', 'token', w0 * 1000, fetch)])
    assert.deepEqual(asked.toSorted(), ['code_frequency', 'commit_activity', 'contributors', 'punch_card'])
    if (status === 202) assert.ok(results.every(result => result.status === 'rejected' && result.reason instanceof StatsPending))
    else assert.ok(results.every(result => result.status === 'fulfilled'))
    responseStatus = 200
    assert.equal((await repositoryStats('org/repo', 'token', fetch)).weeks.length, 2, 'completed or pending responses are read again')
    assert.equal(asked.filter(kind => kind === 'contributors').length, 2)
  })
}

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
  // What is read behind an answer, kept to be waited for.
  const tracked = []
  const handler = createManagedRequestHandler({ config, db, originGate: { isOriginAllowed: () => true }, isShuttingDown: () => false, track(work) { tracked.push(work) } })
  const request = async (query, { method = 'GET', path = 'pulse' } = {}) => {
    const res = { status: 0, body: '', headers: {}, writeHead(status, headers) { this.status = status; this.headers = headers }, end(body) { this.body = body } }
    await handler({ method, url: `/api/admin/repositories/${path}?${new URLSearchParams(query)}`, headers: { cookie: session.setCookie.split(';')[0] } }, res)
    return { status: res.status, body: JSON.parse(res.body) }
  }
  return Object.assign(request, { db, settled: () => Promise.all(tracked.splice(0)) })
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
  assert.equal(asked.length, reads, 'the month\'s pull requests and issues told of those kept, those read for the year, none searched for')
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
  const moved = await request({ repoId: '1', weeks: '52' })
  assert.deepEqual([moved.body.reading, total(moved.body)], [500, 700], 'five pages read, the year as it was')
  const counted = await request({ repoId: '1', weeks: '52' })
  assert.deepEqual([counted.body.reading, total(counted.body)], [null, 1300])
})

test('a month counted once its weeks and as many before are read, the rest of the year read only as a longer period asks, so said', async t => {
  const request = await fixture(t)
  const commits = chain(400, Date.now(), DAY)
  const asked = github(t, { commits })
  const total = body => body.stats.weeks.reduce((sum, week) => sum + week.commits, 0)
  const month = await request({ repoId: '1' })
  assert.deepEqual([month.body.reading, total(month.body), month.body.stats.from, graphQueries(asked)], [null, 100, Date.parse(commits[99].committedDate), 1],
    'a page read, its last commit\'s parent the only one not, eight weeks before')
  const year = await request({ repoId: '1', weeks: '52' })
  assert.deepEqual([year.body.reading, 'from' in year.body.stats, graphQueries(asked)], [null, false, 4], 'the rest read on from the page kept')
  assert.equal(total((await request({ repoId: '1' })).body), total(year.body), 'the year whole kept for every period')
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
    named: [], committedAt: Date.parse(node.committedDate), additions: null, deletions: null, authoredAt: null, authorZone: null }))
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

test('a period\'s pull requests and issues narrowed to some of its days and authors: each searched over those days, by any of those accounts, an app\'s as GitHub names it', async t => {
  const asked = github(t, { graphql: () => ({ data: {} }) })
  const now = Date.UTC(2026, 9, 15, 12)
  await repositoryActivity('org/repo', 'token', 4, now, globalThis.fetch, { from: Date.UTC(2026, 8, 28), to: Date.UTC(2026, 8, 28), authors: ['ada', 'dependabot[bot]'] })
  assert.equal(asked[0].variables.merged, 'repo:org/repo is:pr is:merged merged:2026-09-28..2026-09-28 author:ada author:app/dependabot sort:updated-desc')
  assert.equal(asked[0].variables.created, 'repo:org/repo is:issue created:2026-09-28..2026-09-28 author:ada author:app/dependabot sort:created-desc')
  await repositoryActivity('org/repo', 'token', 4, now, globalThis.fetch, { from: Date.UTC(2026, 8, 20), to: null, authors: ['ada'] })
  assert.equal(asked[1].variables.opened, 'repo:org/repo is:pr created:>=2026-09-20 author:ada sort:created-desc', 'on from its first day')
  await repositoryActivity('org/repo', 'token', 4, now, globalThis.fetch, { from: Date.UTC(2026, 8, 27), to: Date.UTC(2026, 9, 3), authors: [] })
  assert.equal(asked[2].variables.closed, 'repo:org/repo is:issue is:closed closed:2026-09-27..2026-10-03 sort:updated-desc', 'by anyone')
})

test('the pulse\'s pull requests and issues narrowed to a day or a week and a contributor\'s accounts, each login once whatever its case, kept for each', async t => {
  const request = await fixture(t)
  const pull = { number: 5, title: 'Pull 5', pullState: 'MERGED', isDraft: false, createdAt: '2026-09-28T00:00:00Z', mergedAt: '2026-09-28T10:00:00Z', author: { login: 'ada' } }
  const asked = github(t, { graphql: () => ({ data: { merged: { issueCount: 1, nodes: [pull] } } }) })
  const searches = () => asked.filter(item => typeof item === 'object')
  const items = (query, options) => request({ repoId: '1', weeks: '4', ...query }, { path: 'pulse/items', ...options })
  const answer = await items({ from: '2026-09-28', to: '2026-09-28', authors: 'Ada,ada' })
  assert.equal(answer.status, 200)
  assert.deepEqual([answer.body.weeks, answer.body.merged.count, answer.body.merged.items.map(item => item.number)], [4, 1, [5]])
  assert.equal(searches().at(-1).variables.merged, 'repo:org/repo is:pr is:merged merged:2026-09-28..2026-09-28 author:ada sort:updated-desc')
  const read = searches().length
  await items({ from: '2026-09-28', to: '2026-09-28', authors: 'ada' })
  assert.equal(searches().length, read, 'kept')
  await items({ from: '2026-09-20' })
  assert.equal(searches().at(-1).variables.merged, 'repo:org/repo is:pr is:merged merged:>=2026-09-20 sort:updated-desc', 'another narrowing read apart')
  for (const query of [{}, { from: '2026-9-28' }, { from: '2026-09-28', to: '2026-09-27' }, { from: '2026-09-28', to: '' }, { from: '2026-09-28', authors: 'a b' },
    { from: '2026-09-28', authors: Array.from({ length: 11 }, (_, at) => `user${at}`).join(',') }, { from: '2026-09-28', weeks: '2' }]) {
    assert.equal((await items(query)).status, 400, JSON.stringify(query))
  }
  assert.equal((await items({ from: '2026-09-28' }, { method: 'POST' })).status, 405)
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
