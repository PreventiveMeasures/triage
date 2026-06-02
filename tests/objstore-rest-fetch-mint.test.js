// E2E tests for the REST fetch-mint endpoint: POST /api/objstore/{tag}/{res}.
//
// Mirrors the WS `objstore-fetch` → `objstore-fetch-token` handshake but
// over a single REST round-trip, independent of the SSE session: the
// workspace signs `[fetch-rest domain, tag, res, ts]` into the JSON body,
// the server verifies it (the workspaceTag IS the Ed25519 pubkey),
// enforces a freshness window + replay dedup in place of the connection
// nonce, and returns `{ ...meta, urlPath, token, expiresAt }`. The caller
// then drives the UNCHANGED bearer-token GET path.
//
// Boots a real server and uploads via the production objstore session so
// the live row + content-addressed blob exist for the mint to point at.

import './_polyfills.js'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { after, before, describe, it } from 'node:test'

import { deriveObjstoreKeys } from '../client/sync/objstore.ts'
import { computeContentHash, signObjstoreFetch, signObjstoreFetchRest } from '../client/sync/objstore-crypto.ts'
import { computeResourceTag } from '../client/sync/objstore-content-crypto.ts'
import { createObjstoreSession } from './_objstore-session.js'
import { bootServer } from './_helpers.js'

