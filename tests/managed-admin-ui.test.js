import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import './_polyfills.js'
import '../ui/client-managed.js'

// Lit's Node implementation lets us exercise the actual async controllers
// without a document. Browser checks cover the rendered controls separately.
const Repositories = customElements.get('managed-admin-repos')
const Reports = customElements.get('managed-admin-reports')
const repo = { id: 7, fullName: 'owner/repo' }
const impact = { repoId: 7, reports: [{ id: 'r', filename: 'report.json' }], bundles: [], triageCount: 0 }

test('repository removal requires valid impact and confirmation, including after a failed load', async (t) => {
  const page = new Repositories()
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
  const page = new Reports()
  const pending = []
  // Ignore abort deliberately: request identity must also guard body reads
  // and transports that finish after cancellation.
  t.mock.method(globalThis, 'fetch', (_url, { signal }) => new Promise((resolve, reject) => { pending.push({ resolve, reject, signal }) }))
  const a = page._togglePreview({ id: 'a' })
  const b = page._togglePreview({ id: 'b' })
  assert.equal(pending[0].signal.aborted, true)
  pending[1].resolve(new Response('Report B'))
  await b
  pending[0].resolve(new Response('Report A'))
  await a
  assert.equal(page._preview, 'b')
  assert.equal(page._previewText, 'Report B')

  const oldA = page._togglePreview({ id: 'a' })
  await page._togglePreview({ id: 'a' }) // Close A while it is pending.
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
