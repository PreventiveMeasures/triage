// `rray-modules/frontend/state-management.mjs` — `autorun` /
// `autopromise` are thin wrappers around @nx-js/observer-util.
// Audit round-15 surfaced three robustness bugs the original
// implementation missed:
//
//   * autorun: `first = false` ran AFTER `method(first)` so a
//     synchronous throw on the initial run left `first` stuck at
//     `true`; subsequent re-runs (from observables touched BEFORE
//     the throw) replayed the first-run branch.
//   * autorun: `observe(fn)` runs `fn` before returning the
//     reaction handle. If `fn` throws, the handle never reaches
//     the caller — observer-util's connectionStore retains the
//     reaction for any observable touched before the throw,
//     leaking a broken subscription that re-triggers forever.
//   * autopromise: `promise.finally(dispose)` deferred disposal to
//     a microtask. Synchronous mutations between `resolve()` and
//     the microtask re-ran `condition`, with confusing failure
//     modes when condition threw on a later run.
//
// These tests pin the fixed behaviour.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const { store, autorun, autopromise } = await import('../rray-modules/frontend/state-management.mjs')

describe('autorun', () => {
  it('passes first=true on the initial run, first=false thereafter', () => {
    const obs = store({ n: 0 })
    const seen = []
    const dispose = autorun((first) => {
      seen.push({ first, n: obs.n })
    })
    assert.deepEqual(seen, [{ first: true, n: 0 }])
    obs.n = 1
    assert.deepEqual(seen[1], { first: false, n: 1 })
    dispose()
  })

  it('subsequent runs see first=false even when the first call threw (audit round-15 finding 3)', () => {
    const obs = store({ n: 0 })
    const seen = []
    let throwOnFirst = true
    assert.throws(() => {
      autorun((first) => {
        seen.push({ first, n: obs.n })
        if (first && throwOnFirst) {
          throwOnFirst = false
          throw new Error('first-run boom')
        }
      })
    }, /first-run boom/u)
    // After the first-run throw, `first` was toggled in the finally
    // block, so the reaction handle (which autorun unobserved before
    // re-throwing) would have logged first=false had it survived.
    // We only see the initial throwing call here.
    assert.equal(seen.length, 1)
    assert.equal(seen[0].first, true)
  })

  it('a synchronous first-run throw unobserves the reaction (audit round-15 finding 1 root)', () => {
    // Pre-fix observer-util's `observe(fn)` ran `fn` before returning
    // the reaction handle. If `fn` threw, the handle was lost and
    // the reaction stayed registered in connectionStore for every
    // observable it had read up to that point. Any later mutation
    // to those observables would re-fire the leaked reaction.
    const obs = store({ n: 0 })
    let postThrowRuns = 0
    assert.throws(() => {
      autorun(() => {
        // Touch the observable so observer-util tracks it.
        void obs.n
        postThrowRuns += 1
        throw new Error('boom')
      })
    }, /boom/u)
    assert.equal(postThrowRuns, 1, 'precondition: the reaction ran exactly once during the throwing autorun')
    // Mutate the observable AFTER the throw. Pre-fix this would
    // re-trigger the leaked reaction; with the fix, autorun called
    // unobserve before re-throwing so no further runs happen.
    obs.n = 42
    assert.equal(postThrowRuns, 1, 'leaked reaction did not fire on post-throw mutation')
  })
})

describe('autopromise', () => {
  it('resolves on the first truthy condition value', async () => {
    const obs = store({ n: 0 })
    const p = autopromise(() => (obs.n >= 3 ? `done@${obs.n}` : null))
    obs.n = 1
    obs.n = 2
    obs.n = 3
    const result = await p
    assert.equal(result, 'done@3')
  })

  it('resolves synchronously on the first run when condition is already truthy', async () => {
    const obs = store({ n: 5 })
    const p = autopromise(() => (obs.n >= 3 ? `init@${obs.n}` : null))
    const result = await p
    assert.equal(result, 'init@5')
  })

  it('a synchronous first-run throw rejects the promise (audit round-15 finding 1)', async () => {
    const obs = store({ n: 0 })
    let runs = 0
    const p = autopromise(() => {
      runs += 1
      void obs.n
      throw new Error('cond-boom')
    })
    await assert.rejects(p, /cond-boom/u)
    assert.equal(runs, 1, 'condition ran once before throwing')
    // Mutate the observable that the (leaked, pre-fix) reaction
    // had registered for. With the fix, autorun unobserved before
    // re-throwing — no further runs.
    obs.n = 7
    // Give microtasks a chance to fire (the pre-fix path used
    // promise.finally, which would have deferred any leftover
    // bookkeeping a microtask).
    await Promise.resolve()
    assert.equal(runs, 1, 'leaked reaction did not fire on post-rejection mutation')
  })

  it('does not re-invoke condition after resolve (audit round-15 finding 2)', async () => {
    // Pre-fix: dispose was scheduled via `promise.finally(dispose)`,
    // a microtask after settle. Synchronous observable mutations in
    // that gap re-ran `condition`, with confusing failure modes if
    // `condition` threw on the later run. Fixed via a `resolved`
    // flag that short-circuits re-runs AND a synchronous dispose.
    const obs = store({ n: 0 })
    let runs = 0
    const p = autopromise(() => {
      runs += 1
      return obs.n >= 1 ? `hit@${obs.n}` : null
    })
    obs.n = 1            // triggers the resolving run
    const before = runs
    obs.n = 2            // would have re-invoked condition pre-fix
    obs.n = 3
    const after = runs
    assert.equal(after, before, 'no condition re-runs between resolve and dispose')
    const result = await p
    assert.equal(result, 'hit@1', 'first matching value wins')
  })

  it('promise.abort(reason) rejects the promise', async () => {
    const obs = store({ n: 0 })
    const p = autopromise(() => (obs.n >= 99 ? obs.n : null))
    p.abort(new Error('aborted'))
    await assert.rejects(p, /aborted/u)
  })
})
