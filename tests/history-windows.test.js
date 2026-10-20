import assert from 'node:assert/strict'
import { test } from 'node:test'
import { gitLogPage } from '../server-managed/history-windows.ts'
import { pulseSince, yearCommits } from '../server-managed/repository-pulse.ts'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const shaOf = (kind, at) => `${kind}${at.toString(16)}`.padStart(40, '0')

// A commit as the walk keeps it (repository-history.ts HistoryCommit).
const kept = (sha, parents, committedAt) => ({ sha, parents, subject: sha, authorName: 'Ada', authorLogin: 'ada', committedAt, additions: 1, deletions: 1,
  authoredAt: committedAt, authorZone: 0 })

// A default branch of merges, `perDay` a day for `days` days back from `now`,
// each bringing a branch of three commits made in the hours before it,
// branched from the merge five before; its merges newest first.
function merged(now, perDay, days) {
  const nodes = new Map()
  const count = perDay * days
  const main = Array.from({ length: count }, (_, at) => ({ sha: shaOf('f', at), at: now - at * DAY / perDay }))
  const node = (oid, at, parents) => nodes.set(oid, { oid, message: oid, committedDate: new Date(at).toISOString(), additions: 1, deletions: 1,
    author: { name: 'Ada', email: 'ada@example.com', date: new Date(at).toISOString(), user: { login: 'ada', databaseId: 7 } }, authors: { nodes: [] },
    parents: { nodes: parents.map(parent => ({ oid: parent })) } })
  for (const [at, merge] of main.entries()) {
    const branch = [0, 1, 2].map(step => ({ sha: shaOf('b', at * 3 + step), at: merge.at - (3 - step) * 10 * 60_000 }))
    if (at + 1 === count) { node(merge.sha, merge.at, []); continue }
    node(merge.sha, merge.at, [main[at + 1].sha, branch[2].sha])
    node(branch[2].sha, branch[2].at, [branch[1].sha])
    node(branch[1].sha, branch[1].at, [branch[0].sha])
    node(branch[0].sha, branch[0].at, [main[Math.min(count - 1, at + 5)].sha])
  }
  return { nodes, main }
}

// `git log` from `top`: the top first, then the latest made of those reached,
// of those made together the first reached; as many as `max`.
function gitLog(nodes, top, max = Number.POSITIVE_INFINITY) {
  const out = []
  const reached = new Set([top])
  const waiting = [nodes.get(top)]
  while (waiting.length > 0 && out.length < max) {
    const node = waiting.shift()
    out.push(node)
    for (const { oid } of node.parents.nodes) {
      if (reached.has(oid)) continue
      reached.add(oid)
      const parent = nodes.get(oid)
      const at = waiting.findIndex(other => Date.parse(other.committedDate) < Date.parse(parent.committedDate))
      waiting.splice(at < 0 ? waiting.length : at, 0, parent)
    }
  }
  return out
}

// GitHub, as the walk reads the history of `dag` from its head: a hundred
// from each commit asked, or of each window of time asked (git log --since
// --until), a hundred after its cursor; `asked` the GraphQL bodies.
function github(t, dag) {
  const asked = []
  const logs = new Map()
  t.mock.method(globalThis, 'fetch', (input, options = {}) => {
    const body = JSON.parse(options.body)
    asked.push(body)
    const { variables } = body
    if (body.query.includes('since: $s0')) {
      if (!logs.has(variables.head)) logs.set(variables.head, gitLog(dag.nodes, variables.head))
      const windows = Object.keys(variables).filter(name => /^u\d+$/u.test(name)).map(name => name.slice(1))
      return Promise.resolve(Response.json({ data: { repository: { object: Object.fromEntries(windows.map(at => {
        const [since, until] = [Date.parse(variables[`s${at}`] ?? '1970-01-01T00:00:00Z'), Date.parse(variables[`u${at}`])]
        const made = logs.get(variables.head).filter(node => Date.parse(node.committedDate) >= since && Date.parse(node.committedDate) <= until)
        const from = Number(variables[`a${at}`] ?? 0)
        return [`w${at}`, { pageInfo: { hasNextPage: from + 100 < made.length, endCursor: String(from + 100) }, nodes: made.slice(from, from + 100) }]
      })) } } }))
    }
    const tops = Object.entries(variables).filter(([name]) => /^o\d+$/u.test(name))
    return Promise.resolve(Response.json({ data: { repository: Object.fromEntries(tops.map(([name, top]) => [`b${name.slice(1)}`,
      dag.nodes.has(top) ? { history: { nodes: gitLog(dag.nodes, top, 100) } } : null])) } }))
  })
  const pages = () => asked.filter(body => !body.query.includes('since: $s0'))
    .reduce((sum, body) => sum + Object.keys(body.variables).filter(name => /^o\d+$/u.test(name)).length, 0)
  return { asked, pages, windows: () => asked.filter(body => body.query.includes('since: $s0')).length }
}

