import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import './_polyfills.js'
import '../ui/client-managed.js'
import { ManagedPage } from '../ui/managed/page.js'
import { ManagedAppState } from '../ui/managed/state.js'

function createPage(Page, appState = new ManagedAppState()) {
  const page = new Page()
  page.appState = appState
  return page
}

// Lit's Node implementation lets us exercise the actual async controllers
// without a document. Browser checks cover the rendered controls separately.
const Repositories = customElements.get('managed-admin-repos')
const Reports = customElements.get('managed-admin-reports')
const repo = { id: 7, fullName: 'owner/repo' }
const impact = { repoId: 7, reports: [{ id: 'r', filename: 'report.json' }], bundles: [], triageCount: 0 }

test('repository removal requires valid impact and confirmation, including after a failed load', async (t) => {
  const page = createPage(Repositories)
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
  const page = createPage(Reports)
  const pending = []
  // Ignore abort deliberately: request identity must also guard body reads
  // and transports that finish after cancellation.
  t.mock.method(globalThis, 'fetch', (_url, { signal }) => new Promise((resolve, reject) => { pending.push({ resolve, reject, signal }) }))
  const a = page._togglePreview({ id: 'a' })
  const b = page._togglePreview({ id: 'b' })
  assert.equal(pending[0].signal.aborted, false, 'navigation keeps shared reads alive')
  pending[1].resolve(new Response('Report B'))
  await b
  pending[0].resolve(new Response('Report A'))
  await a
  assert.equal(page._preview, 'b')
  assert.equal(page._previewText, 'Report B')

  const oldA = page._togglePreview({ id: 'a' })
  await page._togglePreview({ id: 'a' }) // Close A while it is pending.
  page.appState.invalidate(['report-preview:a'])
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
  ['history', '_history', '/api/admin/history', { history: [{ id: 'h', kind: 'triage', reportId: 'r' }], total: 1, page: 1, limit: 100 }],
]) {
  test(`${tag} retains loaded content on refresh and failure without probing the session`, async (t) => {
    const Page = customElements.get(`managed-admin-${tag}`)
    const notices = []
    const appState = new ManagedAppState(message => notices.push(message))
    const page = createPage(Page, appState)
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
    ManagedPage.prototype.disconnectedCallback.call(page)
    const next = createPage(Page, appState)
    next.session = adminSession
    const refresh = next._load()
    assert.equal(next._loading, true)
    assert.equal(next[field], loaded, 'loaded content remains mounted during revalidation')
    complete(new Response('Unavailable', { status: 503 }))
    await refresh
    assert.equal(next[field], loaded, 'a failed refresh keeps the last successful result')
    assert.equal(next._error, null, 'background failures do not insert an error banner')
    assert.match(notices[0], /503/u)
    assert.equal(notices.length, 1)
    assert.equal(next._loading, false)
    assert.ok(network.mock.callCount() >= 2)
  })
}

test('navigation reuses an in-flight collection request without updating detached pages', async (t) => {
  const appState = new ManagedAppState()
  const firstPage = createPage(Reports, appState)
  let resolve
  let signal
  const fetch = t.mock.method(globalThis, 'fetch', (_url, options) => {
    signal = options.signal
    return new Promise(done => { resolve = done })
  })
  const first = firstPage._load()
  firstPage.disconnectedCallback()
  assert.equal(signal.aborted, false)
  const secondPage = createPage(Reports, appState)
  const second = secondPage._load()
  assert.equal(fetch.mock.callCount(), 1)
  resolve(Response.json({ reports: [{ id: 'current' }] }))
  await Promise.all([first, second])
  assert.equal(firstPage._data, null)
  assert.equal(secondPage._data.reports[0].id, 'current')
})

test('history requests server pages and filters, and an old response cannot replace a newer result', async (t) => {
  const History = customElements.get('managed-admin-history')
  const page = createPage(History)
  page.session = adminSession
  const pending = []
  t.mock.method(globalThis, 'fetch', (url, { signal }) => new Promise(resolve => { pending.push({ url: new URL(url, 'http://localhost'), signal, resolve }) }))
  page._filter = 'access'
  page._query = 'alice & team'
  const older = page._load(2)
  assert.equal(pending[0].url.pathname, '/api/admin/history')
  assert.deepEqual(Object.fromEntries(pending[0].url.searchParams), { page: '2', limit: '100', kind: 'access', q: 'alice & team' })
  page._filter = 'triage'
  const newer = page._load()
  assert.equal(pending[0].signal.aborted, false, 'shared reads can complete for future navigation')
  pending[1].resolve(Response.json({ history: [{ id: 'new' }], total: 205, page: 1, limit: 100 }))
  await newer
  pending[0].resolve(Response.json({ history: [{ id: 'stale' }], total: 1, page: 2, limit: 100 }))
  await older
  assert.equal(page._history[0].id, 'new')
  assert.equal(page._total, 205)
  assert.equal(page._page, 1)
  const next = page._load(3)
  assert.equal(page._page, 1, 'keep the displayed page until the new request succeeds')
  pending[2].resolve(Response.json({ history: [{ id: 'last' }], total: 205, page: 3, limit: 100 }))
  await next
  assert.equal(page._page, 3)
  page._query = 'uncached query'
  const malformed = page._load()
  pending[3].resolve(Response.json({ history: [] }))
  await malformed
  assert.equal(page._history[0].id, 'last')
  assert.match(page._error, /No history/u)
})

