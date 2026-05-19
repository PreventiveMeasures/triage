// End-to-end protocol tests for the v1.objstore extension. Boots
// the relay in a child process; drives it from `ws` clients with
// real Ed25519 signatures (WebCrypto) and routes byte transfers
// through the REST plane via global `fetch`. Each test uses a fresh
// keypair (= fresh workspaceTag) so chains don't collide.
//
// Two-plane shape under test:
//   WS:     workspace-subscribe (broadcast attach), objstore-put-begin,
//           objstore-fetch (token issuance), objstore-delete, objstore-list
//   REST:   PUT /api/objstore/{tag}/{res}, GET /api/objstore/{tag}/{res}
//           (Authorization: Bearer <token>, body = raw ciphertext)

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { Buffer } from 'node:buffer'
import { encodeUtf8 } from '../common/utf8.js'
import { bootServer } from './_helpers.js'

const SUBSCRIBE_DOMAIN = 'deepview-triage-sync.v1.subscribe'
const PUT_DOMAIN = 'deepview-objstore.v1.put'
const DELETE_DOMAIN = 'deepview-objstore.v1.delete'
const LIST_DOMAIN = 'deepview-objstore.v1.list'
const FETCH_DOMAIN = 'deepview-objstore.v1.fetch'

function b64url(bytes) { return Buffer.from(bytes).toString('base64url') }

async function makeKp() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey)
  return { sk: kp.privateKey, tag: b64url(Buffer.from(jwk.x, 'base64url')) }
}

async function sign(sk, payload) {
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, sk, payload))
  return b64url(sig)
}

function signSubscribe(sk, tag, from, connectionNonce) {
  return sign(sk, encodeUtf8([SUBSCRIBE_DOMAIN, tag, from == null ? '' : String(from), connectionNonce].join('\n')))
}

function signPut(sk, fields, connectionNonce) {
  return sign(sk, encodeUtf8([
    PUT_DOMAIN,
    fields.workspaceTag, fields.resourceTag,
    fields.prevVersion == null ? '' : String(fields.prevVersion),
    fields.contentHash, String(fields.expectedLength),
    connectionNonce,
  ].join('\n')))
}

function signDelete(sk, fields, connectionNonce) {
  return sign(sk, encodeUtf8([
    DELETE_DOMAIN, fields.workspaceTag, fields.resourceTag,
    fields.prevVersion == null ? '' : String(fields.prevVersion),
    connectionNonce,
  ].join('\n')))
}

function signList(sk, tag, connectionNonce) {
  return sign(sk, encodeUtf8([LIST_DOMAIN, tag, connectionNonce].join('\n')))
}

function signFetch(sk, tag, resourceTag, connectionNonce) {
  return sign(sk, encodeUtf8([FETCH_DOMAIN, tag, resourceTag, connectionNonce].join('\n')))
}

function syntheticHash() { return b64url(crypto.getRandomValues(new Uint8Array(32))) }

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const queue = []
    const waiters = []
    ws.addEventListener('message', (event) => {
      let msg
      try { msg = JSON.parse(event.data) } catch { return }
      for (let i = 0; i < waiters.length; i++) {
        if (waiters[i].predicate(msg)) {
          const w = waiters[i]
          waiters.splice(i, 1)
          w.resolve(msg)
          return
        }
      }
      queue.push(msg)
    })
    function recv(predicate, timeoutMs = 5_000) {
      for (let i = 0; i < queue.length; i++) {
        if (predicate(queue[i])) return Promise.resolve(queue.splice(i, 1)[0])
      }
      return new Promise((res, rej) => {
        const waiter = { predicate, resolve: null }
        const t = setTimeout(() => {
          const idx = waiters.indexOf(waiter)
          if (idx >= 0) waiters.splice(idx, 1)
          rej(new Error(`recv: timeout (queue=${queue.length})`))
        }, timeoutMs)
        waiter.resolve = (msg) => { clearTimeout(t); res(msg) }
        waiters.push(waiter)
      })
    }
    function expectSilent(ms = 200) {
      const start = queue.length
      return new Promise((res, rej) => {
        setTimeout(() => {
          if (queue.length === start) res()
          else rej(new Error(`expectSilent: got ${JSON.stringify(queue.slice(start)).slice(0, 200)}`))
        }, ms)
      })
    }
    ws.addEventListener('open', () => {
      recv((m) => m.type === 'challenge', 5_000).then((challenge) => {
        resolve({ ws, recv, expectSilent, connectionNonce: challenge.nonce })
        return null
      }).catch((err) => reject(err))
    }, { once: true })
    ws.addEventListener('error', (event) => reject(event.error ?? new Error('websocket error')), { once: true })
  })
}

async function subscribeWS(c, sk, tag) {
  const sig = await signSubscribe(sk, tag, null, c.connectionNonce)
  c.ws.send(JSON.stringify({ type: 'workspace-subscribe', workspaceTag: tag, from: null, signature: sig }))
  await c.recv((m) => m.type === 'workspace-subscribed' && m.workspaceTag === tag)
  await c.recv((m) => m.type === 'workspace-state' && m.workspaceTag === tag)
}

// Two-step PUT: WS objstore-put-begin → objstore-put-token, then
// HTTP PUT to the urlPath with the bearer + ciphertext body.
async function putBlob(c, sk, tag, resourceTag, payloadBytes, prevVersion = null, httpOrigin) {
  const fields = {
    workspaceTag: tag, resourceTag, prevVersion,
    expectedLength: payloadBytes.byteLength,
    contentHash: syntheticHash(),
  }
  const signature = await signPut(sk, fields, c.connectionNonce)
  c.ws.send(JSON.stringify({ type: 'objstore-put-begin', ...fields, signature }))
  const tok = await c.recv((m) => (m.type === 'objstore-put-token' || m.type === 'objstore-conflict' || m.type === 'objstore-put-error') && m.resourceTag === resourceTag)
  if (tok.type === 'objstore-conflict') return { conflict: tok }
  if (tok.type === 'objstore-put-error') return { putError: tok }
  const res = await fetch(httpOrigin + tok.urlPath, {
    method: 'PUT',
    headers: { authorization: `Bearer ${tok.token}`, 'content-type': 'application/octet-stream' },
    body: payloadBytes,
  })
  return { putRes: res, ackBody: res.ok ? await res.json() : null, fields }
}

async function fetchBlob(c, sk, tag, resourceTag, httpOrigin) {
  const sig = await signFetch(sk, tag, resourceTag, c.connectionNonce)
  c.ws.send(JSON.stringify({ type: 'objstore-fetch', workspaceTag: tag, resourceTag, signature: sig }))
  const tok = await c.recv((m) => (m.type === 'objstore-fetch-token' || m.type === 'objstore-fetch-not-found')
    && m.resourceTag === resourceTag)
  if (tok.type === 'objstore-fetch-not-found') return { notFound: true }
  const res = await fetch(httpOrigin + tok.urlPath, {
    headers: { authorization: `Bearer ${tok.token}` },
  })
  if (!res.ok) return { httpStatus: res.status }
  const buf = Buffer.from(await res.arrayBuffer())
  return { meta: tok, body: buf }
}

