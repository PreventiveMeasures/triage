// Pin the v1 canonical formulas so any change is conscious.
// Touching the canonical bytes / domain string / AAD shape here
// means a v2 bump, not an in-place edit — `client/sync-crypto.js`
// has the implementation, this file is the contract.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Buffer } from 'node:buffer'
import { encodeUtf8 } from '../common/utf8.js'

// Polyfill `localStorage` so the client modules import cleanly in
// Node — sync-crypto itself doesn't read it, but its module graph
// does at load time.
if (typeof globalThis.localStorage === 'undefined') {
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

const { computeRevisionId, buildAad } = await import('../client/sync-crypto.js')

async function sha256b64url(str) {
  const digest = await crypto.subtle.digest('SHA-256', encodeUtf8(str))
  return Buffer.from(new Uint8Array(digest)).toString('base64url')
}

describe('triage-sync v1 canonical formulas (golden)', () => {
  // Re-build the canonical save payload in the test by hand, then
  // assert computeRevisionId produces the matching hash. If
  // canonicalSavePayload in sync-crypto.js drifts (field order,
  // separator, domain string, what's signed, keyframe encoding),
  // this fails — and the signal is "bump to v2", not "edit this
  // expectation".
  it('save canonical: <domain>\\n<pk>\\n<base>\\n<keyframe>\\n<nonce>\\n<ciphertext>', async () => {
    const input = {
      publicKeyB64: 'pk-fixture',
      base: 'base-fixture',
      keyframe: false,
      nonceB64: 'nonce-fixture',
      ciphertextB64: 'ct-fixture',
    }
    const expected = await sha256b64url([
      'deepview-triage-sync.v1.save',
      input.publicKeyB64,
      input.base,
      // keyframe = false → empty
      '',
      input.nonceB64,
      input.ciphertextB64,
    ].join('\n'))
    assert.equal(await computeRevisionId(input), expected)
  })

  it('save canonical: null base encodes as "" and keyframe=true encodes as "1"', async () => {
    const input = {
      publicKeyB64: 'pk',
      base: null,
      keyframe: true,
      nonceB64: 'n',
      ciphertextB64: 'c',
    }
    const expected = await sha256b64url(
      ['deepview-triage-sync.v1.save', 'pk', '', '1', 'n', 'c'].join('\n'),
    )
    assert.equal(await computeRevisionId(input), expected)
  })

  it('AAD: `<workspaceTag>|<base>` with empty string for null base', () => {
    assert.deepEqual(buildAad('TAG', null), encodeUtf8('TAG|'))
    assert.deepEqual(buildAad('TAG', 'rev-id'), encodeUtf8('TAG|rev-id'))
  })
})
