// `client/bundle-hash-index.js` — the cross-bundle file-hash index's
// change notification.
//
// The index fills asynchronously (a fire-and-forget prefetch at
// ingest, and from empty on every reload) and its readers — the focus
// view's inline Code panel, the finding-card's "Code →" button, the
// Files tab's per-file link — all consult it synchronously during a
// render that has usually already happened by the time the hashes
// land. Subscribers are the only thing that tells those views to ask
// again, so the notification firing exactly when an answer can change
// is what keeps a reloaded report from sitting there with no Code
// panel until the user clicks something.

import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'

const {
  bundlesForFileHash,
  dropBundleFromHashIndex,
  recordBundleFileHashes,
  subscribeToBundleHashIndex,
} = await import('../client/bundle-hash-index.js')

const HASH_A = 'sha512-aaa'
const HASH_B = 'sha512-bbb'

// Module-scope index — each test cleans up the integrities it added so
// the next one starts from a known state.
let unsubscribe = null
let calls = 0

beforeEach(() => {
  unsubscribe?.()
  calls = 0
  unsubscribe = subscribeToBundleHashIndex(() => { calls++ })
})

describe('subscribeToBundleHashIndex', () => {
  it('fires when an integrity is first recorded', () => {
    recordBundleFileHashes('int-1', new Map([['src/a.js', HASH_A]]))
    assert.equal(calls, 1)
    assert.deepEqual(bundlesForFileHash(HASH_A), [{ integrity: 'int-1', file: 'src/a.js' }])
    dropBundleFromHashIndex('int-1')
  })

  // A re-record is the same bundle's bytes hashing to the same map, so
  // no lookup's answer changes — notifying would be a render for nothing.
  it('stays quiet when the same integrity is re-recorded', () => {
    recordBundleFileHashes('int-2', new Map([['src/a.js', HASH_A]]))
    recordBundleFileHashes('int-2', new Map([['src/a.js', HASH_A]]))
    assert.equal(calls, 1)
    dropBundleFromHashIndex('int-2')
  })

  // Removal changes an answer as surely as arrival does: a view still
  // offering the deleted bundle's code has to drop the offer.
  it('fires when a bundle is dropped from the index', () => {
    recordBundleFileHashes('int-3', new Map([['src/a.js', HASH_B]]))
    calls = 0
    dropBundleFromHashIndex('int-3')
    assert.equal(calls, 1)
    assert.deepEqual(bundlesForFileHash(HASH_B), [])
  })

  it('ignores a record with no integrity or no hashes', () => {
    recordBundleFileHashes('', new Map([['src/a.js', HASH_A]]))
    recordBundleFileHashes('int-4', null)
    assert.equal(calls, 0)
  })

  it('stops delivering after unsubscribe', () => {
    unsubscribe()
    unsubscribe = null
    recordBundleFileHashes('int-5', new Map([['src/a.js', HASH_A]]))
    assert.equal(calls, 0)
    dropBundleFromHashIndex('int-5')
  })

  // One listener throwing can't take down the record path — the caller
  // is mid-index and the other subscribers still need the news.
  it('survives a throwing listener', () => {
    const off = subscribeToBundleHashIndex(() => { throw new Error('boom') })
    recordBundleFileHashes('int-6', new Map([['src/a.js', HASH_A]]))
    assert.equal(calls, 1)
    off()
    dropBundleFromHashIndex('int-6')
  })
})
