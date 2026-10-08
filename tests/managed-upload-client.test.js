// Async test doubles preserve the network API contract.
/* eslint-disable require-await */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { test } from 'node:test'
import { managedFetch, setPreviewRole } from '../client/managed/request.js'
import { newUploadKey, openSessionUpload, uploadPublicKey } from '../server-managed/uploads.ts'
import { uploadReport } from '../ui/managed/admin-api.js'
import { genericMarkdown } from './_generic-markdown.js'

const CHUNK = 3 * 1024 * 1024
const KEY = newUploadKey()
const KEY_PATH = '/api/admin/uploads/key'
const keyResponse = () => Response.json({ key: uploadPublicKey(KEY) })
const open = async (...parts) => openSessionUpload(KEY, Buffer.from(await new Blob(parts).arrayBuffer()), 2 ** 30)

test('report upload errors explain invalid content and preserve other failures', async t => {
  const cases = [
    [400, { error: 'invalid-report', reason: 'JSON, but not a report: no findings array' },
      'This file is not a report: JSON, but not a report: no findings array'],
    [400, { error: 'invalid-report' }, 'This file is not a recognized report.'],
    [400, { error: 'repo-not-connected', repo: 'owner/repo' }, 'HTTP 400: owner/repo is not connected'],
    [413, { error: 'too-large' }, 'too large'],
    [500, null, 'HTTP 500'],
  ]
  for (const [status, body, message] of cases) {
    const fetch = t.mock.method(globalThis, 'fetch', async url => url === '/api/config' ? Response.json({ managed: {} })
      : url === KEY_PATH ? keyResponse() : Response.json(body, { status }))
    await assert.rejects(uploadReport(new File(['{}'], 'file.json'), 'csrf'), { message })
    fetch.mock.restore()
  }
})

test('large managed uploads negotiate chunks, preserve metadata and finalize only after all parts', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options })
    if (url === KEY_PATH) return keyResponse()
    return Response.json(url === '/api/config' ? { managed: { uploadChunkBytes: CHUNK } } : { ok: true })
  })
  const headers = { 'x-csrf-token': 'csrf', 'x-report-filename': 'file.json', 'x-repo-id': '12' }
  const file = new Uint8Array(CHUNK + 10)
  file[CHUNK] = 1
  const result = await managedFetch('/api/admin/reports', { method: 'POST', headers, body: new Blob([file]) })
  assert.equal(result.ok, true)
  assert.deepEqual(calls.map(call => call.url.replace(/[a-f\d-]{36}/u, 'id')),
    ['/api/config', KEY_PATH, '/api/admin/uploads/reports/id/0', '/api/admin/uploads/reports/id/1', '/api/admin/reports'])
  // Binary content is sealed without compression: a 34-byte header and a
  // 16-byte tag for each of its four 1 MiB segments.
  const sealed = CHUNK + 10 + 34 + 4 * 16
  assert.equal(calls[2].options.body.size, CHUNK)
  assert.equal(calls[3].options.body.size, sealed - CHUNK)
  assert.deepEqual(await open(calls[2].options.body, calls[3].options.body), Buffer.from(file))
  const final = calls[4]
  assert.equal(final.url, '/api/admin/reports')
  assert.equal(final.options.headers.get('x-csrf-token'), 'csrf')
  assert.equal(final.options.headers.get('x-report-filename'), 'file.json')
  assert.equal(final.options.headers.get('x-upload-encryption'), '1')
  assert.equal(final.options.headers.get('x-upload-parts'), '2')
  assert.equal(final.options.headers.get('x-upload-size'), String(sealed))
  assert.equal(final.options.body, '')
})

