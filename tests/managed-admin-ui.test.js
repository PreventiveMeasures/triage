import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import './_polyfills.js'
import '../ui/client-managed.js'
import { ManagedPage } from '../ui/managed/page.js'
import { ManagedAppState, managedAppState } from '../ui/managed/state.js'

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

test('managed report labels, actions and search use decoded product names', (t) => {
  const page = createPage(Reports)
  const report = { id: 'generic', filename: 'Audit%20notes: Product%20A%2FB%20100%25.generic-md', visible: true }
  const name = 'Audit notes: Product A/B 100%'
  function values(value) {
    if (Array.isArray(value)) return value.flatMap(values)
    return value?.strings ? value.values.flatMap(values) : [value]
  }
  const labels = values(page._row(report)).filter(value => typeof value === 'string')
  assert.ok(labels.includes(name), 'visible label and tooltip decode the stored name')
  for (const action of ['Preview', 'Hide', 'Download', 'Delete']) assert.ok(labels.includes(`${action} ${name}`))
  assert.ok(!labels.some(label => label.includes('%20') || label.includes('.generic-md')))
  page._data = { reports: [report] }
  const row = t.mock.method(page, '_row', () => null)
  for (const query of ['Product A/B', '100%', 'Audit notes']) {
    page._query = query
    page._body()
  }
  assert.equal(row.mock.callCount(), 3)
  assert.equal(report.filename, 'Audit%20notes: Product%20A%2FB%20100%25.generic-md')
})

test('managed bundle rows label server builds, which search can find', (t) => {
  const page = createPage(customElements.get('managed-admin-bundles'))
  // Static template text as well as interpolated values.
  function markup(value) {
    if (Array.isArray(value)) return value.map(markup).join('')
    return value?.strings ? value.strings.map((part, i) => part + (i < value.values.length ? markup(value.values[i]) : '')).join('') : String(value ?? '')
  }
  const bundle = { id: 'b', filename: 'org-repo.aaaaaaa.stasis.code.br', kind: 'stasis', byteSize: 1, visible: true }
  assert.match(markup(page._row({ ...bundle, provenance: 'build' })), /class="bundle-provenance"[^>]*>Built</u)
  for (const provenance of ['upload', null]) assert.doesNotMatch(markup(page._row({ ...bundle, provenance })), /bundle-provenance/u)
  page._data = { bundles: [{ ...bundle, provenance: 'build' }, { ...bundle, id: 'u', provenance: 'upload' }] }
  const row = t.mock.method(page, '_row', () => null)
  page._query = 'built'
  page._body()
  assert.deepEqual(row.mock.calls.map(call => call.arguments[0].id), ['b'])
})

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
  ['links', '_data', '/api/admin/links', { shares: [{ id: 'link', teamId: 't', teamName: 'Team', createdBy: 'manager', permissions: { security: false, dependencies: false } }] }],
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

test('successful creation opens the new bundle from the collection and repository entry points', t => {
  const bundle = { id: 'created-bundle', slug: 'created', integrity: 'created-hash', filename: 'created.stasis.code.br', repoId: 7 }
  for (const createRepoId of [null, 7]) {
    const page = createPage(customElements.get('managed-admin-bundles'))
    page.createRepoId = createRepoId
    page._creating = true
    t.mock.method(page, '_load', async () => {})
    t.mock.method(page, '_showCreate', () => {})
    const events = []
    page.dispatchEvent = event => { events.push(event); return true }
    const view = page.render()
    const created = view.values[view.strings.findIndex(string => string.includes('@bundle-created='))]
    created({ detail: bundle })
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'managed-bundle-open')
    assert.equal(events[0].detail, bundle)
    assert.equal(events[0].bubbles, true)
    assert.equal(events[0].composed, true)
    assert.equal(page._load.mock.callCount(), 0, 'opening the bundle does not reload the collection')
    assert.equal(page._showCreate.mock.callCount(), 0, 'repository creation must not navigate back to the collection')
  }
})

