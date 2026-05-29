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

  // The three tests below are forward-regression guards for the
  // tombstone's edge paths (flagged in the #148 re-review). They pin
  // the intended invariants; unlike the no-clobber test above they
  // aren't fix-distinguishers (the chained removal converges the end
  // state), so they guard against a FUTURE break of the tombstone logic.

  it('a concurrent hydrate during a pending removal leaves the key removed (tombstone skip)', async () => {
    // The tombstone keeps the key pinned in pendingValues, so a hydrate
    // landing before the removal's writeChain slot runs SKIPS it instead
    // of re-reading the on-disk value. hydrate only walks SECURE_KEYS.
    const K = ss.SECURE_KEYS[0]
    await ss.setItem(K, 'V') // disk = V (plaintext, vault disabled)
    const rmP = ss.removeItem(K) // tombstone pinned; cache cleared synchronously
    await ss.hydrate() // must not re-cache the on-disk V
    await rmP
    assert.equal(ss.getItem(K), null, 'key stays removed across an interleaved hydrate')
    assert.equal(globalThis.localStorage.getItem(K), null, 'disk removed')
  })

  it('remove then a set whose persist fails leaves the key cleanly empty', async () => {
    // The tombstone guard must interoperate with setItem's rollback:
    // when the later writer's persist throws, its optimistic cache value
    // is rolled back, the failure surfaces to the caller, and nothing is
    // left diverged (cache vs disk) or as an unhandled rejection.
    const K = 'deepview.test.rmsetfail'
    const realSetItem = globalThis.localStorage.setItem
    globalThis.localStorage.setItem = (k, v) => {
      if (k === K && v === 'V2') throw new Error('quota exceeded')
      return realSetItem(k, v)
    }
    try {
      const rmP = ss.removeItem(K)
      const outcome = ss.setItem(K, 'V2').then(() => 'ok', () => 'rejected')
      const [, result] = await Promise.all([rmP, outcome])
      assert.equal(result, 'rejected', 'the failed persist surfaces as a rejection')
      assert.equal(ss.getItem(K), null, 'rolled back — cache not left holding the un-persisted value')
      assert.equal(globalThis.localStorage.getItem(K), null, 'disk empty')
    } finally {
      globalThis.localStorage.setItem = realSetItem
    }
  })

  it('two concurrent removeItem calls leave no stuck tombstone (pin cleared)', async () => {
    // Distinct Symbol tombstones: the first finishRemoval sees its pin
    // already replaced by the second's tombstone and skips the clear;
    // the second clears its own. Neither leaves a stuck pin — proven by
    // a later on-disk value being picked up by hydrate (a stuck pin
    // would make hydrate skip the key and never re-cache it).
    const K = ss.SECURE_KEYS[0]
    await ss.setItem(K, 'V')
    await Promise.all([ss.removeItem(K), ss.removeItem(K)])
    assert.equal(ss.getItem(K), null, 'both removals leave the key gone')
    assert.equal(globalThis.localStorage.getItem(K), null, 'disk removed')
    globalThis.localStorage.setItem(K, 'X') // a value appears on disk afterwards
    await ss.hydrate()
    assert.equal(ss.getItem(K), 'X', 'hydrate re-caches — pendingValues holds no stuck tombstone')
  })
})
