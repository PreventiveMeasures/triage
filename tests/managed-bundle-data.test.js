import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { constants, createGzip } from 'node:zlib'
import { beforeEach, test } from 'node:test'
import { fetchBundleContents, fetchBundleMetadata, fetchBundleOrigin, fetchManagedBundleCatalog } from '../ui/managed/bundle-data.js'
import { managedAppState } from '../ui/managed/state.js'
import { beginViewNavigation, currentViewSignal } from '../ui/view/view-navigation.js'

beforeEach(() => {
  managedAppState.reset()
  managedAppState.setSession({ id: 'alice', role: 'manage' })
  beginViewNavigation()
})

// Keep a real gzipped response open after headers and some decompressed data
// arrive. Cancellation must stop response.text(), not just discard its result.
async function streamingContents(t) {
  const closed = Promise.withResolvers(), reading = Promise.withResolvers()
  const server = createServer((req, res) => {
    assert.equal(req.url, '/api/bundles/bundle%2Fid/contents')
    res.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Type': 'application/json' })
    const gzip = createGzip()
    gzip.pipe(res)
    gzip.write('{"sourcesContent":["')
    gzip.flush(constants.Z_SYNC_FLUSH)
    res.on('close', () => { gzip.destroy(); closed.resolve() })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    const stopping = new Promise(resolve => { server.close(resolve) })
    server.closeAllConnections()
    await stopping
  })
  const nativeFetch = globalThis.fetch
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.cache, 'no-store')
    assert.ok(options.signal instanceof AbortSignal)
    const response = await nativeFetch(new URL(url, `http://127.0.0.1:${server.address().port}`), options)
    const text = response.text.bind(response)
    response.text = () => { reading.resolve(options.signal); return text() }
    return response
  })
  const notices = []
  t.mock.method(managedAppState, 'notify', message => notices.push(message))
  return { reading: reading.promise, closed: closed.promise, notices }
}

for (const [name, cancel] of [
  ['leaving the view', () => beginViewNavigation()],
  ['signing out', () => managedAppState.setSession(null)],
  ['changing users', () => managedAppState.setSession({ id: 'bob', role: 'manage' })],
  ['losing the role', () => managedAppState.setSession({ id: 'alice', role: 'none' })],
  ['resetting managed mode', () => managedAppState.reset()],
]) {
  test(`${name} aborts a streaming contents body without an error toast`, { timeout: 5000 }, async t => {
    const stream = await streamingContents(t)
    const loading = fetchBundleContents('bundle/id', { signal: currentViewSignal() })
    const rejected = assert.rejects(loading, { name: 'AbortError' })
    const signal = await stream.reading
    cancel()
    assert.equal(signal.aborted, true)
    await rejected
    await stream.closed
    assert.deepEqual(stream.notices, [])
  })
}

test('a stale view never starts downloading; the next view can request contents', async t => {
  const oldSignal = currentViewSignal()
  beginViewNavigation()
  const network = t.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response('{"fresh":true}')))
  await assert.rejects(fetchBundleContents('bundle/id', { signal: oldSignal }), { name: 'AbortError' })
  assert.equal(network.mock.callCount(), 0)
  assert.equal(await fetchBundleContents('bundle/id', { signal: currentViewSignal() }), '{"fresh":true}')
  assert.equal(network.mock.callCount(), 1)
})

test('rotating a token preserves an active contents request; actual failures still toast', async t => {
  const stream = await streamingContents(t)
  const loading = fetchBundleContents('bundle/id', { signal: currentViewSignal() })
  const rejected = assert.rejects(loading, { name: 'AbortError' })
  const signal = await stream.reading
  managedAppState.setSession({ id: 'alice', role: 'manage', csrfToken: 'new' })
  assert.equal(signal.aborted, false)
  beginViewNavigation()
  await rejected
  t.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response('', { status: 503 })))
  await assert.rejects(fetchBundleContents('bundle/id'), /503/u)
  assert.deepEqual(stream.notices, ["Couldn't load bundle contents: Bundle contents request failed (503)"])
})

