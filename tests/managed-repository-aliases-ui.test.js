import './_polyfills.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import '../ui/managed/repository-aliases.js'
import { ManagedAppState } from '../ui/managed/state.js'

const Component = customElements.get('managed-repository-aliases')
function component() {
  const page = new Component()
  page.session = { id: 'admin', role: 'admin', csrfToken: 'csrf' }
  page.appState = new ManagedAppState()
  return page
}
test('repository aliases can be added, edited and deleted while retaining failed edits', async t => {
  const page = component(), rows = []
  const calls = []
  let reject = false
  t.mock.method(globalThis, 'fetch', (path, options) => {
    calls.push([path, options])
    if (options.method) {
      assert.equal(options.headers['x-csrf-token'], 'csrf')
      if (reject) return Response.json({ error: 'alias-exists' }, { status: 409 })
      if (options.method === 'POST') rows.push({ ...JSON.parse(options.body), id: 'alias' })
      if (options.method === 'PATCH') Object.assign(rows[0], JSON.parse(options.body))
      if (options.method === 'DELETE') rows.splice(0)
      return Response.json({ ok: true })
    }
    return Response.json({ aliases: rows, repos: [{ repoId: 2, fullName: 'org/mono', active: true }] })
  })
  await page._load()
  page._start()
  page._edit = { ...page._edit, oldRepo: 'org/old', oldPath: 'a', repoId: 2, newPath: 'projects/a' }
  await page._save()
  assert.equal(page._edit, null)
  assert.equal(page._data.aliases.length, 1)
  page._start(page._data.aliases[0])
  page._edit.newPath = 'projects/new'
  reject = true
  await page._save()
  assert.equal(page._edit.newPath, 'projects/new')
  assert.match(page._error, /already exists/u)
  reject = false
  await page._save()
  assert.equal(page._data.aliases[0].newPath, 'projects/new')
  await page._mutate('DELETE', 'alias')
  assert.deepEqual(page._data.aliases, [])
  assert.deepEqual(calls.filter(([, opts]) => opts.method).map(([path, opts]) => [path, opts.method]), [
    ['/api/admin/repositories/aliases', 'POST'], ['/api/admin/repositories/aliases/alias', 'PATCH'],
    ['/api/admin/repositories/aliases/alias', 'PATCH'], ['/api/admin/repositories/aliases/alias', 'DELETE'],
  ])
})
