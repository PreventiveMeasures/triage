// `retryOnContendedImpl` — unit pins for the bounded retry
// helper that wraps `put` / `deleteByName` in client/objstore.ts.
// Exported from client/objstore.ts as a test seam so we can pin
// the contract (retry count, exhaustion behavior, immediate-pass-
// through for non-contended results) without spinning up a
// WebSocket + REST server. The helper has a `sleep` injection
// point so the test runs instantly regardless of the production
// backoff schedule (100–200, 200–400, 400–800 ms jittered).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { retryOnContendedImpl } from '../client/objstore.ts'

// Injected sleep that records the requested durations and resolves
// immediately. Lets tests assert the backoff schedule.
function instantSleep() {
  const calls = []
  return {
    calls,
    // eslint-disable-next-line require-await
    sleep: async (ms) => { calls.push(ms) },
  }
}

describe('retryOnContendedImpl', () => {
  it('passes through non-contended results immediately (no retry)', async () => {
    const { sleep, calls } = instantSleep()
    const result = await retryOnContendedImpl(
      // eslint-disable-next-line require-await
      async () => ({ ok: true, meta: { version: 1, contentLength: 4 } }),
      sleep,
    )
    assert.deepEqual(result, { ok: true, meta: { version: 1, contentLength: 4 } })
    assert.deepEqual(calls, [], 'no sleeps when first attempt succeeded')
  })

  it('passes through other failure reasons without retry (e.g. conflict)', async () => {
    const { sleep, calls } = instantSleep()
    const result = await retryOnContendedImpl(
      // eslint-disable-next-line require-await
      async () => ({ ok: false, reason: 'conflict', currentVersion: 5 }),
      sleep,
    )
    assert.deepEqual(result, { ok: false, reason: 'conflict', currentVersion: 5 })
    assert.deepEqual(calls, [], 'no sleeps for non-contended failures')
  })

  it('retries on contended; succeeds on second attempt', async () => {
    let attempt = 0
    const { sleep, calls } = instantSleep()
    const result = await retryOnContendedImpl(
      // eslint-disable-next-line require-await
      async () => {
        attempt++
        if (attempt === 1) return { ok: false, reason: 'contended' }
        return { ok: true, meta: { version: 1, contentLength: 4 } }
      },
      sleep,
    )
    assert.equal(result.ok, true)
    assert.equal(attempt, 2, 'second attempt won')
    assert.equal(calls.length, 1, 'one sleep before the retry')
    // First backoff: 100..200 ms. Verify the band; jitter is random
    // so we can't assert exact ms.
    assert.ok(calls[0] >= 100 && calls[0] <= 200, `first sleep ${calls[0]} ms outside [100, 200]`)
  })

  it('exhausts 3 retries; surfaces contended to caller', async () => {
    let attempt = 0
    const { sleep, calls } = instantSleep()
    const result = await retryOnContendedImpl(
      // eslint-disable-next-line require-await
      async () => {
        attempt++
        return { ok: false, reason: 'contended' }
      },
      sleep,
    )
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'contended')
    assert.equal(attempt, 4, 'initial + 3 retries')
    // Sleep schedule: 100–200, 200–400, 400–800 ms (jittered).
    assert.equal(calls.length, 3)
    assert.ok(calls[0] >= 100 && calls[0] <= 200, `attempt-1 sleep ${calls[0]} ms`)
    assert.ok(calls[1] >= 200 && calls[1] <= 400, `attempt-2 sleep ${calls[1]} ms`)
    assert.ok(calls[2] >= 400 && calls[2] <= 800, `attempt-3 sleep ${calls[2]} ms`)
  })

  it('succeeds on the 4th and final allowed attempt', async () => {
    let attempt = 0
    const { sleep } = instantSleep()
    const result = await retryOnContendedImpl(
      // eslint-disable-next-line require-await
      async () => {
        attempt++
        if (attempt < 4) return { ok: false, reason: 'contended' }
        return { ok: true, deletedVersion: 3 }
      },
      sleep,
    )
    assert.equal(result.ok, true)
    assert.equal(attempt, 4, 'fourth attempt is the last one before propagating')
  })

  it('handles different contended result shapes (delete vs put)', async () => {
    // The helper checks `ok === false && reason === 'contended'`,
    // not the specific result type — so both put and delete
    // contended shapes get retried identically.
    let attempt = 0
    const { sleep } = instantSleep()
    const result = await retryOnContendedImpl(
      // eslint-disable-next-line require-await
      async () => {
        attempt++
        if (attempt < 3) return { ok: false, reason: 'contended' }
        return { ok: false, reason: 'not-found' }
      },
      sleep,
    )
    assert.deepEqual(result, { ok: false, reason: 'not-found' })
    assert.equal(attempt, 3)
  })
})