// Pages kept in memory, by their tops.
const memoryPages = () => {
  const store = new Map()
  return { store, read: tops => Promise.resolve(new Map(tops.flatMap(top => store.has(top) ? [[top, store.get(top)]] : []))),
    write: (top, commits) => { store.set(top, commits); return Promise.resolve() } }
}

test('a page of commits read is listed as git log lists it: the top first, then the latest made of those reached, of those made together the first reached', () => {
  const known = new Map([kept('t', ['a', 'b'], 10), kept('a', ['c'], 5), kept('b', ['c'], 5), kept('c', ['d'], 4), kept('d', [], 1)].map(commit => [commit.sha, commit]))
  assert.deepEqual(gitLogPage('t', known, 0).map(commit => commit.sha), ['t', 'a', 'b', 'c', 'd'])
  // A parent made after its child, its clock ahead: listed after it all the
  // same, then before those made earlier.
  known.set('c', kept('c', ['d'], 20))
  assert.deepEqual(gitLogPage('t', known, 0).map(commit => commit.sha), ['t', 'a', 'c', 'b', 'd'])
})

test('a page lists none where it would list a commit not read, or one made before every one is read while one not read waits; a whole page made since, as read', () => {
  const known = new Map([kept('t', ['a', 'x'], 10), kept('a', [], 8)].map(commit => [commit.sha, commit]))
  assert.equal(gitLogPage('t', known, 0), null, 'its commits run out where one not read would come next')
  assert.equal(gitLogPage('missing', known, 0), null)
  // A hundred and fifty made since 100, one beside them not read, made before.
  const chain = Array.from({ length: 150 }, (_, at) => kept(`c${at}`, at === 0 ? ['c1', 'x'] : [`c${at + 1}`], 1000 - at))
  const line = new Map(chain.map(commit => [commit.sha, commit]))
  assert.deepEqual(gitLogPage('c0', line, 100)?.length, 100, 'every one made since 100 read, the one not read made before them')
  assert.equal(gitLogPage('c0', line, 950), null, 'those made before 950 listed while the one not read might be made between them')
})

test('a fortnight of a busy branch of merges read at once by when its commits were made, after two pages: whole as far back as it needs, the pages read kept as git log lists them', async t => {
  const now = Date.UTC(2026, 9, 15, 12)
  const dag = merged(now, 20, 31)
  const head = dag.main[20].sha
  const read = github(t, dag)
  const pages = memoryPages()
  const [since, need] = [pulseSince(52, now), pulseSince(2, now)]
  const year = await yearCommits('org/repo', 'token', head, since, pages, globalThis.fetch, need)
  assert.equal(year.complete, true)
  assert.ok(year.from < need)
  const reachable = gitLog(dag.nodes, head).filter(node => Date.parse(node.committedDate) >= need).map(node => node.oid)
  const counted = new Set(year.commits.map(commit => commit.sha))
  assert.deepEqual(reachable.filter(sha => !counted.has(sha)), [], 'every commit made since it needs read')
  assert.ok(reachable.length > 500)
  assert.ok(read.pages() <= 20, 'two pages of GitHub from each of as many as ten commits')
  assert.ok(read.windows() > 0)
  for (const [top, page] of pages.store) assert.deepEqual(page.map(commit => commit.sha), gitLog(dag.nodes, top, 100).map(node => node.oid), `the page from ${top}`)
  // The head moved on a day: its new commits read a page at a time, those
  // under them kept.
  const [before, windows] = [read.pages(), read.windows()]
  const moved = await yearCommits('org/repo', 'token', dag.main[0].sha, since, pages, globalThis.fetch, need)
  assert.equal(moved.complete, true)
  assert.equal(read.windows(), windows, 'no windows read')
  assert.ok(read.pages() - before <= 20)
  const now0 = gitLog(dag.nodes, dag.main[0].sha).filter(node => Date.parse(node.committedDate) >= need).map(node => node.oid)
  const counted0 = new Set(moved.commits.map(commit => commit.sha))
  assert.deepEqual(now0.filter(sha => !counted0.has(sha)), [])
})
