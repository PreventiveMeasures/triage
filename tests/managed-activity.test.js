import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { openSqliteManagedDb } from '../server-managed/db.ts'

const query = { page: 1, limit: 100, kind: 'all', query: '', contexts: null }
const report = { id: 'r', filename: 'scan.json', contentType: 'application/json', byteSize: 2, sha256: 'x', uploadedBy: null, uploadedByLogin: 'alice', repoId: null, bundleId: null, bundleIntegrity: null }

test('activity migrates existing uploads and triage, persists snapshots after deletion and restart, and does not duplicate backfill', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'managed-activity-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'managed.sqlite')
  let db = openSqliteManagedDb(file)
  await db.insertReport(report, 100)
  await db.insertBundle({ id: 'b', integrity: 'hash', filename: 'source.zip', kind: null, byteSize: 4, uploadedBy: null, uploadedByLogin: 'bob', repoId: null }, 200)
  await db.setTriage('finding', { comment: 'annotation body is not in the activity feed' }, null, 'alice', 300)
  await db.close()

  // Recreate the pre-feature schema with existing records, then migrate it.
  const legacy = new DatabaseSync(file)
  legacy.exec(`DROP TRIGGER managed_report_activity; DROP TRIGGER managed_bundle_activity; DROP TABLE managed_activity;
    ALTER TABLE finding_triage_event DROP COLUMN report_id;
    ALTER TABLE finding_triage_event DROP COLUMN report;
    ALTER TABLE finding_triage_event DROP COLUMN repo;`)
  legacy.close()
  db = openSqliteManagedDb(file)
  const first = await db.listActivity(query)
  assert.deepEqual(first.history.map(entry => [entry.kind, entry.actor, entry.at]), [
    ['triage', 'alice', 300], ['upload', 'bob', 200], ['upload', 'alice', 100],
  ])
  assert.equal(first.history[0].report, null, 'legacy triage never invents missing report context')
  assert.doesNotMatch(JSON.stringify(first), /annotation body/u)
  await db.recordActivity({ kind: 'delete', actor: 'alice', action: 'deleted a report', reportId: 'r', report: 'scan.json' }, 400)
  await db.deleteReport('r')
  await db.deleteBundle('b')
  await db.close()
  db = openSqliteManagedDb(file)
  t.after(() => db.close())
  const reopened = await db.listActivity(query)
  assert.equal(reopened.total, 4)
  assert.equal(reopened.history[0].kind, 'delete')
  assert.deepEqual(reopened.history.slice(1), first.history, 'original times and filenames survive deletion')
})

test('activity search and type filters run before pagination; ties, empty pages, and manager context are deterministic', async (t) => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  await db.insertReport(report, 1)
  for (let i = 1; i <= 12; i++) await db.setTriageEntries([['shared', { comment: String(i) }]], null, 'alice', 100, 'r')
  await db.setTriage('private', { color: 'red' }, null, 'bob', 200)
  await db.recordActivity({ kind: 'access', actor: 'admin', action: 'changed a private team' }, 300)
  const first = await db.listActivity({ ...query, kind: 'triage', limit: 5 })
  const second = await db.listActivity({ ...query, kind: 'triage', limit: 5, page: 2 })
  assert.equal(first.total, 13)
  assert.equal(first.history[1].id, 'triage:12', 'numeric event order wins timestamp ties')
  assert.equal(new Set([...first.history, ...second.history].map(entry => entry.id)).size, 10)
  assert.equal((await db.listActivity({ ...query, limit: 5, page: 999 })).page, 3)
  const searched = await db.listActivity({ ...query, query: 'ALICE', limit: 5, page: 2 })
  assert.equal(searched.total, 13)
  assert.ok(searched.history.every(entry => entry.actor === 'alice'))
  assert.equal((await db.listActivity({ ...query, query: '%' })).total, 0, 'search is literal, not SQL LIKE syntax')
  assert.deepEqual((await db.listActivity({ ...query, contexts: [] })).history, [])
  const contexts = [{ finding: 'shared', reportId: 'visible', report: 'allowed.json', repo: 'allowed/repo' }]
  const manager = await db.listActivity({ ...query, contexts, limit: 5 })
  assert.equal(manager.total, 12)
  assert.deepEqual(manager.filters, { repos: ['allowed/repo'], users: [{ id: 'legacy:alice', login: 'alice', detail: 'Legacy actor' }] })
  assert.equal((await db.listActivity({ ...query, contexts, repo: 'allowed/repo', actor: 'legacy:alice' })).total, 12)
  assert.equal((await db.listActivity({ ...query, contexts, actor: 'legacy:bob' })).total, 0)
  assert.ok(manager.history.every(entry => entry.reportId === 'visible' && entry.report === 'allowed.json' && entry.repo === 'allowed/repo'))
  assert.equal((await db.listActivity({ ...query, contexts, query: 'scan.json' })).total, 0, 'search cannot probe the original private context')
  assert.equal((await db.listActivity({ ...query, contexts, query: 'allowed.json' })).total, 12)
  await db.deleteTriage(['shared'])
  assert.equal((await db.listActivity({ ...query, contexts })).total, 0, 'explicit triage deletion removes its activity too')
})

