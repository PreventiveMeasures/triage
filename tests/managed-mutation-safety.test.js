import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { endSession } from '../server-managed/session.ts'
import { config, harness, memoryStore, removal, seedBundle, seedReport, setup } from './_managed-mutation-safety.js'

async function fixture(t) {
  const db = openSqliteManagedDb(':memory:'); t.after(() => db.close())
  const session = await setup(db)
  const bundles = memoryStore(), reports = memoryStore(), uploads = memoryStore()
  const reportId = await seedReport(db, reports, session.userId)
  const bundleId = await seedBundle(db, bundles, session.userId)
  return { db, session, reports, bundles, uploads, reportId, bundleId, send: harness(db, reports, bundles, uploads) }
}

for (const revocation of ['none', 'view', 'logout', 'expired']) {
  test(`management writes reject ${revocation} while reading their request body`, async t => {
    for (const route of ['publish', 'hide-bundle', 'move-report', 'move-bundle', 'remove-repository', 'deactivate', 'stage']) {
      await t.test(route, async st => {
        const f = await fixture(st)
        const routes = {
          publish: ['/api/admin/reports/set-visible', { reportId: f.reportId, visible: true }],
          'hide-bundle': ['/api/admin/bundles/set-visible', { bundleId: f.bundleId, visible: false }],
          'move-report': ['/api/admin/reports/set-repo', { reportId: f.reportId, repoId: 2 }],
          'move-bundle': ['/api/admin/bundles/set-repo', { bundleId: f.bundleId, repoId: 2 }],
          'remove-repository': ['/api/admin/repositories/remove', removal],
          deactivate: ['/api/admin/repositories/select', { repoId: 1, selected: false }],
          stage: [`/api/admin/uploads/reports/${randomUUID()}/0`, Buffer.from('part')],
        }
        const [path, body] = routes[route]
        const response = await f.send(path, { session: f.session, body, beforeBody: async () => {
          if (revocation === 'logout') await endSession(config, f.db, f.session.setCookie.split(';')[0])
          else if (revocation === 'expired') { const now = Date.now(); st.mock.method(Date, 'now', () => now + config.sessionTtlMs) }
          else await f.db.setUserRole(f.session.userId, revocation)
        } })
        assert.equal(response.status, revocation === 'logout' || revocation === 'expired' ? 401 : 403, String(response.body))
        assert.equal((await f.db.getReport(f.reportId)).visible, false)
        assert.equal((await f.db.getReport(f.reportId)).repoId, 1)
        assert.equal((await f.db.getBundle(f.bundleId)).repoId, 1)
        assert.equal((await f.db.getBundle(f.bundleId)).visible, true)
        assert.equal((await f.db.listSelectedRepos()).length, 2)
        assert.equal(f.reports.blobs.size, 1)
        assert.equal(f.bundles.blobs.size, 1)
        assert.equal(f.uploads.blobs.size, 0)
      })
    }
  })
}

for (const target of ['report', 'bundle']) {
  test(`${target} upload rechecks session after slow byte storage`, async t => {
    const f = await fixture(t), store = target === 'report' ? f.reports : f.bundles
    const put = store.put
    t.mock.method(store, 'put', async (id, bytes) => { await put(id, bytes); await endSession(config, f.db, f.session.setCookie.split(';')[0]) })
    const result = await f.send(`/api/admin/${target}s`, { session: f.session,
      body: Buffer.from(target === 'report' ? '{"findings":[]}' : 'new bundle'), headers: { 'x-repo-id': '1' } })
    assert.equal(result.status, 401)
    assert.equal(store.blobs.size, 1, 'rolled back uploads clean up their new bytes')
    assert.equal((await f.db.listReports()).length, 1)
    assert.equal((await f.db.listBundles()).length, 1)
  })
  test(`${target} delete checks current grants inside its write transaction`, async t => {
    const f = await fixture(t)
    await f.db.setUserRole(f.session.userId, 'manage')
    await f.db.createTeam('team', 'Team', Date.now())
    await f.db.setTeamRepo('team', 1, null)
    await f.db.setTeamMember('team', f.session.userId, { dependencies: true, security: true })
    const method = target === 'report' ? 'mutateReport' : 'mutateBundle', mutate = f.db[method]
    t.mock.method(f.db, method, async (...args) => { await f.db.removeTeamMember('team', f.session.userId); return mutate(...args) })
    const id = target === 'report' ? f.reportId : f.bundleId
    const result = await f.send(`/api/admin/${target}s/${id}`, { session: f.session, method: 'DELETE' })
    assert.equal(result.status, 403)
    assert.ok(await f.reports.get(f.reportId))
    assert.ok(await f.bundles.get(f.bundleId))
    assert.ok(await f.db.getReport(f.reportId))
    assert.ok(await f.db.getBundle(f.bundleId))
  })
}