test('history search debounces, cancels stale work immediately, and actor navigation reloads the first page', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  globalThis.document = { removeEventListener() {} }
  t.after(() => { delete globalThis.document })
  const History = customElements.get('managed-admin-history')
  const page = createPage(History)
  const pending = []
  t.mock.method(globalThis, 'fetch', (url, { signal }) => new Promise(resolve => { pending.push({ url, signal, resolve }) }))
  const initial = page._load(2)
  const consumer = page._loadRequest
  page._search('a')
  assert.equal(consumer.signal.aborted, true)
  assert.equal(pending[0].signal.aborted, false, 'shared reads survive consumer cancellation')
  pending[0].resolve(Response.json({ history: [], total: 0, page: 1 }))
  await initial
  assert.equal(page._loading, true, 'debounced search remains busy after the aborted request settles')
  page._search('alice')
  t.mock.timers.tick(249)
  assert.equal(pending.length, 1)
  t.mock.timers.tick(1)
  assert.equal(pending.length, 2)
  assert.match(pending[1].url, /q=alice/u)
  page._filter = 'access'
  page._repo = 'owner/one'
  page._actor = 'user:previous'
  page._onActorFilter({ detail: { actor: 'user:bob' } })
  assert.equal(pending[1].signal.aborted, false)
  assert.deepEqual(Object.fromEntries(new URL(pending[2].url, 'http://test').searchParams), { page: '1', limit: '100', kind: 'all', q: '', actor: 'user:bob' })
  page._search('cancelled')
  page.disconnectedCallback()
  t.mock.timers.tick(1000)
  assert.equal(pending.length, 3, 'leaving the page cancels its scheduled request')
})

