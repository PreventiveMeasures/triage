import './_polyfills.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reportEntries } from '@preventive/report'
import { loadTeamReports } from '../server-managed/team-reports.ts'

globalThis[Symbol.for('@rray/frontend')] ??= { html: () => null, nothing: null, LitElement: class {}, StateElement: class {} }
const { managedTeamAppMetadata, ManagedTeamAppCache } = await import('../ui/view/managed-team-app.js')
const app = id => ({ id, severity: 'high', confidence: 9, file: 'app.js', revalidate: 'revalidation', isApp: true })
const source = id => ({ id, severity: 'high', confidence: 9, file: 'app.js', isApp: false })
const report = (id, ...findings) => ({ id, filename: `${id}.json`, data: { findings } })

test('managed teams use workspace App coverage, conflicting verdicts and linked finding counts', () => {
  const reports = [report('source', source('S')), report('app', [app('A'), { ...source('S'), revalidate: 'confirmed' }], app('B'))]
  assert.deepEqual(managedTeamAppMetadata(reports), { appMode: true, appFindings: 2 })
  const links = { id: 'links', filename: 'links.json', data: { source: 'links', links: [['A', 'B']] } }
  assert.deepEqual(managedTeamAppMetadata([...reports, links]), { appMode: true, appFindings: 1 })
  const globalLinks = [...reports]
  Object.defineProperty(globalLinks, 'links', { value: [['A', 'B']] })
  assert.deepEqual(managedTeamAppMetadata(globalLinks), { appMode: true, appFindings: 1 }, 'global links count just like local link reports')
  assert.deepEqual(managedTeamAppMetadata([...reports, report('uncovered', source('U'))]), { appMode: false })
  assert.deepEqual(managedTeamAppMetadata([...reports, report('conflict', [app('A'), { ...source('S'), revalidate: 'partial' }])]), { appMode: false })
  assert.deepEqual(managedTeamAppMetadata([]), { appMode: false })
  assert.deepEqual(managedTeamAppMetadata([report('source', source('S'))]), { appMode: false })
})

test('loaded team classification ignores hidden reports and links and resets when published', () => {
  const workspace = [report('app', app('A'), app('B')), report('hidden', source('S')),
    { id: 'links', filename: 'links.json', data: { source: 'links', links: [['A', 'B']] } }]
  const team = { id: 'team', reports: [{ id: 'app' }, { id: 'hidden', visible: false }, { id: 'links', visible: false }] }
  const cache = new ManagedTeamAppCache()
  const session = { id: 'manager', role: 'manage' }
  cache.sync(session, [team])
  cache.record('team', cache.token('team'), workspace.slice(0, 1))
  assert.deepEqual(cache.get('team'), { appMode: true, appFindings: 2 })
  cache.sync(session, [{ ...team, reports: team.reports.map(r => ({ ...r, visible: true })) }])
  assert.equal(cache.get('team'), null)
  cache.record('team', cache.token('team'), workspace)
  assert.deepEqual(cache.get('team'), { appMode: false })
})

for (const knownHidden of [false, true]) {
  for (const cached of [false, true]) {
    test(`${knownHidden ? 'publishing a hidden' : 'adding a new'} report cannot use ${cached ? 'cached' : 'new'} App metadata before the catalog catches up`, () => {
      const cache = new ManagedTeamAppCache()
      const session = { id: 'manager', role: 'manage' }
      const team = { id: 'team', reports: [{ id: 'app' }, ...(knownHidden ? [{ id: 'source', visible: false }] : [])] }
      cache.sync(session, [team])
      const token = cache.token('team')
      if (cached) {
        cache.record('team', token, [report('app', app('A'))])
        assert.deepEqual(cache.get('team'), { appMode: true, appFindings: 1 })
      }
      const workspace = [report('app', app('A')), report('source', source('S'))]
      cache.record('team', token, workspace)
      assert.equal(cache.get('team'), null, 'an unexpected report must leave the team unclassified')
      cache.sync(session, [team])
      assert.equal(cache.get('team'), null, 'repainting with the stale catalog must not restore App mode')
      cache.sync(session, [{ ...team, reports: [{ id: 'app' }, { id: 'source' }] }])
      cache.record('team', cache.token('team'), workspace.toReversed())
      assert.deepEqual(cache.get('team'), { appMode: false }, 'the refreshed catalog classifies every published report regardless of response order')
    })
  }
}

