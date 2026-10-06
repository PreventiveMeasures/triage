import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { lookupIssueLinks } from '../server-managed/github-issue-links.ts'
import { visibleManagedIssues } from '../server-managed/managed-issues.ts'
import { hashToken } from '../server-managed/crypto.ts'
import { config, harness, memoryStore, seedReport, setup } from './_managed-mutation-safety.js'
import { checkManagedIssueFixes } from './_managed-issue-fixes.js'

const issueUrl = 'https://github.com/org/repo1/issues/1'
const pullUrl = number => `https://github.com/org/repo1/pull/${number}`
const repository = { databaseId: 1, nameWithOwner: 'org/repo1' }
const pull = (number, extra = {}) => ({ number, title: `PR ${number}`, body: 'Details', state: 'OPEN', isDraft: false,
  createdAt: `2026-09-${String(number).padStart(2, '0')}T00:00:00Z`, repository, ...extra })
const issue = (nodes, extra = {}) => ({ number: 1, title: 'Issue', body: 'Description', state: 'OPEN', stateReason: null,
  closedByPullRequestsReferences: { nodes, pageInfo: { hasNextPage: false, endCursor: null } }, ...extra })
const response = (...items) => Response.json({ data: Object.fromEntries(items.map((item, i) => [`r${i}`, { ...repository, item }])) })

async function fixture(t) {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const session = await setup(db), sessionId = hashToken(session.setCookie.split(';')[0].slice(4))
  await db.setUserTokens(session.userId, { accessToken: 'viewer-token', refreshToken: null, expiresAt: null })
  await db.createTeam('team', 'Team', 1)
  await db.setTeamRepo('team', 1, '')
  await db.setTeamMember('team', session.userId, { dependencies: true, security: true })
  await db.claimManagedIssue({ findingId: 'shared-finding', repoId: 1, repository: 'org/repo1', requestId: 'r', createdBy: session.userId, createdAt: 1 })
  await db.finishManagedIssue('shared-finding', 'r', issueUrl)
  const snapshot = await db.getTeamReportAccessSnapshot(sessionId, Date.now(), 'team')
  const lookup = async (fetchImpl, urls = [issueUrl]) => lookupIssueLinks(config, db, snapshot, urls, await db.listManagedIssues(['shared-finding']), fetchImpl)
  return { db, session, sessionId, snapshot, lookup }
}

test('SQLite automatic issue fixes are separate, conditional, scoped and revisioned', async t => {
  const db = openSqliteManagedDb(':memory:'); t.after(() => db.close())
  await checkManagedIssueFixes(db)
})

