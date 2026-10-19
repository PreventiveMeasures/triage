import assert from 'node:assert/strict'
import { test } from 'node:test'
import { listedActivity } from '../server-managed/listed-activity.ts'
import { readIssues } from '../server-managed/repository-pulls.ts'

const DAY = 24 * 60 * 60_000
const signals = { sessions: [], tasks: [], claude: false, codex: false, agents: [] }
// A pull request kept as the Agents tab and the Pulse read it, merged (`at`)
// or not; an issue.
const pull = (number, { at = null, ...more } = {}) => ({ number, title: `Pull ${number}`, state: at === null ? 'open' : 'merged', draft: false, author: 'ada',
  authorId: 7, createdAt: Date.UTC(2026, 9, 1), updatedAt: Date.UTC(2026, 9, 14), head: null, fork: null, additions: 0, deletions: 0, commits: 1, closes: [], signals,
  ...at === null ? {} : { merged: { sha: number.toString(16).padStart(40, '0'), at, agent: false } }, ...more })
const issue = (number, more = {}) => ({ number, title: `Issue ${number}`, state: 'open', author: 'ada', authorId: 7, createdAt: Date.UTC(2026, 9, 1),
  updatedAt: Date.UTC(2026, 9, 14), closedAt: null, reason: null, ...more })

test('a period\'s pull requests and issues told of those kept as a search counts them: by the day (UTC), and over the same days a period earlier; the latest listed first', () => {
  // A Thursday: four weeks from Sunday the 20th, the period before from the 23rd of August to the 17th of September, that day whole.
  const now = Date.UTC(2026, 9, 15, 12)
  const pulls = [pull(4, { at: Date.UTC(2026, 9, 2) }), pull(5, { at: Date.UTC(2026, 9, 9) }), pull(6, { draft: true, author: null, authorId: null }),
    pull(7, { at: Date.UTC(2026, 8, 17, 23), createdAt: Date.UTC(2026, 8, 10) }), pull(8, { at: Date.UTC(2026, 8, 18), createdAt: Date.UTC(2026, 7, 22, 23) })]
  const issues = [issue(3, { state: 'closed', closedAt: Date.UTC(2026, 9, 3), reason: 'not-planned' }),
    // Closed, then opened again: none closed.
    issue(10, { closedAt: Date.UTC(2026, 9, 4) }), issue(11, { createdAt: Date.UTC(2026, 8, 10) })]
  const read = listedActivity(pulls, issues, 4, now)
  assert.deepEqual([read.since, read.previousSince], [Date.UTC(2026, 8, 20), Date.UTC(2026, 7, 23)])
  assert.deepEqual([read.merged.count, read.merged.previous, read.opened.count, read.opened.previous], [2, 1, 3, 1])
  assert.deepEqual([read.closed.count, read.closed.previous, read.created.count, read.created.previous], [1, 0, 2, 1])
  assert.deepEqual(read.merged.items.map(item => item.number), [5, 4], 'the latest merged first')
  assert.deepEqual(read.merged.items[0], { number: 5, title: 'Pull 5', author: 'ada', authorId: 7, at: Date.UTC(2026, 9, 9), createdAt: Date.UTC(2026, 9, 1), kind: 'pulls',
    state: 'merged', draft: false })
  assert.deepEqual(read.opened.items.find(item => item.number === 6), { number: 6, title: 'Pull 6', author: null, authorId: null, at: Date.UTC(2026, 9, 1),
    createdAt: Date.UTC(2026, 9, 1), kind: 'pulls', state: 'open', draft: true })
  assert.deepEqual(read.closed.items, [{ number: 3, title: 'Issue 3', author: 'ada', authorId: 7, at: Date.UTC(2026, 9, 3), createdAt: Date.UTC(2026, 9, 1), kind: 'issues',
    state: 'closed', reason: 'not-planned' }])
  // As many listed as ten, the latest.
  const many = listedActivity(Array.from({ length: 12 }, (_, at) => pull(100 + at, { at: Date.UTC(2026, 9, 1) + at * DAY })), [], 4, now)
  assert.deepEqual([many.merged.count, many.merged.items.length, many.merged.items[0].number], [12, 10, 111])
})

test('a period\'s pull requests and issues narrowed to its days and the logins a contributor committed as, whatever their case, an app\'s as GitHub names its bot', () => {
  const now = Date.UTC(2026, 9, 15, 12)
  // Dependabot's bot, as GitHub's GraphQL API names it, and a user of its name.
  const pulls = [pull(1, { at: Date.UTC(2026, 8, 28, 10) }), pull(2, { at: Date.UTC(2026, 8, 28, 20), author: 'dependabot', authorId: 49699333, bot: true }),
    pull(3, { at: Date.UTC(2026, 8, 28, 12), author: 'grace' }), pull(4, { at: Date.UTC(2026, 8, 29) }), pull(5, { at: Date.UTC(2026, 8, 28, 9), author: 'dependabot' })]
  const day = authors => ({ from: Date.UTC(2026, 8, 28), to: Date.UTC(2026, 8, 28), authors })
  assert.deepEqual(listedActivity(pulls, [], 4, now, day(['Ada', 'dependabot[bot]'])).merged.items.map(item => item.number), [2, 1])
  assert.deepEqual(listedActivity(pulls, [], 4, now, day(['Dependabot'])).merged.items.map(item => item.number), [5], 'the user, not the bot of its name')
  assert.deepEqual(listedActivity(pulls, [], 4, now, { from: Date.UTC(2026, 8, 28), to: null, authors: [] }).merged.count, 5, 'on from its day, by anyone')
})

test('a repository\'s issues kept as read, the most recently updated first: when and why each closed was', async t => {
  const since = Date.UTC(2025, 9, 19)
  t.mock.method(globalThis, 'fetch', (input, options = {}) => {
    const body = JSON.parse(options.body)
    assert.match(body.query, /issues\(first: \$first, after: \$after, orderBy: \{ field: UPDATED_AT, direction: DESC \}\)/u)
    assert.equal(body.variables.first, 100, 'a hundred a page, none read before')
    assert.doesNotMatch(body.query, /body|comments/u, 'no text read')
    return Promise.resolve(Response.json({ data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
      { number: 2, title: 'Two', state: 'CLOSED', stateReason: 'DUPLICATE', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-03T00:00:00Z', closedAt: '2026-10-02T00:00:00Z',
        author: { login: 'ada', databaseId: 7 } },
      { number: 1, title: 'One', state: 'OPEN', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', author: { __typename: 'Bot', login: 'renovate' } },
      null] } } } }))
  })
  const read = await readIssues('org/repo', 'token', since, null)
  assert.deepEqual(read.rows, [
    { number: 2, title: 'Two', state: 'closed', author: 'ada', authorId: 7, createdAt: Date.parse('2026-10-01T00:00:00Z'), updatedAt: Date.parse('2026-10-03T00:00:00Z'),
      closedAt: Date.parse('2026-10-02T00:00:00Z'), reason: 'duplicate' },
    { number: 1, title: 'One', state: 'open', author: 'renovate', authorId: null, createdAt: Date.parse('2026-09-01T00:00:00Z'), updatedAt: Date.parse('2026-10-02T00:00:00Z'),
      bot: true, closedAt: null, reason: null }], 'a bot\'s told apart')
  assert.deepEqual([read.all, read.through, read.next], [true, Date.parse('2026-10-03T00:00:00Z'), null])
})
