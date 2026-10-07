import assert from 'node:assert/strict'
import { test } from 'node:test'
import { uploadFiles, uploadLocalFile } from '../ui/managed/file-uploads.js'
import { ManagedAppState } from '../ui/managed/state.js'

function host(appState = new ManagedAppState()) {
  return { appState, _queue: [], _busy: false, _error: null, _csrf: 'csrf', loads: 0, _load() { this.loads++; return Promise.resolve() }, _upload() {} }
}
const file = name => new File(['{}'], name)
async function cache(appState, ...keys) {
  for (const key of keys) await appState.load(key, key, () => Promise.resolve('cached'))
}

test('a failed upload still refreshes its collections, since part of it may be stored', async () => {
  const page = host()
  await cache(page.appState, 'reports', 'history', 'teams')
  // A split Markdown import throws after storing its other products.
  await uploadFiles(page, [file('audit.md')], () => Promise.reject(new Error('1 of 2 products failed (audit: A.generic-md: HTTP 500)')), ['reports', 'history'])
  assert.equal(page._error, 'Upload failed: audit.md: 1 of 2 products failed (audit: A.generic-md: HTTP 500)')
  assert.equal(page.appState.read('reports'), undefined)
  assert.equal(page.appState.read('history'), undefined)
  assert.equal(page.appState.read('teams'), 'cached', 'unrelated collections stay cached')

  await cache(page.appState, 'reports')
  await assert.rejects(uploadLocalFile(page, file('local.md'), () => Promise.reject(new Error('partial')), ['reports']), /partial/u)
  assert.equal(page.appState.read('reports'), undefined, 'local imports refresh after a failure too')
  assert.equal(page._busy, false)
})

test('a session change ends the batch and clears its queue', async () => {
  for (const failure of ['abort', 'error']) {
    const page = host()
    const sent = []
    await uploadFiles(page, [file('a.json'), file('b.json'), file('c.json')], selected => {
      sent.push(selected.name)
      if (selected.name !== 'b.json') return Promise.resolve({ ok: true })
      page.appState.reset() // logout or account switch while b.json uploads
      if (failure === 'error') return Promise.reject(new Error('HTTP 401'))
      return Promise.resolve({ ok: true }) // mutate reports the session change as an AbortError
    }, ['reports'])
    assert.deepEqual(sent, ['a.json', 'b.json'], `${failure}: files after a session change are not sent`)
    assert.deepEqual(page._queue, [])
    assert.equal(page._error, null, `${failure}: the cancelled file is not reported as a failed upload`)
    assert.equal(page._busy, false)
  }

  const page = host()
  const sent = []
  const batch = uploadFiles(page, [file('first.json')], async selected => {
    sent.push(selected.name)
    if (selected.name === 'first.json') {
      await uploadFiles(page, [file('dropped.json')], () => assert.fail('a running batch only queues the drop'), ['reports'])
      page.appState.reset()
      throw new Error('HTTP 500')
    }
    return { ok: true }
  }, ['reports'])
  await batch
  assert.deepEqual(sent, ['first.json'], 'files dropped during the batch are dropped with the session')
  assert.deepEqual(page._queue, [])
})