test('bundle location editing retains the collection and directory on failure, then saves with the current token', async (t) => {
  const Bundles = customElements.get('managed-admin-bundles')
  const page = createPage(Bundles)
  page.session = adminSession
  const bundle = { id: 'b', repoId: 7, repoDirectory: 'old' }
  page._data = { bundles: [bundle], repos: [] }
  let token = 'current-token'
  let status = 403
  t.mock.method(globalThis, 'fetch', (_url, options) => {
    if (options.method === 'POST') {
      assert.equal(options.headers['x-csrf-token'], token)
      assert.deepEqual(JSON.parse(options.body), { bundleId: 'b', repoId: 7, directory: '/foo/sub' })
      return Promise.resolve(new Response('', { status }))
    }
    return Promise.resolve(Response.json({ bundles: [bundle], repos: [] }))
  })
  page._openLocation(bundle)
  assert.equal(page._locationDirectory, 'old')
  page._locationDirectory = '/foo/sub'
  await page._saveLocation(bundle)
  assert.match(page._error, /choose a repository and directory within your team access/u)
  assert.equal(page._locationBundle, 'b')
  assert.equal(page._locationDirectory, '/foo/sub')
  assert.deepEqual(page._data.bundles, [bundle])
  status = 200
  token = 'rotated-token'
  page.session = { ...adminSession, csrfToken: token }
  await page._saveLocation(bundle)
  assert.equal(page._locationBundle, null)
  assert.equal(page._error, null, 'a successful retry clears the previous action error')
})

test('bundle origins load only for open Stasis editors and never replace the assignment', async t => {
  const page = createPage(customElements.get('managed-admin-bundles'))
  const requests = []
  t.mock.method(globalThis, 'fetch', (url, options) => {
    if (url.startsWith('/api/admin/repositories/resolve?')) return Promise.resolve(Response.json({ location: null }))
    const pending = Promise.withResolvers()
    requests.push({ url, options, ...pending })
    return pending.promise
  })
  const first = { id: 'origin-first', kind: 'stasis', repoId: null, repoDirectory: '' }
  const second = { id: 'origin-second', kind: 'stasis', repoId: 7, repoDirectory: 'assigned' }
  page._openLocation({ id: 'map', kind: 'sourcemap' })
  assert.equal(requests.length, 0)
  page._openLocation({ ...first, canChangeRepo: false })
  assert.equal(requests.length, 0)
  page._openLocation(first)
  assert.equal(requests[0].url, '/api/bundles/origin-first/metadata')
  assert.equal(page._locationOrigin, undefined)
  page._openLocation(second)
  page._locationDirectory = 'user edit'
  requests[1].resolve(Response.json({ bundle: { repo: { github: 'source/repo', directory: 'original' } } }))
  await setImmediate()
  assert.deepEqual(page._locationOrigin, { github: 'source/repo', directory: 'original' })
  assert.equal(page._locationRepo, 7)
  assert.equal(page._locationDirectory, 'user edit')
  requests[0].resolve(Response.json({ bundle: { repo: { github: 'stale/repo', directory: 'old' } } }))
  await setImmediate()
  assert.equal(page._locationOrigin.github, 'source/repo', 'late metadata cannot replace the current row')
  page._closeLocation()
  assert.equal(page._locationOrigin, null)
  assert.equal(page._locationBundle, null)
})

