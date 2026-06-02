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

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { deriveObjstoreKeys } from '../client/sync/objstore.ts'
import { computeContentHash, signObjstoreDelete, signObjstoreDeleteRest, signObjstoreFetch, signObjstoreFetchRest, signObjstorePut, signObjstorePutBeginRest } from '../client/sync/objstore-crypto.ts'
import { computeResourceTag } from '../client/sync/objstore-content-crypto.ts'
import { createObjstoreSession } from './_objstore-session.js'
import { bootServer } from './_helpers.js'

describe('objstore REST mint (POST /api/objstore/{tag}/{res}; op=fetch|put|delete)', () => {
  let httpOrigin, server, serverUrl
  before(async () => { server = await bootServer(); serverUrl = server.serverUrl; httpOrigin = server.httpOrigin })
  after(async () => { if (server) await server.teardown() })

  function makeKeys() {
    return deriveObjstoreKeys(crypto.getRandomValues(new Uint8Array(32)).toBase64(), crypto.randomUUID())
  }
  // Defaults the body's `op` to 'fetch' (this suite's op); a caller can
  // override via the body. The server requires `op` to route the mint.
  function mintPost(tag, res, body) {
    return fetch(`${httpOrigin}/api/objstore/${tag}/${res}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'fetch', ...body }),
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

  it('rejects an unknown op with 400', async () => {
    const keys = await makeKeys()
    const tag = keys.workspaceTag
    const res = await computeResourceTag(keys.tagKey, 'unknownop.json')
    assert.equal((await mintPost(tag, res, { op: 'bogus', ts: Date.now(), signature: 'x' })).status, 400)
  })

  // ---- op:'put' (put-begin mint) ----

  // Sign + POST a put-begin mint for `bytes` (with optional prev). Returns
  // the fetch Response. `contentHash`/`expectedLength` derive from `bytes`.
  async function putBeginMint(keys, tag, res, bytes, { prevVersion = null, prevIncarnation = null } = {}) {
    const contentHash = await computeContentHash(bytes)
    const ts = Date.now()
    const fields = { workspaceTag: tag, resourceTag: res, prevVersion, prevIncarnation, expectedLength: bytes.length, contentHash }
    const signature = await signObjstorePutBeginRest(keys.signingKey, fields, ts)
    return mintPost(tag, res, { op: 'put', ts, signature, prevVersion, prevIncarnation, expectedLength: bytes.length, contentHash })
  }

  it('put-begin mint: POST op=put → token → REST PUT commits, then round-trips', async () => {
    const keys = await makeKeys()
    const tag = keys.workspaceTag
    const res = await computeResourceTag(keys.tagKey, 'rest-put.json')
    const bytes = Buffer.from('opaque-ciphertext-stand-in-for-rest-put-0001')
    const begin = await putBeginMint(keys, tag, res, bytes)
    assert.equal(begin.status, 200, 'put-begin mint should succeed for a new object')
    const j = await begin.json()
    assert.equal(j.urlPath, `/api/objstore/${tag}/${res}`)
    assert.equal(typeof j.token, 'string')
    assert.equal(typeof j.stagingId, 'string')
    // Commit the bytes with the minted put-token (the UNCHANGED PUT path).
    const put = await fetch(`${httpOrigin}${j.urlPath}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${j.token}`, 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) },
      body: bytes,
    })
    if (put.status !== 200) assert.fail(`commit should succeed, got ${put.status}: ${await put.text().catch(() => '')}`)
    const ack = await put.json()
    assert.equal(ack.version, 1)
    assert.equal(ack.contentHash, await computeContentHash(bytes))
    // Read it back via a fetch-mint get-token.
    const fmTs = Date.now()
    const fm = await mintPost(tag, res, { op: 'fetch', ts: fmTs, signature: await signObjstoreFetchRest(keys.signingKey, tag, res, fmTs) })
    assert.equal(fm.status, 200)
    const fmJ = await fm.json()
    const get = await fetch(`${httpOrigin}${fmJ.urlPath}`, { headers: { authorization: `Bearer ${fmJ.token}` } })
    assert.equal(get.status, 200)
    assert.equal(Buffer.from(await get.arrayBuffer()).toString('utf8'), bytes.toString('utf8'))
  })

  it('put-begin rejects a replayed signature with 401', async () => {
    const keys = await makeKeys()
    const tag = keys.workspaceTag
    const res = await computeResourceTag(keys.tagKey, 'rest-put-replay.json')
    const bytes = Buffer.from('replay-bytes')
    const contentHash = await computeContentHash(bytes)
    const ts = Date.now()
    const fields = { workspaceTag: tag, resourceTag: res, prevVersion: null, prevIncarnation: null, expectedLength: bytes.length, contentHash }
    const signature = await signObjstorePutBeginRest(keys.signingKey, fields, ts)
    const body = { op: 'put', ts, signature, prevVersion: null, prevIncarnation: null, expectedLength: bytes.length, contentHash }
    assert.equal((await mintPost(tag, res, body)).status, 200)
    assert.equal((await mintPost(tag, res, body)).status, 401, 'replayed put-begin signature rejected')
  })

  it('put-begin rejects a signature from a different workspace key with 401', async () => {
    const keys = await makeKeys()
    const other = await makeKeys()
    const tag = keys.workspaceTag
    const res = await computeResourceTag(keys.tagKey, 'rest-put-wrongkey.json')
    const bytes = Buffer.from('x')
    const contentHash = await computeContentHash(bytes)
    const ts = Date.now()
    const fields = { workspaceTag: tag, resourceTag: res, prevVersion: null, prevIncarnation: null, expectedLength: bytes.length, contentHash }
    const signature = await signObjstorePutBeginRest(other.signingKey, fields, ts)
    assert.equal((await mintPost(tag, res, { op: 'put', ts, signature, prevVersion: null, prevIncarnation: null, expectedLength: bytes.length, contentHash })).status, 401)
  })

  it('put-begin rejects a WS put signature presented to the mint (domain separation) with 401', async () => {
    const keys = await makeKeys()
    const tag = keys.workspaceTag
    const res = await computeResourceTag(keys.tagKey, 'rest-put-domainsep.json')
    const bytes = Buffer.from('x')
    const contentHash = await computeContentHash(bytes)
    const ts = Date.now()
    const fields = { workspaceTag: tag, resourceTag: res, prevVersion: null, prevIncarnation: null, expectedLength: bytes.length, contentHash }
    // Sign under the WS put domain (nonce slot = the ts string); the REST
    // mint canonicalizes under a DISTINCT domain → won't verify.
    const wsSig = await signObjstorePut(keys.signingKey, fields, String(ts))
    assert.equal((await mintPost(tag, res, { op: 'put', ts, signature: wsSig, prevVersion: null, prevIncarnation: null, expectedLength: bytes.length, contentHash })).status, 401)
  })

  it('put-begin returns 409 conflict when the precondition is stale', async () => {
    const keys = await makeKeys()
    const tag = keys.workspaceTag
    const res = await computeResourceTag(keys.tagKey, 'rest-put-conflict.json')
    const bytes = Buffer.from('v1-bytes')
    const begin1 = await putBeginMint(keys, tag, res, bytes)
    assert.equal(begin1.status, 200)
    const j1 = await begin1.json()
    const commit = await fetch(`${httpOrigin}${j1.urlPath}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${j1.token}`, 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) },
      body: bytes,
    })
    assert.equal(commit.status, 200)
    // A second put-begin with prev=null (must-not-exist) now conflicts.
    const begin2 = await putBeginMint(keys, tag, res, Buffer.from('v2-attempt'))
    assert.equal(begin2.status, 409, 'must-not-exist precondition against a live row → conflict')
    const j2 = await begin2.json()
    assert.equal(j2.error, 'conflict')
    assert.equal(typeof j2.currentVersion, 'number')
    assert.equal(typeof j2.currentIncarnation, 'string')
  })

  it('put-begin rejects a missing expectedLength/contentHash with 400', async () => {
    const keys = await makeKeys()
    const tag = keys.workspaceTag
    const res = await computeResourceTag(keys.tagKey, 'rest-put-malformed.json')
    // A syntactically-valid auth pair but no put fields → 400 before sig verify.
    assert.equal((await mintPost(tag, res, { op: 'put', ts: Date.now(), signature: 'A'.repeat(86) })).status, 400)
  })

  it('put-begin on a password-gated server refuses a new workspace with 401 (client falls back to WS)', async () => {
    // A password-configured server gates the first write to a never-seen
    // workspace. The REST mint can't operator-authenticate, so it 401s; the
    // client (not exercised here) falls back to the in-band WS put-begin.
    const gatedDir = mkdtempSync(path.join(tmpdir(), 'deepview-gated-'))
    writeFileSync(path.join(gatedDir, 'config.json'), JSON.stringify({ password: 'sekret' }))
    const gated = await bootServer({ dir: gatedDir })
    try {
      const keys = await makeKeys()
      const tag = keys.workspaceTag
      const res = await computeResourceTag(keys.tagKey, 'gated-new.json')
      const bytes = Buffer.from('x')
      const contentHash = await computeContentHash(bytes)
      const ts = Date.now()
      const fields = { workspaceTag: tag, resourceTag: res, prevVersion: null, prevIncarnation: null, expectedLength: bytes.length, contentHash }
      const signature = await signObjstorePutBeginRest(keys.signingKey, fields, ts)
      const r = await fetch(`${gated.httpOrigin}/api/objstore/${tag}/${res}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'put', ts, signature, prevVersion: null, prevIncarnation: null, expectedLength: bytes.length, contentHash }),
      })
      assert.equal(r.status, 401, 'gated new-workspace put-begin refused over REST')
      // Fetch-mint for a new workspace on the SAME gated server is NOT gated
      // (read-only) — it's a plain 404 (no live row), proving the gate is
      // put-specific.
      const fm = await fetch(`${gated.httpOrigin}/api/objstore/${tag}/${res}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'fetch', ts, signature: await signObjstoreFetchRest(keys.signingKey, tag, res, ts) }),
      })
      assert.equal(fm.status, 404, 'fetch-mint is not gated (read-only) — new resource is just not-found')
    } finally {
      await gated.teardown()
      rmSync(gatedDir, { recursive: true, force: true })
    }
  })

  // ---- op:'delete' (delete mint) ----

  // Sign + POST a delete mint (with optional prev precondition). Returns the
  // fetch Response. Unlike put/fetch, delete mints nothing — it mutates in
  // place and the 200 body is just `{ deletedVersion }`.
  async function deleteMint(keys, tag, res, { prevVersion = null, prevIncarnation = null } = {}) {
    const ts = Date.now()
    const fields = { workspaceTag: tag, resourceTag: res, prevVersion, prevIncarnation }
    const signature = await signObjstoreDeleteRest(keys.signingKey, fields, ts)
    return mintPost(tag, res, { op: 'delete', ts, signature, prevVersion, prevIncarnation })
  }

  it('delete mint: drops a live object; a follow-up fetch-mint then 404s (gone)', async () => {
    const content = Buffer.from('delete-me-opaque-ciphertext-stand-in-0001')
    const { keys, res, put, session } = await seedObject('rest-delete.json', content)
    try {
      const tag = keys.workspaceTag
      const del = await deleteMint(keys, tag, res, { prevVersion: put.meta.version, prevIncarnation: put.meta.incarnation })
      assert.equal(del.status, 200, 'delete should succeed for a matching precondition')
      assert.equal((await del.json()).deletedVersion, put.meta.version)
      // The live row is gone — a fetch-mint for the same resource now 404s.
      const fmTs = Date.now()
      const fm = await mintPost(tag, res, { op: 'fetch', ts: fmTs, signature: await signObjstoreFetchRest(keys.signingKey, tag, res, fmTs) })
      assert.equal(fm.status, 404, 'object is gone after delete')
    } finally { session.close() }
  })

  it('delete mint: a null precondition against a missing row is an idempotent no-op (deletedVersion 0)', async () => {
    const keys = await makeKeys()
    const tag = keys.workspaceTag
    const res = await computeResourceTag(keys.tagKey, 'rest-delete-noop.json')
    // No live row + must-not-exist precondition → success with deletedVersion 0
    // (nothing was dropped, nothing to broadcast).
    const del = await deleteMint(keys, tag, res, { prevVersion: null, prevIncarnation: null })
    assert.equal(del.status, 200)
    assert.equal((await del.json()).deletedVersion, 0)
  })

  it('delete mint: a non-null precondition against a missing row 404s', async () => {
    const keys = await makeKeys()
    const tag = keys.workspaceTag
    const res = await computeResourceTag(keys.tagKey, 'rest-delete-missing.json')
    // A concrete (version, incarnation) precondition but no row to match it →
    // not-found (distinct from the null-precondition no-op above).
    const del = await deleteMint(keys, tag, res, { prevVersion: 1, prevIncarnation: 'a'.repeat(22) })
    assert.equal(del.status, 404)
  })

  it('delete mint: a stale precondition against a live row 409s with the current version', async () => {
    const { keys, res, put, session } = await seedObject('rest-delete-conflict.json', Buffer.from('v1-bytes'))
    try {
      const tag = keys.workspaceTag
      // A wrong-version precondition against the live row → conflict, echoing
      // the current (version, incarnation) for the client to rebase on.
      const del = await deleteMint(keys, tag, res, { prevVersion: put.meta.version + 999, prevIncarnation: put.meta.incarnation })
      assert.equal(del.status, 409)
      const j = await del.json()
      assert.equal(j.error, 'conflict')
      assert.equal(j.currentVersion, put.meta.version)
      assert.equal(j.currentIncarnation, put.meta.incarnation)
    } finally { session.close() }
  })

  it('delete mint: rejects a replayed signature with 401', async () => {
    const keys = await makeKeys()
    const tag = keys.workspaceTag
    const res = await computeResourceTag(keys.tagKey, 'rest-delete-replay.json')
    const ts = Date.now()
    const fields = { workspaceTag: tag, resourceTag: res, prevVersion: null, prevIncarnation: null }
    const signature = await signObjstoreDeleteRest(keys.signingKey, fields, ts)
    const body = { op: 'delete', ts, signature, prevVersion: null, prevIncarnation: null }
    // First admit succeeds (a null-precondition no-op); the replay is caught by
    // the freshness/replay guard BEFORE the delete runs.
    assert.equal((await mintPost(tag, res, body)).status, 200)
    assert.equal((await mintPost(tag, res, body)).status, 401, 'replayed delete signature rejected')
  })

  it('delete mint: rejects a signature from a different workspace key with 401', async () => {
    const keys = await makeKeys()
    const other = await makeKeys()
    const tag = keys.workspaceTag
    const res = await computeResourceTag(keys.tagKey, 'rest-delete-wrongkey.json')
    const ts = Date.now()
    const fields = { workspaceTag: tag, resourceTag: res, prevVersion: null, prevIncarnation: null }
    // Structurally valid Ed25519 sig but by the WRONG signer — won't verify
    // against `tag` (the victim's pubkey).
    const signature = await signObjstoreDeleteRest(other.signingKey, fields, ts)
    assert.equal((await mintPost(tag, res, { op: 'delete', ts, signature, prevVersion: null, prevIncarnation: null })).status, 401)
  })

  it('delete mint: rejects a WS delete signature presented to the mint (domain separation) with 401', async () => {
    const keys = await makeKeys()
    const tag = keys.workspaceTag
    const res = await computeResourceTag(keys.tagKey, 'rest-delete-domainsep.json')
    const ts = Date.now()
    const fields = { workspaceTag: tag, resourceTag: res, prevVersion: null, prevIncarnation: null }
    // Sign under the WS delete domain (nonce slot = the ts string); the REST
    // mint canonicalizes under a DISTINCT domain → won't verify.
    const wsSig = await signObjstoreDelete(keys.signingKey, fields, String(ts))
    assert.equal((await mintPost(tag, res, { op: 'delete', ts, signature: wsSig, prevVersion: null, prevIncarnation: null })).status, 401)
  })

  it('delete mint: rejects a half-pair precondition (version without incarnation) with 400', async () => {
    const keys = await makeKeys()
    const tag = keys.workspaceTag
    const res = await computeResourceTag(keys.tagKey, 'rest-delete-halfpair.json')
    const ts = Date.now()
    // prevVersion set but prevIncarnation null → malformed precondition,
    // rejected before sig verify (matches the WS validPrevPair gate).
    const fields = { workspaceTag: tag, resourceTag: res, prevVersion: 1, prevIncarnation: null }
    const signature = await signObjstoreDeleteRest(keys.signingKey, fields, ts)
    assert.equal((await mintPost(tag, res, { op: 'delete', ts, signature, prevVersion: 1, prevIncarnation: null })).status, 400)
  })
})
