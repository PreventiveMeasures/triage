// A repository's change stamp (server-managed/repository-stamp.ts): what
// moves as anything its tabs read of it changes, but its pull requests'
// checks, in one cheap query; none where GitHub's answer tells no counts.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { repositoryStamp } from '../server-managed/repository-stamp.ts'

const answer = (more = {}) => ({ data: { repository: { pushedAt: '2026-10-19T00:00:00Z', heads: { totalCount: 3 }, tags: { totalCount: 1 },
  pullRequests: { totalCount: 5, nodes: [{ updatedAt: '2026-10-18T00:00:00Z' }] }, issues: { totalCount: 0, nodes: [] }, ...more } } })

test('a repository\'s stamp: when it was pushed to, its branches and tags counted, its pull requests and issues counted and the one updated last; moving as each does', async t => {
  let told = answer()
  const asked = []
  t.mock.method(globalThis, 'fetch', (input, options) => {
    asked.push(JSON.parse(options.body))
    return Promise.resolve(Response.json(told))
  })
  const { stamp } = await repositoryStamp('org/repo', 'token')
  assert.deepEqual(JSON.parse(stamp), ['2026-10-19T00:00:00Z', 3, 1, 5, '2026-10-18T00:00:00Z', 0, null])
  assert.deepEqual(asked[0].variables, { owner: 'org', name: 'repo' })
  assert.match(asked[0].query, /pullRequests\(first: 1, orderBy: \{ field: UPDATED_AT, direction: DESC \}\)/u)
  assert.doesNotMatch(asked[0].query, /statusCheckRollup|body|title/u, 'nothing but what moves')
  for (const moved of [{ pushedAt: '2026-10-19T01:00:00Z' }, { heads: { totalCount: 2 } }, { tags: { totalCount: 2 } },
    { pullRequests: { totalCount: 5, nodes: [{ updatedAt: '2026-10-19T02:00:00Z' }] } }, { issues: { totalCount: 1, nodes: [{ updatedAt: '2026-10-19T02:00:00Z' }] } }]) {
    told = answer(moved)
    assert.notEqual((await repositoryStamp('org/repo', 'token')).stamp, stamp, JSON.stringify(moved))
  }
  // One telling no counts tells nothing.
  told = answer({ issues: null })
  await assert.rejects(repositoryStamp('org/repo', 'token'), { message: 'github-malformed' })
  told = { data: { repository: null } }
  await assert.rejects(repositoryStamp('org/repo', 'token'), { message: 'github-not-found' })
})
