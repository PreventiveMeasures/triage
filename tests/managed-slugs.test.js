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
    await db.insertBundle({ id, integrity: id, filename: `${repoId}.map`, kind: 'sourcemap', byteSize: 1, uploadedBy: user, repoId }, 100)
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
  assert.equal((await db.getBundle(first)).slug, short)
  assert.equal((await db.getTeam(second)).slug, second)
  assert.equal((await db.getReport(second)).slug, second)
  assert.equal((await db.getBundle(second)).slug, second)
  assert.equal(await db.getTeam(short), null, 'DB lookups keep using UUIDs')
  assert.equal(await db.getReport(short), null)
  assert.equal(await db.getBundle(short), null)
  assert.deepEqual((await db.listBundles()).map(bundle => bundle.slug), [short, second])
  const [visible] = await db.listTeamsForUser(user)
  assert.equal(visible.id, second)
  assert.deepEqual(visible.bundles.map(({ id, slug, integrity, repoId }) => ({ id, slug, integrity, repoId })),
    [{ id: second, slug: second, integrity: second, repoId: 2 }])
  assert.equal(visible.slug, second, 'a collision outside the user\'s teams still reserves the short slug')
  assert.deepEqual(visible.reports.map(({ id, slug, filename }) => ({ id, slug, filename })), [{ id: second, slug: second, filename: '2.json' }])
  assert.equal(await db.userCanReadReport(user, first), false)
  assert.equal(await db.userCanReadReport(user, second), true)
  assert.deepEqual((await db.listReports()).map(report => report.slug), [short, second])
  await db.renameTeam(second, 'Renamed', 200)
  await db.deleteTeam(first)
  await db.deleteReport(first)
  await db.deleteBundle(first)
  await db.close()
  db = openSqliteManagedDb(path)
  assert.equal((await db.getTeam(second)).slug, second, 'renaming or removing a collision does not break links')
  assert.equal((await db.getReport(second)).slug, second)
  assert.equal((await db.getBundle(second)).slug, second)
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
  for (const table of ['managed_team', 'managed_report', 'managed_bundle']) {
    legacy.exec(`DROP INDEX ${table}_slug_idx; ALTER TABLE ${table} DROP COLUMN slug`)
  }
  legacy.close()
  db = openSqliteManagedDb(path)
  t.after(() => db.close())
  assert.deepEqual((await db.listTeams()).map(team => [team.id, team.slug]), [[first, short], [second, second]])
  assert.deepEqual((await db.listReports()).map(report => [report.id, report.slug]), [[first, short], [second, second]])
  assert.deepEqual((await db.listBundles()).map(bundle => [bundle.id, bundle.slug]), [[first, short], [second, second]])
  assert.equal(await db.userCanReadReport(user, first), false)
  assert.equal(await db.userCanReadReport(user, second), true)
  await db.close()
  db = openSqliteManagedDb(path)
  assert.equal((await db.getTeam(first)).slug, short)
  assert.equal((await db.getReport(second)).slug, second)
  assert.equal((await db.getBundle(second)).slug, second)
})

test('migration reserves legacy IDs before UUIDs can claim their suffixes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'managed-legacy-slugs-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'managed.sqlite')
  let db = openSqliteManagedDb(path)
  await db.close()
  const ids = ['00000000-0000-4000-8000-123456789abc', short, 'ffffffff-ffff-4fff-8fff-123456789abc']
  const legacy = new DatabaseSync(path)
  try {
    for (const table of ['managed_team', 'managed_report', 'managed_bundle']) {
      legacy.exec(`DROP INDEX ${table}_slug_idx; ALTER TABLE ${table} DROP COLUMN slug`)
    }
    for (const id of ids) {
      legacy.prepare(`INSERT INTO managed_bundle (id, integrity, filename, byte_size, uploaded_at) VALUES (?, ?, ?, 1, 100)`).run(id, id, `${id}.map`)
      legacy.prepare('INSERT INTO managed_team (id, name, created_at, updated_at) VALUES (?, ?, 100, 100)').run(id, id)
      legacy.prepare(`INSERT INTO managed_report (id, filename, content_type, byte_size, sha256, uploaded_at)
        VALUES (?, ?, 'application/json', 1, 'hash', 100)`).run(id, `${id}.json`)
    }
  } finally { legacy.close() }
  db = openSqliteManagedDb(path)
  t.after(() => db.close())
  for (const id of ids) {
    assert.equal((await db.getTeam(id)).slug, id)
    assert.equal((await db.getReport(id)).slug, id)
    assert.equal((await db.getBundle(id)).slug, id)
  }
  await db.close()
  db = openSqliteManagedDb(path)
  assert.deepEqual((await db.listTeams()).map(team => team.slug), ids)
  assert.deepEqual((await db.listReports()).map(report => report.slug), ids)
  assert.deepEqual((await db.listBundles()).map(bundle => bundle.slug), ids)
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
        assert.equal(path, `/team/${team.slug}${report ? `/report/${report.slug}` : ''}${view === 'files' ? '/files' : ''}`)
        assert.deepEqual(resolveManagedRoute(parseManagedRoute(new URL(path, 'https://triage.test')), teams), internal)
      }
    }
    // A team's lists, by what each lists.
    for (const kind of ['reports', 'bundles', 'repositories', 'dependencies']) {
      const internal = { view: `workspace-${kind}`, teamId: team.id }
      const path = managedRoutePath(managedRouteForIds(internal, teams))
      assert.equal(path, `/team/${team.slug}/${kind}`)
      assert.deepEqual(resolveManagedRoute(parseManagedRoute(new URL(path, 'https://triage.test')), teams), internal)
    }
    // Its dependencies' sub-tabs, past the first, which its list's own
    // address names.
    for (const dependencyTab of ['pulls', 'versions', 'branch', 'reviews']) {
      const internal = { view: 'workspace-dependencies', teamId: team.id, dependencyTab }
      const path = managedRoutePath(managedRouteForIds(internal, teams))
      assert.equal(path, `/team/${team.slug}/dependencies${dependencyTab === 'pulls' ? '' : `/${dependencyTab}`}`)
      assert.deepEqual(resolveManagedRoute(parseManagedRoute(new URL(path, 'https://triage.test')), teams),
        dependencyTab === 'pulls' ? { view: 'workspace-dependencies', teamId: team.id } : internal)
    }
    assert.deepEqual(parseManagedRoute(new URL(`/team/${team.slug}/dependencies/pulls`, 'https://triage.test')),
      { view: 'workspace-dependencies', teamSlug: team.slug, dependencyTab: 'pulls' })
    for (const path of [`/team/${team.slug}/dependencies/other`, `/team/${team.slug}/repositories/versions`]) {
      assert.equal(parseManagedRoute(new URL(path, 'https://triage.test')), null, path)
    }
    assert.equal(managedRoutePath({ view: 'workspace-dependencies', teamSlug: team.slug, dependencyTab: 'other' }), null)
    assert.equal(managedRoutePath({ view: 'workspace-repositories', teamSlug: team.slug, dependencyTab: 'versions' }), `/team/${team.slug}/repositories`,
      'a sub-tab of its dependencies alone')
  }
  assert.equal(resolveManagedRoute({ view: 'findings', teamSlug: first }, teams), null, 'a UUID is not an alias for a different stored slug')
  assert.equal(resolveManagedRoute({ view: 'findings', teamSlug: short, reportSlug: second }, teams), null, 'report must belong to the selected team')
  assert.equal(managedRouteForIds({ view: 'findings', teamId: first, reportId: second }, teams), null)
})