test('bundle metadata shortcuts match supported GitHub origins and apply their declared location', () => {
  const page = createPage(customElements.get('managed-admin-bundles'))
  page._data = { repos: [{ repoId: 7, fullName: 'Owner/Repo' }] }
  function templates(value) {
    if (Array.isArray(value)) return value.flatMap(templates)
    return value?.strings ? [value, ...value.values.flatMap(templates)] : []
  }
  for (const [github, available] of [
    ['owner/repo', true],
    ['https://github.com/owner/repo.git', true],
    ['github.com/OWNER/REPO/tree/main', true],
    [' owner/repo.git/ ', true],
    ['https://github.com/owner/other.git', false],
    ['https://gitlab.com/owner/repo.git', false],
    ['not a repository', false],
  ]) {
    page._locationRepo = null
    page._locationDirectory = 'user edit'
    page._locationOrigin = { github, directory: 'original' }
    const view = templates(page._locationEditor({ id: 'origin' }))
    const button = view.find(template => template.values.includes(`Use repository from metadata: ${github}`))
    assert.equal(Boolean(button), available, github)
    assert.ok(view.some(template => template.values.includes(github)), 'display the original metadata value')
    if (button) button.values.find(value => typeof value === 'function')()
    assert.equal(page._locationRepo, available ? 7 : null, github)
    assert.equal(page._locationDirectory, available ? 'original' : 'user edit', 'the repository shortcut also assigns its declared directory')
  }
  for (const directory of ['/', '', null]) {
    page._locationDirectory = 'user edit'
    page._locationOrigin = { github: 'owner/repo', directory }
    const button = templates(page._locationEditor({ id: 'origin' }))
      .find(template => template.values.includes('Use repository from metadata: owner/repo'))
    button.values.find(value => typeof value === 'function')()
    assert.equal(page._locationDirectory, directory ?? 'user edit', 'explicit roots clear the old path; unspecified metadata preserves it')
  }
})

