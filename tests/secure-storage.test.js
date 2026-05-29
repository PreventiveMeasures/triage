// `client/secure-storage.js` — removeItem must coordinate with the
// per-key writeChain so a still-in-flight setItem persist can't write
// a removed value back to disk. Only the localStorage shim is needed
// (vault disabled → persist is a plaintext localStorage.setItem).

import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'

await import('./_polyfills.js')
const ss = await import('../client/secure-storage.js')

describe('secure-storage: removeItem', () => {
  beforeEach(() => {
    ss.__test__.reset()
    globalThis.localStorage.clear()
  })

  it('is not resurrected by a still-pending setItem persist', async () => {
    const K = 'deepview.test.removeitem'
    // Don't await the setItem: its persist is queued on the writeChain.
    // removeItem must chain BEHIND that persist (post-fix) rather than
    // clear disk synchronously and let the pending persist write V back.
    const setP = ss.setItem(K, 'V')
    const rmP = ss.removeItem(K)
    await Promise.all([setP, rmP])
    assert.equal(
      globalThis.localStorage.getItem(K),
      null,
      'disk removal wins; the pending persist must not resurrect V',
    )
    assert.equal(ss.getItem(K), null, 'cache cleared')
  })

  it('does not clobber a setItem that lands after removeItem (later writer wins)', async () => {
    // Copilot review #148: the queued removal must not unconditionally
    // delete the cache — a setItem that lands while the removal is still
    // queued on the writeChain owns the key, so its value + pin must
    // survive (cache stays consistent with disk).
    const K = 'deepview.test.rmset'
    const rmP = ss.removeItem(K)   // tombstone + queued removal
    const setP = ss.setItem(K, 'V2') // later writer; replaces the tombstone
    await Promise.all([rmP, setP])
    assert.equal(ss.getItem(K), 'V2', 'later setItem value survives in cache')
    assert.equal(globalThis.localStorage.getItem(K), 'V2', 'disk holds the later value')
  })
})
