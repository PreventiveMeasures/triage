import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { setImmediate } from 'node:timers/promises'
import { beforeEach, mock, test } from 'node:test'
import { Bundle } from '@exodus/stasis-core/bundle'
import { createBundleMetadata } from '../common/bundle-metadata.js'
import { managedRouteForIds, resolveManagedRoute } from '../common/managed/routes.js'
import { managedAppState } from '../ui/managed/state.js'
import { fetchBundleMetadata } from '../ui/managed/bundle-data.js'
import { managedBundleEntry, managedBundleRoute, managedTeamBundleEntries } from '../ui/view/managed-bundle-navigation.js'
import { refreshManagedBundleView } from '../ui/view/managed-bundle-refresh.js'
import { createManagedHistory } from '../ui/view/managed-history.js'
import { beginViewNavigation } from '../ui/view/view-navigation.js'
import { browserAt } from './_managed-browser.js'

const notices = [], state = {}
let managed = true
mock.module('../client/index.js', { namedExports: {
  state, isManagedUiMode: () => managed, ensureBundleFindingsIndexed() {}, hasBundleFileHashes() {},
  readBundle() {}, readBundleIndex() {}, recordBundleFileHashes() {}, saveBundleIndex() {},
} })
// The browser loads an emitted managed chunk beside view.js. Route that lazy
// import to its real bundle APIs, keeping the navigation proxy under test.
const proxyUrl = new URL('../ui/view/client-managed.js', import.meta.url).href
const bundleDataUrl = new URL('../ui/managed/bundle-data.js', import.meta.url).href
registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier === './client-managed.js' && context.parentURL === proxyUrl ? bundleDataUrl : specifier, context)
} })
mock.module('../ui/view/render.js', { namedExports: { render() {} } })
mock.module('../ui/view/toast.js', { namedExports: { showToast() {} } })
const { openManagedBundle } = await import('../ui/view/managed-bundle-open.js')
const { ManagedCreateBundle } = await import('../ui/managed/create-bundle.js')

const bundle = { id: 'created', slug: 'created', integrity: 'sha512-created', filename: 'repo.aaaaaaa.stasis.code.br', byteSize: 100, repoId: 1 }
const team = key => ({ id: 'team', slug: 'team', cacheKey: key, reports: [], bundles: [bundle] })
const metadata = await createBundleMetadata({ integrity: bundle.integrity, kind: 'stasis', size: bundle.byteSize,
  bundle: new Bundle({ entries: new Set(['index.js']),
    modules: new Map([['.', { name: 'app', version: '1', files: { 'index.js': 'export default 1' } }]]),
    formats: new Map([['index.js', 'module']]),
  }) })

beforeEach(t => {
  managed = true
  beginViewNavigation()
  managedAppState.reset()
  managedAppState.setSession({ id: 'user', role: 'manage' })
  Object.assign(state, { currentView: 'manage-bundles', bundleDetails: null, bundles: [], currentManagedTeam: null })
  notices.length = 0
  t.mock.method(managedAppState, 'notify', message => notices.push(message))
  globalThis.document = {
    body: { classList: { remove() {} } }, querySelector: () => null,
  }
  t.after(() => managedAppState.reset())
})

