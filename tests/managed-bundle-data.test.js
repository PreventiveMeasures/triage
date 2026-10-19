import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { constants, createGzip } from 'node:zlib'
import { beforeEach, test } from 'node:test'
import { fetchBundleContents, fetchBundleMetadata, fetchBundleOrigin, fetchManagedBundleCatalog, fetchRepositoryAgents, fetchRepositoryIssues, fetchRepositoryPulse, prefetchActivity }
  from '../ui/managed/bundle-data.js'
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

test('origin suggestions use shared paths from metadata without fetching contents or changing metadata', async t => {
  const original = { github: 'org/c' }
  const metadata = { bundle: { repo: original }, files: [['.', null, null, null], ['a/src/x.js', 1, 'hash', 1], ['a/icon.png', null, null, null]], unsized: ['a/icon.png'] }
  t.mock.method(globalThis, 'fetch', url => {
    if (url.endsWith('/metadata')) return Promise.resolve({ ok: true, json: () => Promise.resolve(metadata) })
    assert.equal(url, '/api/admin/repositories/resolve?repo=org%2Fc&directory=&filePrefix=a')
    return Promise.resolve(Response.json({ location: { github: 'org/mono', repoId: 1, directory: 'projects', mapped: true } }))
  })
  assert.deepEqual(await fetchBundleOrigin('bundle/id'), { github: 'org/mono', repoId: 1, directory: 'projects' })
  assert.deepEqual(original, { github: 'org/c' })
  assert.equal(metadata.files[1][0], 'a/src/x.js')
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

// A 502 is npm unreachable only where the server says so: an answer it
// couldn't read, or too large to, is told as that.
test('npm reads name a registry answer that could not be read apart from an unreachable registry', async t => {
  const { fetchNpmPackage, fetchNpmRisk } = await import('../ui/managed/bundle-data.js')
  for (const [status, error, message] of [
    [502, 'upstream-invalid', "The npm registry's answer for this package couldn't be read."],
    [502, 'upstream-too-large', "The npm registry's answer for this package is too large to read here."],
    [502, 'upstream-unavailable', "The npm registry couldn't be reached."],
    [422, 'bad-tarball', "This package's tarball couldn't be read."],
  ]) {
    t.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({ error }, { status })))
    for (const read of [() => fetchNpmRisk('temp', '0.4.0'), () => fetchNpmPackage('temp', '0.4.0')]) {
      await assert.rejects(read(), { status, code: error, message })
    }
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

test('an Activity view\'s first read asked for ahead is taken by the first to read it, none read again; one failing read anew, another session\'s not taken', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const asked = []
  let fail = false, refuse = false
  t.mock.method(globalThis, 'fetch', url => {
    asked.push(url)
    if (fail) return Promise.reject(new TypeError('offline'))
    if (refuse) return Promise.resolve(Response.json({ error: 'repository-busy' }, { status: 503 }))
    return Promise.resolve(Response.json({ read: asked.length }))
  })
  prefetchActivity(7, 'pulse', { weeks: 52 })
  prefetchActivity(7, 'pulse', { weeks: 52 })
  prefetchActivity(7, 'pulls', { state: 'closed' })
  prefetchActivity(7, 'agents')
  assert.deepEqual(asked, ['/api/admin/repositories/pulse?repoId=7&weeks=52', '/api/admin/repositories/issues?repoId=7&kind=pulls&state=closed',
    '/api/admin/repositories/agents?repoId=7'], 'each asked once')
  assert.deepEqual(await fetchRepositoryPulse(7, 52), { read: 1 })
  assert.deepEqual(await fetchRepositoryIssues(7, 'pulls', { state: 'closed' }), { read: 2 })
  assert.equal(asked.length, 3, 'taken, none read again')
  assert.deepEqual(await fetchRepositoryPulse(7, 52), { read: 4 }, 'taken once: the next read asks')
  // One failing: read anew.
  fail = true
  prefetchActivity(7, 'pulse', { weeks: 4 })
  fail = false
  assert.deepEqual(await fetchRepositoryPulse(7, 4), { read: 6 })
  // One refused, as a server busy for a moment refuses it: read anew.
  refuse = true
  prefetchActivity(7, 'pulse', { weeks: 13 })
  refuse = false
  assert.deepEqual(await fetchRepositoryPulse(7, 13), { read: 8 })
  // Another session's: not taken.
  managedAppState.setSession({ id: 'bob', role: 'manage' })
  assert.deepEqual(await fetchRepositoryAgents(7), { read: 9 })
  assert.equal(asked.length, 9)
})

test('a read asked for ahead that none takes in time is called off', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const signals = []
  t.mock.method(globalThis, 'fetch', (url, options) => { signals.push(options.signal); return new Promise(() => {}) })
  prefetchActivity(8, 'agents')
  t.mock.timers.tick(14_999)
  assert.equal(signals[0].aborted, false)
  t.mock.timers.tick(1)
  assert.equal(signals[0].aborted, true, 'called off')
  prefetchActivity(8, 'agents')
  assert.equal(signals.length, 2, 'asked anew')
})