test('bundle origin errors are retryable and cancelled editors ignore late metadata', async t => {
  const page = createPage(customElements.get('managed-admin-bundles'))
  const requests = []
  const notices = []
  t.mock.method(managedAppState, 'notify', message => notices.push(message))
  t.mock.method(globalThis, 'fetch', url => {
    if (url.startsWith('/api/admin/repositories/resolve?')) return Promise.resolve(Response.json({ location: null }))
    const pending = Promise.withResolvers()
    requests.push(pending)
    return pending.promise
  })
  const bundle = { id: 'origin-retry', kind: 'stasis' }
  page._openLocation(bundle)
  requests[0].resolve(new Response('', { status: 503 }))
  await setImmediate()
  assert.match(page._locationOriginError, /Couldn't load/u)
  assert.deepEqual(notices, [], 'active editor errors are shown inline without a duplicate global notice')
  const retry = page._loadLocationOrigin(bundle)
  requests[1].resolve(Response.json({ bundle: { repo: { github: 'source/root', root: true } } }))
  await retry
  assert.equal(page._locationOriginError, null)
  assert.deepEqual(page._locationOrigin, { github: 'source/root', directory: '/' })
  page._openLocation({ id: 'origin-absent', kind: 'stasis' })
  requests[2].resolve(Response.json({ bundle: {} }))
  await setImmediate()
  assert.equal(page._locationOrigin, null)
  assert.equal(page._locationOriginError, null)
  page._openLocation({ id: 'origin-cancelled', kind: 'stasis' })
  page.disconnectedCallback()
  requests[3].resolve(Response.json({ bundle: { repo: { github: 'late/repo' } } }))
  await setImmediate()
  assert.equal(page._locationOrigin, null)
  assert.equal(page._locationBundle, null)
})

test('bundle metadata suggestions use current aliases without replacing the saved or edited location', async t => {
  const page = createPage(customElements.get('managed-admin-bundles'))
  page._data = { repos: [] }
  page._locationRepo = null
  page._locationDirectory = 'user edit'
  let target = { repoId: 8, github: 'org/mono', directory: 'projects/a', mapped: true }
  t.mock.method(globalThis, 'fetch', (url, options) => {
    if (url.endsWith('/metadata')) return Promise.resolve(Response.json({ bundle: { repo: { github: 'org/old', directory: 'a' } } }))
    assert.equal(url, '/api/admin/repositories/resolve?repo=org%2Fold&directory=a')
    assert.equal(options.cache, 'no-store')
    return Promise.resolve(Response.json({ location: target }))
  })
  await page._loadLocationOrigin({ id: 'origin' })
  assert.deepEqual(page._locationOrigin, { github: 'org/mono', directory: 'projects/a' })
  assert.deepEqual(page._data.repos, [{ repoId: 8, fullName: 'org/mono' }], 'newly connected destinations become selectable')
  assert.equal(page._locationRepo, null)
  assert.equal(page._locationDirectory, 'user edit')
  target = { ...target, directory: 'moved/a' }
  await page._loadLocationOrigin({ id: 'origin' })
  assert.equal(page._locationOrigin.directory, 'moved/a', 'opening again reads current aliases')
  function templates(value) {
    if (Array.isArray(value)) return value.flatMap(templates)
    return value?.strings ? [value, ...value.values.flatMap(templates)] : []
  }
  const shortcut = templates(page._locationEditor({ id: 'origin' })).find(template => template.values.includes('Use repository from metadata: org/mono'))
  shortcut.values.find(value => typeof value === 'function')()
  assert.equal(page._locationRepo, 8)
  assert.equal(page._locationDirectory, 'moved/a')
})

for (const abandon of ['close', 'switch', 'disconnect']) {
  test(`abandoned bundle origin failures stay silent after ${abandon}`, async t => {
    const page = createPage(customElements.get('managed-admin-bundles'))
    const notices = []
    const pending = Promise.withResolvers()
    let signal
    t.mock.method(managedAppState, 'notify', message => notices.push(message))
    // Deliberately settle after cancellation, as a response may already be in flight.
    t.mock.method(globalThis, 'fetch', (_url, options) => { signal = options.signal; return pending.promise })
    page._openLocation({ id: `origin-abandon-${abandon}`, kind: 'stasis' })
    if (abandon === 'close') page._closeLocation()
    else if (abandon === 'switch') page._openLocation({ id: 'another-bundle', kind: 'sourcemap' })
    else page.disconnectedCallback()
    pending.resolve(new Response('', { status: 503 }))
    await setImmediate()
    assert.deepEqual(notices, [], 'an abandoned editor must not emit a global failure notice')
    assert.equal(signal.aborted, true, 'closing the editor also cancels its request')
    assert.equal(page._locationOrigin, null)
    assert.equal(page._locationOriginError, null)
  })
}

test('upload batches preserve arrival order, use the current token without location overrides, and discard the rest on failure', async t => {
  for (const kind of ['report', 'bundle']) {
    const page = createPage(customElements.get(`managed-admin-${kind}s`))
    page.session = adminSession
    const first = Promise.withResolvers()
    const firstStarted = Promise.withResolvers()
    const requests = []
    let refreshes = 0
    const fetch = t.mock.method(globalThis, 'fetch', (url, options) => {
      if (url === '/api/config') return Promise.resolve(Response.json({ managed: {} }))
      assert.equal(url, `/api/admin/${kind}s`)
      if (options.method !== 'POST') {
        refreshes++
        return Promise.resolve(Response.json({ [`${kind}s`]: [], repos: [] }))
      }
      requests.push({ name: options.body.name, headers: options.headers })
      firstStarted.resolve()
      return requests.length === 1 ? first.promise : Promise.resolve(new Response('', { status: 500 }))
    })
    try {
      await page._upload([])
      assert.equal(refreshes, 0, 'an empty selection must not reload the page')
      const pending = page._upload([new File(['{}'], 'first.json'), new File(['{}'], 'second.json')])
      await page._upload([new File(['{}'], 'dropped.json')])
      await firstStarted.promise // report uploads may read and split Markdown before sending
      assert.equal(page._busy, true)
      assert.equal(requests.length, 1, 'only one upload runs at a time')
      page.session = { ...adminSession, csrfToken: 'rotated' }
      first.resolve(Response.json({ ok: true }))
      await pending
      assert.deepEqual(requests.map(request => request.name), ['first.json', 'second.json'])
      for (const request of requests) {
        assert.equal(request.headers['x-repo-id'], undefined)
        assert.equal(request.headers['x-repo-directory'], undefined)
      }
      assert.equal(requests[1].headers['x-csrf-token'], 'rotated')
      assert.deepEqual(page._queue, [])
      assert.equal(page._busy, false)
      assert.equal(page._error, 'Upload failed: HTTP 500')
      assert.equal(refreshes, 1, 'the failed batch still refreshes once')
    } finally { fetch.mock.restore() }
  }
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

test('installed Show all defaults off, resets organization filtering, and ignores a late all-repos response', async (t) => {
  const page = createPage(Repositories)
  const pending = []
  t.mock.method(globalThis, 'fetch', (url) => new Promise(resolve => { pending.push({ url: new URL(url, 'http://localhost'), resolve }) }))
  page._open('installed')
  assert.equal(page._showAll, false)
  assert.equal(pending[0].url.searchParams.get('showAll'), 'false')
  pending[0].resolve(Response.json({ repositories: [repo], total: 1 }))
  await setImmediate()
  page._organization = 'owner'
  page._setShowAll(true)
  assert.equal(page._organization, null)
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

for (const scope of ['connected', 'installed', 'public']) {
  test(`${scope} loads every repository once and filters locally by organization and search`, async (t) => {
    const page = createPage(Repositories)
    const repositories = [...Array.from({ length: 35 }, (_, i) => ({ id: i, fullName: `acme/repo-${i}` })), { id: 50, fullName: 'other/only' }]
    const network = t.mock.method(globalThis, 'fetch', (url) => {
      const params = new URL(url, 'http://localhost').searchParams
      assert.equal(params.get('scope'), scope)
      for (const name of ['q', 'page', 'limit']) assert.equal(params.has(name), false)
      return Promise.resolve(Response.json({ repositories, total: repositories.length }))
    })
    page._open(scope)
    await setImmediate()
    let choices = page._repositoryChoices()
    assert.equal(choices.count, 36)
    assert.equal(choices.showFacets, true)
    assert.deepEqual(choices.facets.map(org => [org.name, org.count]), [['acme', 35], ['other', 1]])
    page._organization = 'other'
    assert.deepEqual(page._repositoryChoices().sections[0].options.map(option => option.repo.id), [50])
    page._search('repo-34')
    assert.equal(page._repositoryChoices().count, 0, 'search stays within the selected organization')
    page._organization = null
    choices = page._repositoryChoices()
    assert.equal(choices.count, 1)
    assert.equal(choices.sections[0].options[0].repo.id, 34, 'repos beyond the old first page are searchable')
    assert.equal(network.mock.callCount(), 1)
    page._data = { repositories: repositories.slice(0, 35) }
    page._search('')
    assert.equal(page._repositoryChoices().showFacets, false, 'one organization needs no sidebar')
  })
}

test('repository labels do not infer public visibility from the stored private flag', () => {
  const page = createPage(Repositories)
  assert.equal(page._accessLabel({ installed: true, private: false, visibility: 'internal' }), 'Internal · GitHub App')
  assert.equal(page._accessLabel({ installed: true, private: false, visibility: 'public' }), 'Public · GitHub App')
  assert.equal(page._accessLabel({ installed: true, private: false }), 'GitHub App', 'stored records with unknown visibility stay neutral')
  assert.equal(page._accessLabel({ installed: true, private: true }), 'Private · GitHub App')
})

test('public repository form submits with CSRF, retains failures and refreshes the connected catalogue on success', async t => {
  const page = createPage(Repositories)
  page.session = adminSession
  page._publicRepoOpen = true
  page._publicRepository = ' owner/repo '
  let status = 403
  let posts = 0
  t.mock.method(globalThis, 'fetch', (url, options) => {
    if (options.method === 'POST') {
      posts++
      assert.equal(url, '/api/admin/repositories/add-public')
      assert.equal(options.headers['x-csrf-token'], adminSession.csrfToken)
      assert.deepEqual(JSON.parse(options.body), { repository: 'owner/repo' })
      return Promise.resolve(Response.json({}, { status }))
    }
    assert.match(url, /scope=connected/u)
    return Promise.resolve(Response.json({ repositories: [repo], canAddAnyPublicRepository: true }))
  })
  await page._addPublicRepository()
  assert.equal(page._publicRepoOpen, true)
  assert.equal(page._publicRepository, ' owner/repo ')
  assert.match(page._publicRepoError, /permission/u)
  assert.equal(page._addingPublic, false)
  status = 200
  const adding = page._addPublicRepository()
  await page._addPublicRepository()
  await adding
  assert.equal(posts, 2, 'double submission is ignored')
  assert.equal(page._publicRepoOpen, false)
  assert.equal(page._publicRepository, '')
  assert.equal(page._publicRepoError, null)
  assert.deepEqual(page._data.repositories, [repo])
})

test('connecting the App submits only the repository ID with CSRF and refreshes list and detail', async t => {
  const page = createPage(Repositories)
  Object.defineProperty(page, 'isConnected', { value: true })
  page.session = adminSession
  page._detail = { ...repo, active: false }
  let finish
  let posts = 0
  t.mock.method(globalThis, 'fetch', (url, options) => {
    if (options.method === 'POST') {
      posts++
      assert.equal(url, '/api/admin/repositories/connect-app')
      assert.equal(options.headers['x-csrf-token'], adminSession.csrfToken)
      assert.deepEqual(JSON.parse(options.body), { repoId: repo.id })
      return new Promise(resolve => { finish = resolve })
    }
    return Promise.resolve(Response.json({ repositories: [{ ...repo, installed: true }] }))
  })
  const pending = page._connectApp(repo)
  await page._connectApp(repo)
  assert.equal(posts, 1)
  assert.equal(page._connectingApp, true)
  finish(Response.json({ connected: true }))
  await pending
  assert.deepEqual(page._detail, { ...repo, active: false, installed: true })
  assert.equal(page._data.repositories[0].installed, true)
  assert.equal(page._busy, null)
  assert.equal(page._connectingApp, false)
})

test('connecting the App redirects only for a valid installation response; failures remain retryable', async t => {
  const page = createPage(Repositories)
  Object.defineProperty(page, 'isConnected', { value: true })
  page.session = adminSession
  const oldLocation = Object.getOwnPropertyDescriptor(globalThis, 'location')
  let destination
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { assign: url => { destination = url } } })
  t.after(() => { if (oldLocation) Object.defineProperty(globalThis, 'location', oldLocation); else delete globalThis.location })
  let result = Response.json({ error: 'github-status-403' }, { status: 502 })
  t.mock.method(globalThis, 'fetch', () => Promise.resolve(result))
  await page._connectApp(repo)
  assert.match(page._actionError, /Could not connect/u)
  assert.equal(destination, undefined)
  assert.equal(page._busy, null)
  result = Response.json({ connected: false, installUrl: 'https://evil.test/install' })
  await page._connectApp(repo)
  assert.equal(destination, undefined)
  assert.match(page._actionError, /Invalid GitHub/u)
  result = Response.json({ connected: false, installUrl: 'https://github.com/apps/triage-test/installations/new' })
  await page._connectApp(repo)
  assert.equal(destination, 'https://github.com/apps/triage-test/installations/new')
  assert.equal(page._actionError, null)
})

test('bundle visibility changes use CSRF, refresh catalogs and retain state on failure', async t => {
  const page = createPage(customElements.get('managed-admin-bundles'))
  page.session = adminSession
  page.appState.setSession(adminSession)
  const bundle = { id: 'bundle', filename: 'app.map', repoId: 7, visible: true }
  const requests = []
  const invalidated = t.mock.method(page.appState, 'invalidate')
  let fail = false
  t.mock.method(globalThis, 'fetch', (url, options) => {
    requests.push({ url, options })
    if (url.endsWith('/set-visible')) return Promise.resolve(fail ? new Response('', { status: 403 }) : Response.json({ ok: true }))
    return Promise.resolve(Response.json({ bundles: [{ ...bundle }], repos: [] }))
  })
  await page._setVisible(bundle, false)
  assert.equal(bundle.visible, false)
  assert.ok(invalidated.mock.calls.some(call => ['bundles', 'teams'].every(key => call.arguments[0].includes(key))))
  assert.equal(requests[0].url, '/api/admin/bundles/set-visible')
  assert.equal(requests[0].options.headers['x-csrf-token'], 'current-token')
  assert.deepEqual(JSON.parse(requests[0].options.body), { bundleId: 'bundle', visible: false })
  assert.equal(page._data.bundles[0].visible, false)
  assert.equal(page._visibilityBusy, null)
  fail = true
  await page._setVisible(bundle, true)
  assert.equal(bundle.visible, false)
  assert.match(page._error, /Couldn't change bundle visibility/u)
  assert.equal(page._visibilityBusy, null)
})