test('uploads are sealed to the session key; text is compressed and older servers receive the file as is', async t => {
  const text = JSON.stringify({ findings: [{ id: 'secret-finding', description: 'x'.repeat(CHUNK) }] })
  for (const [url, body] of [['/api/admin/reports', text], ['/api/admin/deduplication', '[["a", "b"]]'], ['/api/admin/bundles', text]]) {
    const calls = []
    const fetch = t.mock.method(globalThis, 'fetch', async (target, options) => {
      calls.push({ url: target, options })
      if (target === KEY_PATH) return keyResponse()
      return Response.json(target === '/api/config' ? { managed: { uploadChunkBytes: CHUNK } } : { ok: true })
    })
    assert.equal((await managedFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: new File([body], 'f') })).ok, true)
    const sent = calls.at(-1)
    assert.equal(sent.url, url, 'compressed text fits one request')
    assert.equal(sent.options.headers.get('x-upload-encryption'), '1')
    assert.equal(sent.options.headers.get('content-type'), 'application/json')
    assert.ok(sent.options.body.size < 64 * 1024)
    assert.equal(Buffer.from(await sent.options.body.arrayBuffer()).includes('secret-finding'), false)
    assert.equal((await open(sent.options.body)).toString(), body)
    fetch.mock.restore()
  }
  const blob = new Blob(['{}'])
  const fetch = t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url === KEY_PATH) return Response.json({ error: 'not-found' }, { status: 404 })
    assert.equal(init.body, blob)
    assert.equal(new Headers(init.headers).has('x-upload-encryption'), false)
    return Response.json({ ok: true })
  })
  assert.equal((await managedFetch('/api/admin/reports', { method: 'POST', body: blob })).ok, true)
  assert.equal(fetch.mock.callCount(), 2)
  for (const [status, body] of [[403, { error: 'forbidden' }], [200, { key: null }]]) {
    fetch.mock.mockImplementation(async url => {
      assert.equal(url, KEY_PATH, 'nothing is uploaded without a usable key')
      return Response.json(body, { status })
    })
    if (status === 403) assert.equal((await managedFetch('/api/admin/reports', { method: 'POST', body: blob })).status, 403)
    else await assert.rejects(managedFetch('/api/admin/reports', { method: 'POST', body: blob }), /invalid upload key/u)
  }
})

test('chunk failures and account switches prevent finalization; local servers retain raw upload', async t => {
  const blob = new Blob([new Uint8Array(CHUNK + 1)])
  const options = { method: 'POST', body: blob }
  let calls = 0
  const fetch = t.mock.method(globalThis, 'fetch', async url => {
    calls++
    if (url === KEY_PATH) return keyResponse()
    return Response.json(url === '/api/config' ? { managed: { uploadChunkBytes: CHUNK } } : { error: 'forbidden' }, { status: url === '/api/config' ? 200 : 403 })
  })
  assert.equal((await managedFetch('/api/admin/bundles', options)).status, 403)
  assert.equal(calls, 4, 'failed chunks trigger a cleanup request')
  fetch.mock.mockImplementation(async url => {
    if (url === '/api/config') return Response.json({ managed: { uploadChunkBytes: CHUNK } })
    if (url === KEY_PATH) return keyResponse()
    setPreviewRole(null)
    return Response.json({ ok: true })
  })
  await assert.rejects(managedFetch('/api/admin/bundles', options), { name: 'AbortError' })
  fetch.mock.mockImplementation(async (url, init) => {
    if (url === '/api/config') return Response.json({ managed: {} })
    if (url === KEY_PATH) return keyResponse()
    assert.equal(url, '/api/admin/bundles')
    assert.deepEqual(await open(init.body), Buffer.from(await blob.arrayBuffer()))
    return Response.json({ ok: true })
  })
  assert.equal((await managedFetch('/api/admin/bundles', options)).ok, true)
})

test('advertised upload limits reject oversized reports and bundles before storing any parts', async t => {
  for (const kind of ['reports', 'bundles']) {
    const calls = []
    const fetch = t.mock.method(globalThis, 'fetch', async url => {
      calls.push(url)
      assert.equal(url, '/api/config')
      return Response.json({ managed: { uploadChunkBytes: CHUNK, uploadMaxBytes: { reports: CHUNK, bundles: CHUNK + 1 } } })
    })
    const response = await managedFetch(`/api/admin/${kind}`, { method: 'POST', body: new Blob([new Uint8Array(CHUNK + 2)]) })
    assert.equal(response.status, 413)
    assert.deepEqual(await response.json(), { error: 'too-large' })
    assert.deepEqual(calls, ['/api/config'])
    fetch.mock.restore()
  }
})

