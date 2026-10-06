// Async test doubles preserve the network API contract.
/* eslint-disable require-await */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { managedFetch, setPreviewRole } from '../client/managed/request.js'
import { uploadReport } from '../ui/managed/admin-api.js'
import { genericMarkdown } from './_generic-markdown.js'

const CHUNK = 3 * 1024 * 1024

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
    const fetch = t.mock.method(globalThis, 'fetch', async url => url === '/api/config' ? Response.json({ managed: {} }) : Response.json(body, { status }))
    await assert.rejects(uploadReport(new File(['{}'], 'file.json'), 'csrf'), { message })
    fetch.mock.restore()
  }
})

test('large managed uploads negotiate chunks, preserve metadata and finalize only after all parts', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options })
    return Response.json(url === '/api/config' ? { managed: { uploadChunkBytes: CHUNK } } : { ok: true })
  })
  const headers = { 'x-csrf-token': 'csrf', 'x-report-filename': 'file.json', 'x-repo-id': '12' }
  const result = await managedFetch('/api/admin/reports', { method: 'POST', headers, body: new Blob([new Uint8Array(CHUNK + 10)]) })
  assert.equal(result.ok, true)
  assert.equal(calls.length, 4)
  assert.match(calls[1].url, /\/uploads\/reports\/[a-f\d-]+\/0$/u)
  assert.equal(calls[1].options.body.size, CHUNK)
  assert.equal(calls[2].options.body.size, 10)
  const final = calls[3]
  assert.equal(final.url, '/api/admin/reports')
  assert.equal(final.options.headers.get('x-csrf-token'), 'csrf')
  assert.equal(final.options.headers.get('x-report-filename'), 'file.json')
  assert.equal(final.options.headers.get('x-upload-parts'), '2')
  assert.equal(final.options.headers.get('x-upload-size'), String(CHUNK + 10))
  assert.equal(final.options.body, '')
})

test('chunk failures and account switches prevent finalization; local servers retain raw upload', async t => {
  const blob = new Blob([new Uint8Array(CHUNK + 1)])
  const options = { method: 'POST', body: blob }
  let calls = 0
  const fetch = t.mock.method(globalThis, 'fetch', async url => {
    calls++
    return Response.json(url === '/api/config' ? { managed: { uploadChunkBytes: CHUNK } } : { error: 'forbidden' }, { status: url === '/api/config' ? 200 : 403 })
  })
  assert.equal((await managedFetch('/api/admin/bundles', options)).status, 403)
  assert.equal(calls, 3, 'failed chunks trigger a cleanup request')
  fetch.mock.mockImplementation(async url => {
    if (url === '/api/config') return Response.json({ managed: { uploadChunkBytes: CHUNK } })
    setPreviewRole(null)
    return Response.json({ ok: true })
  })
  await assert.rejects(managedFetch('/api/admin/bundles', options), { name: 'AbortError' })
  fetch.mock.mockImplementation(async (url, init) => {
    if (url === '/api/config') return Response.json({ managed: {} })
    assert.equal(init.body, blob)
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
    assert.equal(calls.at(-1).url, calls[1].url.replace(/\/0$/u, ''))
    assert.equal(calls.filter(call => call.options.method === 'DELETE').length, 1)
    fetch.mock.restore()
  }
})


test('managed generic Markdown upload splits by product before sending bytes', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === '/api/config') return Response.json({ managed: {} })
    calls.push({ url, headers: new Headers(options.headers), data: JSON.parse(await options.body.text()) })
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
    assert.match(decodeURIComponent(call.headers.get('x-report-filename')), /audit: Product%20[AB]\.generic-md$/u)
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