test('origin reference failures stay local while ordinary metadata failures still notify', async t => {
  const notices = []
  t.mock.method(managedAppState, 'notify', message => notices.push(message))
  t.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response('', { status: 503 })))
  await assert.rejects(fetchBundleOrigin('bundle/id'), /503/u)
  assert.deepEqual(notices, [])
  await assert.rejects(fetchBundleMetadata('bundle/id'), /503/u)
  assert.deepEqual(notices, ["Couldn't refresh bundle metadata: Bundle metadata request failed (503)"])
})

test('session changes abort origin reads and discard late response bodies', async t => {
  const body = Promise.withResolvers()
  const reading = Promise.withResolvers()
  const notices = []
  let signal
  t.mock.method(managedAppState, 'notify', message => notices.push(message))
  t.mock.method(globalThis, 'fetch', (_url, options) => {
    signal = options.signal
    return Promise.resolve({ ok: true, json: () => { reading.resolve(); return body.promise } })
  })
  const loading = fetchBundleOrigin('bundle/id')
  const rejected = assert.rejects(loading, { name: 'AbortError' })
  await reading.promise
  managedAppState.reset()
  assert.equal(signal.aborted, true)
  body.resolve({ bundle: { repo: { github: 'previous/session' } } })
  await rejected
  assert.deepEqual(notices, [])
})

test('bundle catalogue errors distinguish denied access from temporary failures', async t => {
  for (const status of [401, 403, 503]) {
    t.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response('', { status })))
    await assert.rejects(fetchManagedBundleCatalog(), { status })
  }
})

test('navigation and session changes abort catalogue reads and discard late bodies', async t => {
  for (const cancel of [() => beginViewNavigation(), () => managedAppState.reset()]) {
    const body = Promise.withResolvers(), reading = Promise.withResolvers()
    let signal
    t.mock.method(globalThis, 'fetch', (url, options) => {
      assert.equal(url, '/api/admin/bundles')
      assert.equal(options.cache, 'no-store')
      signal = options.signal
      return Promise.resolve({ ok: true, json: () => { reading.resolve(); return body.promise } })
    })
    const loading = fetchManagedBundleCatalog({ signal: currentViewSignal() })
    const rejected = assert.rejects(loading, { name: 'AbortError' })
    await reading.promise
    cancel()
    assert.equal(signal.aborted, true)
    body.resolve({ bundles: [{ id: 'old' }] })
    await rejected
  }
})

test('advisories send only an encoded bundle ID and team, using managed session cancellation', async t => {
  const { fetchBundleAdvisories } = await import('../ui/managed/bundle-data.js')
  t.mock.method(globalThis, 'fetch', (url, options) => {
    assert.equal(url, '/api/bundles/bundle%2Fid/advisories?team=team%2Fid')
    assert.equal(options.body, undefined)
    assert.equal(options.credentials, 'same-origin')
    assert.equal(options.signal, managedAppState.sessionController.signal)
    return Promise.resolve(Response.json({ packages: { dep: ['1.0.0'] }, advisories: {} }))
  })
  assert.deepEqual(await fetchBundleAdvisories('bundle/id', 'team/id'), { packages: { dep: ['1.0.0'] }, advisories: {} })
})


test('advisory reason and team are encoded independently without sending inventory', async t => {
  const { fetchBundleAdvisories } = await import('../ui/managed/bundle-data.js')
  const calls = []
  t.mock.method(globalThis, 'fetch', (url, options) => {
    calls.push(url)
    assert.equal(options.body, undefined)
    return Promise.resolve(Response.json({ packages: {}, advisories: {} }))
  })
  await fetchBundleAdvisories('bundle/id', 'team/id', 'custom & build')
  await fetchBundleAdvisories('bundle/id', undefined, 'run')
  await fetchBundleAdvisories('bundle/id', 'team/id', 'custom & build', true)
  await fetchBundleAdvisories('bundle/id', 'team/id', 'custom & build', true, true)
  assert.deepEqual(calls, [
    '/api/bundles/bundle%2Fid/advisories?team=team%2Fid&reason=custom%20%26%20build',
    '/api/bundles/bundle%2Fid/advisories?reason=run',
    '/api/bundles/bundle%2Fid/advisories?team=team%2Fid&reason=custom%20%26%20build&repoAdvisories=true',
    '/api/bundles/bundle%2Fid/advisories?team=team%2Fid&reason=custom%20%26%20build&repoAdvisories=true&details=true',
  ])
})
