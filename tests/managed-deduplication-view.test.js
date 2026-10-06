import './_polyfills.js'
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { fetchManagedLinkWorkspace } from '../ui/managed/deduplication-data.js'
import { clearManagedWorkspace, setManagedWorkspace } from '../client/managed/workspace.js'
import { reportRowsForFindingIds } from '../client/bundle-finding-index.js'
import { state } from '../client/state.ts'
import { closeLinksPreview, getLinksPreview, openLinksPreview } from '../ui/view/links-preview.js'

afterEach(() => {
  closeLinksPreview(); clearManagedWorkspace()
  state.serverMode = null; state.currentManagedTeam = null; state.managedSession = null; state.currentLinks = null
})

function mockReports(t, { fail = false, revoke = false } = {}) {
  let detailReads = 0
  t.mock.method(globalThis, 'fetch', path => {
    if (path === '/api/admin/deduplication/link') {
      detailReads++
      return Promise.resolve(revoke && detailReads > 1 ? Response.json({}, { status: 403 })
        : Response.json({ id: 'link', filename: 'disabled.link.json', enabled: false, groups: [['a', 'b'], ['b', 'missing']] }))
    }
    if (path === '/api/admin/reports') { return Promise.resolve(Response.json({ reports: [
      { id: 'one', filename: 'same.json', visible: false }, { id: 'two', filename: 'same.json', visible: true },
    ] })) }
    if (fail && path === '/api/reports/two') return Promise.resolve(Response.json({}, { status: 503 }))
    const data = path === '/api/reports/one'
      ? { source: 'deepview', groups: [[{ id: 'a', title: 'First copy' }, { id: 'context', title: 'Context' }], [{ id: 'unrelated' }]] }
      : { findings: [{ id: 'b', title: 'Second copy' }, { id: 'unrelated' }] }
    return Promise.resolve(Response.json({ data, repo: { github: 'org/app', directory: 'src' } }))
  })
}

test('management links retain original groups and matching full rows across unpublished reports', async t => {
  mockReports(t)
  const reports = await fetchManagedLinkWorkspace('link')
  assert.deepEqual(reports.map(r => r.id), ['one', 'two', 'link'])
  assert.deepEqual(reports[0].data.groups.map(row => row.map(f => f.id)), [['a', 'context']])
  assert.deepEqual(reports[1].data.findings.map(f => f.id), ['b'])
  assert.deepEqual(reports[2].data.links, [['a', 'b'], ['b', 'missing']])
  state.serverMode = 'managed'; state.localMode = false; state.managedSession = { id: 'admin', role: 'admin' }
  state.currentManagedTeam = null
  setManagedWorkspace(null, reports)
  state.currentView = 'links'
  state.currentLinks = { managedId: 'link', name: reports[2].filename, groups: reports[2].data.links, skipped: 0 }
  assert.equal(reportRowsForFindingIds(['a'])[0].members[0].title, 'First copy')
  await openLinksPreview('a', 'same.json', 0, 'one')
  assert.deepEqual(getLinksPreview().group.map(f => f.id), ['a', 'context'])
  await openLinksPreview('b', 'same.json', 0, 'two')
  assert.equal(getLinksPreview().group[0].title, 'Second copy')
  assert.equal(getLinksPreview().group[0]._managedReportId, 'two')
})

test('management link viewing rejects partial reads and an admin grant revoked during loading', async t => {
  mockReports(t, { fail: true })
  await assert.rejects(fetchManagedLinkWorkspace('link'), /Could not load same.json/u)
  mockReports(t, { revoke: true })
  await assert.rejects(fetchManagedLinkWorkspace('link'), /403/u)
})