async function fixture(t) {
  const requests = []
  t.mock.method(globalThis, 'fetch', (url, { signal }) => {
    assert.equal(url, `/api/bundles/${bundle.id}/metadata`)
    const request = { ...Promise.withResolvers(), signal }
    requests.push(request)
    const abort = () => request.reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    return request.promise.finally(() => signal.removeEventListener('abort', abort))
  })
  let teams = []
  managedAppState.setReportCatalog(teams)
  const { browser } = browserAt('/manage/bundle?createRepo=1')
  const history = createManagedHistory(browser)
  const landings = []
  await history.start(async (route, isCurrent) => {
    beginViewNavigation()
    if (route.view === 'home') {
      landings.push(route)
      state.currentView = 'home'; state.bundleDetails = null
      return true
    }
    if (route.view !== 'bundles') { state.currentView = route.view; return true }
    const resolved = resolveManagedRoute(route, teams, [bundle])
    if (!resolved) return false
    const entries = resolved.teamId == null ? [managedBundleEntry(bundle)] : managedTeamBundleEntries(teams)
    if (!await openManagedBundle(resolved, entries, isCurrent, () => {})) return false
    return managedRouteForIds({ ...resolved, bundleTab: state.bundleDetailsTab }, teams, [bundle])
  })
  let opening
  const page = new ManagedCreateBundle()
  page._repoId = 1; page._commit = 'a'.repeat(40); page._selected = new Set(['index.js'])
  page.createBundle = () => managedAppState.mutate(() => Promise.resolve(bundle), ['bundles', 'bundle-metadata'])
  page.dispatchEvent = event => {
    assert.equal(event.type, 'bundle-created')
    const entry = managedBundleEntry(event.detail)
    const owner = teams.find(candidate => candidate.bundles.some(candidateBundle => candidateBundle.id === entry.managedId))
    opening = history.navigate(managedBundleRoute(teams, entry, owner?.id))
    return true
  }
  const refresh = key => {
    teams = [team(key)]
    return managedAppState.setReportCatalog(teams)
  }
  await page.buildBundle()
  await setImmediate()
  assert.equal(page._opening, true)
  assert.equal(requests.length, 1)
  return { browser, history, landings, opening, page, refresh, requests }
}

test('a bundle shows its catalogue entry at once and its files once the metadata arrives', async t => {
  const f = await fixture(t)
  assert.equal(state.currentView, 'bundles', 'shown before its metadata')
  assert.equal(state.selectedBundle, bundle.integrity)
  assert.equal(state.bundleDetails, null)
  assert.equal(f.browser.location.pathname, '/manage/bundle', 'the URL follows once the open succeeds')
  f.requests[0].resolve(Response.json(metadata))
  assert.equal(await f.opening, true)
  assert.equal(state.bundleDetails.managedId, bundle.id)
  assert.deepEqual([...state.bundleDetails.fileSizes.keys()], ['index.js'])
  assert.equal(f.browser.location.pathname, '/manage/bundle/created')
})

test('a tab picked while the metadata loads still gets the files, or says why there are none', async t => {
  const responses = [
    ['files', () => Response.json(metadata)],
    [/503/u, () => new Response('', { status: 503 })],
    [/another version/u, () => Response.json({ ...metadata, integrity: 'sha512-other' })],
    [/Invalid bundle metadata/u, () => Response.json({ ...metadata, files: null })],
  ]
  for (const [outcome, response] of responses) {
    await t.test(String(outcome), async st => {
      const f = await fixture(st)
      state.bundleDetailsTab = 'code'
      f.history.pushRoute(managedRouteForIds({ view: 'bundles', teamId: null, bundleId: bundle.id, bundleTab: 'code' }, [], [bundle]))
      f.requests[0].resolve(response())
      assert.equal(await f.opening, false, 'the tab change took over the navigation')
      assert.equal(f.browser.location.pathname, '/manage/bundle/created/code')
      assert.equal(state.currentView, 'bundles')
      assert.deepEqual(f.landings, [])
      if (outcome === 'files') assert.equal(state.bundleDetails.fileSizes.get('index.js'), 16)
      else assert.match(state.bundleDetails.error, outcome)
      assert.equal(state.bundleDetails.managedId, bundle.id)
    })
  }
})

test('a catalogue refresh while the metadata loads rehomes the bundle, which still gets its files', async t => {
  const f = await fixture(t)
  state.bundleDetailsTab = 'code'
  f.history.pushRoute(managedRouteForIds({ view: 'bundles', teamId: null, bundleId: bundle.id, bundleTab: 'code' }, [], [bundle]))
  const teams = [team('moved')]
  assert.equal(await refreshManagedBundleView(state, teams, { fetchCatalog: () => assert.fail('the team catalogue confirms access'),
    isCurrent: () => true, render() {}, replaceRoute: route => f.history.replaceRoute(route) }), true)
  assert.equal(state.currentManagedTeam, 'team')
  assert.equal(f.browser.location.pathname, '/team/team/bundle/created/code')
  f.requests[0].resolve(Response.json(metadata))
  assert.equal(await f.opening, false, 'the tab change took over the navigation')
  assert.equal(state.bundleDetails.fileSizes.get('index.js'), 16)
  assert.equal(state.bundleDetails.managedId, bundle.id)
})

