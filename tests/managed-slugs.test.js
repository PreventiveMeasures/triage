import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { managedRouteForIds, managedRoutePath, parseManagedRoute, resolveManagedRoute } from '../common/managed/routes.js'
import { createManagedHistory } from '../ui/view/managed-history.js'
import { browserAt } from './_managed-browser.js'

const first = '11111111-1111-4111-8111-123456789abc'
const second = '22222222-2222-4222-8222-123456789abc'
const short = '123456789abc'

async function seed(db) {
  const user = await db.upsertUser({ githubUserId: 1, login: 'member', name: null, avatarUrl: null }, 100)
  for (const [index, id] of [first, second].entries()) {
    const repoId = index + 1
    await db.selectRepo({ repoId, fullName: `owner/repo${repoId}`, private: false, installationId: null, defaultBranch: 'main', htmlUrl: 'h', addedBy: user }, 100)
    await db.createTeam(id, `Team ${repoId}`, 100)
    await db.setTeamRepo(id, repoId, null)
    await db.insertReport({ id, filename: `${repoId}.json`, contentType: 'application/json', byteSize: 1, sha256: id, uploadedBy: user, repoId, visible: true }, 100)
  }
  await db.setTeamMember(second, user, { dependencies: false, security: false })
  return user
}

test('slugs are global within each namespace, persistent, and leave UUID relationships intact', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'managed-slugs-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'managed.sqlite')
  let db = openSqliteManagedDb(path)
  t.after(() => db.close())
  const user = await seed(db)
  assert.equal((await db.getTeam(first)).slug, short)
  assert.equal((await db.getReport(first)).slug, short)
  assert.equal((await db.getTeam(second)).slug, second)
  assert.equal((await db.getReport(second)).slug, second)
  assert.equal(await db.getTeam(short), null, 'DB lookups keep using UUIDs')
  assert.equal(await db.getReport(short), null)
  const [visible] = await db.listTeamsForUser(user)
  assert.equal(visible.id, second)
  assert.equal(visible.slug, second, 'a collision outside the user\'s teams still reserves the short slug')
  assert.deepEqual(visible.reports, [{ id: second, slug: second, filename: '2.json' }])
  assert.equal(await db.userCanReadReport(user, first), false)
  assert.equal(await db.userCanReadReport(user, second), true)
  assert.deepEqual((await db.listReports()).map(report => report.slug), [short, second])
  await db.renameTeam(second, 'Renamed', 200)
  await db.deleteTeam(first)
  await db.deleteReport(first)
  await db.close()
  db = openSqliteManagedDb(path)
  assert.equal((await db.getTeam(second)).slug, second, 'renaming or removing a collision does not break links')
  assert.equal((await db.getReport(second)).slug, second)
  assert.equal((await db.listTeamsForUser(user))[0].reports[0].id, second)
})

test('existing teams and reports are backfilled deterministically without changing IDs or access', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'managed-slug-migration-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'managed.sqlite')
  let db = openSqliteManagedDb(path)
  const user = await seed(db)
  await db.close()
  const legacy = new DatabaseSync(path)
  for (const table of ['managed_team', 'managed_report']) {
    legacy.exec(`DROP INDEX ${table}_slug_idx; ALTER TABLE ${table} DROP COLUMN slug`)
  }
  legacy.close()
  db = openSqliteManagedDb(path)
  t.after(() => db.close())
  assert.deepEqual((await db.listTeams()).map(team => [team.id, team.slug]), [[first, short], [second, second]])
  assert.deepEqual((await db.listReports()).map(report => [report.id, report.slug]), [[first, short], [second, second]])
  assert.equal(await db.userCanReadReport(user, first), false)
  assert.equal(await db.userCanReadReport(user, second), true)
  await db.close()
  db = openSqliteManagedDb(path)
  assert.equal((await db.getTeam(first)).slug, short)
  assert.equal((await db.getReport(second)).slug, second)
})

const teams = [
  { id: first, slug: short, reports: [{ id: first, slug: short }] },
  { id: second, slug: second, reports: [{ id: first, slug: short }, { id: second, slug: second }] },
]

test('managed routes use exact server slugs and resolve back to internal UUIDs', () => {
  for (const team of teams) {
    for (const report of [null, ...team.reports]) {
      for (const view of ['findings', 'files']) {
        const internal = { view, teamId: team.id, reportId: report?.id ?? null }
        const external = managedRouteForIds(internal, teams)
        const path = managedRoutePath(external)
        assert.equal(path, `/teams/${team.slug}${report ? `/reports/${report.slug}` : ''}${view === 'files' ? '/files' : ''}`)
        assert.deepEqual(resolveManagedRoute(parseManagedRoute(new URL(path, 'https://triage.test')), teams), internal)
      }
    }
  }
  assert.equal(resolveManagedRoute({ view: 'findings', teamSlug: first }, teams), null, 'a UUID is not an alias for a different stored slug')
  assert.equal(resolveManagedRoute({ view: 'findings', teamSlug: short, reportSlug: second }, teams), null, 'report must belong to the selected team')
  assert.equal(managedRouteForIds({ view: 'findings', teamId: first, reportId: second }, teams), null)
})

test('unknown and ambiguous slugs go home, including finding links; duplicate report membership is not ambiguous', async () => {
  const duplicateTeam = [...teams, { id: 'other', slug: short, reports: [] }]
  const duplicateReport = [...teams, { id: 'other', slug: 'other', reports: [{ id: 'other-report', slug: short }] }]
  for (const [catalogue, path] of [
    [teams, '/teams/missing'], [teams, `/teams/${short}/reports/missing`],
    [duplicateTeam, `/teams/${short}`], [duplicateReport, `/teams/${short}/reports/${short}#finding=issue`],
  ]) {
    const { browser } = browserAt(path)
    let shown
    await createManagedHistory(browser).start(route => {
      const resolved = resolveManagedRoute(route, catalogue)
      if (!resolved) return false
      shown = resolved
      return true
    })
    assert.deepEqual(shown, { view: 'home' })
    assert.equal(browser.location.pathname, '/')
  }
  assert.equal(managedRouteForIds({ view: 'findings', teamId: first }, duplicateTeam), null)
  assert.equal(managedRouteForIds({ view: 'findings', teamId: first, reportId: first }, duplicateReport), null)
  assert.equal(resolveManagedRoute({ view: 'findings', teamSlug: short, reportSlug: short }, teams).reportId, first)
})

test('slug history resolves UUIDs on clicks, Back/Forward and reload', async () => {
  const { browser } = browserAt(`/teams/${short}/reports/${short}`)
  let shown
  const restore = route => {
    const resolved = resolveManagedRoute(route, teams)
    if (!resolved) return false
    shown = resolved
    return managedRouteForIds(resolved, teams)
  }
  const nav = createManagedHistory(browser)
  await nav.start(restore)
  assert.equal(shown.reportId, first)
  await nav.navigate(managedRouteForIds({ view: 'files', teamId: second, reportId: second }, teams))
  assert.equal(shown.reportId, second)
  await browser.move(-1)
  assert.equal(shown.reportId, first)
  await browser.move(1)
  assert.equal(shown.reportId, second)
  await createManagedHistory(browser).start(restore)
  assert.equal(shown.reportId, second)
  assert.equal(browser.location.pathname, `/teams/${second}/reports/${second}/files`)
})
