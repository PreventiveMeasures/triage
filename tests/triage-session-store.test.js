// `client/sync/triage-session-store.ts` — the persistence-degraded
// latch and its listener registry. Pure (a Set + a boolean), no DOM.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

await import('./_polyfills.js')

describe('triage-session-store: onPersistenceDegraded', () => {
  it('two subscriptions of the same callback are independent (no Set dedup)', async () => {
    // Fresh module instance so the module-global latch + listener Set
    // start clean for this test.
    const stamp = `${Date.now()}-${Math.random()}`
    const mod = await import(`../client/sync/triage-session-store.ts?dedup-${stamp}`)
    const calls = []
    const cb = (d) => calls.push(d)
    const un1 = mod.onPersistenceDegraded(cb)
    const un2 = mod.onPersistenceDegraded(cb)
    // Let the two on-subscribe microtasks fire (current latch = false).
    await Promise.resolve()
    // Unsubscribe only the FIRST registration. Pre-fix both shared one
    // Set entry, so this removed the listener for BOTH; post-fix each
    // subscription is a distinct wrapper, so the second still fires.
    un1()
    mod.setPersistenceDegraded(true) // off → on transition
    assert.ok(
      calls.includes(true),
      'the second subscription still fires after the first unsubscribes',
    )
    un2()
  })
})