test('refreshing reports preserves the open preview until that report is removed', async (t) => {
  const page = createPage(Reports)
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
  const page = createPage(Bundles)
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

test('cached repository details remain visible but cannot authorize removal after a failed refresh', async (t) => {
  const notices = []
  const appState = new ManagedAppState(message => notices.push(message))
  await appState.load('repo-impact:7', 'repository data', () => impact)
  const page = createPage(Repositories, appState)
  let complete
  t.mock.method(globalThis, 'fetch', () => new Promise(resolve => { complete = resolve }))
  page._openDetail(repo)
  assert.equal(page._impact, impact)
  page._acknowledge = true
  page._confirmName = repo.fullName
  assert.equal(page._canRemove(repo), false)
  complete(new Response('', { status: 503 }))
  await setImmediate()
  assert.equal(page._impact, impact)
  assert.equal(page._impactLoading, false)
  assert.equal(page._actionError, null)
  assert.equal(page._canRemove(repo), false)
  assert.match(notices[0], /repository data: HTTP 503/u)
})

test('managed scan model controls reuse the cached catalogue and share a failing background refresh', async (t) => {
  const appState = new ManagedAppState()
  const catalogue = { models: [{ id: 'test-model', efforts: ['high'] }], defaultModel: 'test-model' }
  await appState.load('models', 'models', () => catalogue)
  const scan = createPage(customElements.get('managed-admin-scans'), appState)
  let complete
  const fetch = t.mock.method(globalThis, 'fetch', () => new Promise(resolve => { complete = resolve }))
  const Picker = customElements.get('scan-model-picker')
  const Regimes = customElements.get('scan-regime-editor')
  const picker = new Picker()
  const regimes = new Regimes()
  picker.loadModels = regimes.loadModels = scan._loadModels
  const loads = [picker._load(), regimes._load()]
  assert.deepEqual(picker._models, catalogue.models)
  assert.equal(picker.value, 'test-model')
  assert.equal(regimes._loading, false)
  assert.equal(regimes._rows[0].model, 'test-model')
  assert.equal(fetch.mock.callCount(), 1)
  complete(new Response('', { status: 503 }))
  await Promise.all(loads)
  assert.equal(picker._error, null)
  assert.equal(regimes._error, null)
  assert.equal(regimes._rows[0].model, 'test-model')
})

test('managed scan report inputs remain usable while cached sources refresh or fail', async (t) => {
  const appState = new ManagedAppState()
  const sources = { merge: { bundles: [{ id: 'b', filename: 'src.zip' }], results: [{ id: 'r', bundleId: 'b' }] }, link: { repositories: [], reports: [] } }
  await appState.load('scan-sources', 'report inputs', () => sources)
  const scan = createPage(customElements.get('managed-admin-scans'), appState)
  const Inputs = customElements.get('scan-report-inputs')
  const inputs = new Inputs()
  inputs.mode = 'merge'
  inputs.loadSources = scan._loadReportSources
  let complete
  t.mock.method(globalThis, 'fetch', url => url === '/api/admin/reports'
    ? new Promise(resolve => { complete = resolve }) : Promise.resolve(Response.json({})))
  const loading = inputs._load()
  assert.equal(inputs._loading, false)
  inputs._selectSource('b')
  assert.deepEqual(inputs.selection.inputs.map(input => input.id), ['r'])
  complete(new Response('', { status: 503 }))
  await loading
  assert.equal(inputs._error, null)
  assert.deepEqual(inputs.selection.inputs.map(input => input.id), ['r'])
})


test('history user and repository filters intersect, reset paging, and keep independent cached results', async t => {
  const page = createPage(customElements.get('managed-admin-history'))
  const requests = []
  const filters = {
    repos: ['owner/one', 'owner/two'],
    users: [{ id: 'user:one', login: 'alice', detail: null }, { id: 'user:two', login: 'bob', detail: null }],
  }
  t.mock.method(globalThis, 'fetch', url => new Promise(resolve => { requests.push({ params: new URL(url, 'http://test').searchParams, resolve }) }))
  const finish = (index, id) => requests[index].resolve(Response.json({ history: [{ id }], total: 201, page: Number(requests[index].params.get('page')), filters }))
  page._query = 'alice & bob'
  page._filter = 'triage'
  const initial = page._load(3)
  finish(0, 'all')
  await initial
  assert.deepEqual(page._options, filters)
  const repoLoad = page._setRepo('owner/one')
  assert.deepEqual(Object.fromEntries(requests[1].params), { page: '1', limit: '100', kind: 'triage', q: 'alice & bob', repo: 'owner/one' })
  finish(1, 'repo')
  await repoLoad
  const user = page._setActor('user:one')
  assert.deepEqual(Object.fromEntries(requests[2].params), { page: '1', limit: '100', kind: 'triage', q: 'alice & bob', repo: 'owner/one', actor: 'user:one' })
  finish(2, 'user')
  await user
  const secondPage = page._load(2)
  assert.equal(requests[3].params.get('actor'), 'user:one')
  assert.equal(requests[3].params.get('page'), '2')
  finish(3, 'second page')
  await secondPage
  const otherRepo = page._setRepo('owner/two')
  assert.equal(requests[4].params.get('actor'), 'user:one', 'repository changes keep the selected user')
  assert.equal(requests[4].params.get('page'), '1')
  finish(4, 'other repo')
  await otherRepo
  const returnToRepo = page._setRepo('owner/one')
  assert.equal(page._history[0].id, 'user', 'each user/repository selection has its own cache')
  finish(5, 'updated user')
  await returnToRepo
  const allUsers = page._setActor('')
  assert.equal(page._history[0].id, 'repo', 'resetting the user restores the unfiltered repository cache')
  assert.equal(requests[6].params.has('actor'), false)
  finish(6, 'updated repo')
  await allUsers
  const selected = page._setActor('user:two')
  finish(7, 'bob')
  await selected
  const clear = page._clearContext()
  assert.equal(requests[8].params.has('repo'), false)
  assert.equal(requests[8].params.has('actor'), false)
  assert.equal(requests[8].params.get('q'), 'alice & bob')
  finish(8, 'clear')
  await clear
})

test('installed Show all defaults off, resets pagination, and ignores a late all-repos response', async (t) => {
  const page = createPage(Repositories)
  const pending = []
  t.mock.method(globalThis, 'fetch', (url) => new Promise(resolve => { pending.push({ url: new URL(url, 'http://localhost'), resolve }) }))
  page._open('installed')
  assert.equal(page._showAll, false)
  assert.equal(pending[0].url.searchParams.get('showAll'), 'false')
  pending[0].resolve(Response.json({ repositories: [repo], total: 1 }))
  await setImmediate()
  page._page = 3
  page._setShowAll(true)
  assert.equal(page._page, 1)
  assert.equal(page._data, null)
  assert.equal(pending[1].url.searchParams.get('showAll'), 'true')
  page._setShowAll(false)
  pending[2].resolve(Response.json({ repositories: [repo], total: 1 }))
  await setImmediate()
  pending[1].resolve(Response.json({ repositories: [{ id: 999, fullName: 'other/private' }], total: 1 }))
  await setImmediate()
  assert.deepEqual(page._data.repositories, [repo])
  const refresh = page._load(true)
  assert.equal(pending[3].url.searchParams.get('refresh'), 'true')
  pending[3].resolve(Response.json({ repositories: [repo], total: 1 }))
  await refresh
  page._open('installed')
  assert.equal(page._showAll, false)
  pending[4].resolve(Response.json({ repositories: [repo], total: 1 }))
  await setImmediate()
})