test('creation opens the bundle when its first team refresh cancels the metadata request during Opening', async t => {
  const f = await fixture(t)
  assert.ok(f.refresh('first').has('bundle:created'))
  assert.equal(f.requests[0].signal.aborted, true)
  await setImmediate()
  assert.deepEqual(f.landings, [])
  assert.equal(f.requests.length, 2, 'Opening must restart the invalidated read rather than navigate to landing')
  assert.equal(f.page._opening, true)
  f.requests[1].resolve(Response.json(metadata))
  assert.equal(await f.opening, true)
  assert.equal(state.currentView, 'bundles')
  assert.equal(state.bundleDetails.managedId, bundle.id)
  assert.equal(state.bundleDetailsTab, 'overview')
  assert.equal(f.browser.location.pathname, '/manage/bundle/created')
  assert.deepEqual(f.landings, [])
  assert.deepEqual(notices, [])
})

test('repeated grant refreshes during Opening restart authorization until metadata is ready', async t => {
  const f = await fixture(t)
  for (const key of ['first', 'second', 'third']) {
    f.refresh(key)
    await setImmediate()
    assert.deepEqual(f.landings, [])
    assert.equal(f.page._opening, true)
  }
  assert.equal(f.requests.length, 4)
  f.requests[3].resolve(Response.json(metadata))
  assert.equal(await f.opening, true)
  assert.equal(f.browser.location.pathname, '/manage/bundle/created')
  assert.deepEqual(notices, [])
})

test('Opening shares a fresh metadata read already started by another consumer after invalidation', async t => {
  const f = await fixture(t)
  f.refresh('first')
  const shared = fetchBundleMetadata(bundle.id)
  await setImmediate()
  assert.equal(f.requests.length, 2, 'the restarted read must join the current cache entry')
  f.requests[1].resolve(Response.json(metadata))
  assert.equal(await shared, managedAppState.read(`bundle-metadata:${bundle.id}`))
  assert.equal(await f.opening, true)
  assert.deepEqual(f.landings, [])
})

test('a late response body from an invalidated request cannot supply the opened bundle', async t => {
  const f = await fixture(t)
  const body = Promise.withResolvers(), reading = Promise.withResolvers()
  f.requests[0].resolve({ ok: true, json: () => { reading.resolve(); return body.promise } })
  await reading.promise
  f.refresh('first')
  body.resolve({ ...metadata, integrity: 'outdated' })
  await setImmediate()
  assert.equal(f.requests.length, 2)
  assert.deepEqual(f.landings, [])
  f.requests[1].resolve(Response.json(metadata))
  assert.equal(await f.opening, true)
  assert.equal(state.bundleDetails.integrity, bundle.integrity)
})

test('leaving during invalidation or a restarted metadata read wins over the old Opening navigation', async t => {
  for (const afterRetry of [false, true]) {
    await t.test(String(afterRetry), async st => {
      const f = await fixture(st)
      f.refresh('first')
      if (afterRetry) await setImmediate()
      assert.equal(await f.history.navigate({ view: 'manage' }), true)
      f.refresh('second')
      await setImmediate()
      assert.equal(f.requests.length, afterRetry ? 2 : 1)
      assert.equal(await f.opening, false)
      assert.equal(state.currentView, 'manage')
      assert.equal(state.bundleDetails, null)
      assert.equal(f.browser.location.pathname, '/manage')
      assert.deepEqual(f.landings, [])
      assert.deepEqual(notices, [])
    })
  }
})

test('a catalogue refresh after leaving Opening cannot retry metadata or show a failure on the destination', async t => {
  const f = await fixture(t)
  assert.equal(await f.history.navigate({ view: 'manage' }), true)
  f.refresh('first')
  await setImmediate()
  assert.equal(f.requests.length, 1)
  assert.equal(await f.opening, false)
  assert.equal(state.currentView, 'manage')
  assert.equal(f.browser.location.pathname, '/manage')
  assert.deepEqual(f.landings, [])
  assert.deepEqual(notices, [])
})

