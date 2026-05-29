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
})