// Each `it` mints fresh keypairs (= fresh workspaceTag) so the
// per-tag chain on the shared server is isolated; parallel `it`s
// don't collide. Concurrency cuts wall-time roughly to the slowest
// single test.
describe('v1.objstore server (REST-primary)', { concurrency: true }, () => {
  let httpOrigin, server, serverDir, serverUrl

  before(async () => {
    server = await bootServer()
    serverDir = server.serverDir
    serverUrl = server.serverUrl
    httpOrigin = server.httpOrigin
  })

  after(async () => {
    if (server) await server.teardown()
  })

  it('put → list → fetch round-trips a small payload byte-for-byte (REST plane)', async () => {
    const { sk, tag } = await makeKp()
    const c = await connect(serverUrl)
    await subscribeWS(c, sk, tag)
    const payload = Buffer.from('opaque ciphertext bytes the relay never reads', 'utf8')
    const { putRes, ackBody } = await putBlob(c, sk, tag, 'r-1', payload, null, httpOrigin)
    assert.equal(putRes.status, 200)
    assert.equal(ackBody.version, 1)
    assert.equal(ackBody.contentLength, payload.byteLength)
    // List returns it.
    const listSig = await signList(sk, tag, c.connectionNonce)
    c.ws.send(JSON.stringify({ type: 'objstore-list', workspaceTag: tag, signature: listSig }))
    const list = await c.recv((m) => m.type === 'objstore-list-result')
    assert.equal(list.resources.length, 1)
    assert.equal(list.resources[0].resourceTag, 'r-1')
    assert.equal(list.resources[0].contentLength, payload.byteLength)
    // Fetch via REST returns the same bytes byte-for-byte.
    const fetched = await fetchBlob(c, sk, tag, 'r-1', httpOrigin)
    assert.deepEqual(fetched.body, payload)
    assert.equal(fetched.meta.contentHash, list.resources[0].contentHash)
    c.ws.close()
  })

  it('broadcasts objstore-put to peers after a successful REST PUT commit', async () => {
    const { sk, tag } = await makeKp()
    const c1 = await connect(serverUrl)
    const c2 = await connect(serverUrl)
    await subscribeWS(c1, sk, tag)
    await subscribeWS(c2, sk, tag)
    const payload = Buffer.from('broadcast-payload', 'utf8')
    const [, broadcastMsg] = await Promise.all([
      putBlob(c1, sk, tag, 'broadcast-r', payload, null, httpOrigin),
      c2.recv((m) => m.type === 'objstore-put' && m.resourceTag === 'broadcast-r'),
    ])
    assert.equal(broadcastMsg.version, 1)
    assert.equal(broadcastMsg.contentLength, payload.byteLength)
    // Originator's WS subscriber sees the broadcast too — REST PUT
    // doesn't carry the originator socket identity, so we broadcast
    // to all subscribed peers including the originator's WS. Client
    // dedupes via contentHash + version.
    const echoToSelf = await c1.recv((m) => m.type === 'objstore-put' && m.resourceTag === 'broadcast-r')
    assert.equal(echoToSelf.version, 1)
    c1.ws.close(); c2.ws.close()
  })

  it('DELETE drops the row and broadcasts to peers; sender gets ack first', async () => {
    const { sk, tag } = await makeKp()
    const c1 = await connect(serverUrl)
    const c2 = await connect(serverUrl)
    await subscribeWS(c1, sk, tag)
    await subscribeWS(c2, sk, tag)
    await putBlob(c1, sk, tag, 'soon-deleted', Buffer.from('bytes', 'utf8'), null, httpOrigin)
    await c2.recv((m) => m.type === 'objstore-put' && m.resourceTag === 'soon-deleted')
    // Drain c1's own put broadcast echo before issuing the delete.
    await c1.recv((m) => m.type === 'objstore-put' && m.resourceTag === 'soon-deleted')
    const sig = await signDelete(sk, { workspaceTag: tag, resourceTag: 'soon-deleted', prevVersion: 1 }, c1.connectionNonce)
    c1.ws.send(JSON.stringify({
      type: 'objstore-delete', workspaceTag: tag, resourceTag: 'soon-deleted', prevVersion: 1, signature: sig,
    }))
    const [ack, broadcastMsg] = await Promise.all([
      c1.recv((m) => m.type === 'objstore-deleted-ack' && m.resourceTag === 'soon-deleted'),
      c2.recv((m) => m.type === 'objstore-deleted' && m.resourceTag === 'soon-deleted'),
    ])
    assert.equal(ack.deletedVersion, 1)
    assert.equal(broadcastMsg.version, 1)
    c1.ws.close(); c2.ws.close()
  })

  it('a peer that connects AFTER a delete sees no record', async () => {
    const { sk, tag } = await makeKp()
    const c1 = await connect(serverUrl)
    await subscribeWS(c1, sk, tag)
    await putBlob(c1, sk, tag, 'will-vanish', Buffer.from('xx', 'utf8'), null, httpOrigin)
    // Drain own broadcast.
    await c1.recv((m) => m.type === 'objstore-put' && m.resourceTag === 'will-vanish')
    const sig = await signDelete(sk, { workspaceTag: tag, resourceTag: 'will-vanish', prevVersion: 1 }, c1.connectionNonce)
    c1.ws.send(JSON.stringify({
      type: 'objstore-delete', workspaceTag: tag, resourceTag: 'will-vanish', prevVersion: 1, signature: sig,
    }))
    await c1.recv((m) => m.type === 'objstore-deleted-ack')
    const c2 = await connect(serverUrl)
    await subscribeWS(c2, sk, tag)
    const listSig = await signList(sk, tag, c2.connectionNonce)
    c2.ws.send(JSON.stringify({ type: 'objstore-list', workspaceTag: tag, signature: listSig }))
    const list = await c2.recv((m) => m.type === 'objstore-list-result')
    assert.equal(list.resources.length, 0)
    c1.ws.close(); c2.ws.close()
  })

  it('rejects PUT with stale prevVersion → emits objstore-conflict echoing current row', async () => {
    const { sk, tag } = await makeKp()
    const c = await connect(serverUrl)
    await subscribeWS(c, sk, tag)
    await putBlob(c, sk, tag, 'r-conflict', Buffer.from('first', 'utf8'), null, httpOrigin)
    // Drain own broadcast.
    await c.recv((m) => m.type === 'objstore-put' && m.resourceTag === 'r-conflict')
    // Second put-begin with prevVersion=null → conflict.
    const fields = {
      workspaceTag: tag, resourceTag: 'r-conflict', prevVersion: null,
      expectedLength: 6,
      contentHash: syntheticHash(),
    }
    const signature = await signPut(sk, fields, c.connectionNonce)
    c.ws.send(JSON.stringify({ type: 'objstore-put-begin', ...fields, signature }))
    const conflict = await c.recv((m) => m.type === 'objstore-conflict')
    assert.equal(conflict.action, 'put')
    assert.equal(conflict.current.version, 1)
    c.ws.close()
  })

  it('drops a put-begin with a forged signature silently (no token issued)', async () => {
    const { tag } = await makeKp()
    const { sk: otherSk } = await makeKp()
    const c = await connect(serverUrl)
    await c.expectSilent(50)
    const fields = {
      workspaceTag: tag, resourceTag: 'r-forge', prevVersion: null,
      expectedLength: 4,
      contentHash: syntheticHash(),
    }
    const signature = await signPut(otherSk, fields, c.connectionNonce)
    c.ws.send(JSON.stringify({ type: 'objstore-put-begin', ...fields, signature }))
    await c.expectSilent(200)
    c.ws.close()
  })

  it('drops an objstore-delete signed with a different connection-nonce → cross-connection replay protection', async () => {
    // Audit H2: `objstore-delete` previously omitted the per-
    // connection challenge nonce from its signed canonical, so a
    // signed frame captured off the wire could be replayed on a new
    // connection. The fix binds the nonce into the canonical, same
    // as list/fetch. Specifically dangerous because versions restart
    // at 1 after each delete — `prevVersion=1` is a recurring
    // alignment window.
    const { sk, tag } = await makeKp()
    const c1 = await connect(serverUrl)
    const c2 = await connect(serverUrl)
    await subscribeWS(c1, sk, tag)
    await subscribeWS(c2, sk, tag)
    await putBlob(c1, sk, tag, 'r-replay-target', Buffer.from('victim', 'utf8'), null, httpOrigin)
    await c1.recv((m) => m.type === 'objstore-put' && m.resourceTag === 'r-replay-target')
    await c2.recv((m) => m.type === 'objstore-put' && m.resourceTag === 'r-replay-target')
    // Sign a delete bound to c1's nonce — perfectly valid on c1.
    const c1Sig = await signDelete(sk, { workspaceTag: tag, resourceTag: 'r-replay-target', prevVersion: 1 }, c1.connectionNonce)
    // Replay that signed delete on c2 — c2's nonce is different, so
    // the canonical bytes differ, verify fails, the message is
    // silently dropped.
    c2.ws.send(JSON.stringify({
      type: 'objstore-delete', workspaceTag: tag, resourceTag: 'r-replay-target',
      prevVersion: 1, signature: c1Sig,
    }))
    await c2.expectSilent(200)
    // Resource still present.
    const listSig = await signList(sk, tag, c2.connectionNonce)
    c2.ws.send(JSON.stringify({ type: 'objstore-list', workspaceTag: tag, signature: listSig }))
    const list = await c2.recv((m) => m.type === 'objstore-list-result')
    assert.equal(list.resources.length, 1, 'replayed delete must not drop the row')
    c1.ws.close(); c2.ws.close()
  })

  it('drops an objstore-put-begin signed with a different connection-nonce → cross-connection replay protection', async () => {
    // Audit H2 companion: same race protection for put-begin.
    // Without the nonce binding, a captured put-begin could be
    // replayed to mint a fresh staging-id token that the attacker
    // can use to upload arbitrary (AEAD-fail) bytes for the
    // original (signed) contentHash, causing peer fetch-then-decrypt
    // failures.
    const { sk, tag } = await makeKp()
    const c1 = await connect(serverUrl)
    const c2 = await connect(serverUrl)
    const fields = {
      workspaceTag: tag, resourceTag: 'r-put-replay', prevVersion: null,
      expectedLength: 8,
      contentHash: syntheticHash(),
    }
    // Sign against c1's nonce.
    const c1Sig = await signPut(sk, fields, c1.connectionNonce)
    // Replay on c2 — must be silently dropped.
    c2.ws.send(JSON.stringify({ type: 'objstore-put-begin', ...fields, signature: c1Sig }))
    await c2.expectSilent(200)
    c1.ws.close(); c2.ws.close()
  })

  it('drops a list with a different connection-nonce → cross-connection replay protection', async () => {
    const { sk, tag } = await makeKp()
    const c1 = await connect(serverUrl)
    const c2 = await connect(serverUrl)
    const sig = await signList(sk, tag, c1.connectionNonce)
    c2.ws.send(JSON.stringify({ type: 'objstore-list', workspaceTag: tag, signature: sig }))
    await c2.expectSilent(200)
    c1.ws.close(); c2.ws.close()
  })

  it('REST PUT without a token → 401', async () => {
    const { tag } = await makeKp()
    const res = await fetch(`${httpOrigin}/api/objstore/${tag}/r-no-token`, {
      method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from('x'),
    })
    assert.equal(res.status, 401)
    assert.deepEqual(await res.json(), { error: 'unauthorized' })
  })

  it('REST PUT with a forged token → 401', async () => {
    const { tag } = await makeKp()
    const res = await fetch(`${httpOrigin}/api/objstore/${tag}/r-bad-token`, {
      method: 'PUT',
      headers: { authorization: 'Bearer aaaaaaaa.bbbbbbbb', 'content-type': 'application/octet-stream' },
      body: Buffer.from('x'),
    })
    assert.equal(res.status, 401)
  })

  it('REST PUT with mismatched Content-Length → 400 length-mismatch', async () => {
    const { sk, tag } = await makeKp()
    const c = await connect(serverUrl)
    const fields = {
      workspaceTag: tag, resourceTag: 'r-bad-len', prevVersion: null,
      expectedLength: 100,
      contentHash: syntheticHash(),
    }
    const signature = await signPut(sk, fields, c.connectionNonce)
    c.ws.send(JSON.stringify({ type: 'objstore-put-begin', ...fields, signature }))
    const tok = await c.recv((m) => m.type === 'objstore-put-token' && m.resourceTag === 'r-bad-len')
    // Body is 50 bytes but token says 100. Server compares
    // Content-Length to expected_length and rejects without opening
    // the file.
    const res = await fetch(httpOrigin + tok.urlPath, {
      method: 'PUT',
      headers: { authorization: `Bearer ${tok.token}`, 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(50),
    })
    assert.equal(res.status, 400)
    assert.deepEqual(await res.json(), { error: 'length-mismatch' })
    c.ws.close()
  })

  it('REST PUT replayed with the same token → 410 gone (single-use)', async () => {
    const { sk, tag } = await makeKp()
    const c = await connect(serverUrl)
    await subscribeWS(c, sk, tag)
    const payload = Buffer.from('once', 'utf8')
    const fields = {
      workspaceTag: tag, resourceTag: 'r-once', prevVersion: null,
      expectedLength: payload.byteLength,
      contentHash: syntheticHash(),
    }
    const signature = await signPut(sk, fields, c.connectionNonce)
    c.ws.send(JSON.stringify({ type: 'objstore-put-begin', ...fields, signature }))
    const tok = await c.recv((m) => m.type === 'objstore-put-token')
    const first = await fetch(httpOrigin + tok.urlPath, {
      method: 'PUT',
      headers: { authorization: `Bearer ${tok.token}`, 'content-type': 'application/octet-stream' },
      body: payload,
    })
    assert.equal(first.status, 200)
    // Replay → staging row gone → 410.
    const replay = await fetch(httpOrigin + tok.urlPath, {
      method: 'PUT',
      headers: { authorization: `Bearer ${tok.token}`, 'content-type': 'application/octet-stream' },
      body: payload,
    })
    assert.equal(replay.status, 410)
    assert.deepEqual(await replay.json(), { error: 'gone' })
    c.ws.close()
  })

  it('REST GET token whose version is stale (resource overwritten) → 404', async () => {
    const { sk, tag } = await makeKp()
    const c = await connect(serverUrl)
    await subscribeWS(c, sk, tag)
    await putBlob(c, sk, tag, 'r-stale-ver', Buffer.from('v1', 'utf8'), null, httpOrigin)
    await c.recv((m) => m.type === 'objstore-put' && m.resourceTag === 'r-stale-ver')
    // Mint a GET token for v1.
    const fetchSig = await signFetch(sk, tag, 'r-stale-ver', c.connectionNonce)
    c.ws.send(JSON.stringify({ type: 'objstore-fetch', workspaceTag: tag, resourceTag: 'r-stale-ver', signature: fetchSig }))
    const tok = await c.recv((m) => m.type === 'objstore-fetch-token')
    // Overwrite to v2 — invalidates the token's `ver = 1` binding.
    await putBlob(c, sk, tag, 'r-stale-ver', Buffer.from('v2', 'utf8'), 1, httpOrigin)
    await c.recv((m) => m.type === 'objstore-put' && m.version === 2)
    // Now the v1 GET token must 404.
    const res = await fetch(httpOrigin + tok.urlPath, {
      headers: { authorization: `Bearer ${tok.token}` },
    })
    assert.equal(res.status, 404)
    c.ws.close()
  })

  it('idempotent DELETE on a missing resource (prevVersion=null) → ack with deletedVersion=0', async () => {
    const { sk, tag } = await makeKp()
    const c = await connect(serverUrl)
    const sig = await signDelete(sk, { workspaceTag: tag, resourceTag: 'never-existed', prevVersion: null }, c.connectionNonce)
    c.ws.send(JSON.stringify({
      type: 'objstore-delete', workspaceTag: tag, resourceTag: 'never-existed', prevVersion: null, signature: sig,
    }))
    const ack = await c.recv((m) => m.type === 'objstore-deleted-ack' && m.resourceTag === 'never-existed')
    assert.equal(ack.deletedVersion, 0)
    c.ws.close()
  })

  it('DELETE with non-null prevVersion on a missing resource → objstore-delete-error { reason: "not-found" }', async () => {
    // README documents this wire shape, and a comment elsewhere in
    // this test file mentions it, but no assertion pinned it. A
    // regression that changed the `reason` string would slip through.
    const { sk, tag } = await makeKp()
    const c = await connect(serverUrl)
    const sig = await signDelete(sk, { workspaceTag: tag, resourceTag: 'never-existed', prevVersion: 1 }, c.connectionNonce)
    c.ws.send(JSON.stringify({
      type: 'objstore-delete', workspaceTag: tag, resourceTag: 'never-existed', prevVersion: 1, signature: sig,
    }))
    const err = await c.recv((m) => m.type === 'objstore-delete-error' && m.resourceTag === 'never-existed')
    assert.equal(err.workspaceTag, tag)
    assert.equal(err.reason, 'not-found')
    c.ws.close()
  })

  it('put-begin with NaN / non-safe-int expectedLength → silent drop (no token issued)', async () => {
    // Audit round-12: pre-sig gate switched from `typeof === number`
    // + range check to `Number.isSafeInteger`. Previously NaN slipped
    // past the typeof gate (since `NaN < 0` and `NaN > MAX` are both
    // false), reaching sig verify before being dropped — wasted CPU.
    // Now rejected up-front. Pin: no `objstore-put-token`,
    // no `objstore-conflict`, no `objstore-put-error` emitted.
    const { sk, tag } = await makeKp()
    const c = await connect(serverUrl)
    const baseFields = {
      workspaceTag: tag, resourceTag: 'r-nan', prevVersion: null,
      expectedLength: 8,
      contentHash: syntheticHash(),
    }
    // We can't sign over NaN canonical bytes (the canonical builder
    // would fail / produce garbage), but the wire-gate at the
    // handler entry rejects BEFORE sig verify anyway. Use any sig.
    const sig = await signPut(sk, baseFields, c.connectionNonce)
    // Case 1: NaN expectedLength.
    c.ws.send(JSON.stringify({ type: 'objstore-put-begin', ...baseFields, expectedLength: Number.NaN, signature: sig }))
    await c.expectSilent(150)
    // Case 2: negative expectedLength.
    c.ws.send(JSON.stringify({ type: 'objstore-put-begin', ...baseFields, expectedLength: -1, signature: sig }))
    await c.expectSilent(150)
    // Case 3: Number.MAX_SAFE_INTEGER + 1 (unsafe int).
    c.ws.send(JSON.stringify({ type: 'objstore-put-begin', ...baseFields, expectedLength: Number.MAX_SAFE_INTEGER + 1, signature: sig }))
    await c.expectSilent(150)
    // Sanity: a well-formed put-begin on the same socket still works.
    const okSig = await signPut(sk, baseFields, c.connectionNonce)
    c.ws.send(JSON.stringify({ type: 'objstore-put-begin', ...baseFields, signature: okSig }))
    const tok = await c.recv((m) => m.type === 'objstore-put-token' && m.resourceTag === 'r-nan')
    assert.equal(tok.workspaceTag, tag)
    c.ws.close()
  })

  it('put-begin with non-safe-int prevVersion → silent drop (handler gate matches sig-verifier)', async () => {
    // `handlePutBegin`'s prevVersion gate was previously `typeof
    // === 'number'` — asymmetric with `verifyObjstorePutSig`'s
    // stricter `isSafeIntOrNull` (sign.ts:119). An unsafe-int
    // prevVersion (2^53, 1.5, ...) would pass the wire gate, reach
    // sig verify, fail there. Now rejected up-front for parity with
    // `handleDelete:116`. Input-validation audit
    // `server/objstore/handlers.ts:76`. (NaN / Infinity aren't
    // testable over JSON — they serialise to `null` — but the same
    // gate covers them deterministically since `Number.isSafeInteger`
    // is false for both.)
    const { sk, tag } = await makeKp()
    const c = await connect(serverUrl)
    const baseFields = {
      workspaceTag: tag, resourceTag: 'r-prev-unsafe', prevVersion: null,
      expectedLength: 8,
      contentHash: syntheticHash(),
    }
    const sig = await signPut(sk, baseFields, c.connectionNonce)
    // Unsafe-int prevVersion (2^53; safe-integer range is [-(2^53-1), 2^53-1]).
    c.ws.send(JSON.stringify({ type: 'objstore-put-begin', ...baseFields, prevVersion: Number.MAX_SAFE_INTEGER + 1, signature: sig }))
    await c.expectSilent(150)
    // Non-integer number.
    c.ws.send(JSON.stringify({ type: 'objstore-put-begin', ...baseFields, prevVersion: 1.5, signature: sig }))
    await c.expectSilent(150)
    // Sanity: prevVersion: null still issues a token.
    const okSig = await signPut(sk, baseFields, c.connectionNonce)
    c.ws.send(JSON.stringify({ type: 'objstore-put-begin', ...baseFields, signature: okSig }))
    const tok = await c.recv((m) => m.type === 'objstore-put-token' && m.resourceTag === 'r-prev-unsafe')
    assert.equal(tok.workspaceTag, tag)
    c.ws.close()
  })

  it('WS upgrade outside /api/sync is rejected; HTTP outside /api/* is 404', async () => {
    // Bad WS path — connect should fail.
    const wsUrl = serverUrl.replace('/api/sync', '/wrong-path')
    await assert.rejects(
      () => new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl)
        ws.addEventListener('open', resolve, { once: true })
        ws.addEventListener('error', () => reject(new Error('rejected')), { once: true })
      }),
    )
    // Bad HTTP path → 404.
    const res = await fetch(`${httpOrigin}/random/path`)
    assert.equal(res.status, 404)
    assert.deepEqual(await res.json(), { error: 'not-found' })
  })

  // Mirrors the per-workspaceTag isolation guarantees the
  // triage-sync chain tests pin, but for the byte-store. Real
  // deployments will host many workspaces side-by-side; these
  // confirm the storage / broadcast / lookup paths key strictly by
  // `(workspaceTag, resourceTag)`.

  it('multiple resources per workspace — list aggregates; fetch isolates per resource', async () => {
    const { sk, tag } = await makeKp()
    const c = await connect(serverUrl)
    await subscribeWS(c, sk, tag)
    const p1 = Buffer.from('alpha', 'utf8')
    const p2 = Buffer.from('beta-payload-is-longer', 'utf8')
    const p3 = Buffer.from('g', 'utf8')
    for (const [name, payload] of [['r-a', p1], ['r-b', p2], ['r-c', p3]]) {
      await putBlob(c, sk, tag, name, payload, null, httpOrigin)
      // Drain the self-echo broadcast so the next put isn't
      // interleaving with stale `objstore-put` frames in the queue.
      await c.recv((m) => m.type === 'objstore-put' && m.resourceTag === name)
    }
    const listSig = await signList(sk, tag, c.connectionNonce)
    c.ws.send(JSON.stringify({ type: 'objstore-list', workspaceTag: tag, signature: listSig }))
    const list = await c.recv((m) => m.type === 'objstore-list-result')
    assert.equal(list.resources.length, 3)
    const tags = list.resources.map((r) => r.resourceTag).toSorted()
    assert.deepEqual(tags, ['r-a', 'r-b', 'r-c'])
    // Per-resource fetch returns its own bytes, not a sibling's.
    const fetchedB = await fetchBlob(c, sk, tag, 'r-b', httpOrigin)
    assert.deepEqual(fetchedB.body, p2)
    const fetchedC = await fetchBlob(c, sk, tag, 'r-c', httpOrigin)
    assert.deepEqual(fetchedC.body, p3)
    c.ws.close()
  })

  it('PUT after DELETE — version restarts at 1 (no tombstone), prevVersion=null required', async () => {
    // The "no tombstones" / fresh-subscriber-invisibility design
    // means a re-PUT of a deleted resourceTag is a NEW row, not a
    // resurrection of the old version. Pin both halves: a stale
    // prevVersion (e.g. the deleted version-id) must conflict, and
    // a `prevVersion = null` PUT lands as version 1 again.
    const { sk, tag } = await makeKp()
    const c = await connect(serverUrl)
    await subscribeWS(c, sk, tag)
    const r = 'r-recycle'
    const { ackBody: ack1 } = await putBlob(c, sk, tag, r, Buffer.from('v1-bytes', 'utf8'), null, httpOrigin)
    assert.equal(ack1.version, 1)
    await c.recv((m) => m.type === 'objstore-put' && m.resourceTag === r)
    const delSig = await signDelete(sk, { workspaceTag: tag, resourceTag: r, prevVersion: 1 }, c.connectionNonce)
    c.ws.send(JSON.stringify({ type: 'objstore-delete', workspaceTag: tag, resourceTag: r, prevVersion: 1, signature: delSig }))
    await c.recv((m) => m.type === 'objstore-deleted-ack')
    // Stale prevVersion=1 against a missing row → not-found (the
    // wire path returns objstore-delete-error reason='not-found',
    // but for PUT we get an objstore-conflict with current=null).
    const stale = await putBlob(c, sk, tag, r, Buffer.from('v2-attempt', 'utf8'), 1, httpOrigin)
    assert.equal(stale.conflict?.type, 'objstore-conflict')
    // prevVersion=null re-establishes the row at version 1.
    const { ackBody: ack2 } = await putBlob(c, sk, tag, r, Buffer.from('reborn', 'utf8'), null, httpOrigin)
    assert.equal(ack2.version, 1, 'version starts back at 1 after the row was dropped')
    c.ws.close()
  })

  it('cross-workspace isolation — putting under tagA does not surface in tagB list', async () => {
    // One TCP connection, two independent workspaces (different
    // seeds → different tags). Mirrors sync-server's
    // "demultiplexes by workspaceTag" but for the byte store.
    const { sk: skA, tag: tagA } = await makeKp()
    const { sk: skB, tag: tagB } = await makeKp()
    const c = await connect(serverUrl)
    await subscribeWS(c, skA, tagA)
    await subscribeWS(c, skB, tagB)
    await putBlob(c, skA, tagA, 'r-shared-name', Buffer.from('A-bytes', 'utf8'), null, httpOrigin)
    await c.recv((m) => m.type === 'objstore-put' && m.workspaceTag === tagA)
    const sigB = await signList(skB, tagB, c.connectionNonce)
    c.ws.send(JSON.stringify({ type: 'objstore-list', workspaceTag: tagB, signature: sigB }))
    const listB = await c.recv((m) => m.type === 'objstore-list-result' && m.workspaceTag === tagB)
    assert.equal(listB.resources.length, 0, 'tagB must not see tagA resources')
    // Fetch the same resource name under tagB → not-found.
    const fetched = await fetchBlob(c, skB, tagB, 'r-shared-name', httpOrigin)
    assert.equal(fetched.notFound, true)
    c.ws.close()
  })

  it('resources persist across reconnects (same DB, fresh socket)', async () => {
    // Mirrors sync-server's "persists revisions across reconnects".
    // The objstore-list response on the second connection must
    // include the resource committed on the first; the byte stream
    // via REST should still return identical bytes.
    const { sk, tag } = await makeKp()
    const c1 = await connect(serverUrl)
    await subscribeWS(c1, sk, tag)
    const payload = Buffer.from('persisted-bytes', 'utf8')
    await putBlob(c1, sk, tag, 'r-persist', payload, null, httpOrigin)
    await c1.recv((m) => m.type === 'objstore-put' && m.resourceTag === 'r-persist')
    c1.ws.close()
    // Fresh socket — re-subscribe, list, fetch.
    const c2 = await connect(serverUrl)
    await subscribeWS(c2, sk, tag)
    const listSig = await signList(sk, tag, c2.connectionNonce)
    c2.ws.send(JSON.stringify({ type: 'objstore-list', workspaceTag: tag, signature: listSig }))
    const list = await c2.recv((m) => m.type === 'objstore-list-result')
    assert.equal(list.resources.length, 1)
    assert.equal(list.resources[0].resourceTag, 'r-persist')
    assert.equal(list.resources[0].version, 1)
    const fetched = await fetchBlob(c2, sk, tag, 'r-persist', httpOrigin)
    assert.deepEqual(fetched.body, payload)
    c2.ws.close()
  })

  it('put-begin from a non-subscribed socket does NOT auto-subscribe (no future broadcasts)', async () => {
    // Mirrors sync-server's "save without a prior subscribe does
    // NOT register the sender as a subscriber" — a passive
    // observer that captured a single valid put-begin frame must
    // not be able to attach as a subscriber by replaying it. We
    // model the writer as never having sent `workspace-subscribe`.
    const { sk, tag } = await makeKp()
    const writer = await connect(serverUrl)
    // Don't subscribe writer. Just PUT.
    await putBlob(writer, sk, tag, 'r-write-only', Buffer.from('p', 'utf8'), null, httpOrigin)
    // A second client subscribes after the fact and PUTs a
    // different resource — writer should NOT receive that
    // broadcast since it was never added to the subscribers map.
    const peer = await connect(serverUrl)
    await subscribeWS(peer, sk, tag)
    await putBlob(peer, sk, tag, 'r-peer-bcast', Buffer.from('q', 'utf8'), null, httpOrigin)
    await peer.recv((m) => m.type === 'objstore-put' && m.resourceTag === 'r-peer-bcast')
    await writer.expectSilent(200)
    writer.ws.close(); peer.ws.close()
  })

  it('two concurrent commits on the same resource — exactly one wins, the other gets 409', async () => {
    // The per-resource async lock serialises commit / delete / begin
    // across the `await` boundaries inside commitPut. Both PUTs
    // begin against `prevVersion = null` (no live row yet); both
    // get tokens; both stream bytes. The first commit creates
    // version 1, the second's recheck inside commitPut sees the
    // bumped version and fails with conflict → HTTP 409.
    const { sk, tag } = await makeKp()
    const c = await connect(serverUrl)
    await subscribeWS(c, sk, tag)
    const payload = Buffer.from('race', 'utf8')
    function mkFields() {
      return {
        workspaceTag: tag, resourceTag: 'r-race', prevVersion: null,
        expectedLength: payload.byteLength,
        contentHash: syntheticHash(),
      }
    }
    const f1 = mkFields(); const f2 = mkFields()
    const s1 = await signPut(sk, f1, c.connectionNonce); const s2 = await signPut(sk, f2, c.connectionNonce)
    c.ws.send(JSON.stringify({ type: 'objstore-put-begin', ...f1, signature: s1 }))
    c.ws.send(JSON.stringify({ type: 'objstore-put-begin', ...f2, signature: s2 }))
    const tok1 = await c.recv((m) => m.type === 'objstore-put-token')
    const tok2 = await c.recv((m) => m.type === 'objstore-put-token' && m.stagingId !== tok1.stagingId)
    const [r1, r2] = await Promise.all([
      fetch(httpOrigin + tok1.urlPath, { method: 'PUT', headers: { authorization: `Bearer ${tok1.token}`, 'content-type': 'application/octet-stream' }, body: payload }),
      fetch(httpOrigin + tok2.urlPath, { method: 'PUT', headers: { authorization: `Bearer ${tok2.token}`, 'content-type': 'application/octet-stream' }, body: payload }),
    ])
    const statuses = [r1.status, r2.status].toSorted()
    assert.deepEqual(statuses, [200, 409], 'exactly one commit wins, the other is 409 conflict')
    // The 409 envelope carries `currentVersion` so a retry can
    // precondition on the live row's version. Without this the
    // caller would loop with `prevVersion: null` against a live
    // slot. API-ergonomics audit `client/objstore.ts:425`.
    const losing = r1.status === 409 ? r1 : r2
    const body = await losing.json()
    assert.equal(body.error, 'conflict')
    assert.equal(body.currentVersion, 1, 'REST 409 conflict body carries currentVersion')
    c.ws.close()
  })

  it('GET-token used on PUT method (and vice versa) → 405 method-not-allowed', async () => {
    // Cross-binding op vs HTTP method — even though the token
    // verifies (correct HMAC + non-expired + tag/res match), the
    // handler rejects when `payload.op` doesn't match `req.method`.
    const { sk, tag } = await makeKp()
    const c = await connect(serverUrl)
    await subscribeWS(c, sk, tag)
    await putBlob(c, sk, tag, 'r-op-mix', Buffer.from('payload', 'utf8'), null, httpOrigin)
    await c.recv((m) => m.type === 'objstore-put' && m.resourceTag === 'r-op-mix')
    // Mint a GET token, use on PUT.
    const fetchSig = await signFetch(sk, tag, 'r-op-mix', c.connectionNonce)
    c.ws.send(JSON.stringify({ type: 'objstore-fetch', workspaceTag: tag, resourceTag: 'r-op-mix', signature: fetchSig }))
    const getTok = await c.recv((m) => m.type === 'objstore-fetch-token')
    const wrongMethod = await fetch(httpOrigin + getTok.urlPath, {
      method: 'PUT',
      headers: { authorization: `Bearer ${getTok.token}`, 'content-type': 'application/octet-stream', 'content-length': '1' },
      body: Buffer.from('x'),
    })
    assert.equal(wrongMethod.status, 405)
    // The reverse: PUT token on GET. Issue a fresh begin (prev
    // resource was version 1; prevVersion=1 for the next bump).
    const putFields = {
      workspaceTag: tag, resourceTag: 'r-op-mix', prevVersion: 1,
      expectedLength: 1,
      contentHash: syntheticHash(),
    }
    const putSig = await signPut(sk, putFields, c.connectionNonce)
    c.ws.send(JSON.stringify({ type: 'objstore-put-begin', ...putFields, signature: putSig }))
    const putTok = await c.recv((m) => m.type === 'objstore-put-token')
    const reverse = await fetch(httpOrigin + putTok.urlPath, {
      headers: { authorization: `Bearer ${putTok.token}` },
    })
    assert.equal(reverse.status, 405)
    c.ws.close()
  })

  it('REST PUT without a Content-Length header → 411 length-required', async () => {
    // The handler refuses chunked transfer-encoding: the signed
    // canonical includes expectedLength, so honest clients always
    // know the size up front. A Node `fetch()` with a Buffer body
    // sets Content-Length automatically, so the test forces the
    // absent-header case via a raw HTTP/1.1 request over net.
    const { default: net } = await import('node:net')
    const { sk, tag } = await makeKp()
    const c = await connect(serverUrl)
    await subscribeWS(c, sk, tag)
    const fields = {
      workspaceTag: tag, resourceTag: 'r-no-len', prevVersion: null,
      expectedLength: 4,
      contentHash: syntheticHash(),
    }
    const signature = await signPut(sk, fields, c.connectionNonce)
    c.ws.send(JSON.stringify({ type: 'objstore-put-begin', ...fields, signature }))
    const tok = await c.recv((m) => m.type === 'objstore-put-token')
    const port = Number(new URL(serverUrl).port)
    const tcp = net.connect({ host: '127.0.0.1', port })
    const chunks = []
    tcp.on('data', (b) => { chunks.push(b) })
    await new Promise((resolve, reject) => {
      tcp.once('connect', resolve); tcp.once('error', reject)
    })
    // Send a PUT with Transfer-Encoding: chunked but NO
    // Content-Length. Server's `lenHeader` is undefined → 411.
    tcp.write(
      `PUT ${tok.urlPath} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\n` +
      `Authorization: Bearer ${tok.token}\r\n` +
      `Content-Type: application/octet-stream\r\n` +
      `Transfer-Encoding: chunked\r\n` +
      `Connection: close\r\n\r\n` +
      `4\r\nabcd\r\n0\r\n\r\n`,
    )
    await new Promise((resolve) => { tcp.once('close', resolve) })
    const text = Buffer.concat(chunks).toString('utf8')
    assert.match(text, /^HTTP\/1\.1 411 /u)
    assert.match(text, /"length-required"/u)
    c.ws.close()
  })

  it('REST PUT with Content-Length > 100 MiB → 411 length-required', async () => {
    // The cap is MAX_CONTENT_LENGTH in rest.ts (100 MiB). A
    // declared length above that is rejected before opening the
    // staging file — protects against a malicious / misconfigured
    // client pinning disk on the staging row. Raw TCP because
    // Node's `fetch()` enforces body-vs-Content-Length on the
    // client side and refuses to send a shorter body.
    const { default: net } = await import('node:net')
    const { sk, tag } = await makeKp()
    const c = await connect(serverUrl)
    await subscribeWS(c, sk, tag)
    const fields = {
      workspaceTag: tag, resourceTag: 'r-oversize', prevVersion: null,
      expectedLength: 1,
      contentHash: syntheticHash(),
    }
    const signature = await signPut(sk, fields, c.connectionNonce)
    c.ws.send(JSON.stringify({ type: 'objstore-put-begin', ...fields, signature }))
    const tok = await c.recv((m) => m.type === 'objstore-put-token')
    const huge = 200 * 1024 * 1024 // 200 MiB, double the cap
    const port = Number(new URL(serverUrl).port)
    const tcp = net.connect({ host: '127.0.0.1', port })
    const chunks = []
    tcp.on('data', (b) => { chunks.push(b) })
    await new Promise((resolve, reject) => {
      tcp.once('connect', resolve); tcp.once('error', reject)
    })
    tcp.write(
      `PUT ${tok.urlPath} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\n` +
      `Authorization: Bearer ${tok.token}\r\n` +
      `Content-Type: application/octet-stream\r\n` +
      `Content-Length: ${huge}\r\n` +
      `Connection: close\r\n\r\n`,
    )
    // No body — server should reject on the header alone.
    await new Promise((resolve) => { tcp.once('close', resolve) })
    const text = Buffer.concat(chunks).toString('utf8')
    assert.match(text, /^HTTP\/1\.1 411 /u)
    c.ws.close()
  })

  // NOTE on Transform overrun coverage: the Transform-in-pipeline
  // byte counter at server/objstore/rest.ts has a defensive
  // `cb(new Error('overrun'))` branch for `received > declared`. We
  // confirmed empirically that this branch is NOT reachable from
  // legitimate HTTP clients: Node's HTTP parser rejects a body that
  // exceeds Content-Length at the wire level (`400 Bad Request` with
  // no body, before our handler runs). The branch exists purely as
  // defense-in-depth (buggy proxy that strips/edits Content-Length
  // while forwarding the body, or a future Node parser change). No
  // wire test exercises it; the Transform is local-scoped so a unit
  // test would require export gymnastics. Documented gap.

  it('101st NEW resource per workspace → objstore-put-error { reason: workspace-full } (H1 cap)', async () => {
    // Audit round-9 H1: server/objstore/store.ts caps live rows per
    // workspace at MAX_RESOURCES_PER_WORKSPACE (100). DB-level
    // coverage is in tests/server-objstore.test.js; this exercises
    // the WS handler path that translates the storage rejection
    // into the typed wire frame.
    const { MAX_RESOURCES_PER_WORKSPACE } = await import('../server/objstore/store.ts')
    const { sk, tag } = await makeKp()
    const c = await connect(serverUrl)
    await subscribeWS(c, sk, tag)
    // Fill the workspace right up to the cap via the full WS+REST
    // path so we exercise the same code the wire frame depends on.
    for (let i = 0; i < MAX_RESOURCES_PER_WORKSPACE; i++) {
      const res = await putBlob(c, sk, tag, `r-fill-${i}`, Buffer.from('x'.repeat(4)), null, httpOrigin)
      assert.equal(res.putRes?.status, 200, `setup row #${i} should succeed`)
      // Drain own broadcast so it doesn't block the next iteration.
      await c.recv((m) => m.type === 'objstore-put' && m.resourceTag === `r-fill-${i}`)
    }
    // 101st distinct resourceTag — server rejects at put-begin BEFORE
    // any token issuance. putBlob returns `{ putError }` on the
    // objstore-put-error path.
    const result = await putBlob(c, sk, tag, 'r-one-too-many', Buffer.from('x'.repeat(4)), null, httpOrigin)
    assert.ok(result.putError, 'expected putError on the 101st new resource')
    assert.equal(result.putError.type, 'objstore-put-error')
    assert.equal(result.putError.workspaceTag, tag)
    assert.equal(result.putError.resourceTag, 'r-one-too-many')
    assert.equal(result.putError.reason, 'workspace-full')
    // Update path is still allowed at the cap — re-upload an existing
    // resource (new version) is not a NEW resource, no count change.
    const reup = await putBlob(c, sk, tag, 'r-fill-0', Buffer.from('y'.repeat(8)), 1, httpOrigin)
    assert.equal(reup.putRes?.status, 200, 'update of existing resource should succeed at the cap')
    c.ws.close()
  })

  it('REST PUT with a token whose payload res does not match the URL → 401', async () => {
    // Defense-in-depth: even with a valid HMAC + tag match, the
    // handler rejects when payload.res != URL resourceTag. Catches
    // a token-substitution attack where a leaked token for r-a is
    // re-aimed at r-b.
    const { sk, tag } = await makeKp()
    const c = await connect(serverUrl)
    await subscribeWS(c, sk, tag)
    // Mint a put-token for r-a.
    const fields = {
      workspaceTag: tag, resourceTag: 'r-a', prevVersion: null,
      expectedLength: 4,
      contentHash: syntheticHash(),
    }
    const signature = await signPut(sk, fields, c.connectionNonce)
    c.ws.send(JSON.stringify({ type: 'objstore-put-begin', ...fields, signature }))
    const tok = await c.recv((m) => m.type === 'objstore-put-token' && m.resourceTag === 'r-a')
    // Use the r-a token on the r-b URL.
    const reaimedUrl = tok.urlPath.replace('/r-a', '/r-b')
    const res = await fetch(httpOrigin + reaimedUrl, {
      method: 'PUT',
      headers: { authorization: `Bearer ${tok.token}`, 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(4),
    })
    assert.equal(res.status, 401)
    c.ws.close()
  })

  it('REST PUT URL with a trailing slash → 404 (regex is exact-match)', async () => {
    // The route regex deliberately rejects trailing slash so a
    // proxy / client misconfiguration that adds one fails loudly
    // instead of silently bypassing the path gate.
    const { tag } = await makeKp()
    const res = await fetch(`${httpOrigin}/api/objstore/${tag}/some-resource/`, {
      method: 'PUT', headers: { authorization: 'Bearer x.y', 'content-length': '0' },
    })
    assert.equal(res.status, 404)
  })

  it('concurrent PUTs with the same put-token — exactly one runs, the other returns 410', async () => {
    // PR #4 review: without the in-flight sid guard, two requests
    // with the same token would both open the staging file in 'w'
    // mode. The first commit renames staging → live; the second's
    // still-open fd points at the inode that's now under the live
    // name, and remaining writes would corrupt the committed blob.
    // The guard refuses the second outright.
    const { sk, tag } = await makeKp()
    const c = await connect(serverUrl)
    await subscribeWS(c, sk, tag)
    const payload = Buffer.from('replay-bytes', 'utf8')
    const fields = {
      workspaceTag: tag, resourceTag: 'r-concurrent-replay', prevVersion: null,
      expectedLength: payload.byteLength,
      contentHash: syntheticHash(),
    }
    const signature = await signPut(sk, fields, c.connectionNonce)
    c.ws.send(JSON.stringify({ type: 'objstore-put-begin', ...fields, signature }))
    const tok = await c.recv((m) => m.type === 'objstore-put-token')
    // Fire two PUTs with the SAME token in parallel.
    const opts = {
      method: 'PUT',
      headers: { authorization: `Bearer ${tok.token}`, 'content-type': 'application/octet-stream' },
      body: payload,
    }
    const [r1, r2] = await Promise.all([
      fetch(httpOrigin + tok.urlPath, opts),
      fetch(httpOrigin + tok.urlPath, opts),
    ])
    const statuses = [r1.status, r2.status].toSorted()
    assert.deepEqual(statuses, [200, 410], 'one succeeds, the other gets 410 gone')
    c.ws.close()
  })

  it('REST PUT with a missing .staging dir under the token → 500 io-error (not 400 aborted)', async () => {
    // PR #4 review: a server-side filesystem fault during the
    // body-streaming step should map to 500 `io-error`, not 400
    // `aborted` (which would mislead the client into retrying as if
    // it had aborted). `createWriteStream` on a path whose parent
    // dir was removed yields ENOENT — that's an FS-side fault. The
    // fix added ENOENT to `IO_FAULT_CODES`.
    const { sk, tag } = await makeKp()
    const c = await connect(serverUrl)
    await subscribeWS(c, sk, tag)
    const payload = Buffer.from('would-have-been-written', 'utf8')
    const fields = {
      workspaceTag: tag, resourceTag: 'r-enoent', prevVersion: null,
      expectedLength: payload.byteLength,
      contentHash: syntheticHash(),
    }
    const signature = await signPut(sk, fields, c.connectionNonce)
    c.ws.send(JSON.stringify({ type: 'objstore-put-begin', ...fields, signature }))
    const tok = await c.recv((m) => m.type === 'objstore-put-token' && m.resourceTag === 'r-enoent')
    // Yank the staging dir out from under the just-issued token.
    rmSync(path.join(serverDir, 'objstore', tag, '.staging'), { recursive: true, force: true })
    const res = await fetch(httpOrigin + tok.urlPath, {
      method: 'PUT',
      headers: { authorization: `Bearer ${tok.token}`, 'content-type': 'application/octet-stream' },
      body: payload,
    })
    assert.equal(res.status, 500)
    const body = await res.json()
    assert.equal(body.error, 'io-error')
    c.ws.close()
  })

  it('GET race against concurrent DELETE returns either intact v1 bytes (fd pinned) or 404/503', async () => {
    // Audit finding: handleRestGet used to `stat(path)` then later
    // `createReadStream(path)`. A concurrent DELETE between the two
    // would have left the GET sending the OLD content-length with
    // bytes from an ENOENT or replaced inode. The fix opens the fd
    // inside the per-resource lock so the inode is pinned for the
    // duration of the stream; subsequent DELETE/PUT can't truncate
    // or corrupt the in-flight response. The invariant we assert is
    // the externally observable one: any successful 200 returns
    // EXACTLY the v1 bytes — no truncation, no garbage, no partial.
    const { sk, tag } = await makeKp()
    const c = await connect(serverUrl)
    await subscribeWS(c, sk, tag)
    // 64 KiB payload — large enough that the response body is
    // streamed in multiple ticks, widening the race window.
    const payload = Buffer.from(crypto.getRandomValues(new Uint8Array(64 * 1024)))
    await putBlob(c, sk, tag, 'race-1', payload, null, httpOrigin)
    await c.recv((m) => m.type === 'objstore-put' && m.resourceTag === 'race-1')
    // Mint a v1-bound fetch token.
    const fetchSig = await signFetch(sk, tag, 'race-1', c.connectionNonce)
    c.ws.send(JSON.stringify({ type: 'objstore-fetch', workspaceTag: tag, resourceTag: 'race-1', signature: fetchSig }))
    const tok = await c.recv((m) => m.type === 'objstore-fetch-token' && m.resourceTag === 'race-1')
    // Fire the GET; concurrently fire a DELETE on the WS plane. We
    // can't deterministically order them — the assertion below is
    // race-agnostic.
    const fetchPromise = fetch(httpOrigin + tok.urlPath, {
      headers: { authorization: `Bearer ${tok.token}` },
    })
    const deleteSig = await signDelete(sk, { workspaceTag: tag, resourceTag: 'race-1', prevVersion: 1 }, c.connectionNonce)
    c.ws.send(JSON.stringify({
      type: 'objstore-delete', workspaceTag: tag, resourceTag: 'race-1', prevVersion: 1, signature: deleteSig,
    }))
    const res = await fetchPromise
    if (res.status === 200) {
      const body = Buffer.from(await res.arrayBuffer())
      assert.equal(body.byteLength, payload.byteLength, 'pinned inode preserves the full v1 byte count')
      assert.deepEqual(body, payload, 'pinned inode preserves the v1 bytes exactly (no truncation)')
    } else {
      assert.ok([404, 503].includes(res.status), `acceptable status under race: got ${res.status}`)
      await res.arrayBuffer()
    }
    c.ws.close()
  })

  it('GET race against concurrent PUT v2 returns either intact v1 bytes or 404/503', async () => {
    // Companion to the DELETE-race test: a concurrent PUT that
    // renames a fresh file over the live path would have made the
    // pre-fix GET send the OLD content-length with NEW bytes
    // (truncated to the OLD count). With the fix, the v1 fd opened
    // inside the lock pins the OLD inode, so a successful 200 still
    // returns v1 bytes byte-for-byte. The new v2 file is at the same
    // path but a different inode.
    const { sk, tag } = await makeKp()
    const c = await connect(serverUrl)
    await subscribeWS(c, sk, tag)
    const v1 = Buffer.from(crypto.getRandomValues(new Uint8Array(64 * 1024)))
    await putBlob(c, sk, tag, 'race-2', v1, null, httpOrigin)
    await c.recv((m) => m.type === 'objstore-put' && m.resourceTag === 'race-2')
    const fetchSig = await signFetch(sk, tag, 'race-2', c.connectionNonce)
    c.ws.send(JSON.stringify({ type: 'objstore-fetch', workspaceTag: tag, resourceTag: 'race-2', signature: fetchSig }))
    const tok = await c.recv((m) => m.type === 'objstore-fetch-token' && m.resourceTag === 'race-2')
    // Different size for v2 so a truncation would be detectable.
    const v2 = Buffer.from(crypto.getRandomValues(new Uint8Array(32 * 1024)))
    const fetchPromise = fetch(httpOrigin + tok.urlPath, {
      headers: { authorization: `Bearer ${tok.token}` },
    })
    // Fire the PUT v2 right after the GET — race the rename against
    // the GET's lock-protected fd open. Capture the promise so we
    // can drain it before closing the socket.
    const putPromise = putBlob(c, sk, tag, 'race-2', v2, 1, httpOrigin)
    const res = await fetchPromise
    if (res.status === 200) {
      const body = Buffer.from(await res.arrayBuffer())
      assert.equal(body.byteLength, v1.byteLength, 'response length matches v1 (not v2)')
      assert.deepEqual(body, v1, 'response bytes match v1 exactly (no v2 leak / truncation)')
    } else {
      assert.ok([404, 503].includes(res.status), `acceptable status under race: got ${res.status}`)
      await res.arrayBuffer()
    }
    await putPromise
    c.ws.close()
  })

  it('DELETE with prevVersion=null when the row exists → conflict (not silent succeed)', async () => {
    // The idempotent-missing-resource path (prevVersion=null + no
    // row → ack with deletedVersion=0) is already covered; this
    // pins the inverse: prevVersion=null on an EXISTING row is a
    // version mismatch and must conflict, so an unconditional
    // DELETE can't accidentally drop a peer's just-committed PUT.
    const { sk, tag } = await makeKp()
    const c = await connect(serverUrl)
    await subscribeWS(c, sk, tag)
    await putBlob(c, sk, tag, 'r-no-null-delete', Buffer.from('present', 'utf8'), null, httpOrigin)
    await c.recv((m) => m.type === 'objstore-put' && m.resourceTag === 'r-no-null-delete')
    const sig = await signDelete(sk, { workspaceTag: tag, resourceTag: 'r-no-null-delete', prevVersion: null }, c.connectionNonce)
    c.ws.send(JSON.stringify({
      type: 'objstore-delete', workspaceTag: tag, resourceTag: 'r-no-null-delete',
      prevVersion: null, signature: sig,
    }))
    const conflict = await c.recv((m) => m.type === 'objstore-conflict' && m.resourceTag === 'r-no-null-delete')
    assert.equal(conflict.action, 'delete')
    assert.equal(conflict.current.version, 1)
    // Row still there — the failed DELETE didn't drop it.
    const listSig = await signList(sk, tag, c.connectionNonce)
    c.ws.send(JSON.stringify({ type: 'objstore-list', workspaceTag: tag, signature: listSig }))
    const list = await c.recv((m) => m.type === 'objstore-list-result')
    assert.equal(list.resources.length, 1)
    c.ws.close()
  })
})