test('one GraphQL request fetches issue status, latest eligible linked PR and manual Fix metadata', async t => {
  const f = await fixture(t)
  const calls = []
  const result = await f.lookup((url, init) => {
    calls.push(url)
    assert.equal(url, 'https://api.github.com/graphql')
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error')
    assert.equal(init.headers.authorization, 'Bearer viewer-token')
    assert.ok(init.signal instanceof AbortSignal)
    const { query } = JSON.parse(init.body)
    assert.match(query, /closedByPullRequestsReferences\(first: 100, includeClosedPrs: true/u)
    assert.match(query, /pullRequest\(number: 2\)/u)
    return response(issue([pull(5), pull(8, { state: 'CLOSED' }), pull(7, { isDraft: true }), pull(4, { state: 'MERGED' })], { state: 'CLOSED', stateReason: 'COMPLETED' }), pull(2, { state: 'CLOSED' }))
  }, [issueUrl, pullUrl(2), pullUrl(2) + '/files'])
  assert.equal(calls.length, 1)
  assert.deepEqual(result.fixes.map(fix => [fix.url, fix.status, fix.stateReason]), [
    [issueUrl, 'closed', 'completed'], [pullUrl(2), 'closed', null], [pullUrl(2) + '/files', 'closed', null], [pullUrl(7), 'draft', null],
  ])
  assert.equal(result.updates[0].next, pullUrl(7))
  assert.equal((await f.db.getManagedIssue('shared-finding')).autoFixUrl, null, 'lookup itself has no unscoped writes')
  assert.deepEqual(await f.db.listGithubMetadata(['1:issue:1', '1:pull:7']), [], 'live private metadata is not placed under stale public cache grants')
})

test('complete reads always follow the newest eligible PR, replace old automatic values and clear absent links', async t => {
  const f = await fixture(t)
  await f.db.setTriage('shared-finding', { fix: pullUrl(2) }, f.session.userId, 'admin', 1)
  const manual = await f.db.listTriage(['shared-finding'])
  for (const [nodes, next] of [[ [pull(3)], pullUrl(3) ], [ [pull(9, { state: 'MERGED' }), pull(10, { state: 'CLOSED' })], pullUrl(9) ], [ [pull(11, { state: 'CLOSED' })], null ], [ [], null ]]) {
    const result = await f.lookup(() => response(issue(nodes)))
    assert.equal(result.updates[0].next, next)
    assert.equal(await f.db.applyManagedIssueFixes(f.sessionId, f.snapshot, result.updates), true)
    assert.equal((await f.db.getManagedIssue('shared-finding')).autoFixUrl, next)
    assert.deepEqual(await f.db.listTriage(['shared-finding']), manual)
  }
})

test('pagination considers every linked PR and issues extra requests only for unfinished connections', async t => {
  const f = await fixture(t)
  let calls = 0
  const result = await f.lookup((url, init) => {
    calls++
    if (calls === 1) return response(issue([], { closedByPullRequestsReferences: { nodes: [pull(3)], pageInfo: { hasNextPage: true, endCursor: 'cursor-1' } } }), pull(2))
    assert.match(JSON.parse(init.body).query, /after: "cursor-1"/u)
    assert.doesNotMatch(JSON.parse(init.body).query, /pullRequest\(number: 2\)/u)
    return response(issue([pull(8, { state: 'MERGED' })]))
  }, [issueUrl, pullUrl(2)])
  assert.equal(calls, 2)
  assert.equal(result.updates[0].next, pullUrl(8))
})

for (const [name, fetchImpl] of [
  ['network failure', () => { throw new Error('offline') }],
  ['HTTP failure', () => new Response(null, { status: 429 })],
  ['partial GraphQL error', () => Response.json({ data: { r0: { ...repository, item: issue([]) } }, errors: [{ message: 'incomplete' }] })],
  ['null response', () => Response.json(null)],
  ['missing connection', () => response(issue([], { closedByPullRequestsReferences: null }))],
  ['malformed PR', () => response(issue([pull(3, { state: 'UNKNOWN' })]))],
  ['repository ID mismatch', () => Response.json({ data: { r0: { ...repository, databaseId: 2, item: issue([]) } } })],
  ['foreign PR', () => response(issue([pull(3, { repository: { databaseId: 2, nameWithOwner: 'org/repo2' } })]))],
]) {
  test(`${name} preserves the old automatic Fix`, async t => {
    const f = await fixture(t)
    await f.db.setManagedIssueAutoFix('shared-finding', issueUrl, null, pullUrl(2), 1)
    const result = await f.lookup(fetchImpl)
    assert.deepEqual(result.updates, [])
    assert.equal((await f.db.getManagedIssue('shared-finding')).autoFixUrl, pullUrl(2))
  })
}

test('a failed later page never replaces a previous automatic Fix with an incomplete selection', async t => {
  const f = await fixture(t)
  let calls = 0
  const result = await f.lookup(() => ++calls === 1 ? response(issue([], {
    closedByPullRequestsReferences: { nodes: [pull(3)], pageInfo: { hasNextPage: true, endCursor: 'cursor' } },
  })) : new Response(null, { status: 500 }))
  assert.equal(result.fixes[0].url, issueUrl)
  assert.deepEqual(result.updates, [])
})

test('more than 200 saved links are handled in bounded batches without permanently dropping the remainder', async t => {
  const f = await fixture(t)
  let calls = 0
  const urls = Array.from({ length: 201 }, (_, i) => pullUrl(i + 1))
  const result = await f.lookup((url, init) => {
    calls++
    return response(...[...JSON.parse(init.body).query.matchAll(/pullRequest\(number: (\d+)\)/gu)].map(match => pull(Number(match[1]))))
  }, urls)
  assert.equal(calls, 2)
  assert.equal(result.fixes.length, 201)
})

test('unscoped or malformed links never access user credentials or GitHub', async t => {
  const f = await fixture(t)
  t.mock.method(f.db, 'getUserTokens', () => assert.fail('no credentials for unscoped links'))
  assert.deepEqual(await f.lookup(() => assert.fail('no upstream request'), ['https://github.com/org/repo2/issues/1', 'https://evil.test/1']), { fixes: [], updates: [] })
})

test('issue projections hide foreign repositories, automatic PRs outside the team, and public shares', async t => {
  const f = await fixture(t), saved = await f.db.listManagedIssues(['shared-finding'])
  assert.equal(visibleManagedIssues(saved, f.snapshot).length, 1)
  assert.deepEqual(visibleManagedIssues([{ ...saved[0], repoId: 2 }], f.snapshot), [])
  assert.equal(visibleManagedIssues([{ ...saved[0], autoFixUrl: 'https://github.com/org/repo2/pull/2' }], f.snapshot)[0].autoFixUrl, null)
  assert.deepEqual(visibleManagedIssues(saved, { ...f.snapshot, user: { ...f.snapshot.user, id: 'share:token' } }), [])
})

test('workspace refresh saves the derived Fix and exposes both links through scoped annotations', async t => {
  const f = await fixture(t), store = memoryStore()
  const reportId = await seedReport(f.db, store, f.session.userId)
  await f.db.setReportVisible(reportId, true)
  await f.db.setTriage('shared-finding', { fix: pullUrl(2) }, f.session.userId, 'admin', 1)
  const request = harness(f.db, store)
  let calls = 0
  t.mock.method(globalThis, 'fetch', (url, init) => {
    calls++
    const items = [...JSON.parse(init.body).query.matchAll(/item: (issue|pullRequest)\(number: (\d+)\)/gu)]
      .map(match => match[1] === 'issue' ? issue([pull(3)]) : pull(Number(match[2])))
    return response(...items)
  })
  assert.equal((await request('/api/teams/team/fixes', { session: f.session, method: 'GET' })).status, 200)
  assert.equal(calls, 1)
  const annotations = await request('/api/teams/team/annotations', { session: f.session, method: 'GET' })
  assert.equal(annotations.status, 200)
  const data = JSON.parse(annotations.body)
  assert.deepEqual(data.issues, { 'shared-finding': { url: issueUrl, autoFix: pullUrl(3) } })
  assert.equal(data.entries['shared-finding'].fix, pullUrl(2))
  assert.ok(data.reports[reportId].includes('shared-finding'))
})


test('SQLite upgrades saved issues without replacing their references and retains automatic fixes after restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'triage-issue-fixes-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'managed.db')
  const original = openSqliteManagedDb(path)
  await original.claimManagedIssue({ findingId: 'f', repoId: 1, repository: 'org/repo1', requestId: 'request', createdBy: null, createdAt: 1 })
  await original.finishManagedIssue('f', 'request', issueUrl)
  await original.close()
  const legacy = new DatabaseSync(path)
  legacy.exec('ALTER TABLE managed_finding_issue DROP COLUMN auto_fix_url; ALTER TABLE managed_finding_issue DROP COLUMN auto_fix_checked_at;')
  legacy.close()
  const upgraded = openSqliteManagedDb(path)
  assert.equal((await upgraded.getManagedIssue('f')).issueUrl, issueUrl)
  assert.equal((await upgraded.getManagedIssue('f')).autoFixUrl, null)
  await upgraded.setManagedIssueAutoFix('f', issueUrl, null, pullUrl(2), 100)
  await upgraded.close()
  const reopened = openSqliteManagedDb(path)
  t.after(() => reopened.close())
  assert.equal((await reopened.getManagedIssue('f')).autoFixUrl, pullUrl(2))
})

test('an error on one GraphQL alias does not block other issues and manual metadata', async t => {
  const f = await fixture(t)
  const result = await f.lookup(() => Response.json({ data: { r0: { ...repository, item: issue([]) }, r1: { ...repository, item: pull(2) } },
    errors: [{ path: ['r0', 'item', 'closedByPullRequestsReferences'], message: 'Unavailable' }] }), [issueUrl, pullUrl(2)])
  assert.deepEqual(result.updates, [], 'the errored connection cannot clear a saved automatic Fix')
  assert.deepEqual(result.fixes.map(fix => fix.url), [pullUrl(2)])
})

test('losing team access during GitHub lookup discards metadata and the derived write', async t => {
  const f = await fixture(t), store = memoryStore()
  const reportId = await seedReport(f.db, store, f.session.userId)
  await f.db.setReportVisible(reportId, true)
  t.mock.method(globalThis, 'fetch', async () => {
    await f.db.setTeamHidden('team', true, Date.now())
    return response(issue([pull(3)]))
  })
  const result = await harness(f.db, store)('/api/teams/team/fixes', { session: f.session, method: 'GET' })
  assert.equal(result.status, 404)
  assert.equal((await f.db.getManagedIssue('shared-finding')).autoFixUrl, null)
})
