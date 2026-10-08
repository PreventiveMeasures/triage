import './_polyfills.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import '../ui/managed/deduplication.js'
import { ManagedAppState } from '../ui/managed/state.js'
import { parseManagedRoute } from '../common/managed/routes.js'

const Page = customElements.get('managed-admin-deduplication')
test('Deduplication imports and toggles global reports, invalidating cached findings', async t => {
  const page = new Page()
  page.session = { id: 'admin', role: 'admin', csrfToken: 'csrf' }
  page.appState = new ManagedAppState()
  const calls = [], reports = []
  t.mock.method(globalThis, 'fetch', async (path, options) => {
    // A server without sealed uploads receives the file itself.
    if (path === '/api/admin/uploads/key') return Response.json({ error: 'not-found' }, { status: 404 })
    calls.push([path, options])
    if (options.method === 'POST') {
      assert.equal(await options.body.text(), '[["a","b"]]')
      reports.push({ id: 'link', filename: options.body.name, enabled: true, groupCount: 1, findingCount: 2 })
      return Response.json(reports[0], { status: 201 })
    }
    if (options.method === 'PATCH') {
      reports[0].enabled = JSON.parse(options.body).enabled
      return Response.json({ ok: true })
    }
    return Response.json({ reports })
  })
  page.appState.resources.set('reports:content:team:one', { data: 'stale' })
  await page._upload([new File(['[["a","b"]]'], 'test.link.json')])
  assert.equal(page._error, null)
  assert.equal(page._data.reports.length, 1)
  assert.equal(page.appState.read('reports:content:team:one'), undefined)
  assert.equal(calls[0][0], '/api/admin/deduplication')
  assert.equal(calls[0][1].headers['x-csrf-token'], 'csrf')
  await page._toggle(reports[0])
  assert.equal(page._data.reports[0].enabled, false)
  assert.equal(page._busy, false)
  assert.equal(calls.find(([, options]) => options.method === 'PATCH')[0], '/api/admin/deduplication/link')
  assert.deepEqual(parseManagedRoute(new URL('https://triage.test/manage/deduplication')), { view: 'manage-deduplication' })
})

test('Deduplication retains actionable upload errors after refreshing the list', async t => {
  const page = new Page()
  page.session = { role: 'admin', csrfToken: 'csrf' }
  page.appState = new ManagedAppState()
  t.mock.method(globalThis, 'fetch', (path, options) => Promise.resolve(path === '/api/admin/uploads/key'
    ? Response.json({ error: 'not-found' }, { status: 404 }) : options.method === 'POST'
      ? Response.json({ error: 'storage-encryption-required' }, { status: 503 }) : Response.json({ reports: [] })))
  await page._upload([new File(['[["a","b"]]'], 'test.link.json')])
  assert.match(page._error, /MANAGED_STORAGE_ENCRYPTION_KEY/u)
  assert.equal(page._busy, false)
  assert.deepEqual(page._queue, [])
})
