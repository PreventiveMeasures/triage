// Unit tests for the REST fetch-mint anti-replay guard
// (e2e-server/objstore/fetch-mint-guard.ts). Pure logic — `now` is injected
// so freshness/expiry are deterministic without timers.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createFetchMintGuard } from '../e2e-server/objstore/fetch-mint-guard.ts'

describe('fetch-mint-guard', () => {
  it('admits a fresh signature once, then rejects the replay', () => {
    const g = createFetchMintGuard({ windowMs: 1000 })
    const now = 10_000
    assert.equal(g.admit('sigA', now, now), 'ok')
    assert.equal(g.admit('sigA', now, now), 'replay')
    assert.equal(g.admit('sigB', now, now), 'ok', 'a different signature is independent')
  })

  it('rejects a stale or future timestamp outside the window; accepts the edges', () => {
    const g = createFetchMintGuard({ windowMs: 1000 })
    const now = 100_000
    assert.equal(g.admit('old', now - 1001, now), 'stale')
    assert.equal(g.admit('future', now + 1001, now), 'stale')
    assert.equal(g.admit('nan', NaN, now), 'stale')
    assert.equal(g.admit('edge-past', now - 1000, now), 'ok')
    assert.equal(g.admit('edge-future', now + 1000, now), 'ok')
  })

  it('re-admits a signature after its window has passed (entry expired)', () => {
    const g = createFetchMintGuard({ windowMs: 1000 })
    assert.equal(g.admit('sig', 5000, 5000), 'ok')
    // `now` advanced past the entry's expiry (5000 + 1000); use a fresh ts.
    assert.equal(g.admit('sig', 6500, 6500), 'ok')
  })

  it('front-prunes expired entries so the set stays bounded', () => {
    const g = createFetchMintGuard({ windowMs: 1000 })
    for (let i = 0; i < 50; i++) g.admit(`s${i}`, 1000 + i, 1000 + i)
    assert.ok(g.size() <= 50)
    // Advance past every entry's expiry; the next admit prunes them all.
    assert.equal(g.admit('later', 10_000, 10_000), 'ok')
    assert.equal(g.size(), 1, 'all earlier (expired) entries pruned')
  })

  it('evicts the oldest beyond maxEntries (flood backstop)', () => {
    // Huge window so nothing expires — exercise the size cap alone.
    const g = createFetchMintGuard({ windowMs: 1_000_000, maxEntries: 3 })
    const now = 1000
    for (const s of ['a', 'b', 'c', 'd', 'e']) g.admit(s, now, now)
    assert.equal(g.size(), 3, 'capped at maxEntries')
    // 'a' and 'b' were evicted as oldest, so re-admitting 'a' is treated as new.
    assert.equal(g.admit('a', now, now), 'ok')
  })
})
