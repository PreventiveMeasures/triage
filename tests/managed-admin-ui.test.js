import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import './_polyfills.js'
import '../ui/client-managed.js'

// Lit's Node implementation lets us exercise the actual async controllers
// without a document. Browser checks cover the rendered controls separately.
const Repositories = customElements.get('managed-admin-repos')
const Reports = customElements.get('managed-admin-reports')
const repo = { id: 7, fullName: 'owner/repo' }
const impact = { repoId: 7, reports: [{ id: 'r', filename: 'report.json' }], bundles: [], triageCount: 0 }

test('repository removal requires valid impact and confirmation, including after a failed load', async (t) => {
  const page = new Repositories()
  let response = new Response('unavailable', { status: 503 })
  const fetch = t.mock.method(globalThis, 'fetch', () => Promise.resolve(response))
  page._openDetail(repo)
  await setImmediate()
  assert.equal(page._impactLoading, false)
  assert.equal(page._impact, null)
  assert.match(page._actionError, /Couldn't load repository data/u)
  page._acknowledge = true
  page._confirmName = repo.fullName
  assert.equal(page._canRemove(repo), false)
  await page._remove(repo)
  assert.equal(fetch.mock.callCount(), 1, 'the removal handler also refuses incomplete impact data')

  response = Response.json({ ok: true })
  page._openDetail(repo)
  await setImmediate()
  assert.equal(page._impact, null, 'malformed success responses do not imply an empty repository')

  response = Response.json(impact)
  page._openDetail(repo)
  assert.equal(page._canRemove(repo), false, 'retry stays disabled while pending')
  await setImmediate()
  assert.equal(page._actionError, null)
  assert.equal(page._canRemove(repo), false, 'successful retry still requires confirmation')
  page._acknowledge = true
  assert.equal(page._canRemove(repo), false, 'attached data requires the typed name')
  page._confirmName = repo.fullName
  assert.equal(page._canRemove(repo), true)
  assert.equal(page._canRemove({ ...repo, id: 8 }), false, 'impact belongs to a specific repository')
})

test('late report preview success and failure cannot overwrite a newer request, even for the same report', async (t) => {
  const page = new Reports()
  const pending = []
  // Ignore abort deliberately: request identity must also guard body reads
  // and transports that finish after cancellation.
  t.mock.method(globalThis, 'fetch', (_url, { signal }) => new Promise((resolve, reject) => { pending.push({ resolve, reject, signal }) }))
  const a = page._togglePreview({ id: 'a' })
  const b = page._togglePreview({ id: 'b' })
  assert.equal(pending[0].signal.aborted, true)
  pending[1].resolve(new Response('Report B'))
  await b
  pending[0].resolve(new Response('Report A'))
  await a
  assert.equal(page._preview, 'b')
  assert.equal(page._previewText, 'Report B')

  const oldA = page._togglePreview({ id: 'a' })
  await page._togglePreview({ id: 'a' }) // Close A while it is pending.
  const newA = page._togglePreview({ id: 'a' })
  pending[2].reject(new Error('Late failure from old A'))
  await oldA
  assert.equal(page._previewLoading, 'a', 'an old failure cannot finish the new loading state')
  pending[3].resolve(new Response('New report A'))
  await newA
  assert.equal(page._previewText, 'New report A')

  const detached = page._togglePreview({ id: 'b' })
  page.disconnectedCallback()
  pending[4].resolve(new Response('Detached response'))
  await detached
  assert.equal(page._preview, null)
  assert.equal(page._previewText, '')
})

const adminSession = { id: 'me', login: 'admin', role: 'admin', csrfToken: 'current-token' }

for (const [tag, field, path, payload] of [
  ['users', '_users', '/api/admin/users', { users: [{ id: 'me', login: 'admin' }] }],
  ['reports', '_data', '/api/admin/reports', { reports: [{ id: 'r' }], repos: [] }],
  ['bundles', '_data', '/api/admin/bundles', { bundles: [{ id: 'b' }], repos: [] }],
  ['teams', '_data', '/api/admin/teams', { teams: [{ id: 't' }] }],
  ['repos', '_data', '/api/admin/repositories', { repositories: [repo], total: 1 }],
  ['history', '_history', '/api/admin/history', { history: [{ id: 'h', kind: 'triage', reportId: 'r' }] }],
]) {
  test(`${tag} retains loaded content on refresh and failure without probing the session`, async (t) => {
    const Page = customElements.get(`managed-admin-${tag}`)
    const page = new Page()
    page.session = adminSession
    let complete
    const network = t.mock.method(globalThis, 'fetch', (url) => {
      assert.notEqual(url, '/api/auth/session')
      if (url.startsWith(path)) return new Promise(resolve => { complete = resolve })
      return Promise.resolve(Response.json({ teams: [] }))
    })
    const first = page._load()
    assert.equal(page._loading, true)
    assert.equal(page[field], null)
    complete(Response.json(payload))
    await first
    const loaded = page[field]
    assert.ok(loaded)
    const refresh = page._load()
    assert.equal(page._loading, true)
    assert.equal(page[field], loaded, 'loaded content remains mounted during revalidation')
    complete(new Response('Unavailable', { status: 503 }))
    await refresh
    assert.equal(page[field], loaded, 'a failed refresh keeps the last successful result')
    assert.match(page._error, /503/u)
    assert.equal(page._loading, false)
    assert.ok(network.mock.callCount() >= 2)
  })
}

test('collection refreshes ignore late responses and stop applying data after disconnect', async (t) => {
  const page = new Reports()
  page.session = adminSession
  const pending = []
  t.mock.method(globalThis, 'fetch', (_url, { signal }) => new Promise((resolve, reject) => { pending.push({ signal, resolve, reject }) }))
  const old = page._load()
  const current = page._load()
  assert.equal(pending[0].signal.aborted, true)
  pending[1].resolve(Response.json({ reports: [{ id: 'current' }] }))
  await current
  pending[0].resolve(Response.json({ reports: [{ id: 'old' }] }))
  await old
  assert.equal(page._data.reports[0].id, 'current')
  const failed = page._load()
  const detached = page._load()
  pending[2].reject(new Error('late failure'))
  await failed
  assert.equal(page._error, null)
  assert.equal(page._loading, true, 'old finally must not finish the pending refresh')
  page.disconnectedCallback()
  assert.equal(pending[3].signal.aborted, true)
  pending[3].resolve(Response.json({ reports: [{ id: 'detached' }] }))
  await detached
  assert.equal(page._data.reports[0].id, 'current')
})

test('refreshing reports preserves the open preview until that report is removed', async (t) => {
  const page = new Reports()
  page._preview = 'r'
  page._previewText = 'Existing preview'
  let payload = { reports: [{ id: 'r' }] }
  t.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json(payload)))
  await page._load()
  assert.equal(page._preview, 'r')
  assert.equal(page._previewText, 'Existing preview')
  payload = { reports: [] }
  await page._load()
  assert.equal(page._preview, null)
})

test('a failed bundle mutation retains the collection and its error after refresh', async (t) => {
  const Bundles = customElements.get('managed-admin-bundles')
  const page = new Bundles()
  page.session = adminSession
  const bundle = { id: 'b', repoId: null }
  page._data = { bundles: [bundle], repos: [] }
  let token = 'current-token'
  let status = 403
  t.mock.method(globalThis, 'fetch', (_url, options) => {
    if (options.method === 'POST') {
      assert.equal(options.headers['x-csrf-token'], token)
      return Promise.resolve(new Response('', { status }))
    }
    return Promise.resolve(Response.json({ bundles: [bundle], repos: [] }))
  })
  await page._setRepo(bundle, 7)
  assert.match(page._error, /Couldn't change repo: HTTP 403/u)
  assert.deepEqual(page._data.bundles, [bundle])
  status = 200
  token = 'rotated-token'
  page.session = { ...adminSession, csrfToken: token }
  await page._setRepo(bundle, 7)
  assert.equal(page._error, null, 'a successful retry clears the previous action error')
})
