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

describe('secure-storage: onAfterHydrate late-subscriber catch-up', () => {
  beforeEach(() => {
    ss.__test__.reset()
    globalThis.localStorage.clear()
  })

  it('fires a subscriber that registers AFTER hydrate (the lazy-sync boot order)', async () => {
    // Regression (re-prompt with a saved password): the lazily-loaded
    // sync surface registers its `onSecureStorageHydrated` hook only once
    // its chunk loads — AFTER `continueBoot`'s one boot hydrate.
    // `hydrate()` fires each listener once per hydrate and won't re-run
    // for a newcomer, so pre-fix the hook never ran at boot, the cached
    // sync password was never copied into memory, and the operator was
    // re-prompted every session. The catch-up must fire the late
    // subscriber once, and it must observe the already-hydrated cache
    // (mirrors `loadCachedSyncPasswordFromStorage` reading via getItem).
    const K = ss.SECURE_KEYS[0]
    globalThis.localStorage.setItem(K, 'persisted') // on disk before boot
    await ss.hydrate() // boot hydrate; no sync listener registered yet
    let fired = 0
    let observed = null
    const unsub = ss.onAfterHydrate(() => { fired++; observed = ss.getItem(K) })
    assert.equal(fired, 0, 'does not fire synchronously — subscribe returns first')
    await Promise.resolve() // drain the catch-up microtask
    assert.equal(fired, 1, 'late subscriber gets exactly one catch-up fire')
    assert.equal(observed, 'persisted', 'callback observes the hydrated cache')
    unsub()
  })

  it('does NOT catch-up an early subscriber; the normal post-hydrate fire still works', async () => {
    // hydratedOnce is false at subscribe → no catch-up. The listener
    // fires through `fireAfterHydrate` inside `hydrate()` exactly once,
    // exactly as before this change.
    let fired = 0
    const unsub = ss.onAfterHydrate(() => { fired++ })
    await Promise.resolve()
    assert.equal(fired, 0, 'no catch-up before any hydrate has completed')
    await ss.hydrate()
    assert.equal(fired, 1, 'fires once via the normal post-hydrate fan-out')
    unsub()
  })

  it('catch-up is skipped when unsubscribed before its microtask runs', async () => {
    await ss.hydrate()
    let fired = 0
    const unsub = ss.onAfterHydrate(() => { fired++ })
    unsub() // remove synchronously, before the queued microtask
    await Promise.resolve()
    assert.equal(fired, 0, 'a removed listener is skipped by the has() guard')
  })

  it('the same callback can subscribe twice; each fires independently with its own unsub', async () => {
    // The `wrapped` closure keys each subscription on a distinct Set
    // entry, so one cb subscribed twice fires twice and each unsub
    // removes only its own subscription.
    await ss.hydrate()
    let fired = 0
    const cb = () => { fired++ }
    const unsubA = ss.onAfterHydrate(cb)
    const unsubB = ss.onAfterHydrate(cb)
    await Promise.resolve()
    assert.equal(fired, 2, 'both subscriptions of the same cb catch-up independently')
    unsubA()
    await ss.hydrate() // only B remains
    assert.equal(fired, 3, 'unsubA removed only its own subscription; B still fires')
    unsubB()
  })

  it('the one-shot catch-up does NOT unwire the listener from later real hydrates', async () => {
    // The real consumer (triage-sync's handleSecureStorageHydrated) is
    // designed to run again on every later hydrate — vault-state change,
    // sibling-tab storage event. After the one-shot catch-up the listener
    // must STILL be in the Set so the next hydrate fans it out; a future
    // refactor that removed `wrapped` once the catch-up fired would
    // silently break that re-fire. This is the most realistic boot
    // sequence (late subscribe → catch-up → a subsequent rehydrate).
    await ss.hydrate()
    let fired = 0
    const unsub = ss.onAfterHydrate(() => { fired++ })
    await Promise.resolve()           // catch-up
    assert.equal(fired, 1, 'one catch-up fire')
    await ss.hydrate()                // a real later hydrate
    assert.equal(fired, 2, 'still fires through fireAfterHydrate after the catch-up')
    unsub()
  })

  it('a throwing late subscriber is swallowed and does not starve a sibling catch-up', async () => {
    // The catch-up runs detached on a microtask, so a synchronous throw
    // in the callback must be swallowed (warn-and-continue, parity with
    // fireAfterHydrate) — otherwise it surfaces as an unhandledRejection
    // and could break a sibling subscriber's catch-up.
    await ss.hydrate()
    let good = 0
    const realWarn = console.warn
    console.warn = () => {} // silence the expected warn-and-continue
    try {
      const unsubBad = ss.onAfterHydrate(() => { throw new Error('boom') })
      const unsubGood = ss.onAfterHydrate(() => { good++ })
      await Promise.resolve()         // drain both catch-up microtasks
      assert.equal(good, 1, 'the throw is isolated; the sibling still catches up')
      unsubBad()
      unsubGood()
    } finally {
      console.warn = realWarn
    }
  })
})