test('repository removal only cleans blobs belonging to metadata deleted in its transaction', async t => {
  const f = await fixture(t), remove = f.db.removeRepository
  t.mock.method(f.db, 'removeRepository', async (...args) => {
    await f.db.setReportRepo(f.reportId, 2)
    await f.db.setBundleRepo(f.bundleId, 2)
    return remove(...args)
  })
  const response = await f.send('/api/admin/repositories/remove', { session: f.session, body: removal })
  assert.equal(response.status, 200)
  assert.equal(JSON.parse(response.body).deletedReports, 0)
  assert.equal(JSON.parse(response.body).deletedBundles, 0)
  assert.equal((await f.db.getReport(f.reportId)).repoId, 2)
  assert.equal((await f.db.getBundle(f.bundleId)).repoId, 2)
  assert.ok(await f.reports.get(f.reportId))
  assert.ok(await f.bundles.get(f.bundleId))
})

for (const change of ['insert', 'move']) {
  test(`repository annotation deletion rejects a concurrent report ${change} and is safe to retry`, async t => {
    const f = await fixture(t), remove = f.db.removeRepository
    await f.db.setTriage('shared-finding', { fix: 'PR-1' }, f.session.userId, 'admin', Date.now())
    await f.db.createComment({ findingId: 'shared-finding', body: 'Discussion', authorId: null, authorLogin: null }, Date.now())
    let survivingId
    t.mock.method(f.db, 'removeRepository', async (...args) => {
      if (change === 'insert') survivingId = await seedReport(f.db, f.reports, f.session.userId, 2)
      else { survivingId = f.reportId; await f.db.setReportRepo(f.reportId, 2) }
      return remove(...args)
    })
    const request = { session: f.session, body: { ...removal, deleteTriage: true } }
    const response = await f.send('/api/admin/repositories/remove', request)
    assert.equal(response.status, 409)
    assert.equal(JSON.parse(response.body).error, 'repository-changed')
    assert.ok(await f.db.getReport(f.reportId))
    assert.equal((await f.db.listAllRepos()).length, 2)
    t.mock.restoreAll()
    assert.equal((await f.send('/api/admin/repositories/remove', request)).status, 200)
    assert.ok(await f.db.getReport(survivingId))
    assert.ok(await f.reports.get(survivingId))
    assert.equal((await f.db.listTriage(['shared-finding'])).length, 1)
    assert.equal((await f.db.listTriageHistory('shared-finding', 100)).length, 1)
    assert.equal((await f.db.listComments(['shared-finding'])).length, 1)
  })
}

test('repository removal rolls back every metadata deletion on a mid-transaction database error', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'managed-remove-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'db.sqlite')
  const db = openSqliteManagedDb(path)
  t.after(() => db.close())
  const session = await setup(db)
  const bundles = memoryStore(), reports = memoryStore()
  const reportId = await seedReport(db, reports, session.userId)
  const bundleId = await seedBundle(db, bundles, session.userId)
  await db.setTriage('shared-finding', { fix: 'PR-1' }, session.userId, 'admin', Date.now())
  const raw = new DatabaseSync(path)
  raw.exec("CREATE TRIGGER fail_bundle_delete BEFORE DELETE ON managed_bundle BEGIN SELECT RAISE(ABORT, 'injected database failure'); END")
  raw.close()
  t.mock.method(console, 'warn', () => {})
  const response = await harness(db, reports, bundles)('/api/admin/repositories/remove', { session, body: { ...removal, deleteTriage: true } })
  assert.equal(response.status, 500)
  assert.ok(await db.getReport(reportId))
  assert.ok(await db.getBundle(bundleId))
  assert.equal((await db.listAllRepos()).length, 2)
  assert.equal((await db.listTriage(['shared-finding'])).length, 1)
  assert.ok(await reports.get(reportId))
  assert.ok(await bundles.get(bundleId))
  assert.equal((await db.listActivity({ page: 1, limit: 100, kind: 'delete', query: '' })).total, 0)
})
