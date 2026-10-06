import './_polyfills.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'

globalThis[Symbol.for('@rray/frontend')] ??= { html: () => null, nothing: null, LitElement: class {}, StateElement: class {} }
const { managedTeamAppMetadata, ManagedTeamAppCache } = await import('../ui/view/managed-team-app.js')
const app = id => ({ id, severity: 'high', confidence: 9, file: 'app.js', revalidate: 'revalidation', isApp: true })
const source = id => ({ id, severity: 'high', confidence: 9, file: 'app.js', isApp: false })
const report = (id, ...findings) => ({ id, filename: `${id}.json`, data: { findings } })
const tick = () => new Promise(resolve => { setImmediate(resolve) })

test('managed teams use workspace App coverage, conflicting verdicts and linked finding counts', () => {
  const reports = [report('source', source('S')), report('app', [app('A'), { ...source('S'), revalidate: 'confirmed' }], app('B'))]
  assert.deepEqual(managedTeamAppMetadata(reports), { appMode: true, appFindings: 2 })
  const links = { id: 'links', filename: 'links.json', data: { source: 'links', links: [['A', 'B']] } }
  assert.deepEqual(managedTeamAppMetadata([...reports, links]), { appMode: true, appFindings: 1 })
  assert.deepEqual(managedTeamAppMetadata([...reports, report('uncovered', source('U'))]), { appMode: false })
  assert.deepEqual(managedTeamAppMetadata([...reports, report('conflict', [app('A'), { ...source('S'), revalidate: 'partial' }])]), { appMode: false })
  assert.deepEqual(managedTeamAppMetadata([]), { appMode: false })
  assert.deepEqual(managedTeamAppMetadata([report('source', source('S'))]), { appMode: false })
})

test('background team promotion ignores hidden reports and links and refreshes when published', async () => {
  const workspace = [report('app', app('A'), app('B')), report('hidden', source('S')),
    { id: 'links', filename: 'links.json', data: { source: 'links', links: [['A', 'B']] } }]
  const team = { id: 'team', reports: [{ id: 'app' }, { id: 'hidden', visible: false }, { id: 'links', visible: false }] }
  let updates = 0
  const cache = new ManagedTeamAppCache(() => Promise.resolve(workspace), () => { updates++ })
  const session = { id: 'manager', role: 'manage' }
  cache.sync(session, [team])
  await tick()
  assert.deepEqual(cache.get('team'), { appMode: true, appFindings: 2 })
  cache.sync(session, [{ ...team, reports: team.reports.map(r => ({ ...r, visible: true })) }])
  assert.equal(cache.get('team'), null)
  await tick()
  assert.deepEqual(cache.get('team'), { appMode: false })
  assert.equal(updates, 2)
})

test('incomplete and failed reads stay expanded; stale catalogs and sessions cannot promote teams', async () => {
  const pending = []
  const cache = new ManagedTeamAppCache(() => { const p = Promise.withResolvers(); pending.push(p); return p.promise }, () => {})
  const session = { id: 'first', role: 'view' }, team = { id: 'team', reports: [{ id: 'app', cacheKey: 'v1' }] }
  cache.sync(session, [team])
  cache.sync(session, [{ ...team, cacheKey: 'v2' }])
  pending[0].resolve([report('app', app('A'))])
  await tick()
  assert.equal(cache.get('team'), null)
  pending[1].resolve([])
  await tick()
  assert.equal(cache.get('team'), null)
  cache.sync({ id: 'second', role: 'view' }, [team])
  cache.sync(null, [])
  pending[2].resolve([report('app', app('A'))])
  await tick()
  assert.equal(cache.get('team'), null)
  cache.sync(session, [team])
  pending[3].reject(new Error('unavailable'))
  await tick()
  assert.equal(cache.get('team'), null)
})

test('background report loads are bounded and reuse unchanged metadata', async () => {
  const pending = []
  const cache = new ManagedTeamAppCache(id => { const p = Promise.withResolvers(); pending.push({ id, ...p }); return p.promise }, () => {})
  const teams = ['a', 'b', 'c'].map(id => ({ id, reports: [{ id }] }))
  cache.sync({ id: 'viewer', role: 'view' }, teams)
  assert.equal(pending.length, 2)
  pending[0].resolve([report('a', app('A'))]); await tick()
  assert.equal(pending.length, 3)
  pending[1].resolve([report('b', app('B'))]); pending[2].resolve([report('c', app('C'))]); await tick()
  cache.sync({ id: 'viewer', role: 'view' }, teams)
  assert.equal(pending.length, 3)
  assert.deepEqual(cache.get('c'), { appMode: true, appFindings: 1 })
})