test('incomplete, failed and isolated hidden reads leave teams expanded until a complete workspace is opened', () => {
  const cache = new ManagedTeamAppCache()
  const session = { id: 'manager', role: 'manage' }
  const team = { id: 'team', reports: [{ id: 'app' }, { id: 'source' }, { id: 'hidden', visible: false }] }
  cache.sync(session, [team])
  const token = cache.token('team')
  for (const incomplete of [null, [], [report('app', app('A'))], [report('hidden', app('H'))], [report('app', app('A')), report('hidden', app('H'))]]) {
    cache.record('team', token, incomplete)
    assert.equal(cache.get('team'), null)
  }
  cache.record('team', token, [report('app', app('A')), report('source', source('S'))])
  assert.deepEqual(cache.get('team'), { appMode: false })
})

test('catalog renders leave unopened teams unclassified and reuse only opened team metadata', () => {
  const cache = new ManagedTeamAppCache()
  const session = { id: 'viewer', role: 'view' }
  const teams = Array.from({ length: 500 }, (_, i) => ({ id: `team-${i}`, reports: [{ id: `report-${i}` }] }))
  cache.sync(session, teams)
  for (const team of teams) assert.equal(cache.get(team.id), null)
  const opened = [report('report-0', app('A'))]
  cache.record('team-0', cache.token('team-0'), opened)
  // Dropping the loaded report bodies cannot change the retained summary.
  opened[0].data.findings.push(app('B'))
  opened.length = 0
  for (let i = 0; i < 4; i++) cache.sync(session, teams.map(team => ({ ...team, name: `Rename ${i}` })).toReversed())
  assert.deepEqual(cache.get('team-0'), { appMode: true, appFindings: 1 })
  for (const team of teams.slice(1)) assert.equal(cache.get(team.id), null)
})

for (const change of ['report', 'team', 'visibility', 'account', 'role', 'session', 'removed']) {
  test(`${change} changes discard cached App metadata and reject stale navigation`, () => {
    const cache = new ManagedTeamAppCache()
    const session = { id: 'viewer', role: 'view', csrfToken: 'first' }
    const team = { id: 'team', cacheKey: 'v1', reports: [{ id: 'app', cacheKey: 'v1' }] }
    cache.sync(session, [team])
    const stale = cache.token('team')
    cache.record('team', stale, [report('app', app('A'))])
    assert.deepEqual(cache.get('team'), { appMode: true, appFindings: 1 })
    if (change === 'report') team.reports[0].cacheKey = 'v2'
    if (change === 'team') team.cacheKey = 'v2'
    if (change === 'visibility') team.reports[0].visible = false
    if (change === 'account') session.id = 'other'
    if (change === 'role') session.role = 'manage'
    if (change === 'session') session.csrfToken = 'second'
    cache.sync(session, change === 'removed' ? [] : [team])
    cache.record('team', stale, [report('app', app('A'))])
    assert.equal(cache.get('team'), null)
  })
}

for (const format of ['JSON', 'Markdown']) {
  test(`server backfills IDs before App coverage and counts are computed for ID-less ${format} reports`, async () => {
    const bodies = [
      JSON.stringify({ findings: [app('confirmed-app')] }),
      format === 'JSON' ? JSON.stringify({ findings: [{ ...app(undefined), description: 'App A' }, { ...app(undefined), description: 'App B' }] })
        : '# App A\n\n---\n**Severity:** high\n\n# App B\n\n---\n**Severity:** high\n',
      JSON.stringify({ findings: [{ ...source(undefined), description: 'Uncovered finding' }] }),
    ]
    const reports = bodies.map((body, i) => ({
      id: String(i), filename: i === 1 && format === 'Markdown' ? 'app.md' : `${i}.json`,
      byteSize: Buffer.byteLength(body), sha256: 'immutable', repo: { github: null, directory: '' },
      permissions: { security: true, dependencies: true },
    }))
    const loaded = await loadTeamReports({}, { get: id => Promise.resolve(Buffer.from(bodies[Number(id)])) }, {
      user: { id: 'user', role: 'view' }, teamId: 'team', repositories: [], reports,
    })
    const findings = loaded.flatMap(r => reportEntries(r.data).flat())
    assert.equal(findings.length, 4)
    assert.ok(findings.every(f => typeof f.id === 'string' && f.id.length > 0))
    assert.equal(new Set(findings.map(f => f.id)).size, 4, 'unrelated ID-less findings must remain distinct')
    assert.deepEqual(managedTeamAppMetadata(loaded.slice(0, 2)), { appMode: true, appFindings: 3 })
    assert.deepEqual(managedTeamAppMetadata(loaded), { appMode: false }, 'App findings must not cover unrelated source rows')
  })
}