test('account and role changes during Opening never retry with a different managed identity', async t => {
  for (const session of [null, { id: 'other', role: 'manage' }, { id: 'user', role: 'view' }]) {
    await t.test(JSON.stringify(session), async st => {
      const f = await fixture(st)
      f.refresh('first')
      managedAppState.setSession(session)
      f.history.reset()
      assert.equal(await f.opening, false)
      assert.equal(f.requests.length, 1)
      assert.equal(state.bundleDetails, null)
      assert.deepEqual(f.landings, [])
      assert.deepEqual(notices, [])
    })
  }
})

test('confirmed metadata failures after catalogue invalidation fail once without an endless retry', async t => {
  for (const status of [401, 403, 404, 422, 503]) {
    await t.test(String(status), async st => {
      const f = await fixture(st)
      f.refresh('first')
      await setImmediate()
      assert.equal(f.requests.length, 2)
      f.requests[1].resolve(new Response('', { status }))
      assert.equal(await f.opening, false)
      assert.equal(f.requests.length, 2)
      assert.equal(state.bundleDetails, null)
      assert.equal(f.browser.location.pathname, '/')
      assert.equal(f.landings.length, 1)
      assert.deepEqual(notices, [`Couldn't refresh bundle metadata: Bundle metadata request failed (${status})`])
    })
  }
})

test('an unrelated transport cancellation does not restart the same metadata resource', async t => {
  const f = await fixture(t)
  f.requests[0].reject(new DOMException('Transport aborted', 'AbortError'))
  assert.equal(await f.opening, false)
  assert.equal(f.requests.length, 1)
  assert.equal(f.landings.length, 1)
  assert.equal(state.bundleDetails, null)
})

test('a Code link carries its file number into the opened bundle until its sources load', async t => {
  const f = await fixture(t)
  f.requests[0].resolve(Response.json(metadata))
  assert.equal(await f.opening, true)
  const requested = f.requests.length
  const opening = f.history.navigate({ view: 'bundles', teamSlug: null, bundleSlug: bundle.slug, bundleTab: 'code', file: 3 })
  await setImmediate()
  if (f.requests.length > requested) f.requests.at(-1).resolve(Response.json(metadata))
  assert.equal(await opening, true)
  assert.equal(state.bundleDetailsTab, 'code')
  assert.deepEqual(state.bundleCodeFileRequest, { bundle: bundle.integrity, file: 3 })
  assert.equal(f.browser.location.pathname, '/manage/bundle/created/code/3')
})

test('a Code link carries its marked lines with its file number', async t => {
  const f = await fixture(t)
  f.requests[0].resolve(Response.json(metadata))
  assert.equal(await f.opening, true)
  const requested = f.requests.length
  const opening = f.history.navigate({ view: 'bundles', teamSlug: null, bundleSlug: bundle.slug, bundleTab: 'code', file: 1, line: 42, endLine: 69 })
  await setImmediate()
  if (f.requests.length > requested) f.requests.at(-1).resolve(Response.json(metadata))
  assert.equal(await opening, true)
  assert.deepEqual(state.bundleCodeFileRequest, { bundle: bundle.integrity, file: 1, line: 42, endLine: 69 })
  assert.equal(f.browser.location.pathname + f.browser.location.hash, '/manage/bundle/created/code/1#L42-L69')
})

test('a bundle Compare\'s swap hands over opens in full, lent the hashes and sizes the server indexed', async t => {
  const { handOffBundles, releaseHandoff } = await import('../ui/view/bundle-load.js')
  t.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json(metadata)))
  const parsed = { integrity: bundle.integrity, kind: 'stasis', size: bundle.byteSize, managedId: bundle.id, bundle: new Bundle({
    modules: new Map([['.', { name: 'app', version: '1', files: { 'index.js': 'export default 1' } }]]),
  }) }
  const held = handOffBundles([parsed])
  t.after(() => releaseHandoff(held))
  assert.equal(await openManagedBundle({ bundleId: bundle.id, teamId: null, bundleTab: 'compare' }, [managedBundleEntry(bundle)], () => true, () => {}), true)
  assert.equal(state.bundleDetails, parsed, 'the parsed bundle itself, not the metadata-only one')
  assert.equal(parsed.metadataOnly, undefined)
  assert.deepEqual([...parsed.fileHashes.keys()], ['index.js'])
  assert.equal(parsed.fileSizes.get('index.js'), 16)
})
