import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import './_polyfills.js'
import '../ui/client-managed.js'
import { ManagedAppState } from '../ui/managed/state.js'

class TestDialog { static styles = []; _finish() { this._settled = true } }
mock.module('../ui/view/dialogs/app-dialog.js', { namedExports: { AppDialog: TestDialog, openAppDialog: () => {} } })
await import('../ui/view/dialogs/managed-share-dialog.js')
const Dialog = customElements.get('managed-share-dialog')
const Links = customElements.get('managed-admin-links')
const session = { id: 'manager', login: 'manager', role: 'manage', csrfToken: 'csrf' }

test('share dialog creates with both permissions off, lists creators, and edits the same public URL', async t => {
  let links = []
  const writes = []
  t.mock.method(globalThis, 'fetch', (path, options) => {
    if (!options.method) return Response.json({ shares: structuredClone(links) })
    assert.equal(options.headers['x-csrf-token'], 'csrf')
    writes.push([path, options.method, options.body && JSON.parse(options.body)])
    if (options.method === 'POST') {
      links.push({ id: 'link-id', createdBy: 'manager', createdAt: 100, permissions: JSON.parse(options.body) })
      return Response.json({ id: 'link-id', path: `/teams/team#public=link-id.${'A'.repeat(43)}` })
    }
    if (options.method === 'PATCH') links[0].permissions = JSON.parse(options.body)
    if (options.method === 'DELETE') links = []
    return Response.json({ ok: true })
  })
  const originalLocation = globalThis.location
  globalThis.location = new URL('https://triage.test/')
  t.after(() => { globalThis.location = originalLocation })
  const dialog = Object.assign(new Dialog(), { team: { id: 'team', name: 'Team' }, session })
  await dialog.load()
  assert.equal(dialog.security, false)
  assert.equal(dialog.dependencies, false)
  await dialog.change()
  assert.deepEqual(writes[0], ['/api/teams/team/share', 'POST', { dependencies: false, security: false }])
  assert.equal(dialog.links[0].createdBy, 'manager')
  assert.equal(dialog.selectedId, 'link-id')
  const url = dialog.urls.get('link-id')
  dialog.security = true
  await dialog.change()
  assert.deepEqual(writes[1], ['/api/teams/team/share/link-id', 'PATCH', { dependencies: false, security: true }])
  assert.equal(dialog.urls.get('link-id'), url)
  dialog.select('')
  assert.equal(dialog.security, false, 'new links do not inherit the previously selected grants')
  dialog.select('link-id')
  assert.equal(dialog.security, true)
  await dialog.change(true)
  assert.equal(writes[2][1], 'DELETE')
  assert.equal(dialog.selectedId, '')
  assert.equal(dialog.links.length, 0)
})

test('Manage Links groups by team ID and retains each link creator', async t => {
  const page = new Links()
  page.session = session
  page.appState = new ManagedAppState()
  const shares = [
    { id: 'a', teamId: 'team-a', teamName: 'Team', createdBy: 'alice' },
    { id: 'b', teamId: 'team-b', teamName: 'Team', createdBy: 'bob' },
    { id: 'c', teamId: 'team-a', teamName: 'Team', createdBy: 'charlie' },
  ]
  t.mock.method(globalThis, 'fetch', (path) => {
    assert.equal(path, '/api/admin/links')
    return Promise.resolve(Response.json({ shares }))
  })
  await page._load()
  assert.deepEqual(page._groups().map(group => group.links.map(link => link.createdBy)), [['alice', 'charlie'], ['bob']])
})
