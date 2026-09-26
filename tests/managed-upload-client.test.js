// Async test doubles preserve the network API contract.
/* eslint-disable require-await */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { managedFetch, setPreviewRole } from '../client/managed/request.js'

const CHUNK = 3 * 1024 * 1024

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
  assert.equal(calls, 2)
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
