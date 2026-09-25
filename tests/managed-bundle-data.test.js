import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { constants, createGzip } from 'node:zlib'
import { beforeEach, test } from 'node:test'
import { fetchBundleContents } from '../ui/managed/bundle-data.js'
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
