// `ui/view/format.js` — `formatModifiedAt` / `formatTimestamp` turn the
// synced report / bundle / triage "last modified" epoch-ms into the
// strings the UI shows. This pins the null-suppression contract (callers
// drop the row on 0 / missing / future-NaN) and the coarse relative
// buckets, since the sidebar tooltips and the bundle Overview rely on them.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

// format.js → frontend-global.js throws at module load when the
// `@rray/frontend` slot isn't installed; neither formatter touches it, so
// a bare stub lets the import chain evaluate (mirrors comment-refs.test.js).
const slotKey = Symbol.for('@rray/frontend')
if (!globalThis[slotKey]) {
  globalThis[slotKey] = {
    LitElement: class {}, html: () => null, nothing: null, render: () => null,
    unsafeCSS: () => null, StateElement: class {}, classMap: () => null,
    repeat: () => null, styleMap: () => null,
  }
}

const { formatModifiedAt, formatTimestamp } = await import('../ui/view/format.js')

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

describe('formatModifiedAt', () => {
  it('returns null for missing / unknown / non-finite values', () => {
    // 0 is the relay's "unknown" sentinel; callers suppress the row.
    for (const v of [undefined, null, 0, -1, NaN, Infinity, -Infinity, '5', {}]) {
      assert.equal(formatModifiedAt(v), null, `expected null for ${String(v)}`)
    }
  })

  it('reads a fresh / future timestamp as "just now"', () => {
    assert.equal(formatModifiedAt(Date.now() - 1_000), 'just now')
    // Clock skew (relay / uploader ahead of us) must not produce a
    // negative age — it collapses to "just now".
    assert.equal(formatModifiedAt(Date.now() + 5 * MIN), 'just now')
  })

  it('renders coarse relative buckets for minutes / hours / days', () => {
    assert.equal(formatModifiedAt(Date.now() - 5 * MIN), '5 min ago')
    assert.equal(formatModifiedAt(Date.now() - 3 * HOUR), '3 hr ago')
    assert.equal(formatModifiedAt(Date.now() - 1 * DAY), '1 day ago')
    assert.equal(formatModifiedAt(Date.now() - 2 * DAY), '2 days ago')
  })

  it('falls back to a locale date past a week', () => {
    const out = formatModifiedAt(Date.now() - 30 * DAY)
    assert.equal(typeof out, 'string')
    // Not a relative phrase — the older-than-a-week branch is an absolute
    // date, so it must not read as "N days ago" / "just now".
    assert.ok(!/ago|just now/u.test(out), `expected an absolute date, got ${out}`)
  })
})

describe('formatTimestamp', () => {
  it('returns null for missing / unknown values', () => {
    for (const v of [undefined, null, 0, -1, NaN, '5']) {
      assert.equal(formatTimestamp(v), null, `expected null for ${String(v)}`)
    }
  })

  it('returns a non-empty locale string for a valid timestamp', () => {
    const out = formatTimestamp(Date.UTC(2026, 0, 2, 3, 4, 5))
    assert.equal(typeof out, 'string')
    assert.ok(out.length > 0)
  })
})