test('failed chunks, finalization, network errors and cancellation discard all attempted parts without masking the error', async t => {
  for (const failure of ['chunk', 'final', 'network', 'abort']) {
    const calls = [], controller = new AbortController()
    const networkError = new Error('connection lost')
    const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
      calls.push({ url, options })
      if (url === '/api/config') return Response.json({ managed: { uploadChunkBytes: CHUNK } })
      if (url === KEY_PATH) return keyResponse()
      if (options.method === 'DELETE') {
        assert.equal(options.headers.get('x-csrf-token'), 'csrf')
        assert.equal(options.headers.get('x-upload-parts'), '2')
        assert.equal(options.body, undefined)
        assert.equal(options.signal.aborted, false, 'cleanup uses a fresh signal')
        assert.equal(options.credentials, 'same-origin')
        throw new Error('cleanup also failed')
      }
      if (url.endsWith('/1')) {
        if (failure === 'chunk') return Response.json({ error: 'too-large' }, { status: 413 })
        if (failure === 'network') throw networkError
        if (failure === 'abort') { controller.abort(); throw controller.signal.reason }
      }
      if (url === '/api/admin/reports') {
        assert.equal(failure, 'final')
        return Response.json({ error: 'too-large' }, { status: 413 })
      }
      return Response.json({ ok: true })
    })
    const upload = managedFetch('/api/admin/reports', { method: 'POST', headers: { 'x-csrf-token': 'csrf' },
      body: new Blob([new Uint8Array(CHUNK + 1)]), credentials: 'same-origin', signal: controller.signal })
    if (failure === 'network') await assert.rejects(upload, error => error === networkError)
    else if (failure === 'abort') await assert.rejects(upload, { name: 'AbortError' })
    else assert.equal((await upload).status, 413)
    assert.equal(calls.at(-1).options.method, 'DELETE')
    assert.equal(calls.at(-1).url, calls[2].url.replace(/\/0$/u, ''))
    assert.equal(calls.filter(call => call.options.method === 'DELETE').length, 1)
    fetch.mock.restore()
  }
})


test('managed generic Markdown upload splits by product before sending bytes', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === '/api/config') return Response.json({ managed: {} })
    if (url === KEY_PATH) return keyResponse()
    calls.push({ url, headers: new Headers(options.headers), data: JSON.parse(await open(options.body)) })
    return Response.json({ id: calls.length })
  })
  await uploadReport(new File([genericMarkdown], 'audit.md'), 'csrf')
  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map(call => call.data.repo.github), ['a/a', 'a/b'])
  assert.deepEqual(calls.map(call => call.data.findings.map(finding => finding.sourceId)), [['AAA-02'], ['BBB-05']])
  for (const call of calls) {
    assert.equal(call.url, '/api/admin/reports')
    assert.equal(call.data.source, 'markdown-generic')
    assert.equal(call.headers.get('x-csrf-token'), 'csrf')
    assert.match(decodeURIComponent(call.headers.get('x-report-filename')), /^audit: Product [AB]\.generic-md$/u)
  }
})

test('invalid generic Markdown uploads reject before sending any product', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url, '/api/config')
    return Response.json({ managed: {} })
  })
  const invalid = genericMarkdown.replace('a/b/blob/abcdef0/f/g/h.js', 'a/other/blob/abcdef0/f/g/h.js')
  await assert.rejects(uploadReport(new File([invalid], 'bad.md'), 'csrf'), /exactly one repository/u)
  assert.equal(fetch.mock.callCount(), 1)
})

test('oversized report uploads fail before decoding the file', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(url)
    assert.equal(url, '/api/config')
    return Response.json({ managed: { uploadChunkBytes: CHUNK, uploadMaxBytes: { reports: 1024 } } })
  })
  for (const name of ['huge.json', 'huge.csv', 'huge.md']) {
    const file = new File([''], name)
    Object.defineProperty(file, 'size', { value: 2 ** 32, configurable: true })
    t.mock.method(file, 'text', () => { throw new Error('must not decode oversized input') })
    for (const size of [1025, CHUNK, CHUNK + 1, 2 ** 32]) {
      Object.defineProperty(file, 'size', { value: size })
      await assert.rejects(uploadReport(file, 'csrf'), { message: 'too large' })
      assert.equal(file.text.mock.callCount(), 0)
    }
  }
  assert.equal(calls.length, 12)
})
