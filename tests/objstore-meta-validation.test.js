// Unit tests for the objstore client's wire-metadata guard
// (`isObjectMeta`). The relay controls the `version` / `contentLength`
// integers on the `objstore-fetch-token` reply, the `objstore-put`
// broadcast, the `objstore-conflict` `current`, and the
// `workspace-subscribed` inventory snapshot — and the Ed25519 PUT
// signature does NOT cover the server-assigned `version`. So an
// unchecked non-finite / out-of-range value would flow into
// `noteVersion` and poison the per-incarnation rollback watermark:
//   - `version: Infinity` floors the watermark, so every later
//     LEGITIMATE fetch trips `assertFreshOrLater` → a permanent,
//     relay-induced fetch DoS for that resource;
//   - a finite-but-unsafe value (> 2^53-1) defeats the monotonic
//     `version < last.version` freshness comparison.
// `isObjectMeta` is the single choke point every watermark-feeding
// path routes through (broadcast, fetch-token, conflict, inventory),
// so this guard is the whole fix. The wire vector is reachable: a
// JSON literal like `1e999` parses to `Infinity` (asserted below).

import './_polyfills.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { __test__ } from '../client/sync/objstore.ts'

const { isObjectMeta } = __test__

// A well-formed wire metadata object. Field shapes mirror what the
// server emits via `objectMetaWire` (resourceTag/incarnation/
// contentHash/signature are base64url-ish strings; version and
// contentLength are non-negative integers).
function validMeta(overrides = {}) {
  return {
    resourceTag: 'r'.repeat(43),
    version: 3,
    incarnation: 'inc-abc',
    contentHash: 'h'.repeat(43),
    contentLength: 1024,
    signature: 's'.repeat(86),
    ...overrides,
  }
}

describe('objstore isObjectMeta wire-metadata guard', () => {
  it('accepts well-formed metadata (incl. the in-domain v0 / len0 edge)', () => {
    assert.equal(isObjectMeta(validMeta()), true)
    assert.equal(isObjectMeta(validMeta({ version: 0, contentLength: 0 })), true)
  })

  it('rejects a non-finite version (the `1e999` → Infinity wire vector)', () => {
    // The attack is reachable over the wire: `1e999` is a valid JSON
    // number literal that `JSON.parse` overflows to a non-finite
    // double, sailing past a bare `typeof === 'number'` check.
    assert.equal(JSON.parse('{"v":1e999}').v, Infinity)
    assert.equal(isObjectMeta(validMeta({ version: Infinity })), false)
    assert.equal(isObjectMeta(validMeta({ version: -Infinity })), false)
  })

  it('rejects a finite-but-unsafe version (> 2^53-1)', () => {
    assert.equal(isObjectMeta(validMeta({ version: 1e308 })), false)
    assert.equal(isObjectMeta(validMeta({ version: Number.MAX_SAFE_INTEGER + 1 })), false)
  })

  it('rejects negative / fractional / NaN version', () => {
    assert.equal(isObjectMeta(validMeta({ version: -1 })), false)
    assert.equal(isObjectMeta(validMeta({ version: 1.5 })), false)
    assert.equal(isObjectMeta(validMeta({ version: NaN })), false)
  })

  it('applies the same rigor to contentLength', () => {
    assert.equal(isObjectMeta(validMeta({ contentLength: Infinity })), false)
    assert.equal(isObjectMeta(validMeta({ contentLength: -1 })), false)
    assert.equal(isObjectMeta(validMeta({ contentLength: 2.5 })), false)
    assert.equal(isObjectMeta(validMeta({ contentLength: NaN })), false)
  })

  it('still rejects wrong-typed / missing fields and non-objects', () => {
    assert.equal(isObjectMeta(undefined), false)
    assert.equal(isObjectMeta(null), false)
    assert.equal(isObjectMeta(validMeta({ version: '3' })), false)
    assert.equal(isObjectMeta(validMeta({ resourceTag: 123 })), false)
    assert.equal(isObjectMeta({ ...validMeta(), signature: undefined }), false)
  })
})
