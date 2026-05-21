// Unit tests for the `validateObjstoreUrlPath` URL-injection guard
// added to client/sync/objstore.ts. The function must reject any
// server-supplied urlPath that would redirect fetch() to a different
// origin than deps.httpOrigin — the key attack vector is a compromised
// relay returning `urlPath: '@attacker.host/...'` which, when
// concatenated with httpOrigin, makes WHATWG URL parsing treat the
// real host as userinfo and send the bearer token cross-origin.

import './_polyfills.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { __test__ } from '../client/sync/objstore.ts'
const { validateObjstoreUrlPath } = __test__

const ORIGIN = 'https://relay.example.com'

describe('validateObjstoreUrlPath', () => {
  it('accepts a well-formed path and returns the full URL', () => {
    const result = validateObjstoreUrlPath('/api/objstore/abc123/def456', ORIGIN)
    assert.equal(result, 'https://relay.example.com/api/objstore/abc123/def456')
  })

  it('accepts paths with hyphens and underscores in both segments', () => {
    const result = validateObjstoreUrlPath('/api/objstore/A-B_C/x-y_z', ORIGIN)
    assert.equal(result, 'https://relay.example.com/api/objstore/A-B_C/x-y_z')
  })

  it('rejects userinfo injection (@attacker.host/...) — the primary string-concat attack vector', () => {
    assert.throws(
      () => validateObjstoreUrlPath('@attacker.host/api/objstore/a/b', ORIGIN),
      /urlPath rejected/u,
    )
  })

  it('rejects protocol-relative URL (//attacker.host/...)', () => {
    assert.throws(
      () => validateObjstoreUrlPath('//attacker.host/api/objstore/a/b', ORIGIN),
      /urlPath rejected/u,
    )
  })

  it('rejects absolute URL pointing to a different origin', () => {
    assert.throws(
      () => validateObjstoreUrlPath('http://attacker.host/api/objstore/a/b', ORIGIN),
      /urlPath rejected/u,
    )
  })

  it('rejects empty string', () => {
    assert.throws(
      () => validateObjstoreUrlPath('', ORIGIN),
      /urlPath rejected/u,
    )
  })

  it('rejects path missing the leading slash', () => {
    assert.throws(
      () => validateObjstoreUrlPath('api/objstore/abc/def', ORIGIN),
      /urlPath rejected/u,
    )
  })

  it('rejects path with too few segments', () => {
    assert.throws(
      () => validateObjstoreUrlPath('/api/objstore/abc', ORIGIN),
      /urlPath rejected/u,
    )
  })

  it('rejects path with extra trailing segments', () => {
    assert.throws(
      () => validateObjstoreUrlPath('/api/objstore/abc/def/ghi', ORIGIN),
      /urlPath rejected/u,
    )
  })

  it('rejects path with a query string', () => {
    assert.throws(
      () => validateObjstoreUrlPath('/api/objstore/abc/def?x=1', ORIGIN),
      /urlPath rejected/u,
    )
  })

  it('rejects path with a fragment', () => {
    assert.throws(
      () => validateObjstoreUrlPath('/api/objstore/abc/def#frag', ORIGIN),
      /urlPath rejected/u,
    )
  })

  it('rejects percent-encoded characters in the path segments', () => {
    assert.throws(
      () => validateObjstoreUrlPath('/api/objstore/abc/de%66', ORIGIN),
      /urlPath rejected/u,
    )
  })

  it('normalises a non-canonical httpOrigin (uppercase scheme) without rejecting a valid path', () => {
    // WHATWG URL lowercases the scheme, so 'HTTPS://relay.example.com'
    // and 'https://relay.example.com' produce the same .origin. A valid
    // path must not be rejected due to scheme case alone.
    assert.doesNotThrow(() => validateObjstoreUrlPath('/api/objstore/a/b', 'HTTPS://relay.example.com'))
  })

  it('rejects a path that resolves to a different origin (origin mismatch gate)', () => {
    // The regex prevents all realistic injection strings, so the origin
    // check is defense-in-depth. Simulate what it catches by calling the
    // underlying WHATWG URL parser directly to confirm the error path is
    // reachable: a path that somehow produced a different origin would
    // trigger the mismatch throw. We verify the error message is correct
    // by monkey-patching URL for this single call.
    const realURL = globalThis.URL
    let calls = 0
    try {
      globalThis.URL = class extends realURL {
        constructor(input, base) {
          super(input, base)
          // On the second URL() call (the urlPath parse), override origin
          if (++calls === 2) Object.defineProperty(this, 'origin', { value: 'https://attacker.example.com' })
        }
      }
      assert.throws(
        () => validateObjstoreUrlPath('/api/objstore/a/b', 'https://relay.example.com'),
        /urlPath origin mismatch/u,
      )
    } finally {
      globalThis.URL = realURL
    }
  })
})