describe('objstore REST fetch-mint (POST /api/objstore/{tag}/{res})', () => {
  let server, serverUrl, httpOrigin
  before(async () => { server = await bootServer(); serverUrl = server.serverUrl; httpOrigin = server.httpOrigin })
  after(async () => { if (server) await server.teardown() })

  function makeKeys() {
    return deriveObjstoreKeys(crypto.getRandomValues(new Uint8Array(32)).toBase64(), crypto.randomUUID())
  }
  function mintPost(tag, res, body) {
    return fetch(`${httpOrigin}/api/objstore/${tag}/${res}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }
  // Upload one object via the production session so a live row exists.
  // Returns the workspace keys + the object's resourceTag + the put meta +
  // the still-open session (caller closes it).
  async function seedObject(fileName, content) {
    const keys = await makeKeys()
    const session = await createObjstoreSession({ serverUrl, httpOrigin, keys })
    const put = await session.put({ fileName, content, prev: null })
    assert.equal(put.ok, true, `seed put failed: ${JSON.stringify(put)}`)
    const res = await computeResourceTag(keys.tagKey, fileName)
    return { keys, res, put, session }
  }

  it('mints a GET token for a live object; the token fetches its bytes', async () => {
    const content = Buffer.from('opaque-ciphertext-stand-in-bytes-1234567890')
    const { keys, res, put, session } = await seedObject('mint-me.json', content)
    try {
      const tag = keys.workspaceTag
      const ts = Date.now()
      const signature = await signObjstoreFetchRest(keys.signingKey, tag, res, ts)
      const r = await mintPost(tag, res, { ts, signature })
      assert.equal(r.status, 200, 'mint should succeed for a live object')
      const j = await r.json()
      assert.equal(j.urlPath, `/api/objstore/${tag}/${res}`)
      assert.equal(j.resourceTag, res)
      assert.equal(typeof j.token, 'string')
      assert.equal(typeof j.expiresAt, 'number')
      assert.equal(j.version, put.meta.version)
      assert.equal(j.incarnation, put.meta.incarnation)
      assert.equal(j.contentLength, put.meta.contentLength)
      // The minted token drives the UNCHANGED GET path (Bearer header). The
      // stored blob is ciphertext, so verify by hash rather than plaintext.
      const get = await fetch(`${httpOrigin}${j.urlPath}`, { headers: { authorization: `Bearer ${j.token}` } })
      assert.equal(get.status, 200)
      const bytes = Buffer.from(await get.arrayBuffer())
      assert.equal(bytes.length, j.contentLength, 'GET returns the full stored blob')
      assert.equal(await computeContentHash(bytes), j.contentHash, 'GET bytes hash to the minted contentHash')
      // The minted token is GET-only (op='get'): presenting it to a PUT is
      // rejected, so it can't be coerced into a write capability.
      const putWithGetToken = await fetch(`${httpOrigin}${j.urlPath}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${j.token}`, 'content-type': 'application/octet-stream', 'content-length': '1' },
        body: Buffer.from('x'),
      })
      assert.equal(putWithGetToken.status, 405, 'a mint get-token must not authorize a PUT')
    } finally { session.close() }
  })

  it('rejects a replayed signature (same ts) with 401', async () => {
    const { keys, res, session } = await seedObject('replay.json', Buffer.from('payload'))
    try {
      const tag = keys.workspaceTag
      const ts = Date.now()
      const signature = await signObjstoreFetchRest(keys.signingKey, tag, res, ts)
      assert.equal((await mintPost(tag, res, { ts, signature })).status, 200, 'first mint ok')
      assert.equal((await mintPost(tag, res, { ts, signature })).status, 401, 'replay of the same signature is rejected')
    } finally { session.close() }
  })

  it('a re-signed request with a fresh ts is accepted after the first (retry path)', async () => {
    const { keys, res, session } = await seedObject('resign.json', Buffer.from('payload'))
    try {
      const tag = keys.workspaceTag
      const ts1 = Date.now()
      const sig1 = await signObjstoreFetchRest(keys.signingKey, tag, res, ts1)
      assert.equal((await mintPost(tag, res, { ts: ts1, signature: sig1 })).status, 200)
      // A distinct ts ⇒ distinct signature ⇒ accepted (this is how a client
      // must retry — re-sign, don't resend).
      const ts2 = ts1 + 1
      const sig2 = await signObjstoreFetchRest(keys.signingKey, tag, res, ts2)
      assert.equal((await mintPost(tag, res, { ts: ts2, signature: sig2 })).status, 200)
    } finally { session.close() }
  })

  it('rejects a stale timestamp (outside the skew window) with 401', async () => {
    const keys = await makeKeys()
    const tag = keys.workspaceTag
    const res = await computeResourceTag(keys.tagKey, 'stale.json')
    const ts = Date.now() - 10 * 60 * 1000 // 10 min ago, well past the 60s window
    const signature = await signObjstoreFetchRest(keys.signingKey, tag, res, ts)
    assert.equal((await mintPost(tag, res, { ts, signature })).status, 401)
  })

  it('rejects a signature from a different workspace key with 401', async () => {
    const keys = await makeKeys()
    const other = await makeKeys()
    const tag = keys.workspaceTag
    const res = await computeResourceTag(keys.tagKey, 'wrongkey.json')
    const ts = Date.now()
    // A structurally valid Ed25519 signature, but by the WRONG signer — it
    // won't verify against `tag` (which is the victim's pubkey).
    const signature = await signObjstoreFetchRest(other.signingKey, tag, res, ts)
    assert.equal((await mintPost(tag, res, { ts, signature })).status, 401)
  })

  it('rejects a WS-fetch signature presented to the REST mint (domain separation) with 401', async () => {
    const keys = await makeKeys()
    const tag = keys.workspaceTag
    const res = await computeResourceTag(keys.tagKey, 'domainsep.json')
    const ts = Date.now()
    // Sign under the WS fetch domain (nonce slot = the same ts string); the
    // REST mint canonicalizes under a DISTINCT domain, so it can't verify.
    const wsSig = await signObjstoreFetch(keys.signingKey, tag, res, String(ts))
    assert.equal((await mintPost(tag, res, { ts, signature: wsSig })).status, 401)
  })

  it('returns 404 for a validly-signed request against a resource with no live row', async () => {
    const keys = await makeKeys()
    const tag = keys.workspaceTag
    const res = await computeResourceTag(keys.tagKey, 'never-uploaded.json')
    const ts = Date.now()
    const signature = await signObjstoreFetchRest(keys.signingKey, tag, res, ts)
    assert.equal((await mintPost(tag, res, { ts, signature })).status, 404)
  })

  it('rejects a malformed body with 400', async () => {
    const keys = await makeKeys()
    const tag = keys.workspaceTag
    const res = await computeResourceTag(keys.tagKey, 'malformed.json')
    assert.equal((await mintPost(tag, res, { ts: 'not-a-number', signature: 'x' })).status, 400)
    assert.equal((await mintPost(tag, res, {})).status, 400)
  })

  it('rejects an over-large body with 400', async () => {
    const keys = await makeKeys()
    const tag = keys.workspaceTag
    const res = await computeResourceTag(keys.tagKey, 'huge.json')
    // JSON body well past the 4096-byte cap → readJsonBody returns null → 400.
    assert.equal((await mintPost(tag, res, { ts: Date.now(), signature: 'A'.repeat(5000) })).status, 400)
  })
})
