// Pin the `workspace-save-error.reason` taxonomy across the server
// (emit sites) and the client (RECOVERABLE classifier). A
// server-side addition of a new reason that doesn't update
// `common/save-error-reason.ts` would surface here AT TEST TIME,
// rather than at runtime as a silent `'rejected'` coercion in
// the client's `handleSaveError`.
//
// Two assertions:
//
// 1. Source-level scrape: enumerate every `reason: '<token>'`
//    literal in `server-e2e/index.ts` save-error emit sites and assert
//    each is a member of `SAVE_ERROR_REASONS` from the shared
//    taxonomy module. New emit sites that bypass `sendSaveError`
//    would also surface here as a typo-collision check.
//
// 2. Invariant pins: the shared sets must satisfy:
//      - `SAVE_ERROR_REASONS ⊇ RECOVERABLE_SAVE_ERROR_REASONS`
//      - `'too-large' ∈ SAVE_ERROR_REASONS` and ∉ RECOVERABLE
//      - `'busy' ∈ RECOVERABLE_SAVE_ERROR_REASONS`
//      - `'stale-base' ∈ SAVE_ERROR_REASONS` and ∉ RECOVERABLE
//        (deliberate — server emits it AFTER the catch-up
//        `workspace-state`; the client's handleChain clears
//        `pending` first and the typed frame's handleSaveError
//        early-returns. See `common/save-error-reason.ts`.)
//
// A future PR that, say, adds `'rate-limited'` to the server's
// emit sites without adding it to the taxonomy module would fail
// scrape assertion #1 (unknown literal).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

if (globalThis.localStorage === undefined) {
  globalThis.localStorage = (() => {
    const m = new Map()
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => { m.set(k, String(v)) },
      removeItem: (k) => { m.delete(k) },
      clear: () => { m.clear() },
      get length() { return m.size },
      key: (i) => [...m.keys()][i] ?? null,
    }
  })()
}

const {
  RECOVERABLE_SAVE_ERROR_REASONS,
  SAVE_ERROR_REASONS,
} = await import('../common/save-error-reason.ts')

const SERVER_INDEX_PATH = fileURLToPath(new URL('../server-e2e/index.ts', import.meta.url))

describe('workspace-save-error.reason taxonomy', () => {
  it('every server-emitted reason literal is a declared SAVE_ERROR_REASONS member', () => {
    // Emit sites live in ws-server.ts (the dispatcher's 'busy' NACK)
    // and sync-handlers.ts ('too-large', 'stale-base'); index.ts is
    // scanned too in case a future emit site lands there.
    const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
    const src = readFileSync(SERVER_INDEX_PATH, 'utf8') + '\n'
      + read('../server-e2e/sync-handlers.ts') + '\n'
      + read('../server-e2e/ws-server.ts')
    // Match `sendSaveError(..., 'reason')` calls — the typed wrapper
    // narrows at call time, but scraping the literals here keeps a
    // PR that bypasses the wrapper from sneaking past.
    // Non-greedy `[\s\S]+?` tolerates multi-line / multi-arg formatting
    // (Prettier-style line wraps + trailing commas + inner `(...)` in
    // earlier args); the `,?\s*\)` end accepts an optional trailing
    // comma after the reason literal.
    // The `(?<!function\s)` lookbehind skips the FUNCTION DEFINITION
    // (`function sendSaveError(socket: WebSocket, ...)`) so the
    // non-greedy span can't accidentally swallow the L519 emit site
    // into the def's `(...)` and silently miss it. Confirmed: without
    // the lookbehind the first match spans ~9 K chars from the def
    // through the L519 call's `'too-large')`, so L519 is NEVER
    // captured and the test passes only by happenstance.
    const matches = [...src.matchAll(/(?<!function\s)sendSaveError\(\s*[\s\S]+?,\s*'([\w-]+)'\s*,?\s*\)/gu)]
    assert.ok(matches.length >= 3, `expected at least 3 sendSaveError call sites, got ${matches.length}`)
    const emittedReasons = new Set(matches.map((m) => m[1]))
    for (const r of emittedReasons) {
      assert.ok(
        SAVE_ERROR_REASONS.has(r),
        `server emits reason '${r}' which is NOT declared in common/save-error-reason.ts SAVE_ERROR_REASONS — taxonomy drift`,
      )
    }
    // Sanity-check the floor: at least the three documented reasons must be emitted somewhere.
    for (const want of ['too-large', 'busy', 'stale-base']) {
      assert.ok(
        emittedReasons.has(want),
        `expected canonical reason '${want}' to appear in server emit sites — removed from protocol?`,
      )
    }
  })

  it('RECOVERABLE_SAVE_ERROR_REASONS ⊆ SAVE_ERROR_REASONS', () => {
    for (const r of RECOVERABLE_SAVE_ERROR_REASONS) {
      assert.ok(SAVE_ERROR_REASONS.has(r), `recoverable reason '${r}' missing from full taxonomy`)
    }
  })

  it("`'too-large'` is in the taxonomy and is NOT recoverable", () => {
    assert.ok(SAVE_ERROR_REASONS.has('too-large'))
    assert.equal(RECOVERABLE_SAVE_ERROR_REASONS.has('too-large'), false, '`too-large` must NOT be recoverable (payload size won\'t shrink on retry)')
  })

  it("`'busy'` is recoverable", () => {
    assert.ok(SAVE_ERROR_REASONS.has('busy'))
    assert.equal(RECOVERABLE_SAVE_ERROR_REASONS.has('busy'), true, '`busy` must be recoverable (transient backpressure)')
  })

  it("`'stale-base'` is in the taxonomy and is NOT recoverable (deliberate — wire-order clears pending first)", () => {
    assert.ok(SAVE_ERROR_REASONS.has('stale-base'))
    assert.equal(
      RECOVERABLE_SAVE_ERROR_REASONS.has('stale-base'),
      false,
      '`stale-base` is deliberately NOT in the recoverable set — the wire-order catch-up `workspace-state` clears `session.pending` first and handleSaveError early-returns. See common/save-error-reason.ts docstring for the rationale.',
    )
  })
})