test('unknown and ambiguous slugs go home; duplicate report membership is not ambiguous', async () => {
  const duplicateTeam = [...teams, { id: 'other', slug: short, reports: [] }]
  const duplicateReport = [...teams, { id: 'other', slug: 'other', reports: [{ id: 'other-report', slug: short }] }]
  for (const [catalogue, path] of [
    [teams, '/team/missing'], [teams, `/team/${short}/report/missing`], [teams, `/team/${short}/report/${second}`], [teams, `/team/missing/report/${short}/files`],
    [duplicateTeam, `/team/${short}`], [duplicateReport, `/team/${short}/report/${short}`],
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

test('a finding link resolves the team and report it can, for its finding to be looked up by', () => {
  const duplicateTeam = [...teams, { id: 'other', slug: short, reports: [] }]
  const duplicateReport = [...teams, { id: 'other', slug: 'other', reports: [{ id: 'other-report', slug: short }] }]
  const finding = { id: 'issue' }
  const resolved = (path, catalogue = teams) => resolveManagedRoute(parseManagedRoute(new URL(path, 'https://triage.test')), catalogue)
  for (const [path, teamId, reportId, catalogue] of [
    [`/team/${short}/report/${short}/finding/issue`, first, first],
    [`/team/${short}/report/${second}/finding/issue`, first, second, teams, 'a report of another team'],
    [`/team/${short}/report/missing/finding/issue`, first, null],
    [`/team/missing/report/${second}/finding/issue`, null, second],
    [`/team/missing/report/missing/finding/issue`, null, null],
    [`/team/${first}/report/${first}/finding/issue`, null, null, teams, 'UUIDs are not slug aliases'],
    [`/team/${short}/report/${short}/finding/issue`, null, first, duplicateTeam],
    [`/team/${short}/report/${short}/finding/issue`, first, null, duplicateReport],
  ]) {
    assert.deepEqual(resolved(path, catalogue), { view: 'findings', finding, teamId, reportId, teamOnly: false }, path)
  }
  assert.deepEqual(resolved(`/team/${short}/finding/issue`), { view: 'findings', finding, teamId: first, reportId: null, teamOnly: true })
  assert.deepEqual(resolved('/team/missing/finding/issue'), { view: 'findings', finding, teamId: null, reportId: null, teamOnly: true })
  // Its own links still name the team and report alone.
  assert.equal(managedRoutePath(managedRouteForIds({ view: 'findings', teamId: second, reportId: first, finding }, teams)), `/team/${second}/report/${short}/finding/issue`)
  assert.equal(managedRouteForIds({ view: 'findings', teamId: first, reportId: second, finding }, teams), null)
  assert.equal(managedRouteForIds({ view: 'findings', teamId: first, finding }, duplicateTeam), null)
  assert.equal(managedRouteForIds({ view: 'findings', teamId: first, reportId: first, finding }, duplicateReport), null)
})

test('slug history resolves UUIDs on clicks, Back/Forward and reload', async () => {
  const { browser } = browserAt(`/team/${short}/report/${short}`)
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
  assert.equal(browser.location.pathname, `/team/${second}/report/${second}/files`)
})