test('existing activity upgrades bundle identities without trusting filenames, and repeated migrations preserve scope', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'managed-activity-scope-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'managed.sqlite')
  let db = openSqliteManagedDb(file)
  const userId = await db.upsertUser({ githubUserId: 1, login: 'manager', name: null, avatarUrl: null }, 1)
  await db.selectRepo({ repoId: 7, fullName: 'o/r', private: false, installationId: null, defaultBranch: 'main', htmlUrl: 'h', addedBy: userId }, 1)
  await db.createTeam('t', 'Team', 1)
  await db.setTeamRepo('t', 7, null)
  await db.setTeamMember('t', userId, { dependencies: false, security: false })
  await db.insertBundle({ id: 'b', integrity: 'hash', filename: 'same.zip', kind: null, byteSize: 1, uploadedBy: userId, uploadedByLogin: 'manager', repoId: 7 }, 1)
  await db.recordActivity({ kind: 'delete', actor: 'admin', action: 'deleted a private bundle', report: 'same.zip' }, 2)
  await db.close()
  const legacy = new DatabaseSync(file)
  legacy.exec(`DROP TRIGGER managed_report_activity; DROP TRIGGER managed_bundle_activity;
    ALTER TABLE managed_activity DROP COLUMN bundle_id;
    ALTER TABLE managed_activity DROP COLUMN repo_id;
    ALTER TABLE managed_activity DROP COLUMN repo_directory;`)
  legacy.close()
  for (let i = 0; i < 2; i++) {
    db = openSqliteManagedDb(file)
    const manager = await db.listActivity({ ...query, contexts: [], userId: userId })
    assert.equal(manager.total, 1)
    assert.equal(manager.history[0].id, 'bundle-upload:b')
    assert.equal((await db.listActivity(query)).total, 2)
    await db.close()
  }
})


test('history repository and user filters intersect before counts and paging without attributing legacy logins', async t => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const identity = (githubUserId, login) => ({ githubUserId, login, name: null, avatarUrl: null })
  const alice = await db.upsertUser(identity(1, 'alice'), 1)
  const bob = await db.upsertUser(identity(2, 'alice-helper'), 1)
  for (const [repoId, fullName] of [[7, 'owner/one'], [8, 'owner/two']]) {
    await db.selectRepo({ repoId, fullName, private: false, installationId: null, defaultBranch: 'main', htmlUrl: 'h', addedBy: null }, 1)
  }
  await db.insertReport({ ...report, id: 'first', repoId: 7, uploadedBy: alice }, 10)
  await db.insertReport({ ...report, id: 'second', repoId: 8, uploadedBy: bob, uploadedByLogin: 'alice-helper' }, 20)
  await db.insertBundle({ id: 'bundle', integrity: 'hash', filename: report.filename, kind: null, byteSize: 1, uploadedBy: alice, uploadedByLogin: 'alice', repoId: 7 }, 30)
  for (let i = 0; i < 6; i++) await db.setTriageEntries([['shared', { comment: String(i) }]], alice, 'alice', 100 + i, 'first')
  await db.setTriageEntries([['shared', { comment: 'latest' }]], bob, 'alice-helper', 200, 'second')
  await db.recordActivity({ kind: 'delete', actorId: alice, actor: 'alice', action: 'deleted a report', repo: 'owner/two', reportId: 'second', report: 'scan.json' }, 210)
  await db.deleteReport('second')
  await db.recordActivity({ kind: 'access', actor: 'alice', action: 'legacy record' }, 220)
  await db.createComment({ findingId: 'shared', body: 'Not in history', authorId: alice, authorLogin: 'alice', reportId: 'first' }, 230)
  await db.upsertUser(identity(1, 'renamed'), 240)
  const filtered = await db.listActivity({ ...query, repo: 'owner/one', actor: `user:${alice}`, kind: 'triage', query: 'renamed', page: 2, limit: 2 })
  assert.equal(filtered.total, 7, 'includes comments and triage by the same user')
  assert.equal(filtered.page, 2)
  assert.equal(filtered.history.length, 2)
  assert.ok(filtered.history.every(entry => entry.repo === 'owner/one' && entry.actor === 'renamed'))
  assert.deepEqual(filtered.filters, {
    repos: ['owner/one', 'owner/two'],
    users: [
      { id: 'legacy:alice', login: 'alice', detail: 'Legacy actor' },
      { id: `user:${bob}`, login: 'alice-helper', detail: null },
      { id: `user:${alice}`, login: 'renamed', detail: null },
    ],
  }, 'choices cover all authorized history independently of filters and pagination')
  const own = await db.listActivity({ ...query, actor: `user:${alice}` })
  assert.equal(own.total, 10, 'stable identity includes old upload names, comments, and deleted report activity')
  assert.equal(own.history.some(entry => entry.action === 'legacy record'), false)
  assert.equal((await db.listActivity({ ...query, actor: 'legacy:alice' })).total, 1, 'legacy logins remain independently selectable')
  assert.equal((await db.listActivity({ ...query, actor: `user:${bob}` })).total, 2, 'similar names never merge users')
  for (const actor of ['renamed', 'legacy:renamed', 'user:missing', 'user:%']) {
    const empty = await db.listActivity({ ...query, actor, page: 99 })
    assert.deepEqual(empty.history, [])
    assert.equal(empty.total, 0)
    assert.equal(empty.page, 1)
  }
})
